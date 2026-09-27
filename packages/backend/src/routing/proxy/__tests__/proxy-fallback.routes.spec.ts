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

/**
 * Locks the route-aware behavior of ProxyFallbackService.tryFallbacks:
 *   - When the caller passes structured `fallbackRoutes`, the loop uses
 *     each route's (provider, authType) directly without consulting the
 *     legacy inference cascade (pricing cache, prefix, findProviderForModel,
 *     getAuthType).
 *   - When fallbackRoutes is null/undefined, behavior is unchanged from the
 *     pre-route world (regression-locking back-compat).
 *   - The same model name appearing twice in fallbackRoutes with different
 *     auth types is tried twice — neither is silently deduped (the #1708
 *     invariant that motivated this whole refactor).
 *   - Each FailedFallback row carries the auth type of the attempt that
 *     actually failed, not the primary's auth.
 */

describe('ProxyFallbackService.tryFallbacks — route-aware path', () => {
  let service: ProxyFallbackService;
  let providerKeyService: jest.Mocked<ProviderKeyService>;
  let customProviderRepo: jest.Mocked<Repository<CustomProvider>>;
  let openaiOauth: jest.Mocked<OpenaiOauthService>;
  let minimaxOauth: jest.Mocked<MinimaxOauthService>;
  let anthropicOauth: jest.Mocked<AnthropicOauthService>;
  let geminiOauth: jest.Mocked<GeminiOauthService>;
  let kiroOauth: jest.Mocked<KiroOauthService>;
  let xaiOauth: jest.Mocked<XaiOauthService>;
  let providerClient: jest.Mocked<ProviderClient>;
  let copilotToken: jest.Mocked<CopilotTokenService>;
  let pricingCache: jest.Mocked<ModelPricingCacheService>;

  beforeEach(() => {
    providerKeyService = {
      getProviderApiKey: jest.fn().mockResolvedValue('sk-test'),
      getProviderKeyId: jest.fn().mockResolvedValue('up-fallback'),
      getDefaultKeyLabel: jest.fn().mockResolvedValue(undefined),
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

    customProviderRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<CustomProvider>>;

    openaiOauth = {
      unwrapToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<OpenaiOauthService>;

    minimaxOauth = {
      unwrapToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<MinimaxOauthService>;

    anthropicOauth = {
      unwrapToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AnthropicOauthService>;

    geminiOauth = {
      unwrapToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<GeminiOauthService>;

    kiroOauth = {
      unwrapToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<KiroOauthService>;
    xaiOauth = {
      unwrapToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<XaiOauthService>;

    providerClient = {
      forward: jest.fn(),
    } as unknown as jest.Mocked<ProviderClient>;

    copilotToken = {
      getCopilotToken: jest.fn().mockResolvedValue('tid=copilot-session'),
    } as unknown as jest.Mocked<CopilotTokenService>;

    pricingCache = {
      getByModel: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<ModelPricingCacheService>;

    const modelParamsService = {
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      set: jest.fn(),
      delete: jest.fn(),
    } as unknown as AgentModelParamsService;

    const providerParamSpecs = {
      getSpecs: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as ProviderParamSpecService;

    service = new ProxyFallbackService(
      providerKeyService,
      customProviderRepo,
      openaiOauth,
      minimaxOauth,
      anthropicOauth,
      geminiOauth,
      kiroOauth,
      xaiOauth,
      providerClient,
      copilotToken,
      pricingCache,
      modelParamsService,
      providerParamSpecs,
      new ReasoningContentCache(),
      {
        isRepairable: jest.fn().mockReturnValue(false),
        maybeHeal: jest.fn(),
      } as unknown as AutofixService,
    );
  });

  const body = { messages: [{ role: 'user', content: 'Hello' }], stream: false };

  it("carries the caller's anthropic-beta flags onto an Anthropic fallback hop", async () => {
    // A fallback that lands on Anthropic needs the beta header just as much as
    // the primary did; without it a beta-gated body 400s on the recovery hop.
    providerClient.forward.mockResolvedValue({
      response: new Response('{}', { status: 200 }),
      isGoogle: false,
      isAnthropic: true,
      isChatGpt: false,
    });
    const routes: ModelRoute[] = [
      { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4' },
    ];

    await service.tryFallbacks(
      'agent-1',
      'user-1',
      ['claude-sonnet-4'],
      body,
      false,
      'sess-1',
      'gpt-4o',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      routes,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'structured-outputs-2025-11-13',
    );

    expect(providerClient.forward.mock.calls[0][0].clientAnthropicBeta).toBe(
      'structured-outputs-2025-11-13',
    );
  });

  it('uses route.provider and route.authType directly, skipping inference cascade', async () => {
    providerClient.forward.mockResolvedValue({
      response: new Response('{}', { status: 200 }),
      isGoogle: false,
      isAnthropic: true,
      isChatGpt: false,
    });
    const routes: ModelRoute[] = [
      { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4' },
    ];

    const result = await service.tryFallbacks(
      'agent-1',
      'user-1',
      ['claude-sonnet-4'],
      body,
      false,
      'sess-1',
      'gpt-4o',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      routes,
    );

    expect(result.success).not.toBeNull();
    expect(result.success!.provider).toBe('anthropic');
    expect(result.success!.authType).toBe('subscription');
    // Inference path must be silent on the route branch.
    expect(pricingCache.getByModel).not.toHaveBeenCalled();
    expect(providerKeyService.getAuthType).not.toHaveBeenCalled();
    expect(providerKeyService.findProviderForModel).not.toHaveBeenCalled();
    // The forward call carries the explicit auth from the route.
    expect(providerClient.forward).toHaveBeenCalledTimes(1);
    expect(providerClient.forward.mock.calls[0][0].authType).toBe('subscription');
  });

  it('tries the same model twice with different auth types when routes specify both (#1708)', async () => {
    // The whole point of carrying authType in the route is that the same
    // model name can be tried under api_key after subscription failed —
    // without dedup'ing it as "same provider, already tried".
    providerClient.forward
      .mockResolvedValueOnce({
        response: new Response('subscription failed', { status: 401 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      })
      .mockResolvedValueOnce({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });

    const routes: ModelRoute[] = [
      { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4' },
      { provider: 'anthropic', authType: 'api_key', model: 'claude-sonnet-4' },
    ];

    const result = await service.tryFallbacks(
      'agent-1',
      'user-1',
      ['claude-sonnet-4', 'claude-sonnet-4'],
      body,
      false,
      'sess-1',
      'gpt-4o',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      routes,
    );

    expect(providerClient.forward).toHaveBeenCalledTimes(2);
    expect(providerClient.forward.mock.calls[0][0].authType).toBe('subscription');
    expect(providerClient.forward.mock.calls[1][0].authType).toBe('api_key');
    expect(result.success).not.toBeNull();
    expect(result.success!.fallbackIndex).toBe(1);
    expect(result.success!.authType).toBe('api_key');
    expect(result.failures).toHaveLength(1);
    // The failure carries the subscription auth, not the api_key one.
    expect(result.failures[0].authType).toBe('subscription');
  });

  it('records the per-attempt authType on each FailedFallback', async () => {
    // mockImplementation gives every call a fresh Response so .text() can
    // read the body each time without "body has already been read".
    providerClient.forward.mockImplementation(async () => ({
      response: new Response('boom', { status: 500 }),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    }));

    const routes: ModelRoute[] = [
      { provider: 'openai', authType: 'subscription', model: 'gpt-4o' },
      { provider: 'anthropic', authType: 'api_key', model: 'claude-sonnet-4' },
    ];

    const result = await service.tryFallbacks(
      'agent-1',
      'user-1',
      ['gpt-4o', 'claude-sonnet-4'],
      body,
      false,
      'sess-1',
      'primary-model',
      undefined,
      'OpenAI', // primaryProvider
      'api_key', // primaryAuthType — explicitly different from the failed auths below
      undefined,
      undefined,
      undefined,
      undefined,
      routes,
    );

    expect(result.success).toBeNull();
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].authType).toBe('subscription');
    expect(result.failures[1].authType).toBe('api_key');
  });

  it('falls back to the legacy inference path when fallbackRoutes is null', async () => {
    // Same scenario but no routes — the inference cascade must run.
    pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);
    providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
    providerClient.forward.mockResolvedValue({
      response: new Response('{}', { status: 200 }),
      isGoogle: false,
      isAnthropic: true,
      isChatGpt: false,
    });

    const result = await service.tryFallbacks(
      'agent-1',
      'user-1',
      ['claude-sonnet-4'],
      body,
      false,
      'sess-1',
      'gpt-4o',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
    );

    expect(result.success).not.toBeNull();
    // pricingCache and getAuthType must have been consulted on this branch.
    expect(pricingCache.getByModel).toHaveBeenCalled();
    expect(providerKeyService.getAuthType).toHaveBeenCalled();
  });

  it('falls back to legacy inference when fallbackRoutes length differs from fallbackModels', async () => {
    // Defensive: an out-of-sync route list mustn't be partially-trusted.
    pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);
    providerClient.forward.mockResolvedValue({
      response: new Response('{}', { status: 200 }),
      isGoogle: false,
      isAnthropic: true,
      isChatGpt: false,
    });

    const routes: ModelRoute[] = [
      { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4' },
    ];
    await service.tryFallbacks(
      'agent-1',
      'user-1',
      ['claude-sonnet-4', 'claude-haiku-3.5'],
      body,
      false,
      'sess-1',
      'gpt-4o',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      routes,
    );

    // Legacy inference must run for both entries because the lengths mismatched.
    expect(pricingCache.getByModel).toHaveBeenCalled();
    expect(providerKeyService.getAuthType).toHaveBeenCalled();
  });
});
