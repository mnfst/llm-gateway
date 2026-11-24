import { ProxyMessageRecorder } from '../proxy-message-recorder';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { IngestEventBusService } from '../../../common/services/ingest-event-bus.service';
import { IngestionContext } from '../../../otlp/interfaces/ingestion-context.interface';

/**
 * Locks the per-failure auth_type contract on recordFailedFallbacks:
 *   - When a FailedFallback carries `authType`, the persisted row uses it.
 *   - When `authType` is missing on the failure, the recorder falls back to
 *     the primary's auth_type (preserving pre-route behavior).
 *
 * This is the recorder-side half of the #1708 invariant tested in
 * proxy-fallback.routes.spec.ts.
 */

const ctx: IngestionContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  agentName: 'test-agent',
  userId: 'user-1',
};

describe('ProxyMessageRecorder.recordFailedFallbacks — per-failure auth_type', () => {
  let recorder: ProxyMessageRecorder;
  let insertMock: jest.Mock;

  beforeEach(() => {
    insertMock = jest.fn();
    const repo = { insert: insertMock } as never;
    const pricingCache = {
      getByModel: jest.fn().mockReturnValue(undefined),
    } as unknown as ModelPricingCacheService;
    const eventBus = { emit: jest.fn() } as unknown as IngestEventBusService;
    const customProviders = {
      canonicalizeAgentMessageKeys: jest
        .fn()
        .mockImplementation(
          async (_agentId: string, provider: string | null, model: string | null) => ({
            provider: provider ?? null,
            model: model ?? null,
          }),
        ),
    } as never;
    const opencodeGoCatalog = {
      getCostPerRequest: jest.fn().mockReturnValue(null),
      resolveCostPerRequest: jest.fn().mockResolvedValue(null),
    } as never;
    recorder = new ProxyMessageRecorder(
      repo,
      pricingCache,
      eventBus,
      customProviders,
      opencodeGoCatalog,
    );
  });

  afterEach(() => {
    recorder.onModuleDestroy();
  });

  it('persists the per-failure authType when set on the FailedFallback', async () => {
    const failures = [
      {
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        status: 401,
        errorBody: 'sub failed',
        fallbackIndex: 0,
        authType: 'subscription' as const,
      },
      {
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        status: 401,
        errorBody: 'key failed',
        fallbackIndex: 1,
        authType: 'api_key' as const,
      },
    ];

    await recorder.recordFailedFallbacks(ctx, 'standard', 'gpt-4o', failures, {
      authType: 'api_key', // primary auth — should NOT win when per-failure auth is set
    });

    const rows = insertMock.mock.calls[0][0] as Array<{ auth_type: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].auth_type).toBe('subscription');
    expect(rows[1].auth_type).toBe('api_key');
  });

  it('falls back to the primary authType when the failure has no authType', async () => {
    // Backward compat: callers from the legacy path don't set per-failure
    // auth. The recorder should attribute those rows to the primary's auth.
    const failures = [
      {
        model: 'gpt-4o',
        provider: 'openai',
        status: 500,
        errorBody: 'boom',
        fallbackIndex: 0,
      },
    ];

    await recorder.recordFailedFallbacks(ctx, 'standard', 'primary', failures, {
      authType: 'api_key',
    });

    const rows = insertMock.mock.calls[0][0] as Array<{ auth_type: string | null }>;
    expect(rows[0].auth_type).toBe('api_key');
  });

  it('persists auth_type=null when neither per-failure nor primary auth is set', async () => {
    const failures = [
      {
        model: 'gpt-4o',
        provider: 'openai',
        status: 500,
        errorBody: 'boom',
        fallbackIndex: 0,
      },
    ];

    await recorder.recordFailedFallbacks(ctx, 'standard', 'primary', failures);

    const rows = insertMock.mock.calls[0][0] as Array<{ auth_type: string | null }>;
    expect(rows[0].auth_type).toBeNull();
  });

  it('mixes per-failure and primary fallback auth across rows in one batch', async () => {
    // Realistic case: the proxy carries a route for one model but inferred
    // the other from the legacy path.
    const failures = [
      {
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        status: 401,
        errorBody: 'fail',
        fallbackIndex: 0,
        authType: 'subscription' as const,
      },
      {
        model: 'claude-haiku-3.5',
        provider: 'anthropic',
        status: 500,
        errorBody: 'fail',
        fallbackIndex: 1,
        // no authType — recorder must fall back to opts.authType
      },
    ];

    await recorder.recordFailedFallbacks(ctx, 'standard', 'primary', failures, {
      authType: 'api_key',
    });

    const rows = insertMock.mock.calls[0][0] as Array<{ auth_type: string | null }>;
    expect(rows[0].auth_type).toBe('subscription');
    expect(rows[1].auth_type).toBe('api_key');
  });

  it('stamps the Autofix audit carried by a recovered fallback hop', async () => {
    const failures = [
      {
        model: 'deepseek-flash',
        provider: 'opencode-go',
        status: 400,
        errorBody: 'response_format unavailable',
        fallbackIndex: 0,
        autofixRole: 'original' as const,
        autofix: {
          groupId: 'group-1',
          outcome: 'healed' as const,
          original_http_status: 400,
          chain: [
            {
              attempt: 0,
              origin: 'original' as const,
              request: {},
              http_status: 400,
              issue_id: 'issue-1',
              patch_id: 'patch-1',
              operations: [{ type: 'drop_param' }],
            },
            { attempt: 1, origin: 'autofix' as const, request: {}, http_status: 200 },
          ],
        },
      },
    ];

    await recorder.recordFailedFallbacks(ctx, 'standard', 'gpt-4o', failures);

    const rows = insertMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      autofix_applied: true,
      autofix_group_id: 'group-1',
      autofix_role: 'original',
    });
  });
});
