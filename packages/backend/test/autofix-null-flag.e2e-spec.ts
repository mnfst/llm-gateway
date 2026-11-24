import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, TEST_TENANT_ID } from './helpers';
import { Agent } from '../src/entities/agent.entity';

/**
 * Regression for the prod bug where Autofix silently never ran for any agent
 * that had never toggled it — i.e. `autofix_enabled = NULL`, the default state
 * that is supposed to inherit the deployment-mode default (ON in cloud).
 *
 * `AutofixService.loadAgentConfig` looked the agent up with
 * `findOne({ where: { id, tenant_id }, select: ['autofix_enabled'] })`. TypeORM's
 * entity transformer treats a row whose only selected column is NULL as "no
 * entity" and returns null, so every NULL-flag agent looked not-found and
 * resolved to `enabled: false`. The mocked unit tests missed it because the mock
 * returns a truthy object; only a real datasource reproduces it. The fix adds
 * the always-present primary key to the select.
 */
let app: INestApplication;
let ds: DataSource;

beforeAll(async () => {
  app = await createTestApp();
  ds = app.get(DataSource);
});

afterAll(async () => {
  await app.close();
});

describe('Autofix NULL-flag agent lookup (real TypeORM)', () => {
  it('materialises a NULL autofix_enabled agent only when the PK is selected', async () => {
    const agentRepo = ds.getRepository(Agent);
    await agentRepo.save({
      id: 'nullflag-agent',
      name: 'nullflag-agent',
      tenant_id: TEST_TENANT_ID,
      autofix_enabled: null,
    });

    // The fix: selecting the PK alongside the NULL flag keeps the row.
    const withId = await agentRepo.findOne({
      where: { id: 'nullflag-agent', tenant_id: TEST_TENANT_ID },
      select: ['id', 'autofix_enabled'],
    });
    expect(withId).not.toBeNull();
    expect(withId!.autofix_enabled).toBeNull();

    // The footgun the fix works around: selecting only the NULL column drops the
    // whole row, which is what silently disabled Autofix for default agents.
    const flagOnly = await agentRepo.findOne({
      where: { id: 'nullflag-agent', tenant_id: TEST_TENANT_ID },
      select: ['autofix_enabled'],
    });
    expect(flagOnly).toBeNull();
  });
});
