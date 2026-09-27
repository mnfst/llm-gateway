import { getMetadataArgsStorage } from 'typeorm';
import { Tenant } from './tenant.entity';
import { Agent } from './agent.entity';

describe('Tenant entity', () => {
  it('creates an instance with all fields', () => {
    const t = new Tenant();
    t.id = 'tenant-1';
    t.name = 'test-tenant';
    t.organization_name = 'Test Org';
    t.email = 'test@example.com';
    t.is_active = true;
    t.agents = [];
    t.created_at = '2024-01-01T00:00:00Z';
    t.updated_at = '2024-01-02T00:00:00Z';
    expect(t.id).toBe('tenant-1');
    expect(t.name).toBe('test-tenant');
    expect(t.organization_name).toBe('Test Org');
    expect(t.email).toBe('test@example.com');
    expect(t.is_active).toBe(true);
    expect(t.agents).toEqual([]);
  });

  it('allows nullable fields to be null', () => {
    const t = new Tenant();
    t.id = 'tenant-2';
    t.name = 'test';
    t.organization_name = null;
    t.email = null;
    expect(t.organization_name).toBeNull();
    expect(t.email).toBeNull();
  });

  it('allows limit_overrides to be set or null', () => {
    const t = new Tenant();
    t.limit_overrides = null;
    expect(t.limit_overrides).toBeNull();

    t.limit_overrides = { requestsPerMonth: 50000 };
    expect(t.limit_overrides).toEqual({ requestsPerMonth: 50000 });
  });

  it('allows billing_email_preferences to be set or null', () => {
    const t = new Tenant();
    t.billing_email_preferences = null;
    expect(t.billing_email_preferences).toBeNull();

    t.billing_email_preferences = { usageAlerts: false };
    expect(t.billing_email_preferences).toEqual({ usageAlerts: false });
  });

  describe('TypeORM relation callbacks', () => {
    it('OneToMany callback resolves to Agent with inverse side', () => {
      const relations = getMetadataArgsStorage().relations.filter((r) => r.target === Tenant);
      const oneToMany = relations.find((r) => r.relationType === 'one-to-many');
      expect(oneToMany).toBeDefined();
      const resolved = (oneToMany!.type as () => unknown)();
      expect(resolved).toBe(Agent);

      // Invoke the inverse side callback
      const agent = new Agent();
      agent.tenant = new Tenant();
      const inverseFn = oneToMany!.inverseSideProperty as (obj: Agent) => unknown;
      expect(inverseFn(agent)).toBe(agent.tenant);
    });
  });
});
