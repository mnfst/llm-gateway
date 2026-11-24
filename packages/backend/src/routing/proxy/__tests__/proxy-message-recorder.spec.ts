import { ProxyMessageRecorder } from '../proxy-message-recorder';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { IngestEventBusService } from '../../../common/services/ingest-event-bus.service';
import { IngestionContext } from '../../../otlp/interfaces/ingestion-context.interface';
import type { AutofixRecord } from '../../autofix/autofix.types';
import type { ProviderAttemptRef } from '../proxy-types';

const sampleAutofix: AutofixRecord = {
  groupId: 'grp-1',
  outcome: 'healed',
  original_http_status: 400,
  chain: [
    {
      attempt: 0,
      origin: 'original',
      request: { max_tokens: 5 },
      http_status: 400,
      error: {
        message: 'Unknown parameter',
        type: 'invalid_request_error',
        param: 'max_tokens',
        code: 'unknown_parameter',
      },
      operations: [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }],
      heal_attempt_id: 'heal-1',
      patch_worked: true,
    },
    { attempt: 1, origin: 'autofix', request: { max_output_tokens: 5 }, http_status: 200 },
  ],
};

const ctx: IngestionContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  agentName: 'test-agent',
  userId: 'user-1',
};

describe('ProxyMessageRecorder', () => {
  let recorder: ProxyMessageRecorder;
  let insertMock: jest.Mock;
  let updateMock: jest.Mock;
  let getByModelMock: jest.Mock;
  let getProvidersMock: jest.Mock;
  let emitMock: jest.Mock;

  beforeEach(() => {
    insertMock = jest.fn();
    updateMock = jest.fn();
    getByModelMock = jest.fn().mockReturnValue(undefined);
    getProvidersMock = jest.fn().mockResolvedValue([]);
    emitMock = jest.fn();
    const repo = {
      insert: insertMock,
      update: updateMock,
      manager: { getRepository: jest.fn(() => ({})) },
    } as never;
    const pricingCache = {
      getByModel: getByModelMock,
    } as unknown as ModelPricingCacheService;
    const eventBus = { emit: emitMock } as unknown as IngestEventBusService;
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
    const providerService = { getProviders: getProvidersMock } as never;
    recorder = new ProxyMessageRecorder(
      repo,
      pricingCache,
      eventBus,
      customProviders,
      opencodeGoCatalog,
      providerService,
    );
  });

  afterEach(() => {
    recorder.onModuleDestroy();
  });

  describe('pending Attempt lifecycle', () => {
    it('inserts pending connection metadata and completes the same row', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-pending',
        attemptNumber: 2,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_125,
        pendingWrite: Promise.resolve(true),
      };

      await expect(
        recorder.recordPendingProviderAttempt(ctx, 'request-1', attempt, {
          provider: 'openai',
          model: 'gpt-4o',
          authType: 'api_key',
          tenantProviderId: 'connection-1',
          keyLabel: 'Work',
        }),
      ).resolves.toBe(true);
      await recorder.completePendingProviderFailure(attempt, 429, 'rate limited', true);

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'attempt-pending',
          request_id: 'request-1',
          attempt_number: 2,
          status: 'pending',
          auth_type: 'api_key',
          tenant_provider_id: 'connection-1',
          provider_key_label: 'Work',
        }),
      );
      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-pending' },
        expect.objectContaining({ status: 'failed', duration_ms: 125, superseded: true }),
      );
    });

    it('does not complete an attempt whose pending insert failed', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-missing',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        pendingWrite: Promise.reject(new Error('insert failed')),
      };

      await recorder.completePendingProviderFailure(attempt, 500, 'failed', false);

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('guarantees a message when a pending Attempt fails', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-empty-error',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        pendingWrite: Promise.resolve(true),
      };

      await recorder.completePendingProviderFailure(attempt, 503, '   ', false);

      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-empty-error' },
        expect.objectContaining({
          status: 'failed',
          error_message: 'Request failed without an error message.',
          error_code: null,
        }),
      );
    });

    it('stamps error_code when completing a pending attempt with a Manifest body', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-m102',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_050,
        pendingWrite: Promise.resolve(true),
      };

      await recorder.completePendingProviderFailure(
        attempt,
        401,
        '[🦚 Manifest M102] openai subscription credentials could not be refreshed.',
        true,
      );

      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-m102' },
        expect.objectContaining({
          status: 'failed',
          error_code: 'M102',
          error_http_status: 401,
          superseded: true,
        }),
      );
    });

    it('finalizes caller-disconnected Requests and Attempts as cancelled without errors', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-cancelled',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_125,
        pendingWrite: Promise.resolve(true),
      };

      await recorder.recordCancelledRequest(ctx, {
        requestId: 'request-cancelled',
        attempt,
        attemptStart: {
          provider: 'openai',
          model: 'gpt-5',
          authType: 'subscription',
          keyLabel: 'Work',
        },
        requestDurationMs: 150,
        traceId: 'trace-cancelled',
      });

      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-cancelled' },
        expect.objectContaining({
          status: 'cancelled',
          error_message: null,
          error_http_status: null,
          provider: 'openai',
          model: 'gpt-5',
          auth_type: 'subscription',
          // A cancelled row has no terminal writer to fill this in, so it has
          // to come from the attempt start.
          provider_key_label: 'Work',
          duration_ms: 125,
        }),
      );
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('cancels only still-pending Attempts whose pending row was written', async () => {
      const written: ProviderAttemptRef = {
        id: 'attempt-left-pending',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_250,
        pendingWrite: Promise.resolve(true),
      };
      const inFlight: ProviderAttemptRef = {
        id: 'attempt-in-flight',
        attemptNumber: 2,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
      };
      const neverInserted: ProviderAttemptRef = {
        id: 'attempt-insert-failed',
        attemptNumber: 3,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        pendingWrite: Promise.reject(new Error('insert failed')),
      };

      updateMock.mockResolvedValue({});

      await recorder.cancelPendingProviderAttempts([written, inFlight, neverInserted]);

      expect(updateMock).toHaveBeenCalledTimes(2);
      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-left-pending', status: 'pending' },
        {
          status: 'cancelled',
          error_message: null,
          error_code: null,
          error_http_status: null,
          duration_ms: 250,
        },
      );
      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-in-flight', status: 'pending' },
        expect.objectContaining({ status: 'cancelled', duration_ms: expect.any(Number) }),
      );
    });

    it('keeps cancelling the other Attempts when one update fails', async () => {
      const attempt = (id: string): ProviderAttemptRef => ({
        id,
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_100,
        pendingWrite: Promise.resolve(true),
      });
      updateMock.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({});

      await expect(
        recorder.cancelPendingProviderAttempts([attempt('first'), attempt('second')]),
      ).resolves.toBeUndefined();

      expect(updateMock).toHaveBeenCalledWith(
        { id: 'second', status: 'pending' },
        expect.objectContaining({ status: 'cancelled' }),
      );
    });

    it('updates the same pending row with terminal status and measured duration', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-1',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_125,
        pendingWrite: Promise.resolve(true),
      };

      await recorder.recordProviderError(ctx, 500, 'upstream failed', {
        requestId: 'request-1',
        attempt,
        model: 'gpt-4o',
        provider: 'openai',
      });

      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-1' },
        expect.objectContaining({
          request_id: 'request-1',
          attempt_number: 1,
          timestamp: '1970-01-01T00:00:01.000Z',
          duration_ms: 125,
          status: 'failed',
        }),
      );
    });

    it('finishes a successful request by updating its pending attempt', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-success',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_050,
        pendingWrite: Promise.resolve(true),
      };

      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 2, completion_tokens: 1 },
        { requestId: 'request-success', provider: 'openai', attempt },
      );

      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-success' },
        expect.objectContaining({ status: 'success', duration_ms: 50 }),
      );
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });
  });

  describe('recordFallbackSuccess', () => {
    it('records with zero tokens when usage has zero tokens (fallback metadata is still valuable)', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 0,
        timestamp: new Date().toISOString(),
        authType: 'api_key',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'success',
        input_tokens: 0,
        output_tokens: 0,
        fallback_from_model: 'claude-opus',
      });
    });

    it('records with zero tokens when usage is undefined (fallback chain succeeded)', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 0,
        timestamp: new Date().toISOString(),
        authType: 'api_key',
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'success',
        input_tokens: 0,
        output_tokens: 0,
      });
    });

    it('stamps the Autofix retry columns when the fallback hop was healed', async () => {
      await recorder.recordFallbackSuccess(ctx, 'deepseek-flash', 'standard', {
        fallbackFromModel: 'gpt-4o',
        fallbackIndex: 0,
        timestamp: new Date().toISOString(),
        authType: 'api_key',
        fallbackAutofix: {
          groupId: 'group-1',
          outcome: 'healed',
          original_http_status: 400,
          chain: [
            {
              attempt: 0,
              origin: 'original',
              request: {},
              http_status: 400,
              issue_id: 'issue-1',
              patch_id: 'patch-1',
              operations: [{ type: 'drop_param' }],
            },
            { attempt: 1, origin: 'autofix', request: {}, http_status: 200 },
          ],
        },
      });

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        autofix_applied: true,
        autofix_group_id: 'group-1',
        autofix_role: 'retry',
      });
    });

    it('does not stamp the primary Autofix record on an ordinary fallback success', async () => {
      // Regression: a failed primary Autofix that later fell back must not leak
      // its retry metadata onto the winning fallback's row.
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 0,
        timestamp: new Date().toISOString(),
        authType: 'api_key',
        autofix: {
          groupId: 'primary-group',
          outcome: 'exhausted',
          original_http_status: 400,
          chain: [
            { attempt: 0, origin: 'original', request: {}, http_status: 400 },
            { attempt: 1, origin: 'autofix', request: {}, http_status: 400 },
          ],
        },
      });

      const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
      expect(row.autofix_applied).toBeUndefined();
      expect(row.autofix_group_id).toBeUndefined();
      expect(row.autofix_role).toBeUndefined();
    });

    it('inserts when only prompt_tokens is non-zero', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        traceId: 'trace-1',
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 1,
        timestamp: new Date().toISOString(),
        authType: 'api_key',
        usage: { prompt_tokens: 200, completion_tokens: 0 },
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        input_tokens: 200,
        output_tokens: 0,
      });
    });

    it('inserts when only completion_tokens is non-zero', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 0,
        timestamp: new Date().toISOString(),
        authType: 'api_key',
        usage: { prompt_tokens: 0, completion_tokens: 75 },
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        input_tokens: 0,
        output_tokens: 75,
      });
    });

    it('inserts a fallback success with correct metadata', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        traceId: 'trace-abc',
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
        authType: 'api_key',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted).toMatchObject({
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        agent_name: 'test-agent',
        user_id: 'user-1',
        trace_id: 'trace-abc',
        status: 'success',
        model: 'gpt-4o',
        routing_tier: 'standard',
        input_tokens: 100,
        output_tokens: 50,
        auth_type: 'api_key',
        fallback_from_model: 'claude-opus',
        fallback_index: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      });
    });

    it('computes cost_usd from pricing cache when usage has tokens', async () => {
      getByModelMock.mockReturnValue({
        model_name: 'gpt-4o',
        provider: 'OpenAI',
        input_price_per_token: 0.0000025,
        output_price_per_token: 0.00001,
        display_name: 'GPT-4o',
      });
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        authType: 'api_key',
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
      const inserted = insertMock.mock.calls[0][0];
      // 1000 * 0.0000025 + 500 * 0.00001 = 0.0075
      expect(inserted.cost_usd).toBeCloseTo(0.0075, 10);
    });

    it('bills peak-window pricing from the attempt timestamp, not the wall clock', async () => {
      getByModelMock.mockReturnValue({
        model_name: 'deepseek-v4-flash',
        provider: 'DeepSeek',
        input_price_per_token: 0.22 / 1_000_000,
        output_price_per_token: 0.66 / 1_000_000,
        time_tiers: [
          {
            windows: ['01:00-04:00', '06:00-10:00'],
            input_price_per_token: 0.44 / 1_000_000,
            output_price_per_token: 1.32 / 1_000_000,
          },
        ],
        display_name: 'DeepSeek V4 Flash',
      });

      // Attempt started inside a peak window.
      await recorder.recordFallbackSuccess(ctx, 'deepseek-v4-flash', 'standard', {
        authType: 'api_key',
        timestamp: '2026-08-17T02:30:00.000Z',
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      });
      expect(insertMock.mock.calls[0][0].cost_usd).toBeCloseTo(0.44 + 1.32, 10);

      // Same usage off-peak bills the base rate.
      await recorder.recordFallbackSuccess(ctx, 'deepseek-v4-flash', 'standard', {
        authType: 'api_key',
        timestamp: '2026-08-17T12:00:00.000Z',
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      });
      expect(insertMock.mock.calls[1][0].cost_usd).toBeCloseTo(0.22 + 0.66, 10);

      // The provider attempt start wins over the synthetic fallback timestamp:
      // the attempt ran in-peak even though the delayed write stamps off-peak.
      const attempt: ProviderAttemptRef = {
        id: 'attempt-peak',
        attemptNumber: 1,
        startedAtMs: Date.parse('2026-08-17T02:30:00.000Z'),
        startedAt: '2026-08-17T02:30:00.000Z',
        pendingWrite: Promise.resolve(true),
      };
      await recorder.recordFallbackSuccess(ctx, 'deepseek-v4-flash', 'standard', {
        authType: 'api_key',
        attempt,
        timestamp: '2026-08-17T12:00:00.000Z',
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      });
      // The resolved pendingWrite routes this through the update path.
      expect(updateMock).toHaveBeenCalledWith(
        { id: 'attempt-peak' },
        expect.objectContaining({ cost_usd: expect.closeTo(0.44 + 1.32, 10) }),
      );
    });

    it('computes cost_usd with cache-read pricing when usage has cached tokens', async () => {
      getByModelMock.mockReturnValue({
        model_name: 'deepseek-v4-pro',
        provider: 'DeepSeek',
        input_price_per_token: 0.435 / 1_000_000,
        output_price_per_token: 0.87 / 1_000_000,
        cache_read_price_per_token: 0.003625 / 1_000_000,
        display_name: 'DeepSeek V4 Pro',
      });

      await recorder.recordFallbackSuccess(ctx, 'deepseek-v4-pro', 'standard', {
        authType: 'api_key',
        usage: {
          prompt_tokens: 36_100,
          completion_tokens: 1_200,
          cache_read_tokens: 21_600,
        },
      });

      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.cache_read_tokens).toBe(21_600);
      expect(inserted.cost_usd).toBeCloseTo(0.0074298, 10);
    });

    it('sets cost_usd to 0 for subscription auth type', async () => {
      getByModelMock.mockReturnValue({
        model_name: 'gpt-4o',
        provider: 'OpenAI',
        input_price_per_token: 0.0000025,
        output_price_per_token: 0.00001,
        display_name: 'GPT-4o',
      });
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        authType: 'subscription',
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.cost_usd).toBe(0);
    });

    it('uses provider-reported cost for subscription fallback success', async () => {
      await recorder.recordFallbackSuccess(ctx, 'stepfun/step-3.7-flash:free', 'default', {
        provider: 'nous',
        authType: 'subscription',
        usage: {
          prompt_tokens: 16,
          completion_tokens: 1,
          reported_cost_usd: 0.00005,
        },
      });

      const inserted = insertMock.mock.calls[0][0];
      expect(inserted).toMatchObject({
        provider: 'nous',
        auth_type: 'subscription',
        input_tokens: 16,
        output_tokens: 1,
        cost_usd: 0.00005,
      });
    });

    it('sets cost_usd to null when no pricing data exists', async () => {
      getByModelMock.mockReturnValue(undefined);
      await recorder.recordFallbackSuccess(ctx, 'unknown-model', 'standard', {
        authType: 'api_key',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.cost_usd).toBeNull();
    });

    it('records with defaults when optional fields are not provided', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard');
      expect(insertMock).toHaveBeenCalledTimes(1);
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.input_tokens).toBe(0);
      expect(inserted.output_tokens).toBe(0);
      expect(inserted.trace_id).toBeNull();
      expect(inserted.fallback_from_model).toBeNull();
      expect(inserted.fallback_index).toBeNull();
      expect(inserted.auth_type).toBeNull();
    });

    it('uses current timestamp when timestamp is not provided', async () => {
      const before = new Date().toISOString();
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const after = new Date().toISOString();
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.timestamp >= before).toBe(true);
      expect(inserted.timestamp <= after).toBe(true);
      expect(inserted.auth_type).toBeNull();
      expect(inserted.fallback_from_model).toBeNull();
      expect(inserted.fallback_index).toBeNull();
      expect(inserted.trace_id).toBeNull();
    });

    it('records cache tokens from usage', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        authType: 'api_key',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cache_read_tokens: 30,
          cache_creation_tokens: 20,
        },
      });
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.cache_read_tokens).toBe(30);
      expect(inserted.cache_creation_tokens).toBe(20);
    });

    it('defaults cache tokens to 0 when not in usage', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        authType: 'api_key',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const inserted = insertMock.mock.calls[0][0];
      expect(inserted.cache_read_tokens).toBe(0);
      expect(inserted.cache_creation_tokens).toBe(0);
    });

    it('emits SSE event after recording', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard');
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('persists the provider column when passed via opts', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gemma4:31b', 'standard', {
        provider: 'ollama-cloud',
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      });
      expect(insertMock.mock.calls[0][0].provider).toBe('ollama-cloud');
    });

    it('persists routing_reason when passed via opts (parity with non-fallback success)', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        reason: 'header-match',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      expect(insertMock.mock.calls[0][0].routing_reason).toBe('header-match');
    });

    it('writes null routing_reason when reason is omitted', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      expect(insertMock.mock.calls[0][0].routing_reason).toBeNull();
    });
  });

  describe('recordProviderError', () => {
    it('guarantees a message for failed rows when the provider body is empty', async () => {
      await recorder.recordProviderError(ctx, 503, '');

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_message: 'Request failed without an error message.',
        }),
      );
    });

    it('records error and emits SSE event', async () => {
      await recorder.recordProviderError(ctx, 500, 'Internal error', {
        model: 'gpt-4o',
        tier: 'standard',
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_message: 'Internal error',
        error_http_status: 500,
        model: 'gpt-4o',
      });
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('stores the HTTP status code for 400 errors', async () => {
      await recorder.recordProviderError(ctx, 400, 'Bad request');
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_http_status: 400,
      });
    });

    it('keeps Anthropic extra-usage errors as HTTP 400 but classifies them as billing', async () => {
      const errorBody = JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'You are out of extra usage. Add more at claude.ai to keep going.',
        },
      });

      await recorder.recordProviderError(ctx, 400, errorBody, {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        authType: 'subscription',
      });

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_http_status: 400,
        error_class: 'billing',
        error_origin: 'provider',
      });
    });

    it('records rate_limited status for 429 and emits SSE event', async () => {
      await recorder.recordProviderError(ctx, 429, 'Rate limited');
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0].status).toBe('failed');
      expect(insertMock.mock.calls[0][0].error_class).toBe('rate_limit');
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('skips insert during cooldown but does not emit', async () => {
      await recorder.recordProviderError(ctx, 429, 'Rate limited');
      insertMock.mockClear();
      emitMock.mockClear();
      await recorder.recordProviderError(ctx, 429, 'Rate limited again');
      expect(insertMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('persists the provider column when passed via opts', async () => {
      await recorder.recordProviderError(ctx, 500, 'Upstream error', {
        model: 'gemma4:31b',
        provider: 'ollama-cloud',
        tier: 'standard',
      });
      expect(insertMock.mock.calls[0][0].provider).toBe('ollama-cloud');
    });

    it('persists provider=null when opts omit the provider', async () => {
      await recorder.recordProviderError(ctx, 500, 'Upstream error', {
        model: 'gpt-4o',
      });
      expect(insertMock.mock.calls[0][0].provider).toBeNull();
    });

    it('scrubs provider secrets from the persisted error_message', async () => {
      const leaky = JSON.stringify({
        error: { message: 'Invalid x-api-key: sk-ant-api03-SECRETKEYVALUE12345' },
      });
      await recorder.recordProviderError(ctx, 401, leaky, { model: 'claude-3' });
      const stored: string = insertMock.mock.calls[0][0].error_message;
      expect(stored).not.toContain('SECRETKEYVALUE12345');
      expect(stored).toContain('[REDACTED]');
    });

    it('persists routing_reason when passed via opts', async () => {
      await recorder.recordProviderError(ctx, 500, 'oops', {
        model: 'gpt-4o',
        reason: 'header-match',
      });
      expect(insertMock.mock.calls[0][0].routing_reason).toBe('header-match');
    });

    it('writes null routing_reason when reason is omitted', async () => {
      await recorder.recordProviderError(ctx, 500, 'oops', { model: 'gpt-4o' });
      expect(insertMock.mock.calls[0][0].routing_reason).toBeNull();
    });

    describe('error classification axes', () => {
      it.each([
        [500, 'provider', 'server_error'],
        [402, 'provider', 'billing'],
        [401, 'provider', 'auth'],
        [404, 'provider', 'not_found'],
        [400, 'provider', 'invalid_request'],
        [429, 'provider', 'rate_limit'],
        [503, 'transport', 'network'],
        [504, 'transport', 'timeout'],
      ])('classifies HTTP %s as %s/%s (never superseded)', async (http, origin, klass) => {
        await recorder.recordProviderError(ctx, http as number, 'boom', { model: 'gpt-4o' });
        expect(insertMock.mock.calls[0][0]).toMatchObject({
          error_origin: origin,
          error_class: klass,
          superseded: false,
        });
      });
    });
  });

  describe('recordManifestBlockedRequest', () => {
    it('persists the error code and the rendered message a user can act on', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        errorMessage:
          '[🦚 Manifest M100] No anthropic API key yet. Add one here: https://x/routing',
        errorCode: 'M100',
        reason: 'no_provider_key',
        model: 'auto',
      });

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_code: 'M100',
        error_message:
          '[🦚 Manifest M100] No anthropic API key yet. Add one here: https://x/routing',
        error_origin: 'config',
        error_class: 'no_provider_key',
        // No provider was contacted and no tier chosen — the row must not claim
        // otherwise (this used to say provider='manifest', routing_tier='simple').
        provider: null,
        routing_tier: null,
        error_http_status: null,
      });
    });

    it('stamps the routing classification of a post-routing failure without claiming a provider', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        errorMessage: 'adapter bug',
        errorCode: 'M500',
        reason: 'manifest_internal_error',
        httpStatus: 500,
        routing: {
          tier: 'standard',
          specificityCategory: 'coding',
          headerTierId: 'header-tier-1',
          headerTierName: 'Program Weeks',
          headerTierColor: 'indigo',
        },
      });

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        error_code: 'M500',
        provider: null,
        auth_type: null,
        routing_tier: 'standard',
        specificity_category: 'coding',
        header_tier_id: 'header-tier-1',
        header_tier_name: 'Program Weeks',
        header_tier_color: 'indigo',
      });
    });

    it('leaves error_code null when a Manifest row carries no documented code', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        errorMessage: 'something went sideways',
        reason: 'manifest_internal_error',
      });
      expect(insertMock.mock.calls[0][0].error_code).toBeNull();
    });

    it('records a malformed caller body on the request origin', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 400,
        errorMessage: '[🦚 Manifest M300] `messages` array is required.',
        errorCode: 'M300',
        reason: 'manifest_invalid_request',
      });

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_code: 'M300',
        error_http_status: 400,
        error_origin: 'request',
        error_class: 'invalid_request',
      });
    });

    it('keeps the failed row and stamps the decision when a heal did not clear the block', async () => {
      const before = Date.now();
      await recorder.recordManifestBlockedRequest(ctx, {
        errorMessage: '[🦚 Manifest M302] Model "ghost" is not available for this agent.',
        errorCode: 'M302',
        reason: 'model_not_available',
        autofix: {
          groupId: 'g-miss',
          outcome: 'unfixable',
          original_http_status: 404,
          chain: [
            {
              attempt: 0,
              origin: 'original',
              request: { model: 'ghost' },
              http_status: 404,
              error: { message: 'model not found' },
              phoenix_status: 'no_patch',
              issue_id: 'issue-m302',
            },
          ],
        },
      });

      const row = insertMock.mock.calls[0][0];
      expect(row).toMatchObject({
        status: 'failed',
        error_code: 'M302',
        superseded: false,
        autofix_decision: {
          status: 'no_patch',
          issueId: 'issue-m302',
          patchId: null,
          healAttemptId: null,
          explanation: null,
        },
      });
      expect(row.autofix_applied).toBeUndefined();
      expect(new Date(row.timestamp).getTime()).toBeGreaterThanOrEqual(before - 100);
    });

    it('finalizes the real provider retry when a patched M302 still fails', async () => {
      const completeFailure = jest.fn().mockResolvedValue(undefined);
      await recorder.recordManifestBlockedRequest(ctx, {
        errorMessage: '[🦚 Manifest M302] Model "ghost" is not available for this agent.',
        errorCode: 'M302',
        reason: 'model_not_available',
        attempt: {
          id: 'attempt-m302-retry',
          attemptNumber: 1,
          startedAtMs: 1_000,
          startedAt: '1970-01-01T00:00:01.000Z',
          pendingWrite: Promise.resolve(true),
          completeFailure,
        },
        autofix: {
          groupId: 'g-retry-failed',
          outcome: 'exhausted',
          original_http_status: 404,
          chain: [
            {
              attempt: 0,
              origin: 'original',
              request: { model: 'ghost' },
              http_status: 404,
              error: { message: 'model not found' },
            },
            {
              attempt: 1,
              origin: 'autofix',
              request: { model: 'still-ghost' },
              http_status: 503,
              error: {
                message: 'patched provider failed',
                type: 'server_error',
                param: null,
                code: 'upstream_unavailable',
              },
            },
          ],
        },
      });

      expect(completeFailure).toHaveBeenCalledWith({
        status: 503,
        errorBody: JSON.stringify({
          error: {
            message: 'patched provider failed',
            type: 'server_error',
            code: 'upstream_unavailable',
          },
        }),
        superseded: false,
      });
    });

    it('records an expired key as a setup error against its agent', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 401,
        errorMessage: '[🦚 Manifest M004] This key has expired.',
        errorCode: 'M004',
        reason: 'key_expired',
      });

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        error_code: 'M004',
        error_origin: 'config',
        error_class: 'auth',
      });
    });

    it('keeps the three rate limits on separate cooldowns', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 429,
        errorMessage: 'per-user',
        reason: 'manifest_rate_limited',
      });
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 429,
        errorMessage: 'per-ip',
        reason: 'manifest_ip_rate_limited',
      });
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 429,
        errorMessage: 'concurrency',
        reason: 'manifest_concurrency_limited',
      });

      // Three distinct limits fired, so three rows. One shared cooldown would
      // have swallowed the second and third.
      expect(insertMock).toHaveBeenCalledTimes(3);
      expect(insertMock.mock.calls.map((c) => c[0].routing_reason)).toEqual([
        'manifest_rate_limited',
        'manifest_ip_rate_limited',
        'manifest_concurrency_limited',
      ]);
    });

    it('records plan-limit blocks as Manifest policy rows', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 402,
        errorMessage: 'Free plan request limit reached',
        reason: 'plan_request_limit_exceeded',
        model: 'auto',
        traceId: 'trace-1',
        sessionKey: 'session-1',
      });

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        agent_name: 'test-agent',
        trace_id: 'trace-1',
        session_key: 'session-1',
        status: 'failed',
        error_message: 'Free plan request limit reached',
        error_http_status: 402,
        routing_reason: 'plan_request_limit_exceeded',
        error_origin: 'policy',
        error_class: 'plan_request_limit_exceeded',
        superseded: false,
        model: 'auto',
        provider: null,
      });
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('records local proxy rate limits as Manifest policy rate-limit rows', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 429,
        errorMessage: 'Too many requests',
        reason: 'manifest_rate_limited',
      });

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_message: 'Too many requests',
        error_http_status: 429,
        routing_reason: 'manifest_rate_limited',
        error_origin: 'policy',
        error_class: 'rate_limit',
        superseded: false,
      });
    });

    it('records each rate-limited Manifest Request independently', async () => {
      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 429,
        errorMessage: 'Too many requests',
        reason: 'manifest_rate_limited',
      });
      insertMock.mockClear();
      emitMock.mockClear();

      await recorder.recordManifestBlockedRequest(ctx, {
        httpStatus: 429,
        errorMessage: 'Too many requests again',
        reason: 'manifest_rate_limited',
      });

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordFailedFallbacks', () => {
    it('updates the measured pending rows when fallback attempts are available', async () => {
      const attempts: ProviderAttemptRef[] = [0, 1].map((index) => ({
        id: `fallback-attempt-${index + 1}`,
        attemptNumber: index + 2,
        startedAtMs: 1_000 + index * 100,
        startedAt: new Date(1_000 + index * 100).toISOString(),
        completedAtMs: 1_050 + index * 100,
        pendingWrite: Promise.resolve(true),
      }));
      const failures = attempts.map((attempt, index) => ({
        model: `fallback-${index + 1}`,
        provider: 'openai',
        status: 500,
        errorBody: 'failed',
        fallbackIndex: index,
        attempt,
      }));

      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        requestId: 'request-fallbacks',
      });

      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledTimes(2);
      expect(updateMock).toHaveBeenNthCalledWith(
        1,
        { id: 'fallback-attempt-1' },
        expect.objectContaining({ request_id: 'request-fallbacks', attempt_number: 2 }),
      );
      expect(updateMock).toHaveBeenNthCalledWith(
        2,
        { id: 'fallback-attempt-2' },
        expect.objectContaining({ request_id: 'request-fallbacks', attempt_number: 3 }),
      );
    });

    // Connection attribution on failure rows: the label must follow the key
    // each hop actually used, and only fall back to the primary's for legacy
    // rows that carry none.
    it('stamps each failed fallback with its own connection label', async () => {
      const failures = [
        {
          model: 'claude-sonnet-4',
          provider: 'anthropic',
          status: 502,
          errorBody: 'boom',
          fallbackIndex: 0,
          keyLabel: 'Personal',
        },
        {
          model: 'gemini-2.5-flash',
          provider: 'gemini',
          status: 502,
          errorBody: 'boom',
          fallbackIndex: 1,
        },
      ];

      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        providerKeyLabel: 'Work',
      });

      const rows = insertMock.mock.calls[0][0];
      expect(rows[0]).toMatchObject({ provider: 'anthropic', provider_key_label: 'Personal' });
      expect(rows[1]).toMatchObject({ provider: 'gemini', provider_key_label: 'Work' });
    });

    it('leaves provider_key_label null when neither the hop nor the primary has one', async () => {
      const failures = [
        {
          model: 'claude-sonnet-4',
          provider: 'anthropic',
          status: 502,
          errorBody: 'boom',
          fallbackIndex: 0,
        },
      ];

      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);

      expect(insertMock.mock.calls[0][0][0]).toMatchObject({ provider_key_label: null });
    });

    it('stamps error_code on mid-chain Manifest credential failures', async () => {
      const failures = [
        {
          model: 'claude-sonnet-4',
          provider: 'anthropic',
          status: 401,
          errorBody: JSON.stringify({
            error: {
              message:
                '[🦚 Manifest M100] No anthropic API key yet. Add one here: https://x/routing See https://manifest.build/llm-gateway/docs/errors/M100/',
            },
          }),
          fallbackIndex: 0,
          authType: 'api_key' as const,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      expect(insertMock.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: 'M100',
            error_http_status: 401,
            provider: 'anthropic',
          }),
        ]),
      );
    });

    it('classifies a mid-chain credential failure as config origin despite a tier routing_reason', async () => {
      // The row carries a synthetic 401 and the tier reason ('scored'), but the
      // stamped M102 must win classification — otherwise a Manifest config error
      // is bucketed as a provider 401 and inflates provider_error_rate/billing.
      const failures = [
        {
          model: 'claude-sonnet-4',
          provider: 'anthropic',
          status: 401,
          errorBody: JSON.stringify({
            error: {
              message:
                '[🦚 Manifest M102] anthropic subscription credentials could not be refreshed. Reconnect OAuth here: https://x/routing See https://manifest.build/llm-gateway/docs/errors/M102/',
            },
          }),
          fallbackIndex: 0,
          authType: 'subscription' as const,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        reason: 'scored',
      });
      const rows = insertMock.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows[0]).toEqual(
        expect.objectContaining({
          error_code: 'M102',
          routing_reason: 'scored', // display keeps the tier reason
          error_origin: 'config', // …but it classifies as Manifest config, not a provider 401
          error_class: 'subscription_credentials_unusable',
        }),
      );
    });

    it('records all failures and emits SSE event once', async () => {
      const failures = [
        { model: 'gpt-4o', provider: 'openai', status: 500, errorBody: 'fail-1', fallbackIndex: 0 },
        {
          model: 'claude-3',
          provider: 'anthropic',
          status: 500,
          errorBody: 'fail-2',
          fallbackIndex: 1,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect((insertMock.mock.calls[0][0] as unknown[]).length).toBe(2);
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('stores the HTTP status code for each fallback failure', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 400,
          errorBody: 'bad request',
          fallbackIndex: 0,
        },
        {
          model: 'claude-3',
          provider: 'anthropic',
          status: 503,
          errorBody: 'unavailable',
          fallbackIndex: 1,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      const rows = insertMock.mock.calls[0][0] as Array<{ error_http_status: number }>;
      expect(rows[0].error_http_status).toBe(400);
      expect(rows[1].error_http_status).toBe(503);
    });

    it('persists the provider column for each fallback failure', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 500,
          errorBody: 'fail-1',
          fallbackIndex: 0,
        },
        {
          model: 'claude-3',
          provider: 'ollama-cloud',
          status: 500,
          errorBody: 'fail-2',
          fallbackIndex: 1,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      const rows = insertMock.mock.calls[0][0] as Array<{ provider: string | null }>;
      expect(rows[0].provider).toBe('openai');
      expect(rows[1].provider).toBe('ollama-cloud');
    });

    it('persists provider=null when the failure has no provider (line 164 falsy branch)', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: undefined as unknown as string,
          status: 500,
          errorBody: 'fail',
          fallbackIndex: 0,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      const rows = insertMock.mock.calls[0][0] as Array<{ provider: string | null }>;
      expect(rows[0].provider).toBeNull();
    });

    it('marks rate_limited status when the failure status is 429 (line 150 branch)', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 429,
          errorBody: 'rate limited',
          fallbackIndex: 0,
        },
      ];
      // markHandled=false is the default → the !useHandledStatus branch runs,
      // so `f.status === 429 ? 'rate_limited' : 'error'` is exercised.
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      const rows = insertMock.mock.calls[0][0] as Array<{ status: string; error_class: string }>;
      expect(rows[0].status).toBe('failed');
      expect(rows[0].error_class).toBe('rate_limit');
    });

    it('marks fallback_error status when markHandled=true and lastAsError=false', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 429,
          errorBody: 'rate limited',
          fallbackIndex: 0,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        markHandled: true,
      });
      const rows = insertMock.mock.calls[0][0] as Array<{ status: string; superseded: boolean }>;
      expect(rows[0].status).toBe('failed');
      expect(rows[0].superseded).toBe(true);
    });

    it('marks the LAST failure as error when lastAsError=true and markHandled=true', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 500,
          errorBody: 'fail-1',
          fallbackIndex: 0,
        },
        {
          model: 'claude-3',
          provider: 'anthropic',
          status: 429,
          errorBody: 'fail-2',
          fallbackIndex: 1,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        markHandled: true,
        lastAsError: true,
      });
      const rows = insertMock.mock.calls[0][0] as Array<{
        status: string;
        superseded: boolean;
        error_class: string;
      }>;
      // First failure uses fallback_error (handled) → superseded.
      expect(rows[0].status).toBe('failed');
      expect(rows[0].superseded).toBe(true);
      // Last failure with status 429 → rate-limit error class.
      expect(rows[1].status).toBe('failed');
      expect(rows[1].error_class).toBe('rate_limit');
    });

    it('uses baseTimeMs to stagger timestamps when provided', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 500,
          errorBody: 'fail',
          fallbackIndex: 0,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        baseTimeMs: Date.parse('2025-01-01T00:00:00.000Z'),
      });
      const rows = insertMock.mock.calls[0][0] as Array<{ timestamp: string }>;
      // baseTimeMs + (1 - 0) * 100 = 100ms past the base.
      expect(rows[0].timestamp).toBe('2025-01-01T00:00:00.100Z');
    });

    it('scrubs provider secrets from each persisted fallback error_message', async () => {
      const failures = [
        {
          model: 'gpt-4o',
          provider: 'openai',
          status: 401,
          errorBody: 'Authorization: Bearer sk-proj-LEAKEDKEY1234567890',
          fallbackIndex: 0,
        },
        {
          model: 'claude-3',
          provider: 'anthropic',
          status: 401,
          errorBody: 'x-api-key: sk-ant-api03-LEAKEDKEY0987654321',
          fallbackIndex: 1,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures);
      const rows = insertMock.mock.calls[0][0] as Array<{ error_message: string }>;
      const first: string = rows[0].error_message;
      const second: string = rows[1].error_message;
      expect(first).not.toContain('LEAKEDKEY1234567890');
      expect(first).toContain('[REDACTED]');
      expect(second).not.toContain('LEAKEDKEY0987654321');
      expect(second).toContain('[REDACTED]');
    });

    it('persists routing_reason on every failed-fallback row when passed via opts', async () => {
      const failures = [
        { model: 'm1', provider: 'openai', status: 500, errorBody: 'oops', fallbackIndex: 0 },
        { model: 'm2', provider: 'openai', status: 502, errorBody: 'oops', fallbackIndex: 1 },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary-model', failures, {
        reason: 'header-match',
      });
      const rows = insertMock.mock.calls[0][0] as Array<{ routing_reason: string }>;
      expect(rows[0].routing_reason).toBe('header-match');
      expect(rows[1].routing_reason).toBe('header-match');
    });
  });

  describe('recordPrimaryFailure', () => {
    it('records failure and emits SSE event', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
      );
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        model: 'gpt-4o',
        // A recovered primary is a superseded attempt, classified by its cause
        // (no HTTP status here ⇒ transport/network), not a terminal outcome.
        superseded: true,
        error_origin: 'transport',
        error_class: 'network',
        error_code: null,
      });
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('stamps error_code when the primary body is a Manifest credential failure', async () => {
      const body = JSON.stringify({
        error: {
          message:
            '[🦚 Manifest M102] openai subscription credentials could not be refreshed. Reconnect OAuth here: https://x/routing See https://manifest.build/llm-gateway/docs/errors/M102/',
        },
      });
      await recorder.recordPrimaryFailure(
        ctx,
        'default',
        'gpt-5.5',
        body,
        '2025-01-01T00:00:00.000Z',
        'subscription',
        { provider: 'openai', httpStatus: 401 },
      );
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        error_code: 'M102',
        error_http_status: 401,
        auth_type: 'subscription',
        provider: 'openai',
      });
      expect(insertMock.mock.calls[0][0].error_message).toContain('M102');
    });

    it('stamps the connection label on the failed primary row', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'default',
        'gpt-4o',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
        'api_key',
        { provider: 'openai', tenantProviderId: 'up-work', providerKeyLabel: 'Work' },
      );

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'failed',
        tenant_provider_id: 'up-work',
        provider_key_label: 'Work',
      });
    });

    it('leaves provider_key_label null when the primary failure carries no label', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'default',
        'gpt-4o',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
      );

      expect(insertMock.mock.calls[0][0]).toMatchObject({ provider_key_label: null });
    });

    it('persists the provider column when passed a provider', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gemma4:31b',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
        'api_key',
        { provider: 'ollama-cloud' },
      );
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        provider: 'ollama-cloud',
        auth_type: 'api_key',
      });
    });

    it('stores provider=null when no provider argument is given', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
      );
      expect(insertMock.mock.calls[0][0].provider).toBeNull();
    });

    it('does not persist an HTML error page when no HTTP status was captured', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        '<html><body>Tunnel failed</body></html>',
        '2025-01-01T00:00:00.000Z',
      );

      expect(insertMock.mock.calls[0][0].error_message).toBe(
        'Upstream endpoint returned an HTML error page',
      );
    });

    it('persists routing_reason when passed via opts', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
        undefined,
        { reason: 'header-match' },
      );
      expect(insertMock.mock.calls[0][0].routing_reason).toBe('header-match');
    });

    it('records the superseded patched retry when heal-then-fallback ran', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'Unknown parameter',
        '2025-01-01T00:00:00.000Z',
        'api_key',
        { provider: 'openai', autofix: sampleAutofix, httpStatus: 400 },
      );
      const row = insertMock.mock.calls[0][0];
      expect(row.status).toBe('failed');
      expect(row.superseded).toBe(true);
      expect(row.autofix_applied).toBe(true);
      expect(row.autofix_group_id).toBe('grp-1');
      expect(row.autofix_role).toBe('retry');
      expect(row.error_http_status).toBe(400);
      expect(row.autofix_operations).toEqual([
        { type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' },
      ]);
    });

    it('leaves autofix columns unset on a plain primary failure (no autofix)', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'upstream error',
        '2025-01-01T00:00:00.000Z',
      );
      const row = insertMock.mock.calls[0][0];
      expect(row.autofix_applied).toBeUndefined();
      expect(row.autofix_group_id).toBeUndefined();
    });
  });

  describe('recordSuccessMessage', () => {
    it('records success message and emits SSE event', async () => {
      await recorder.recordSuccessMessage(ctx, 'gpt-4o', 'standard', 'scored', {
        prompt_tokens: 100,
        completion_tokens: 50,
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('uses provider-reported cost for subscription success messages', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'stepfun/step-3.7-flash:free',
        'default',
        'default',
        {
          prompt_tokens: 16,
          completion_tokens: 1,
          reported_cost_usd: 0.00005,
        },
        { provider: 'nous', authType: 'subscription' },
      );

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        provider: 'nous',
        auth_type: 'subscription',
        input_tokens: 16,
        output_tokens: 1,
        cost_usd: 0.00005,
      });
    });

    it('computes Copilot subscription cost from the selected connection token prices', async () => {
      getProvidersMock.mockResolvedValue([
        {
          id: 'copilot-connection',
          provider: 'copilot',
          cached_models: [
            {
              id: 'copilot/gpt-5.6-terra',
              displayName: 'gpt-5.6-terra',
              inputPricePerToken: 1 / 1_000_000,
              outputPricePerToken: 5 / 1_000_000,
              cacheReadPricePerToken: 0.1 / 1_000_000,
            },
          ],
        },
      ]);

      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-5.6-terra',
        'default',
        'default',
        {
          prompt_tokens: 80_200,
          completion_tokens: 852,
          cache_read_tokens: 72_300,
          reported_cost_usd: 1,
        },
        {
          provider: 'copilot',
          authType: 'subscription',
          tenantProviderId: 'copilot-connection',
        },
      );

      expect(insertMock.mock.calls[0][0].cost_usd).toBeCloseTo(0.01939, 10);
      expect(getByModelMock).not.toHaveBeenCalled();
    });

    it('switches Copilot pricing only above the long-context prompt threshold', async () => {
      getProvidersMock.mockResolvedValue([
        {
          id: 'copilot-connection',
          provider: 'copilot',
          cached_models: [
            {
              id: 'copilot/gpt-5.6-terra',
              displayName: 'gpt-5.6-terra',
              inputPricePerToken: 1 / 1_000_000,
              outputPricePerToken: 5 / 1_000_000,
              cacheReadPricePerToken: 0.1 / 1_000_000,
              cacheWritePricePerToken: 1.25 / 1_000_000,
              longContextPricing: {
                thresholdTokens: 100_000,
                inputPricePerToken: 2 / 1_000_000,
                outputPricePerToken: 8 / 1_000_000,
                cacheReadPricePerToken: 0.2 / 1_000_000,
                cacheWritePricePerToken: 2.5 / 1_000_000,
              },
            },
          ],
        },
      ]);

      const options = {
        provider: 'copilot',
        authType: 'subscription' as const,
        tenantProviderId: 'copilot-connection',
      };

      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-5.6-terra',
        'default',
        'default',
        {
          prompt_tokens: 100_000,
          completion_tokens: 100,
          cache_read_tokens: 60_000,
          cache_creation_tokens: 10_000,
        },
        options,
      );
      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-5.6-terra',
        'default',
        'default',
        {
          prompt_tokens: 100_001,
          completion_tokens: 100,
          cache_read_tokens: 60_000,
          cache_creation_tokens: 10_000,
        },
        options,
      );

      expect(insertMock.mock.calls[0][0].cost_usd).toBeCloseTo(0.049, 10);
      expect(insertMock.mock.calls[1][0].cost_usd).toBeCloseTo(0.097802, 10);
    });

    it('uses billable long-context prices when Copilot default prices are zero', async () => {
      getProvidersMock.mockResolvedValue([
        {
          id: 'copilot-connection',
          provider: 'copilot',
          cached_models: [
            {
              id: 'copilot/gpt-5.6-terra',
              displayName: 'gpt-5.6-terra',
              inputPricePerToken: 0,
              outputPricePerToken: 0,
              longContextPricing: {
                thresholdTokens: 100,
                inputPricePerToken: 2 / 1_000_000,
                outputPricePerToken: 8 / 1_000_000,
              },
            },
          ],
        },
      ]);

      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-5.6-terra',
        'default',
        'default',
        { prompt_tokens: 101, completion_tokens: 10 },
        {
          provider: 'copilot',
          authType: 'subscription',
          tenantProviderId: 'copilot-connection',
        },
      );

      expect(insertMock.mock.calls[0][0].cost_usd).toBeCloseTo(0.000282, 10);
    });

    it('falls back to default Copilot prices when its long-context tier is invalid', async () => {
      getProvidersMock.mockResolvedValue([
        {
          id: 'copilot-connection',
          cached_models: [
            {
              id: 'copilot/gpt-5.6-terra',
              inputPricePerToken: 1 / 1_000_000,
              outputPricePerToken: 5 / 1_000_000,
              longContextPricing: {
                thresholdTokens: 100,
                inputPricePerToken: 0,
                outputPricePerToken: 0,
              },
            },
          ],
        },
      ]);

      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-5.6-terra',
        'default',
        'default',
        { prompt_tokens: 101, completion_tokens: 10 },
        {
          provider: 'copilot',
          authType: 'subscription',
          tenantProviderId: 'copilot-connection',
        },
      );

      expect(insertMock.mock.calls[0][0].cost_usd).toBeCloseTo(0.000151, 10);
    });

    it('keeps Copilot at zero when no selected connection id is available', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-5-mini',
        'default',
        'default',
        { prompt_tokens: 1000, completion_tokens: 100 },
        { provider: 'copilot', authType: 'subscription' },
      );

      expect(insertMock.mock.calls[0][0].cost_usd).toBe(0);
      expect(getProvidersMock).not.toHaveBeenCalled();
    });

    it('keeps Copilot at zero when its selected connection has no token pricing', async () => {
      getProvidersMock.mockResolvedValue([
        {
          id: 'copilot-connection',
          provider: 'copilot',
          cached_models: [
            {
              id: 'copilot/gpt-4o',
              inputPricePerToken: 0,
              outputPricePerToken: 0,
            },
          ],
        },
      ]);

      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'default', {
        provider: 'copilot',
        authType: 'subscription',
        tenantProviderId: 'copilot-connection',
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      });

      expect(insertMock.mock.calls[0][0].cost_usd).toBe(0);
    });

    it('keeps Copilot recording available when cached provider lookup fails', async () => {
      getProvidersMock.mockRejectedValue(new Error('database unavailable'));

      await recorder.recordSuccessMessage(
        ctx,
        'copilot/gpt-4o',
        'default',
        'default',
        { prompt_tokens: 1000, completion_tokens: 100 },
        {
          provider: 'copilot',
          authType: 'subscription',
          tenantProviderId: 'copilot-connection',
        },
      );

      expect(insertMock.mock.calls[0][0].cost_usd).toBe(0);
    });

    it('records message even when tokens are zero', async () => {
      await recorder.recordSuccessMessage(ctx, 'gpt-4o', 'standard', 'scored', {
        prompt_tokens: 0,
        completion_tokens: 0,
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        input_tokens: 0,
        output_tokens: 0,
        status: 'success',
      });
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('produces N separate inserts for N successive calls with identical usage, model and agent', async () => {
      // The regression pinned by mnfst/llm-gateway#2513: ProxyMessageDedup used to
      // treat "same tenant/agent/model/usage within a short window" as a
      // duplicate and silently drop it via an update-into-existing-row path.
      // Distinct requests that happen to look alike must each persist their
      // own row.
      const usage = { prompt_tokens: 100, completion_tokens: 50 };
      const callCount = 12;
      for (let i = 0; i < callCount; i++) {
        await recorder.recordSuccessMessage(ctx, 'gpt-4o', 'standard', 'scored', usage);
      }

      expect(insertMock).toHaveBeenCalledTimes(callCount);
      expect(updateMock).not.toHaveBeenCalled();
      const ids = insertMock.mock.calls.map((call) => (call[0] as { id?: string }).id);
      expect(new Set(ids).size).toBe(callCount);
    });

    it('collapses the "default" placeholder session key to null on the persisted row', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 50, completion_tokens: 25 },
        { sessionKey: 'default' },
      );
      expect(insertMock.mock.calls[0][0].session_key).toBeNull();
    });

    it('persists a real session_key on the inserted row', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 50, completion_tokens: 25 },
        { sessionKey: 'session-abc' },
      );
      expect(insertMock.mock.calls[0][0].session_key).toBe('session-abc');
      expect(emitMock).toHaveBeenCalledWith('tenant-1', 'message', 'user-1');
    });

    it('persists the provider column on insert path', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'gemma4:31b',
        'standard',
        'scored',
        { prompt_tokens: 100, completion_tokens: 50 },
        { provider: 'ollama-cloud' },
      );
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0].provider).toBe('ollama-cloud');
    });

    it('updates the pending attempt row instead of inserting when the attempt has a pending write', async () => {
      const attempt: ProviderAttemptRef = {
        id: 'attempt-success-update-payload',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_200,
        pendingWrite: Promise.resolve(true),
      };

      await recorder.recordSuccessMessage(
        ctx,
        'gemma4:31b',
        'standard',
        'scored',
        { prompt_tokens: 50, completion_tokens: 25 },
        { provider: 'ollama-cloud', sessionKey: 'session-xyz', attempt },
      );

      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(updateMock.mock.calls[0][0]).toEqual({ id: 'attempt-success-update-payload' });
      expect(updateMock.mock.calls[0][1]).toMatchObject({
        provider: 'ollama-cloud',
        session_key: 'session-xyz',
        duration_ms: 200,
        status: 'success',
      });
    });

    it('includes durationMs in the inserted row when provided (no in-flight attempt)', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 50, completion_tokens: 25 },
        { durationMs: 1500 },
      );

      expect(insertMock.mock.calls[0][0]).toMatchObject({
        duration_ms: 1500,
      });
    });

    it('keeps status=ok and no error axes for every reason — Manifest stubs never reach here', async () => {
      await recorder.recordSuccessMessage(ctx, 'gpt-4o', 'standard', 'scored', {
        prompt_tokens: 1,
        completion_tokens: 1,
      });
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'success',
        error_message: null,
        routing_reason: 'scored',
        error_origin: null,
        error_class: null,
        superseded: false,
      });
    });

    // The canned-stub detour through recordSuccessMessage is gone: a Manifest
    // failure is written by recordManifestBlockedRequest, never by the success
    // path flipping its own status to 'error'. A reason like `no_provider` that
    // somehow arrives here is a routing reason, not a failure signal.
    it('does not resurrect the canned-response branch for a Manifest reason', async () => {
      await recorder.recordSuccessMessage(ctx, 'gpt-4o', 'simple', 'no_provider', {
        prompt_tokens: 0,
        completion_tokens: 0,
      });
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        status: 'success',
        error_message: null,
        error_origin: null,
      });
    });
  });

  describe('request_headers persistence', () => {
    it('recordProviderError persists request_headers', async () => {
      await recorder.recordProviderError(ctx, 500, 'boom', {
        requestHeaders: { 'x-custom': 'yes' },
      });
      expect(insertMock.mock.calls[0][0].request_headers).toEqual({ 'x-custom': 'yes' });
    });

    it('recordProviderError defaults request_headers to null when opts omit them', async () => {
      await recorder.recordProviderError(ctx, 500, 'boom');
      expect(insertMock.mock.calls[0][0].request_headers).toBeNull();
    });

    it('recordFailedFallbacks persists request_headers on each row', async () => {
      const failures = [
        { model: 'gpt-4o', provider: 'openai', status: 500, errorBody: 'fail', fallbackIndex: 0 },
        {
          model: 'claude-3',
          provider: 'anthropic',
          status: 500,
          errorBody: 'fail',
          fallbackIndex: 1,
        },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'primary', failures, {
        requestHeaders: { 'x-a': '1' },
      });
      const rows = insertMock.mock.calls[0][0] as Array<{ request_headers: unknown }>;
      expect(rows[0].request_headers).toEqual({ 'x-a': '1' });
      expect(rows[1].request_headers).toEqual({ 'x-a': '1' });
    });

    it('recordPrimaryFailure persists request_headers', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'boom',
        '2025-01-01T00:00:00.000Z',
        'api_key',
        { requestHeaders: { 'x-b': '2' } },
      );
      expect(insertMock.mock.calls[0][0].request_headers).toEqual({ 'x-b': '2' });
    });

    it('recordFallbackSuccess persists request_headers', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        requestHeaders: { 'x-c': '3' },
      });
      expect(insertMock.mock.calls[0][0].request_headers).toEqual({ 'x-c': '3' });
    });

    it('recordSuccessMessage persists request_headers on insert and update paths', async () => {
      // Insert path — no in-flight attempt.
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 1, completion_tokens: 1 },
        { requestHeaders: { 'x-d': '4' } },
      );
      expect(insertMock.mock.calls.at(-1)![0].request_headers).toEqual({ 'x-d': '4' });

      // Update path — a pending Attempt whose write already landed.
      const attempt: ProviderAttemptRef = {
        id: 'attempt-headers-update',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_050,
        pendingWrite: Promise.resolve(true),
      };
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 5, completion_tokens: 5 },
        { requestHeaders: { 'x-e': '5' }, attempt },
      );
      expect(updateMock.mock.calls[0][1].request_headers).toEqual({ 'x-e': '5' });
    });
  });

  describe('autofix persistence', () => {
    const operations = [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }];
    const failedRetryAutofix: AutofixRecord = {
      ...sampleAutofix,
      outcome: 'exhausted',
      chain: [
        sampleAutofix.chain[0],
        {
          attempt: 1,
          origin: 'autofix',
          request: { max_output_tokens: 5 },
          http_status: 400,
          error: { message: 'Retry also failed' },
        },
      ],
    };

    it('recordProviderError records a failed patched request as the retry', async () => {
      await recorder.recordProviderError(ctx, 400, 'Retry also failed', {
        autofix: failedRetryAutofix,
      });
      const row = insertMock.mock.calls.at(-1)![0];
      expect(row.autofix_applied).toBe(true);
      expect(row.autofix_group_id).toBe('grp-1');
      expect(row.autofix_role).toBe('retry');
      expect(row.autofix_operations).toEqual(operations);
    });

    it('recordProviderError keeps a no-patch Phoenix audit without claiming Autofix', async () => {
      const noPatch: AutofixRecord = {
        groupId: 'grp-no-patch',
        outcome: 'unfixable',
        original_http_status: 400,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: {},
            http_status: 400,
            error: { message: 'Unknown parameter' },
            phoenix_status: 'no_patch',
            issue_id: 'issue-no-patch',
            patch_id: null,
            heal_attempt_id: null,
          },
        ],
      };

      await recorder.recordProviderError(ctx, 400, 'Unknown parameter', { autofix: noPatch });

      const row = insertMock.mock.calls.at(-1)![0];
      expect(row.autofix_applied).toBeUndefined();
      expect(row.autofix_group_id).toBeUndefined();
      expect(row.autofix_role).toBeUndefined();
      expect(row.autofix_decision).toEqual({
        status: 'no_patch',
        issueId: 'issue-no-patch',
        patchId: null,
        healAttemptId: null,
        explanation: null,
      });
    });

    it('recordPrimaryFailure keeps a failed retry identity through fallback', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'Retry also failed',
        '2026-07-15T12:00:00.000Z',
        'api_key',
        { autofix: failedRetryAutofix, httpStatus: 400 },
      );

      const row = insertMock.mock.calls.at(-1)![0];
      expect(row.status).toBe('failed');
      expect(row.superseded).toBe(true);
      expect(row.error_http_status).toBe(400);
      expect(row.autofix_applied).toBe(true);
      expect(row.autofix_role).toBe('retry');
      expect(row.autofix_group_id).toBe('grp-1');
    });

    it('recordProviderError leaves autofix columns unset when omitted', async () => {
      await recorder.recordProviderError(ctx, 400, 'boom');
      const row = insertMock.mock.calls.at(-1)![0];
      expect(row.autofix_applied).toBeUndefined();
      expect(row.autofix_group_id).toBeUndefined();
    });

    it('recordAutofixOriginal writes a linked auto_fixed original row', async () => {
      await recorder.recordAutofixOriginal(ctx, 'gpt-4o', 'default', sampleAutofix, {
        provider: 'openai',
        reason: 'default',
        authType: 'api_key',
        traceId: 'trace-af',
      });
      const row = insertMock.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(row.status).toBe('failed');
      expect(row.superseded).toBe(true);
      expect(row.error_http_status).toBe(400);
      // The full provider envelope, like every other error row. Storing the bare message
      // would drop type/param/code — the dimensions that identify the error downstream.
      expect(JSON.parse(row.error_message as string)).toEqual({
        error: {
          message: 'Unknown parameter',
          type: 'invalid_request_error',
          param: 'max_tokens',
          code: 'unknown_parameter',
        },
      });
      expect(row.autofix_applied).toBe(true);
      expect(row.autofix_group_id).toBe('grp-1');
      expect(row.autofix_role).toBe('original');
      expect(row.autofix_operations).toEqual(operations);
      // Persist Phoenix's own identifiers for the heal decision. sampleAutofix's
      // failed entry carries only heal_attempt_id, so issueId/patchId fall to
      // null while healAttemptId is preserved (covers the non-null branch).
      expect(row.autofix_decision).toEqual({
        status: null,
        issueId: null,
        patchId: null,
        healAttemptId: 'heal-1',
        explanation: null,
      });
    });

    it('recordAutofixOriginal falls each absent Phoenix id to null while keeping the present one', async () => {
      // The ternary is entered via patch_id alone, so issueId + healAttemptId
      // exercise the `?? null` fallback (covers the null side of each field).
      await recorder.recordAutofixOriginal(ctx, 'gpt-4o', 'default', {
        ...sampleAutofix,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: { max_tokens: 5 },
            http_status: 400,
            error: { message: 'Unknown parameter' },
            patch_id: 'patch-xyz',
          },
          { attempt: 1, origin: 'autofix', request: { max_output_tokens: 5 }, http_status: 200 },
        ],
      });
      const row = insertMock.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(row.autofix_decision).toEqual({
        status: null,
        issueId: null,
        patchId: 'patch-xyz',
        healAttemptId: null,
        explanation: null,
      });
    });

    it('recordAutofixOriginal carries the Phoenix explanation onto autofix_decision', async () => {
      // Phoenix's human-readable "why" is persisted alongside the ids so the
      // dashboard Autofix card can render it (not re-derive it locally).
      const explanation = {
        summary: 'Renamed the "max_tokens" parameter to "max_output_tokens".',
        operations: [
          {
            type: 'rename_param',
            detail: 'Renamed the "max_tokens" parameter to "max_output_tokens".',
          },
        ],
        source: 'deterministic' as const,
      };
      await recorder.recordAutofixOriginal(ctx, 'gpt-4o', 'default', {
        ...sampleAutofix,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: { max_tokens: 5 },
            http_status: 400,
            error: { message: 'Unknown parameter' },
            issue_id: 'issue-9',
            heal_attempt_id: 'heal-9',
            explanation,
          },
          { attempt: 1, origin: 'autofix', request: { max_output_tokens: 5 }, http_status: 200 },
        ],
      });
      const row = insertMock.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(row.autofix_decision).toEqual({
        status: null,
        issueId: 'issue-9',
        patchId: null,
        healAttemptId: 'heal-9',
        explanation,
      });
    });

    it('recordAutofixOriginal sets autofix_decision to null when the failed entry has no Phoenix ids', async () => {
      // A failed chain entry with none of issue_id/patch_id/heal_attempt_id must
      // leave autofix_decision null (covers the `: null` branch of the ternary).
      await recorder.recordAutofixOriginal(ctx, 'gpt-4o', 'default', {
        ...sampleAutofix,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: { max_tokens: 5 },
            http_status: 400,
            error: { message: 'Unknown parameter' },
          },
          { attempt: 1, origin: 'autofix', request: { max_output_tokens: 5 }, http_status: 200 },
        ],
      });
      const row = insertMock.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(row.autofix_decision).toBeNull();
    });

    it('recordAutofixOriginal is a no-op when the chain has no failed original', async () => {
      await recorder.recordAutofixOriginal(ctx, 'gpt-4o', 'default', {
        ...sampleAutofix,
        chain: [{ attempt: 1, origin: 'autofix', request: {}, http_status: 200 }],
      });
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('recordAutofixOriginal is a no-op when Phoenix supplied no patch', async () => {
      await recorder.recordAutofixOriginal(ctx, 'gpt-4o', 'default', {
        ...sampleAutofix,
        outcome: 'unfixable',
        chain: [sampleAutofix.chain[0]],
      });
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('recordSuccessMessage persists the autofix audit on insert and update paths', async () => {
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 1, completion_tokens: 1 },
        { autofix: sampleAutofix },
      );
      const inserted = insertMock.mock.calls.at(-1)![0];
      expect(inserted.autofix_applied).toBe(true);
      expect(inserted.autofix_role).toBe('retry');
      expect(inserted.autofix_group_id).toBe('grp-1');

      const attempt: ProviderAttemptRef = {
        id: 'attempt-autofix-update',
        attemptNumber: 1,
        startedAtMs: 1_000,
        startedAt: '1970-01-01T00:00:01.000Z',
        completedAtMs: 1_050,
        pendingWrite: Promise.resolve(true),
      };
      await recorder.recordSuccessMessage(
        ctx,
        'gpt-4o',
        'standard',
        'scored',
        { prompt_tokens: 5, completion_tokens: 5 },
        { autofix: sampleAutofix, attempt },
      );
      expect(updateMock.mock.calls[0][1].autofix_applied).toBe(true);
      expect(updateMock.mock.calls[0][1].autofix_role).toBe('retry');
    });
  });

  describe('cooldown overflow eviction', () => {
    it('evicts expired entries when cooldown map exceeds MAX_COOLDOWN_ENTRIES', async () => {
      // Fill the cooldown map to capacity by recording 429 errors for unique agents
      const maxEntries = 1_000;
      for (let i = 0; i < maxEntries; i++) {
        const agentCtx: IngestionContext = {
          tenantId: `t-${i}`,
          agentId: `a-${i}`,
          agentName: 'test',
          userId: 'user-1',
        };
        await recorder.recordProviderError(agentCtx, 429, 'rate limited');
      }
      expect(insertMock).toHaveBeenCalledTimes(maxEntries);
      insertMock.mockClear();

      // Force all existing entries to be expired by advancing time
      const realDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(realDateNow() + 120_000);

      try {
        // This 429 for a new agent pushes size above MAX_COOLDOWN_ENTRIES,
        // triggering the overflow eviction branch
        const overflowCtx: IngestionContext = {
          tenantId: 't-overflow',
          agentId: 'a-overflow',
          agentName: 'test',
          userId: 'user-1',
        };
        await recorder.recordProviderError(overflowCtx, 429, 'rate limited');
        expect(insertMock).toHaveBeenCalledTimes(1);
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  describe('evictExpiredCooldowns', () => {
    it('removes expired entries from the cooldown map', async () => {
      // Record a 429 to add an entry to the cooldown map
      await recorder.recordProviderError(ctx, 429, 'rate limited');
      insertMock.mockClear();
      emitMock.mockClear();

      // Advance time past the cooldown window and invoke the private method
      const realDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(realDateNow() + 120_000);

      try {
        (recorder as unknown as { evictExpiredCooldowns: () => void }).evictExpiredCooldowns();

        // The cooldown entry should have been evicted, so a new 429 should insert
        await recorder.recordProviderError(ctx, 429, 'rate limited again');
        expect(insertMock).toHaveBeenCalledTimes(1);
      } finally {
        Date.now = realDateNow;
      }
    });

    it('keeps non-expired entries in the cooldown map', async () => {
      await recorder.recordProviderError(ctx, 429, 'rate limited');
      insertMock.mockClear();
      emitMock.mockClear();

      // Advance time but stay within the cooldown window
      const realDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(realDateNow() + 30_000);

      try {
        (recorder as unknown as { evictExpiredCooldowns: () => void }).evictExpiredCooldowns();

        // The cooldown entry should still be present, so a new 429 should be skipped
        await recorder.recordProviderError(ctx, 429, 'rate limited again');
        expect(insertMock).not.toHaveBeenCalled();
        expect(emitMock).not.toHaveBeenCalled();
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  describe('request_params persistence', () => {
    const params = { thinking: { type: 'disabled' as const } };

    it('recordProviderError persists requestParams when supplied', async () => {
      await recorder.recordProviderError(ctx, 500, 'oops', { requestParams: params });
      expect(insertMock.mock.calls[0][0]).toMatchObject({ request_params: params });
    });

    it('recordProviderError leaves request_params null when omitted (back-compat)', async () => {
      await recorder.recordProviderError(ctx, 500, 'oops');
      expect(insertMock.mock.calls[0][0]).toMatchObject({ request_params: null });
    });

    it('recordPrimaryFailure persists requestParams when supplied', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'err',
        new Date().toISOString(),
        'api_key',
        { requestParams: params },
      );
      expect(insertMock.mock.calls[0][0]).toMatchObject({ request_params: params });
    });

    it('recordPrimaryFailure leaves request_params null when omitted (back-compat)', async () => {
      await recorder.recordPrimaryFailure(
        ctx,
        'standard',
        'gpt-4o',
        'err',
        new Date().toISOString(),
        'api_key',
      );
      expect(insertMock.mock.calls[0][0]).toMatchObject({ request_params: null });
    });

    it('recordFailedFallbacks persists requestParams on every row in the batch', async () => {
      const failures = [
        { model: 'a', provider: 'p', fallbackIndex: 0, status: 500, errorBody: 'e1' },
        { model: 'b', provider: 'p', fallbackIndex: 1, status: 502, errorBody: 'e2' },
      ];
      await recorder.recordFailedFallbacks(ctx, 'standard', 'gpt-4o', failures, {
        requestParams: params,
      });
      const rows = insertMock.mock.calls[0][0] as Array<{ request_params: unknown }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].request_params).toEqual(params);
      expect(rows[1].request_params).toEqual(params);
    });

    it('recordFallbackSuccess persists requestParams when supplied', async () => {
      await recorder.recordFallbackSuccess(ctx, 'gpt-4o', 'standard', {
        fallbackFromModel: 'claude-opus',
        fallbackIndex: 0,
        requestParams: params,
      });
      expect(insertMock.mock.calls[0][0]).toMatchObject({ request_params: params });
    });

    it('arbitrary param shapes round-trip — forward-compat for future provider knobs and user-defined custom params', async () => {
      const future = {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        custom_safety: { mode: 'permissive', threshold: 0.8 },
      } as never;
      await recorder.recordProviderError(ctx, 500, 'oops', { requestParams: future });
      expect(insertMock.mock.calls[0][0]).toMatchObject({ request_params: future });
    });
  });
});

describe('ProxyMessageRecorder with real CustomProviderService', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CustomProviderService } = require('../../custom-provider/custom-provider.service');

  function wire(customProviderRow: { id: string; name: string; agent_id: string }) {
    const insertMock = jest.fn();
    const messageRepo = { insert: insertMock } as never;
    const pricingCache = {
      getByModel: jest.fn().mockReturnValue(undefined),
      reload: jest.fn(),
    } as never;
    const eventBus = { emit: jest.fn() } as never;

    const customProviderRepo = {
      find: jest.fn().mockResolvedValue([customProviderRow]),
    } as never;
    const providerService = {
      upsertProvider: jest.fn(),
      removeProvider: jest.fn(),
    } as never;
    const routingCache = {
      getCustomProviders: jest.fn().mockReturnValue(null),
      setCustomProviders: jest.fn(),
      invalidateAgent: jest.fn(),
    } as never;

    const customProviders = new CustomProviderService(
      customProviderRepo,
      providerService,
      routingCache,
      pricingCache,
      eventBus,
    );

    const mockOpencodeGoCatalog = {
      getCostPerRequest: jest.fn().mockReturnValue(null),
      resolveCostPerRequest: jest.fn().mockResolvedValue(null),
    } as never;
    const recorder = new ProxyMessageRecorder(
      messageRepo,
      pricingCache,
      eventBus,
      customProviders,
      mockOpencodeGoCatalog,
    );
    return { recorder, insertMock };
  }

  it('rewrites a llama.cpp row end-to-end: provider + model land canonical in the DB', async () => {
    const { recorder, insertMock } = wire({
      id: 'cp-llamacpp',
      name: 'llama.cpp',
      agent_id: 'agent-1',
    });
    try {
      await recorder.recordProviderError(ctx, 500, 'upstream error', {
        provider: 'custom:cp-llamacpp',
        model: 'custom:cp-llamacpp/qwen2.5-0.5b-q4.gguf',
        tier: 'default',
      });

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        provider: 'llamacpp',
        model: 'llamacpp/qwen2.5-0.5b-q4.gguf',
      });
    } finally {
      recorder.onModuleDestroy();
    }
  });

  it('costs a tile-connected llama.cpp run at a known zero, not an unknown null', async () => {
    // llama.cpp and LM Studio are `tileOnly`, so they reach the recorder as
    // `custom:<uuid>` and only become `llamacpp` after canonicalization. A
    // local-provider check run on the raw string misses them entirely and the
    // row falls through to `null` — "we don't know" for inference that is
    // free by construction.
    const { recorder, insertMock } = wire({
      id: 'cp-llamacpp',
      name: 'llama.cpp',
      agent_id: 'agent-1',
    });
    try {
      await recorder.recordSuccessMessage(
        ctx,
        'custom:cp-llamacpp/qwen2.5-0.5b-q4.gguf',
        'default',
        'test',
        { prompt_tokens: 1000, completion_tokens: 500 } as never,
        { provider: 'custom:cp-llamacpp' },
      );

      expect(insertMock).toHaveBeenCalled();
      expect(insertMock.mock.calls[0][0]).toMatchObject({ cost_usd: 0 });
    } finally {
      recorder.onModuleDestroy();
    }
  });

  it('leaves a user-defined custom provider unchanged (no tileOnly match)', async () => {
    const { recorder, insertMock } = wire({
      id: 'cp-my-groq',
      name: 'My Groq',
      agent_id: 'agent-1',
    });
    try {
      await recorder.recordProviderError(ctx, 500, 'upstream error', {
        provider: 'custom:cp-my-groq',
        model: 'custom:cp-my-groq/llama-3.1-70b',
        tier: 'default',
      });

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0]).toMatchObject({
        provider: 'custom:cp-my-groq',
        model: 'custom:cp-my-groq/llama-3.1-70b',
      });
    } finally {
      recorder.onModuleDestroy();
    }
  });
});

describe('ProxyMessageRecorder OpenCode Go subscription cost', () => {
  let recorder: ProxyMessageRecorder;
  let insertMock: jest.Mock;
  let getCostPerRequestMock: jest.Mock;

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
    getCostPerRequestMock = jest.fn().mockResolvedValue(0.01364);
    const opencodeGoCatalog = {
      getCostPerRequest: jest.fn().mockReturnValue(0.01364),
      resolveCostPerRequest: getCostPerRequestMock,
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

  it('records the catalog per-request cost for an opencode-go subscription success', async () => {
    await recorder.recordSuccessMessage(
      ctx,
      'glm-5.1',
      'standard',
      'scored',
      { prompt_tokens: 700, completion_tokens: 150 },
      { provider: 'opencode-go', authType: 'subscription' },
    );

    expect(getCostPerRequestMock).toHaveBeenCalledWith('glm-5.1');
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      model: 'glm-5.1',
      provider: 'opencode-go',
      auth_type: 'subscription',
      cost_usd: 0.01364,
    });
  });

  it('records the catalog per-request cost for an opencode-go subscription fallback success', async () => {
    await recorder.recordFallbackSuccess(ctx, 'glm-5.1', 'standard', {
      provider: 'opencode-go',
      authType: 'subscription',
      fallbackFromModel: 'kimi-k2.5',
      fallbackIndex: 0,
      usage: { prompt_tokens: 700, completion_tokens: 150 },
    });

    expect(getCostPerRequestMock).toHaveBeenCalledWith('glm-5.1');
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      model: 'glm-5.1',
      provider: 'opencode-go',
      auth_type: 'subscription',
      cost_usd: 0.01364,
      fallback_from_model: 'kimi-k2.5',
    });
  });

  it('falls back to $0 when the catalog has no cost for the model (cold-start safety)', async () => {
    getCostPerRequestMock.mockResolvedValueOnce(null);
    await recorder.recordSuccessMessage(
      ctx,
      'glm-5.1',
      'standard',
      'scored',
      { prompt_tokens: 100, completion_tokens: 50 },
      { provider: 'opencode-go', authType: 'subscription' },
    );

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      cost_usd: 0,
      auth_type: 'subscription',
    });
  });

  it('does not consult the catalog for non-subscription opencode-go calls', async () => {
    await recorder.recordSuccessMessage(
      ctx,
      'glm-5.1',
      'standard',
      'scored',
      { prompt_tokens: 100, completion_tokens: 50 },
      { provider: 'opencode-go', authType: 'api_key' },
    );

    expect(getCostPerRequestMock).not.toHaveBeenCalled();
  });

  it('records the catalog cost when the provider is stored under an alias (e.g. "opencodego")', async () => {
    await recorder.recordSuccessMessage(
      ctx,
      'glm-5.1',
      'standard',
      'scored',
      { prompt_tokens: 700, completion_tokens: 150 },
      { provider: 'opencodego', authType: 'subscription' },
    );

    expect(getCostPerRequestMock).toHaveBeenCalledWith('glm-5.1');
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      cost_usd: 0.01364,
      auth_type: 'subscription',
    });
  });

  it('records $0 when provider is null and authType is subscription (defensive)', async () => {
    await recorder.recordSuccessMessage(
      ctx,
      'glm-5.1',
      'standard',
      'scored',
      { prompt_tokens: 100, completion_tokens: 50 },
      { provider: undefined, authType: 'subscription' },
    );

    expect(getCostPerRequestMock).not.toHaveBeenCalled();
    expect(insertMock.mock.calls[0][0]).toMatchObject({ cost_usd: 0 });
  });

  it('does not consult the catalog for other providers on subscription auth', async () => {
    await recorder.recordSuccessMessage(
      ctx,
      'claude-opus-4',
      'reasoning',
      'scored',
      { prompt_tokens: 100, completion_tokens: 50 },
      { provider: 'anthropic', authType: 'subscription' },
    );

    expect(getCostPerRequestMock).not.toHaveBeenCalled();
    // Flat-fee subscription path: cost stays 0, not derived from token math.
    expect(insertMock.mock.calls[0][0]).toMatchObject({ cost_usd: 0 });
  });
});
