import { getMetadataArgsStorage } from 'typeorm';
import { Agent } from './agent.entity';
import { Tenant } from './tenant.entity';
import { AgentApiKey } from './agent-api-key.entity';

describe('Agent entity', () => {
  it('creates an instance with all fields', () => {
    const agent = new Agent();
    agent.id = 'agent-1';
    agent.name = 'demo-agent';
    agent.display_name = 'Demo Agent';
    agent.description = 'A test agent';
    agent.is_active = true;
    agent.tenant_id = 'tenant-1';
    agent.created_at = '2024-01-01T00:00:00Z';
    agent.updated_at = '2024-01-02T00:00:00Z';

    expect(agent.id).toBe('agent-1');
    expect(agent.name).toBe('demo-agent');
    expect(agent.display_name).toBe('Demo Agent');
    expect(agent.description).toBe('A test agent');
    expect(agent.is_active).toBe(true);
    expect(agent.tenant_id).toBe('tenant-1');
  });

  it('allows nullable fields to be null', () => {
    const agent = new Agent();
    agent.id = 'agent-2';
    agent.name = 'test';
    agent.display_name = null;
    agent.description = null;

    expect(agent.display_name).toBeNull();
    expect(agent.description).toBeNull();
  });

  describe('TypeORM relation callbacks', () => {
    it('ManyToOne callback resolves to Tenant with inverse side', () => {
      const relations = getMetadataArgsStorage().relations.filter((r) => r.target === Agent);
      const manyToOne = relations.find((r) => r.relationType === 'many-to-one');
      expect(manyToOne).toBeDefined();
      const resolved = (manyToOne!.type as () => unknown)();
      expect(resolved).toBe(Tenant);

      // Invoke the inverse side callback
      const tenant = new Tenant();
      tenant.agents = [new Agent()];
      const inverseFn = manyToOne!.inverseSideProperty as (obj: Tenant) => unknown;
      expect(inverseFn(tenant)).toBe(tenant.agents);
    });

    it('OneToOne callback resolves to AgentApiKey with inverse side', () => {
      const relations = getMetadataArgsStorage().relations.filter((r) => r.target === Agent);
      const oneToOne = relations.find((r) => r.relationType === 'one-to-one');
      expect(oneToOne).toBeDefined();
      const resolved = (oneToOne!.type as () => unknown)();
      expect(resolved).toBe(AgentApiKey);

      // Invoke the inverse side callback
      const apiKey = new AgentApiKey();
      apiKey.agent = new Agent();
      const inverseFn = oneToOne!.inverseSideProperty as (obj: AgentApiKey) => unknown;
      expect(inverseFn(apiKey)).toBe(apiKey.agent);
    });
  });

  describe('TypeORM table metadata', () => {
    it('is mapped to the "agents" table', () => {
      const table = getMetadataArgsStorage().tables.find((t) => t.target === Agent);
      expect(table).toBeDefined();
      expect(table!.name).toBe('agents');
      // Regular table (not view/junction/closure) — used by the schema sync.
      expect(table!.type).toBe('regular');
    });
  });

  describe('TypeORM index metadata', () => {
    const agentIndices = () => getMetadataArgsStorage().indices.filter((i) => i.target === Agent);

    it('declares the partial unique index on (tenant_id, name) WHERE deleted_at IS NULL', () => {
      const indices = agentIndices();
      expect(indices.length).toBeGreaterThan(0);

      // Find the composite (tenant_id, name) index. `columns` is a string[] when
      // declared at class-level via @Index(['tenant_id', 'name'], { ... }).
      const composite = indices.find((idx) => {
        const cols = idx.columns;
        return (
          Array.isArray(cols) && cols.length === 2 && cols[0] === 'tenant_id' && cols[1] === 'name'
        );
      });

      expect(composite).toBeDefined();
      expect(composite!.unique).toBe(true);
      // The partial predicate gates uniqueness so soft-deleted rows don't
      // collide with a freshly created agent of the same name.
      expect(composite!.where).toBe('"deleted_at" IS NULL');
    });

    it('does not silently drop the partial WHERE clause to a full unique index', () => {
      // Regression guard: a full unique index on (tenant_id, name) would block
      // recreating an agent with the same name after a soft delete. Make sure
      // no Agent index claims uniqueness on those columns without `where`.
      const indices = agentIndices();
      const offending = indices.find((idx) => {
        const cols = idx.columns;
        return (
          Array.isArray(cols) &&
          cols.length === 2 &&
          cols[0] === 'tenant_id' &&
          cols[1] === 'name' &&
          idx.unique === true &&
          (idx.where === undefined || idx.where === null || idx.where === '')
        );
      });
      expect(offending).toBeUndefined();
    });
  });

  describe('TypeORM column metadata', () => {
    const agentColumns = () => getMetadataArgsStorage().columns.filter((c) => c.target === Agent);

    it('declares "id" as the primary column (varchar)', () => {
      const id = agentColumns().find((c) => c.propertyName === 'id');
      expect(id).toBeDefined();
      // PrimaryColumn registers with mode "regular" and primary: true in options.
      expect(id!.options.primary).toBe(true);
      expect(id!.options.type).toBe('varchar');
    });

    it('declares boolean defaults that match the source-of-truth migrations', () => {
      const cols = agentColumns();

      const isActive = cols.find((c) => c.propertyName === 'is_active');
      expect(isActive).toBeDefined();
      expect(isActive!.options.type).toBe('boolean');
      // Agents default to enabled when created from the dashboard.
      expect(isActive!.options.default).toBe(true);

      const complexity = cols.find((c) => c.propertyName === 'complexity_routing_enabled');
      expect(complexity).toBeDefined();
      expect(complexity!.options.type).toBe('boolean');
      // Opt-in feature — must default to false so existing agents are unaffected.
      expect(complexity!.options.default).toBe(false);
    });

    it('marks the expected fields as nullable and the required ones as non-null', () => {
      const cols = agentColumns();
      const byName = (name: string) => cols.find((c) => c.propertyName === name);

      // Required columns: name, tenant_id (and the boolean flags above).
      expect(byName('name')!.options.nullable).toBeFalsy();
      expect(byName('tenant_id')!.options.nullable).toBeFalsy();

      // Nullable columns — these may legitimately be missing on legacy rows.
      expect(byName('display_name')!.options.nullable).toBe(true);
      expect(byName('description')!.options.nullable).toBe(true);
      expect(byName('agent_category')!.options.nullable).toBe(true);
      expect(byName('agent_platform')!.options.nullable).toBe(true);

      // Soft-delete column: NULL for live rows, set on delete.
      expect(byName('deleted_at')!.options.nullable).toBe(true);
      expect(byName('deleted_at')!.options.default).toBeNull();
    });
  });

  describe('TypeORM relation options', () => {
    const agentRelations = () =>
      getMetadataArgsStorage().relations.filter((r) => r.target === Agent);

    it('cascades agent deletes when the parent tenant is removed', () => {
      const manyToOne = agentRelations().find((r) => r.relationType === 'many-to-one');
      expect(manyToOne).toBeDefined();
      // FK to tenants(id) must cascade — orphaned agents would break tenant filtering.
      expect(manyToOne!.options.onDelete).toBe('CASCADE');
    });

    it('cascades inserts/updates through the agent → apiKey OneToOne', () => {
      const oneToOne = agentRelations().find((r) => r.relationType === 'one-to-one');
      expect(oneToOne).toBeDefined();
      // `cascade: true` lets `agentRepo.save(agent)` persist the attached apiKey
      // in the same transaction as ApiKeyGeneratorService.onboardAgent.
      expect(oneToOne!.options.cascade).toBe(true);
    });

    it('wires the tenant join column to the "tenant_id" foreign key', () => {
      const joinColumns = getMetadataArgsStorage().joinColumns.filter((jc) => jc.target === Agent);
      const tenantJoin = joinColumns.find((jc) => jc.propertyName === 'tenant');
      expect(tenantJoin).toBeDefined();
      // Mismatched names here would silently break ManyToOne loading.
      expect(tenantJoin!.name).toBe('tenant_id');
    });
  });
});
