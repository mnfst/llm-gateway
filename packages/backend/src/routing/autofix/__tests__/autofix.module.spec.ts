import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Agent } from '../../../entities/agent.entity';
import { AgentMessage } from '../../../entities/agent-message.entity';
import { ManifestRequest } from '../../../entities/request.entity';
import { InstallMetadata } from '../../../entities/install-metadata.entity';
import { InstallIdService } from '../../../telemetry/install-id.service';
import { ApiKey } from '../../../entities/api-key.entity';
import { AutofixModule } from '../autofix.module';
import { HEALING_CLIENT } from '../healing-client';
import { HttpHealingClient } from '../http-healing-client';
import { AUTOFIX_URL } from '../autofix-healing-config';
import { MockHealingClient } from '../mock-healing-client';

/**
 * Compile AutofixModule with a global ConfigModule seeded from `configValues`
 * (a real ConfigService, so the factory reads exactly what the app would) and
 * the TypeORM Agent repo stubbed, then resolve the HEALING_CLIENT the factory
 * produced. A global ConfigModule exports ConfigService into AutofixModule's
 * scope — a root-level provider would be encapsulated out of the imported
 * module.
 */
async function resolveHealingClient(configValues: Record<string, string>) {
  const previousMode = process.env.MANIFEST_MODE;
  process.env.MANIFEST_MODE = configValues.MANIFEST_MODE ?? 'cloud';
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => configValues] }),
        AutofixModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Agent))
      .useValue({})
      .overrideProvider(getRepositoryToken(AgentMessage))
      .useValue({})
      .overrideProvider(getRepositoryToken(ManifestRequest))
      .useValue({})
      // Autofix pulls the install id from TelemetryModule; stub its repo so the
      // module graph resolves without a database.
      .overrideProvider(getRepositoryToken(InstallMetadata))
      .useValue({})
      // The telemetry payload builder also reads api_keys (and the raw OAuth
      // tables through that repo's manager); stub it too.
      .overrideProvider(getRepositoryToken(ApiKey))
      .useValue({})
      .compile();

    const client = moduleRef.get(HEALING_CLIENT);
    await moduleRef.close();
    return client;
  } finally {
    if (previousMode === undefined) delete process.env.MANIFEST_MODE;
    else process.env.MANIFEST_MODE = previousMode;
  }
}

describe('AutofixModule HEALING_CLIENT factory', () => {
  it('provides a MockHealingClient outside production (NODE_ENV unset)', async () => {
    const client = await resolveHealingClient({});

    expect(client).toBeInstanceOf(MockHealingClient);
  });

  it('provides a MockHealingClient outside production even when NODE_ENV=development', async () => {
    // Explicit non-production NODE_ENV still exercises the dev/test branch.
    const client = await resolveHealingClient({ NODE_ENV: 'development' });

    expect(client).toBeInstanceOf(MockHealingClient);
  });

  it('keeps the mock in a self-hosted DEV run rather than dialling hosted Phoenix', async () => {
    // A developer running self-hosted mode locally must not post real failures
    // at the production healer just because the mode matches.
    const client = await resolveHealingClient({
      NODE_ENV: 'development',
      MANIFEST_MODE: 'selfhosted',
    });

    expect(client).toBeInstanceOf(MockHealingClient);
  });

  it('dials hosted Phoenix in self-hosted production', async () => {
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      MANIFEST_MODE: 'selfhosted',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(AUTOFIX_URL);
  });

  it('dials the same hosted Phoenix in CLOUD production', async () => {
    // Regression guard for dropping AUTOFIX_HEALING_URL: cloud used to depend
    // on that variable and would go inert without it, silently killing
    // Autofix in production for every hosted tenant.
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      MANIFEST_MODE: 'cloud',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(AUTOFIX_URL);
  });

  it('forwards AUTOFIX_HEALING_API_KEY and sends no instance id when set (cloud)', async () => {
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      AUTOFIX_HEALING_API_KEY: 'secret',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
    const inner = client as unknown as { apiKey?: string; instanceId?: unknown };
    expect(inner.apiKey).toBe('secret');
    expect(inner.instanceId).toBeUndefined();
  });

  it('provides an HttpHealingClient with a valid AUTOFIX_TIMEOUT_MS override', async () => {
    // Exercises the truthy side of the timeout ternary (parsed integer > 0).
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      AUTOFIX_TIMEOUT_MS: '5000',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
    expect((client as unknown as { timeoutMs: number }).timeoutMs).toBe(5000);
  });

  it('falls back to the default timeout when AUTOFIX_TIMEOUT_MS is invalid', async () => {
    // Number.parseInt('abc', 10) is NaN → Number.isInteger false → default.
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      AUTOFIX_TIMEOUT_MS: 'abc',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
  });

  it('falls back to the default timeout when AUTOFIX_TIMEOUT_MS is non-positive', async () => {
    // parsed = 0 → `parsed > 0` false → default branch.
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      AUTOFIX_TIMEOUT_MS: '0',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
  });

  it('rejects a numeric-prefixed AUTOFIX_TIMEOUT_MS (5abc) and uses the default', async () => {
    // `Number.parseInt('5abc')` would silently yield 5; the digits-only guard
    // rejects it, so the client keeps the 10s default instead of a 5ms timeout.
    const client = await resolveHealingClient({
      NODE_ENV: 'production',
      AUTOFIX_TIMEOUT_MS: '5abc',
    });

    expect(client).toBeInstanceOf(HttpHealingClient);
    expect((client as unknown as { timeoutMs: number }).timeoutMs).toBe(10_000);
  });

  it('resolves the install id once per process instead of per request', async () => {
    const previousMode = process.env.MANIFEST_MODE;
    process.env.MANIFEST_MODE = 'selfhosted';
    const getOrCreate = jest.fn().mockResolvedValue({ install_id: 'install-1' });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'no_patch', issueId: 'issue-1' }),
    });
    const realFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [() => ({ NODE_ENV: 'production' })],
          }),
          AutofixModule,
        ],
      })
        .overrideProvider(getRepositoryToken(Agent))
        .useValue({})
        .overrideProvider(getRepositoryToken(AgentMessage))
        .useValue({})
        .overrideProvider(getRepositoryToken(ManifestRequest))
        .useValue({})
        .overrideProvider(getRepositoryToken(InstallMetadata))
        .useValue({})
        .overrideProvider(getRepositoryToken(ApiKey))
        .useValue({})
        .overrideProvider(InstallIdService)
        .useValue({ getOrCreate })
        .compile();

      const client = moduleRef.get(HEALING_CLIENT) as {
        heal: (input: unknown, context: { harness: string }) => Promise<unknown>;
      };
      const heal = () =>
        client.heal(
          {
            traceId: 't',
            tenantId: 'tenant-1',
            provider: 'openai',
            authType: 'api_key',
            api: 'chat_completions',
            request: { max_tokens: 1 },
            response: { statusCode: 400, error: { message: 'bad' } },
          },
          { harness: 'claude-code' },
        );

      await heal();
      await heal();

      // The factory memoizes the resolved id, so the DB is read once even
      // though the client calls the provider on every request.
      expect(getOrCreate).toHaveBeenCalledTimes(1);

      // And the id actually reaches Phoenix, not just the memoizer.
      const healCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/heal'));
      expect(healCalls).toHaveLength(2);
      for (const [, init] of healCalls) {
        expect((init as RequestInit).headers).toMatchObject({
          'X-Manifest-Instance': 'install-1',
        });
      }
      await moduleRef.close();
    } finally {
      global.fetch = realFetch;
      if (previousMode === undefined) delete process.env.MANIFEST_MODE;
      else process.env.MANIFEST_MODE = previousMode;
    }
  });
});
