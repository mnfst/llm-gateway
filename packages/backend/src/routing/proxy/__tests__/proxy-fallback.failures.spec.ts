import { Repository } from 'typeorm';
import type { ModelRoute } from 'manifest-shared';
import { ProxyFallbackService } from '../proxy-fallback.service';
import { ReasoningContentCache } from '../reasoning-content-cache';
import { ProviderKeyService } from '../../routing-core/provider-key.service';
import { CustomProvider } from '../../../entities/custom-provider.entity';
import { OpenaiOauthService } from '../../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../../oauth/xai/xai-oauth.service';
import { ProviderClient } from '../provider-client';
import { CopilotTokenService } from '../copilot-token.service';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { AgentModelParamsService } from '../../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../../routing-core/provider-param-spec.service';
import { AutofixService } from '../../autofix/autofix.service';
import type { StartProviderAttempt } from '../proxy-types';

/**
 * Status-code-driven fallback chain behavior for tryFallbacks().
 *
 * `shouldTriggerFallback(status)` returns true for status-only errors >= 400,
 * so upstream 401 auth, 404 not-found, 429 rate limit, and 5xx keep the loop
 * going to the next route. Context overflow follows the same route policy so
 * a later fallback with a larger context window can recover.
 */

describe('ProxyFallbackService.tryFallbacks — failure chain by status code', () => {
  let service: ProxyFallbackService;
  let providerKeyService: jest.Mocked<ProviderKeyService>;
  let providerClient: jest.Mocked<ProviderClient>;

  const body = { messages: [{ role: 'user', content: 'Hello' }], stream: false };

  // Helper: build a structured ModelRoute. Keeps call-sites readable since
  // tryFallbacks takes the route array at positional arg 16.
  const route = (
    provider: string,
    model: string,
    authType: 'api_key' | 'subscription' = 'api_key',
  ): ModelRoute => ({ provider, authType, model });

  // Helper: invoke tryFallbacks with the 16-arg signature. Trailing args we
  // don't care about are passed as undefined.
  const runFallbacks = (
    models: string[],
    routes: ModelRoute[] | null,
    primaryModel = 'gpt-4o',
    apiMode?: 'chat_completions' | 'responses' | 'messages',
  ) =>
    service.tryFallbacks(
      'agent-1',
      'user-1',
      models,
      body,
      false,
      'sess-1',
      primaryModel,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      apiMode,
      undefined,
      routes,
    );

  beforeEach(() => {
    providerKeyService = {
      getProviderApiKey: jest.fn().mockResolvedValue('sk-test'),
      getProviderKeyId: jest.fn().mockResolvedValue('up-fallback'),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      findProviderForModel: jest.fn().mockResolvedValue(undefined),
      getProviderRegion: jest.fn().mockResolvedValue(null),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      // Single key selection per attempt — composed from the legacy mocks so
      // existing setups driving getProviderApiKey/getProviderKeyId/getProviderRegion
      // keep working; apiKey, id, and region all come from this one row.
      selectProviderKey: jest.fn(
        async (
          userId: string,
          provider: string,
          authType?: string,
          label?: string,
          agentId?: string,
        ) => {
          const apiKey = await providerKeyService.getProviderApiKey(
            userId,
            provider,
            authType as never,
            label,
            agentId,
          );
          if (apiKey === null || apiKey === undefined) return null;
          const id = await providerKeyService.getProviderKeyId(
            userId,
            provider,
            authType as never,
            label,
            agentId,
          );
          const region = await providerKeyService.getProviderRegion(
            userId,
            provider,
            authType as never,
            label,
            agentId,
          );
          return { apiKey, id, region, label: label ?? 'Default', priority: 0 };
        },
      ),
    } as unknown as jest.Mocked<ProviderKeyService>;

    providerClient = {
      forward: jest.fn(),
    } as unknown as jest.Mocked<ProviderClient>;

    const customProviderRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<CustomProvider>>;

    const oauthStub = { unwrapToken: jest.fn().mockResolvedValue(null) };

    service = new ProxyFallbackService(
      providerKeyService,
      customProviderRepo,
      oauthStub as unknown as OpenaiOauthService,
      oauthStub as unknown as MinimaxOauthService,
      oauthStub as unknown as AnthropicOauthService,
      oauthStub as unknown as GeminiOauthService,
      oauthStub as unknown as KiroOauthService,
      oauthStub as unknown as XaiOauthService,
      providerClient,
      {
        getCopilotToken: jest.fn().mockResolvedValue('tid=copilot-session'),
      } as unknown as CopilotTokenService,
      {
        getByModel: jest.fn().mockReturnValue(null),
      } as unknown as ModelPricingCacheService,
      {
        get: jest.fn().mockResolvedValue(null),
        list: jest.fn().mockResolvedValue([]),
      } as unknown as AgentModelParamsService,
      {
        getSpecs: jest.fn().mockResolvedValue([]),
        list: jest.fn().mockResolvedValue([]),
      } as unknown as ProviderParamSpecService,
      new ReasoningContentCache(),
      {
        isRepairable: jest.fn().mockReturnValue(false),
        maybeHeal: jest.fn(),
      } as unknown as AutofixService,
    );
  });

  it('tries all three routes when first returns 429, second returns 429, third returns 200', async () => {
    // Rate-limit → rate-limit → success is the canonical "retry across
    // providers when the cheap one is throttled" path. All three must run
    // and the third's success is what tryFallbacks returns.
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response('rate limit', { status: 429 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('rate limit', { status: 429 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{}', { status: 200 }),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      });

    const routes: ModelRoute[] = [
      route('openai', 'gpt-4o-mini'),
      route('anthropic', 'claude-haiku-3.5'),
      route('gemini', 'gemini-2.5-flash'),
    ];
    const result = await runFallbacks(
      ['gpt-4o-mini', 'claude-haiku-3.5', 'gemini-2.5-flash'],
      routes,
    );

    expect(providerClient.forward).toHaveBeenCalledTimes(3);
    expect(result.success).not.toBeNull();
    expect(result.success!.fallbackIndex).toBe(2);
    expect(result.success!.provider).toBe('gemini');
    expect(result.success!.model).toBe('gemini-2.5-flash');
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((f) => f.status)).toEqual([429, 429]);
    expect(result.failures.map((f) => f.provider)).toEqual(['openai', 'anthropic']);
  });

  it('advances after a fallback returns HTTP 200 with an empty completion', async () => {
    const realClient = new ProviderClient();
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      const hostname = new URL(url).hostname;
      if (hostname === 'api.openai.com') {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-empty',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: null },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (hostname !== 'api.deepseek.com') {
        throw new Error(`Unexpected fallback hostname: ${hostname}`);
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-success',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Recovered' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    global.fetch = fetchMock as typeof fetch;
    providerClient.forward.mockImplementation((options) => realClient.forward(options));

    try {
      const routes: ModelRoute[] = [
        route('openai', 'gpt-4o-mini'),
        route('deepseek', 'deepseek-chat'),
      ];
      const result = await runFallbacks(
        ['gpt-4o-mini', 'deepseek-chat'],
        routes,
        'primary-model',
        'chat_completions',
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.success).toMatchObject({
        fallbackIndex: 1,
        provider: 'deepseek',
        model: 'deepseek-chat',
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        fallbackIndex: 0,
        provider: 'openai',
        status: 502,
      });
      expect(JSON.parse(result.failures[0].errorBody)).toMatchObject({
        error: { code: 'empty_response' },
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('cooldowns repeated 429 attempts for the same provider key and model', async () => {
    providerClient.forward.mockResolvedValueOnce({
      response: new Response('rate limit', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
      isGoogle: false,
      isAnthropic: true,
      isChatGpt: false,
    });

    const opts = {
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-sonnet-4-6',
      body,
      stream: false,
      sessionKey: 'sess-1',
      agentId: 'agent-1',
      providerKeyLabel: 'Claude Code',
      authType: 'subscription',
    };

    const first = await service.tryForwardToProvider(opts);
    const second = await service.tryForwardToProvider(opts);

    expect(first.response.status).toBe(429);
    expect(first.providerCallStarted).toBe(true);
    expect(second.response.status).toBe(429);
    expect(second.providerCallStarted).toBe(false);
    expect(second.response.headers.get('retry-after')).toBe('120');
    expect(await second.response.text()).toContain('temporarily cooling down');
    expect(providerClient.forward).toHaveBeenCalledTimes(1);
  });

  it('reserves attempt order for a cooldown before trying the real fallback', async () => {
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response('rate limit', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

    const cooledRoute = {
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-sonnet-4-6',
      body,
      stream: false,
      sessionKey: 'sess-1',
      agentId: 'agent-1',
      providerKeyLabel: 'Claude Code',
      authType: 'subscription',
    };
    await service.tryForwardToProvider(cooledRoute);

    let attemptNumber = 0;
    const startProviderAttempt: StartProviderAttempt = jest.fn((start) => ({
      id: `attempt-${attemptNumber + 1}`,
      attemptNumber: ++attemptNumber,
      startedAtMs: Date.now(),
      startedAt: new Date().toISOString(),
      pendingWrite: Promise.resolve(start.providerCallStarted !== false),
    }));

    const cooldown = await service.tryForwardToProvider({
      ...cooledRoute,
      startProviderAttempt,
    });
    const fallback = await service.tryForwardToProvider({
      ...cooledRoute,
      provider: 'openai',
      model: 'gpt-4o',
      authType: 'api_key',
      providerKeyLabel: 'OpenAI',
      startProviderAttempt,
    });

    expect(cooldown.providerCallStarted).toBe(false);
    expect(cooldown.attempt?.attemptNumber).toBe(1);
    expect(fallback.providerCallStarted).toBe(true);
    expect(fallback.attempt?.attemptNumber).toBe(2);
    expect(startProviderAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: 'anthropic', providerCallStarted: false }),
    );
    expect(providerClient.forward).toHaveBeenCalledTimes(2);
  });

  it('evicts an active cooldown when the cooldown cache is full', async () => {
    const cooldowns = (service as unknown as { rateLimitCooldowns: Map<string, number> })
      .rateLimitCooldowns;
    const farFuture = Date.now() + 60_000;
    for (let i = 0; i < 2_000; i += 1) {
      cooldowns.set(
        `agent-1\u0000anthropic\u0000subscription\u0000Key ${i}\u0000model-${i}`,
        farFuture + i,
      );
    }

    providerClient.forward.mockResolvedValueOnce({
      response: new Response('rate limit', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
      isGoogle: false,
      isAnthropic: true,
      isChatGpt: false,
    });

    await service.tryForwardToProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-sonnet-4-6',
      body,
      stream: false,
      sessionKey: 'sess-1',
      agentId: 'agent-1',
      providerKeyLabel: 'Claude Code',
      authType: 'subscription',
    });

    expect(cooldowns.size).toBe(2_000);
    expect(cooldowns.has('agent-1\u0000anthropic\u0000subscription\u0000Key 0\u0000model-0')).toBe(
      false,
    );
    expect(
      cooldowns.has(
        'agent-1\u0000anthropic\u0000subscription\u0000Claude Code\u0000claude-sonnet-4-6',
      ),
    ).toBe(true);
  });

  describe('rate-limit cooldown TTL derived from Retry-After', () => {
    // Drive one real 429 carrying the given Retry-After header, then read the
    // stored cooldown expiry so we can assert the TTL parseRetryAfterMs derived.
    // A fresh service (beforeEach) means exactly one cooldown entry exists after
    // the call. Returns the duration in ms measured from just before the call,
    // so assertions allow small upper-bound slack for test runtime.
    const recordCooldownTtl = async (retryAfter: string | null): Promise<number> => {
      const headers: Record<string, string> = {};
      if (retryAfter !== null) headers['retry-after'] = retryAfter;
      providerClient.forward.mockResolvedValueOnce({
        response: new Response('rate limit', { status: 429, headers }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });

      const before = Date.now();
      await service.tryForwardToProvider({
        provider: 'anthropic',
        apiKey: 'sk-ant-oat-token',
        model: 'claude-sonnet-4-6',
        body,
        stream: false,
        sessionKey: 'sess-1',
        agentId: 'agent-1',
        providerKeyLabel: 'Claude Code',
        authType: 'subscription',
      });

      const cooldowns = (service as unknown as { rateLimitCooldowns: Map<string, number> })
        .rateLimitCooldowns;
      expect(cooldowns.size).toBe(1);
      const [expiresAt] = [...cooldowns.values()];
      return expiresAt - before;
    };

    it('uses the short 15s default when the 429 carries no Retry-After', async () => {
      const ttl = await recordCooldownTtl(null);
      expect(ttl).toBeGreaterThanOrEqual(15_000);
      expect(ttl).toBeLessThan(16_000);
    });

    it('uses the short default when Retry-After is unparseable', async () => {
      const ttl = await recordCooldownTtl('not-a-date');
      expect(ttl).toBeGreaterThanOrEqual(15_000);
      expect(ttl).toBeLessThan(16_000);
    });

    it('honors an HTTP-date Retry-After under a minute instead of flooring it to 60s', async () => {
      // Before this fix the date form was floored to 60s; a ~10s instant now
      // yields a ~10s cooldown, matching the numeric-seconds path.
      const future = new Date(Date.now() + 10_000).toUTCString();
      const ttl = await recordCooldownTtl(future);
      expect(ttl).toBeGreaterThan(8_000);
      expect(ttl).toBeLessThanOrEqual(10_000);
    });

    it('falls back to the short default when the Retry-After date is in the past', async () => {
      const past = new Date(Date.now() - 5_000).toUTCString();
      const ttl = await recordCooldownTtl(past);
      expect(ttl).toBeGreaterThanOrEqual(15_000);
      expect(ttl).toBeLessThan(16_000);
    });

    it('caps an HTTP-date Retry-After beyond the 5-minute ceiling', async () => {
      const future = new Date(Date.now() + 30 * 60_000).toUTCString();
      const ttl = await recordCooldownTtl(future);
      expect(ttl).toBeGreaterThanOrEqual(5 * 60_000);
      expect(ttl).toBeLessThan(5 * 60_000 + 1_000);
    });
  });

  it('does NOT short-circuit on 401 auth errors — continues to next route (current contract)', async () => {
    // shouldTriggerFallback(401) === true, so an auth failure on the first
    // route keeps the loop going. This test pins that behavior: if anyone
    // later wants 401 to halt the chain they need to change
    // fallback-status-codes.ts AND update this test deliberately.
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response('invalid api key', { status: 401 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('rate limit', { status: 429 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{}', { status: 200 }),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      });

    const routes: ModelRoute[] = [
      route('openai', 'gpt-4o-mini'),
      route('anthropic', 'claude-haiku-3.5'),
      route('gemini', 'gemini-2.5-flash'),
    ];
    const result = await runFallbacks(
      ['gpt-4o-mini', 'claude-haiku-3.5', 'gemini-2.5-flash'],
      routes,
    );

    expect(providerClient.forward).toHaveBeenCalledTimes(3);
    expect(result.success).not.toBeNull();
    expect(result.success!.provider).toBe('gemini');
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ status: 401, provider: 'openai' });
    expect(result.failures[1]).toMatchObject({ status: 429, provider: 'anthropic' });
  });

  it('continues the fallback chain on a context length error body', async () => {
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 262144 tokens. However, your messages resulted in 334146 tokens.",
              code: 'context_length_exceeded',
            },
          }),
          { status: 400 },
        ),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{}', { status: 200 }),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      });

    const routes: ModelRoute[] = [
      route('openai', 'gpt-4o-mini'),
      route('gemini', 'gemini-2.5-flash'),
    ];
    const result = await runFallbacks(['gpt-4o-mini', 'gemini-2.5-flash'], routes);

    expect(providerClient.forward).toHaveBeenCalledTimes(2);
    expect(result.success).not.toBeNull();
    expect(result.success!.provider).toBe('gemini');
    expect(result.success!.model).toBe('gemini-2.5-flash');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      status: 400,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('returns success=null with all-404 failures when every fallback lacks the model (no 503 collapse)', async () => {
    // The "model not available on any provider" chain. tryFallbacks must
    // preserve each per-attempt 404 status + body, NOT synthesize a
    // generic 503 — the caller decides how to surface this.
    providerClient.forward.mockImplementation(async () => ({
      // Fresh Response per call — bodies can only be read once.
      response: new Response('{"error":"model not found on this provider"}', {
        status: 404,
      }),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    }));

    const routes: ModelRoute[] = [
      route('openai', 'unknown-model-x'),
      route('anthropic', 'unknown-model-x'),
      route('gemini', 'unknown-model-x'),
    ];
    const result = await runFallbacks(
      ['unknown-model-x', 'unknown-model-x', 'unknown-model-x'],
      routes,
    );

    expect(providerClient.forward).toHaveBeenCalledTimes(3);
    expect(result.success).toBeNull();
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.status).toBe(404);
      expect(failure.errorBody).toBe('{"error":"model not found on this provider"}');
    }
    expect(result.failures.map((f) => f.fallbackIndex)).toEqual([0, 1, 2]);
    expect(result.failures.map((f) => f.provider)).toEqual(['openai', 'anthropic', 'gemini']);
  });

  it('preserves the LAST fallback errorBody/status when all return 404 (caller surfaces final 404 verbatim)', async () => {
    // Same scenario as above with distinct per-provider error bodies. The
    // final failure entry holds the last attempt's body verbatim — that
    // is what proxy.service projects back to the agent as the user-facing
    // response when the chain exhausts.
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response('{"error":"openai: model_not_found"}', { status: 404 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{"error":"anthropic: not_found_error"}', { status: 404 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{"error":"gemini: NOT_FOUND"}', { status: 404 }),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      });

    const routes: ModelRoute[] = [
      route('openai', 'unknown-model-x'),
      route('anthropic', 'unknown-model-x'),
      route('gemini', 'unknown-model-x'),
    ];
    const result = await runFallbacks(
      ['unknown-model-x', 'unknown-model-x', 'unknown-model-x'],
      routes,
    );

    expect(result.success).toBeNull();
    const last = result.failures[result.failures.length - 1];
    expect(last.status).toBe(404);
    expect(last.errorBody).toBe('{"error":"gemini: NOT_FOUND"}');
    expect(last.provider).toBe('gemini');
    // Sanity: middle entries retain their own bodies — no overwrite.
    expect(result.failures[0].errorBody).toContain('openai: model_not_found');
    expect(result.failures[1].errorBody).toContain('anthropic: not_found_error');
  });

  it('records each failed hop against its own pinned connection', async () => {
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response('{"error":"boom"}', { status: 502 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{"error":"boom"}', { status: 502 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });

    const routes: ModelRoute[] = [
      { ...route('openai', 'gpt-4o-mini'), keyLabel: 'Work' },
      { ...route('anthropic', 'claude-haiku-3.5'), keyLabel: 'Personal' },
    ];
    const result = await runFallbacks(['gpt-4o-mini', 'claude-haiku-3.5'], routes);

    expect(result.success).toBeNull();
    // Each hop carries its own label; without it the recorder would stamp the
    // primary's connection on every failed fallback row.
    expect(result.failures.map((f) => f.keyLabel)).toEqual(['Work', 'Personal']);
  });

  it('keeps the pinned label on a hop that never got credentials', async () => {
    providerKeyService.getProviderApiKey.mockResolvedValue(null);

    const routes: ModelRoute[] = [{ ...route('openai', 'gpt-4o-mini'), keyLabel: 'Work' }];
    const result = await runFallbacks(['gpt-4o-mini'], routes);

    expect(providerClient.forward).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ keyLabel: 'Work', status: 401 });
  });
});
