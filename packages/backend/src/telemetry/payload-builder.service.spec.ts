import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { ApiKey } from '../entities/api-key.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';
import { PayloadBuilderService } from './payload-builder.service';

interface ProviderRow {
  provider: string | null;
  count: string;
  cost?: string | null;
}
interface BucketRow {
  bucket: string | null;
  count: string;
}
interface CategoryPlatformRow {
  category: string | null;
  platform: string | null;
  count: string;
}
interface TotalsRow {
  total: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cost?: string | null;
}

interface RequestTotalsRow {
  total: string;
  failed: string | null;
}

interface CliKeyRow {
  total: string;
  active: string | null;
}
interface McpCountsRow {
  clients: string;
  consents: string;
  tokens: string;
  active_clients: string;
}
interface McpNameRow {
  name: string | null;
  count: string;
}

interface MockData {
  providers: ProviderRow[];
  tiers: BucketRow[];
  authTypes: BucketRow[];
  totals: TotalsRow | undefined;
  agentPlatforms: CategoryPlatformRow[];
  agentsCount: number;
  requestTotals: RequestTotalsRow | undefined;
  errorClasses: BucketRow[];
  cliKeys: CliKeyRow | undefined;
  mcpCounts: McpCountsRow | undefined;
  mcpNames: McpNameRow[];
  /** When set, every raw OAuth query rejects with this error. */
  mcpQueryError: Error | undefined;
}

function defaultData(): MockData {
  return {
    providers: [],
    tiers: [],
    authTypes: [],
    totals: { total: '0', input_tokens: '0', output_tokens: '0' },
    agentPlatforms: [],
    agentsCount: 0,
    requestTotals: { total: '0', failed: '0' },
    errorClasses: [],
    cliKeys: { total: '0', active: '0' },
    mcpCounts: { clients: '0', consents: '0', tokens: '0', active_clients: '0' },
    mcpNames: [],
    mcpQueryError: undefined,
  };
}

interface MakeServiceResult {
  service: PayloadBuilderService;
  agentsRepo: {
    createQueryBuilder: jest.Mock;
  };
}

async function makeService(partial: Partial<MockData>): Promise<PayloadBuilderService> {
  return (await makeServiceWithRepo(partial)).service;
}

async function makeServiceWithRepo(partial: Partial<MockData>): Promise<MakeServiceResult> {
  const data: MockData = { ...defaultData(), ...partial };

  const messagesQueue = [
    { rows: data.providers, mode: 'getRawMany' as const },
    { rows: data.tiers, mode: 'getRawMany' as const },
    { rows: data.authTypes, mode: 'getRawMany' as const },
    { row: data.totals, mode: 'getRawOne' as const },
  ];
  // userAgentsCount() uses getRawOne returning {count: string};
  // agentsByPlatform() uses getRawMany returning CategoryPlatformRow[].
  const agentsQueue = [
    { row: { count: String(data.agentsCount) }, mode: 'getRawOne' as const },
    { rows: data.agentPlatforms, mode: 'getRawMany' as const },
  ];
  // requestCounts() uses getRawOne; failedRequestsByClass() uses getRawMany.
  const requestsQueue = [
    { row: data.requestTotals, mode: 'getRawOne' as const },
    { rows: data.errorClasses, mode: 'getRawMany' as const },
  ];

  function makeQb(entry: { rows?: unknown; row?: unknown; mode: 'getRawMany' | 'getRawOne' }) {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(entry.rows ?? []),
      getRawOne: jest.fn().mockResolvedValue(entry.row),
    };
  }

  const messagesRepo = {
    createQueryBuilder: jest.fn(() => makeQb(messagesQueue.shift()!)),
  };
  const agentsRepoMock = {
    createQueryBuilder: jest.fn(() => makeQb(agentsQueue.shift()!)),
  };
  const requestsRepo = {
    createQueryBuilder: jest.fn(() => makeQb(requestsQueue.shift()!)),
  };
  // The OAuth tables have no entity, so the builder goes through the api_keys
  // repository's entity manager. Two statements: the scalar counts (no GROUP BY)
  // and the per-name rollup.
  const apiKeysRepo = {
    createQueryBuilder: jest.fn(() => makeQb({ row: data.cliKeys, mode: 'getRawOne' })),
    manager: {
      query: jest.fn((sql: string) => {
        if (data.mcpQueryError) return Promise.reject(data.mcpQueryError);
        if (sql.includes('GROUP BY')) return Promise.resolve(data.mcpNames);
        return Promise.resolve(data.mcpCounts ? [data.mcpCounts] : []);
      }),
    },
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PayloadBuilderService,
      { provide: getRepositoryToken(AgentMessage), useValue: messagesRepo },
      { provide: getRepositoryToken(Agent), useValue: agentsRepoMock },
      { provide: getRepositoryToken(ManifestRequest), useValue: requestsRepo },
      { provide: getRepositoryToken(ApiKey), useValue: apiKeysRepo },
    ],
  }).compile();

  return { service: module.get(PayloadBuilderService), agentsRepo: agentsRepoMock };
}

describe('PayloadBuilderService', () => {
  it('builds a payload with the full v1 shape', async () => {
    const service = await makeService({
      providers: [{ provider: 'anthropic', count: '3' }],
      totals: { total: '3', input_tokens: '100', output_tokens: '50' },
      agentsCount: 2,
    });

    const payload = await service.build('inst-123', '5.47.0');

    expect(payload.schema_version).toBe(1);
    expect(payload.install_id).toBe('inst-123');
    expect(payload.manifest_version).toBe('5.47.0');
    expect(payload.platform).toBe(process.platform);
    expect(payload.arch).toBe(process.arch);
  });

  it('aggregates message counts and token totals across the 24h window', async () => {
    const service = await makeService({
      providers: [
        { provider: 'anthropic', count: '10' },
        { provider: 'openai', count: '5' },
      ],
      totals: { total: '15', input_tokens: '1200', output_tokens: '800' },
      agentsCount: 4,
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_total).toBe(15);
    expect(payload.tokens_input_total).toBe(1200);
    expect(payload.tokens_output_total).toBe(800);
    expect(payload.agents_total).toBe(4);
    expect(payload.messages_by_provider).toEqual({ anthropic: 10, openai: 5 });
  });

  it('collapses unknown provider names to "custom" to prevent leakage', async () => {
    const service = await makeService({
      providers: [
        { provider: 'anthropic', count: '2' },
        { provider: 'my-self-hosted-vllm', count: '4' },
        { provider: 'another-custom', count: '1' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_provider).toEqual({ anthropic: 2, custom: 5 });
  });

  it('maps NULL providers to an "unknown" bucket', async () => {
    const service = await makeService({ providers: [{ provider: null, count: '2' }] });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_provider).toEqual({ unknown: 2 });
  });

  it('respects provider registry aliases (e.g. "google" → "gemini")', async () => {
    const service = await makeService({
      providers: [{ provider: 'google', count: '3' }],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(Object.keys(payload.messages_by_provider)).toContain('gemini');
  });

  it('treats missing token sums as zero', async () => {
    const service = await makeService({
      totals: { total: '0', input_tokens: null, output_tokens: null },
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.tokens_input_total).toBe(0);
    expect(payload.tokens_output_total).toBe(0);
    expect(payload.messages_total).toBe(0);
  });

  it('defaults totals to zero when the query returns undefined', async () => {
    const service = await makeService({ totals: undefined });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_total).toBe(0);
    expect(payload.tokens_input_total).toBe(0);
    expect(payload.tokens_output_total).toBe(0);
  });

  it('emits request-level counters split by error class', async () => {
    const service = await makeService({
      requestTotals: { total: '20', failed: '6' },
      errorClasses: [
        { bucket: 'rate_limit', count: '4' },
        { bucket: 'auth', count: '2' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.requests_total).toBe(20);
    expect(payload.errors_total).toBe(6);
    expect(payload.errors_by_class).toEqual({ rate_limit: 4, auth: 2 });
  });

  it('buckets NULL error classes as "unknown" and off-taxonomy strings as "other"', async () => {
    const service = await makeService({
      requestTotals: { total: '9', failed: '3' },
      errorClasses: [
        { bucket: null, count: '1' },
        { bucket: 'totally-novel-class', count: '2' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.errors_by_class).toEqual({ unknown: 1, other: 2 });
  });

  it('treats a NULL failed sum (empty window) and a missing row as zero errors', async () => {
    const withNullSum = await makeService({ requestTotals: { total: '0', failed: null } });
    expect((await withNullSum.build('inst', '1.0.0')).errors_total).toBe(0);

    const withNoRow = await makeService({ requestTotals: undefined });
    const payload = await withNoRow.build('inst', '1.0.0');
    expect(payload.requests_total).toBe(0);
    expect(payload.errors_total).toBe(0);
    expect(payload.errors_by_class).toEqual({});
  });

  it('emits cost_usd_total = 0 and cost_usd_by_provider = {} when no cost data', async () => {
    const service = await makeService({
      providers: [{ provider: 'anthropic', count: '3' }],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.cost_usd_total).toBe(0);
    expect(payload.cost_usd_by_provider).toEqual({});
  });

  it('sums cost_usd_total from totals.cost and rounds to cents', async () => {
    const service = await makeService({
      totals: {
        total: '10',
        input_tokens: '0',
        output_tokens: '0',
        cost: '12.345678',
      },
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.cost_usd_total).toBe(12.35);
  });

  it('buckets cost_usd_by_provider with the same canonicalization as messages', async () => {
    const service = await makeService({
      providers: [
        { provider: 'anthropic', count: '10', cost: '5.4321' },
        { provider: 'openai', count: '5', cost: '2.1' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.cost_usd_by_provider).toEqual({ anthropic: 5.43, openai: 2.1 });
  });

  it('collapses custom provider costs into a single "custom" bucket', async () => {
    const service = await makeService({
      providers: [
        { provider: 'anthropic', count: '2', cost: '1.00' },
        { provider: 'my-self-hosted-vllm', count: '4', cost: '0.50' },
        { provider: 'another-custom', count: '1', cost: '0.25' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.cost_usd_by_provider).toEqual({ anthropic: 1, custom: 0.75 });
  });

  it('skips zero and null costs from cost_usd_by_provider', async () => {
    const service = await makeService({
      providers: [
        { provider: 'ollama', count: '100', cost: '0' },
        { provider: 'anthropic', count: '3', cost: '1.50' },
        { provider: 'openai', count: '1', cost: null },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.cost_usd_by_provider).toEqual({ anthropic: 1.5 });
  });

  it('drops cost_usd_by_provider buckets that round to 0 after rounding', async () => {
    const service = await makeService({
      providers: [{ provider: 'anthropic', count: '1', cost: '0.001' }],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.cost_usd_by_provider).toEqual({});
  });

  it('returns messages_by_tier grouped across the 4 canonical tiers', async () => {
    const service = await makeService({
      tiers: [
        { bucket: 'simple', count: '80' },
        { bucket: 'standard', count: '40' },
        { bucket: 'complex', count: '7' },
        { bucket: 'reasoning', count: '3' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_tier).toEqual({
      simple: 80,
      standard: 40,
      complex: 7,
      reasoning: 3,
    });
  });

  it('returns messages_by_auth_type grouped by api_key vs subscription', async () => {
    const service = await makeService({
      authTypes: [
        { bucket: 'api_key', count: '100' },
        { bucket: 'subscription', count: '20' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_auth_type).toEqual({ api_key: 100, subscription: 20 });
  });

  it('buckets NULL routing_tier rows under "unknown"', async () => {
    const service = await makeService({
      tiers: [
        { bucket: null, count: '5' },
        { bucket: 'simple', count: '10' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_tier).toEqual({ unknown: 5, simple: 10 });
  });

  it('keeps message-only routing tiers in telemetry buckets', async () => {
    const service = await makeService({
      tiers: [
        { bucket: 'direct', count: '3' },
        { bucket: 'playground', count: '2' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_tier).toEqual({ direct: 3, playground: 2 });
  });

  it('collapses unknown routing_tier strings to "other" so a future write path cannot leak verbatim values', async () => {
    // Defense-in-depth: if some caller writes "warp-speed" into routing_tier,
    // the whitelist clamps it to "other" before it leaves the install.
    const service = await makeService({
      tiers: [
        { bucket: 'simple', count: '4' },
        { bucket: 'warp-speed', count: '6' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.messages_by_tier).toEqual({ simple: 4, other: 6 });
  });

  it('returns agents_by_platform grouped by agent_platform with bare keys for known platforms', async () => {
    const service = await makeService({
      agentPlatforms: [
        { category: 'personal', platform: 'openclaw', count: '3' },
        { category: 'personal', platform: 'hermes', count: '1' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_by_platform).toEqual({ openclaw: 3, hermes: 1 });
  });

  it('emits composite "<category>:other" keys so peacock can tell the three Other variants apart', async () => {
    const service = await makeService({
      agentPlatforms: [
        { category: 'personal', platform: 'other', count: '5' },
        { category: 'app', platform: 'other', count: '2' },
        { category: 'coding', platform: 'other', count: '1' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_by_platform).toEqual({
      'personal:other': 5,
      'app:other': 2,
      'coding:other': 1,
    });
  });

  it('mixes bare and composite keys in the same payload (known platforms stay bare)', async () => {
    const service = await makeService({
      agentPlatforms: [
        { category: 'personal', platform: 'openclaw', count: '4' },
        { category: 'coding', platform: 'claude-code', count: '2' },
        { category: 'personal', platform: 'other', count: '3' },
        { category: 'coding', platform: 'other', count: '1' },
      ],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_by_platform).toEqual({
      openclaw: 4,
      'claude-code': 2,
      'personal:other': 3,
      'coding:other': 1,
    });
  });

  it('falls back to bare "other" when the row has no category (legacy un-migrated rows)', async () => {
    const service = await makeService({
      agentPlatforms: [{ category: null, platform: 'other', count: '7' }],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_by_platform).toEqual({ other: 7 });
  });

  it('buckets NULL agent_platform rows under "unknown"', async () => {
    const service = await makeService({
      agentPlatforms: [{ category: 'personal', platform: null, count: '2' }],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_by_platform).toEqual({ unknown: 2 });
  });

  it('excludes playground agents from agents_total count (is_playground = false filter applied)', async () => {
    // The count query is for user agents only — playground agents (e.g. Playground)
    // must not inflate the install telemetry.
    const { service, agentsRepo } = await makeServiceWithRepo({ agentsCount: 3 });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_total).toBe(3);
    // The count QB must have received a where clause filtering playground agents.
    const countQb = agentsRepo.createQueryBuilder.mock.results[0].value as {
      where: jest.Mock;
    };
    expect(countQb.where).toHaveBeenCalledWith('a.is_playground = false');
  });

  it('excludes playground agents from agents_by_platform (is_playground = false filter applied)', async () => {
    const { service, agentsRepo } = await makeServiceWithRepo({
      agentPlatforms: [{ category: 'personal', platform: 'openclaw', count: '2' }],
    });

    const payload = await service.build('inst', '1.0.0');

    expect(payload.agents_by_platform).toEqual({ openclaw: 2 });
    // The platform QB (second agents QB call) must filter playground agents.
    const platformQb = agentsRepo.createQueryBuilder.mock.results[1].value as {
      where: jest.Mock;
    };
    expect(platformQb.where).toHaveBeenCalledWith('a.is_playground = false');
  });
  describe('management-surface adoption (CLI + MCP)', () => {
    it('reports CLI key totals and 7-day actives from the api_keys rollup', async () => {
      const service = await makeService({ cliKeys: { total: '5', active: '2' } });

      const payload = await service.build('inst', '1.0.0');

      expect(payload.cli_keys_total).toBe(5);
      expect(payload.cli_keys_active_7d).toBe(2);
    });

    it('treats a missing CLI rollup row and a NULL active sum as zero', async () => {
      const none = await makeService({ cliKeys: undefined });
      expect((await none.build('inst', '1.0.0')).cli_keys_total).toBe(0);

      const nullActive = await makeService({ cliKeys: { total: '3', active: null } });
      const payload = await nullActive.build('inst', '1.0.0');
      expect(payload.cli_keys_total).toBe(3);
      expect(payload.cli_keys_active_7d).toBe(0);
    });

    it('reports MCP client, consent, and token counts from the OAuth tables', async () => {
      const service = await makeService({
        mcpCounts: { clients: '3', consents: '4', tokens: '96', active_clients: '2' },
      });

      const payload = await service.build('inst', '1.0.0');

      expect(payload.mcp_clients_total).toBe(3);
      expect(payload.mcp_consents_total).toBe(4);
      expect(payload.mcp_tokens_issued_24h).toBe(96);
      expect(payload.mcp_clients_active_24h).toBe(2);
    });

    it('whitelists MCP client names and collapses the rest to "other" / "unknown"', async () => {
      const service = await makeService({
        mcpNames: [
          { name: 'Claude Code', count: '2' },
          { name: 'cursor', count: '1' },
          { name: "Guillaume's laptop agent", count: '1' },
          { name: 'https://internal.example.com/tool', count: '1' },
          // Declared but empty: a name we decline to forward, not a missing one.
          { name: '', count: '1' },
          { name: null, count: '1' },
        ],
      });

      const payload = await service.build('inst', '1.0.0');

      expect(payload.mcp_clients_by_name).toEqual({
        'claude-code': 2,
        cursor: 1,
        other: 3,
        unknown: 1,
      });
    });

    it('degrades to zeros when the OAuth tables are missing instead of failing the report', async () => {
      const service = await makeService({
        mcpQueryError: new Error('relation "oauthClient" does not exist'),
        cliKeys: { total: '1', active: '1' },
      });

      const payload = await service.build('inst', '1.0.0');

      expect(payload.mcp_clients_total).toBe(0);
      expect(payload.mcp_consents_total).toBe(0);
      expect(payload.mcp_tokens_issued_24h).toBe(0);
      expect(payload.mcp_clients_active_24h).toBe(0);
      expect(payload.mcp_clients_by_name).toEqual({});
      // The rest of the payload is unaffected.
      expect(payload.cli_keys_total).toBe(1);
    });

    it('degrades to zeros on a non-Error rejection too', async () => {
      const service = await makeService({
        mcpQueryError: 'connection reset' as unknown as Error,
      });

      const payload = await service.build('inst', '1.0.0');

      expect(payload.mcp_clients_total).toBe(0);
      expect(payload.mcp_clients_by_name).toEqual({});
    });

    it('degrades to zeros when the counts query returns no row', async () => {
      const service = await makeService({
        mcpCounts: undefined,
        mcpNames: [{ name: 'zed', count: '1' }],
      });

      const payload = await service.build('inst', '1.0.0');

      expect(payload.mcp_clients_total).toBe(0);
      expect(payload.mcp_clients_by_name).toEqual({});
    });
  });
});
