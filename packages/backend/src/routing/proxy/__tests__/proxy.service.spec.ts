import { ManifestError } from '../../../common/errors/manifest-error';
import { ConfigService } from '@nestjs/config';
import {
  deriveAutofixStatus,
  getProviderParamSpecs,
  type AuthType,
  type ModelRoute,
  type ProviderParamSpecCatalog,
} from 'manifest-shared';
import { ProxyService } from '../proxy.service';
import type { ResolveService } from '../../resolve/resolve.service';
import type { ProviderKeyService } from '../../routing-core/provider-key.service';
import type { OpenaiOauthService } from '../../oauth/openai/openai-oauth.service';
import type { MinimaxOauthService } from '../../oauth/minimax/minimax-oauth.service';
import type { AnthropicOauthService } from '../../oauth/anthropic/anthropic-oauth.service';
import type { GeminiOauthService } from '../../oauth/gemini/gemini-oauth.service';
import type { KiroOauthService } from '../../oauth/kiro/kiro-oauth.service';
import type { XaiOauthService } from '../../oauth/xai/xai-oauth.service';
import type { SessionMomentumService } from '../session-momentum.service';
import type { LimitCheckService } from '../../../notifications/services/limit-check.service';
import type { ProxyFallbackService } from '../proxy-fallback.service';
import type { ThoughtSignatureCache } from '../thought-signature-cache';
import type { ThinkingBlockCache } from '../thinking-block-cache';
import { AgentModelParamsService } from '../../routing-core/agent-model-params.service';
import type { ProviderParamSpecService } from '../../routing-core/provider-param-spec.service';
import { AutofixService } from '../../autofix/autofix.service';
import type { HealingClient } from '../../autofix/healing-client';
import type { ModelDiscoveryService } from '../../../model-discovery/model-discovery.service';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';

/**
 * Stream-warmup helper is mocked because the real implementation depends on
 * a streaming Response body. We control its return value per test.
 */
jest.mock('../stream-warmup', () => ({
  peekStream: jest.fn(),
  STREAM_WARMUP_MS: 15_000,
}));

import { peekStream } from '../stream-warmup';
const mockedPeek = peekStream as jest.MockedFunction<typeof peekStream>;

const route = (provider: string, authType: ModelRoute['authType'], model: string): ModelRoute => ({
  provider,
  authType,
  model,
});

const okResponse = (status = 200) =>
  new Response('{"ok":true}', { status, headers: { 'content-type': 'application/json' } });

function discoveredModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 4,
    authType: 'api_key',
    ...overrides,
  };
}

const specCatalog: ProviderParamSpecCatalog = [
  {
    provider: 'deepseek',
    authType: 'api_key',
    model: 'deepseek-v4-flash',
    params: [
      {
        path: 'thinking.type',
        type: 'enum',
        label: 'Thinking mode',
        description: 'Controls whether DeepSeek thinking mode is enabled.',
        default: 'enabled',
        values: ['enabled', 'disabled'],
        group: 'reasoning',
      },
    ],
  },
];

describe('ProxyService — orchestration', () => {
  let resolveService: jest.Mocked<
    Pick<
      ResolveService,
      'resolve' | 'resolveLazy' | 'resolveForTier' | 'resolveHeaderTier' | 'pinRouteKeyLabel'
    >
  >;
  let providerKeyService: jest.Mocked<
    Pick<
      ProviderKeyService,
      | 'getProviderApiKey'
      | 'getProviderRegion'
      | 'getProviderKeyId'
      | 'selectProviderKey'
      | 'hasRouteCredentials'
    >
  >;
  let openaiOauth: jest.Mocked<Pick<OpenaiOauthService, 'unwrapToken'>>;
  let minimaxOauth: jest.Mocked<Pick<MinimaxOauthService, 'unwrapToken'>>;
  let anthropicOauth: jest.Mocked<Pick<AnthropicOauthService, 'unwrapToken'>>;
  let geminiOauth: jest.Mocked<Pick<GeminiOauthService, 'unwrapToken'>>;
  let kiroOauth: jest.Mocked<Pick<KiroOauthService, 'unwrapToken'>>;
  let xaiOauth: jest.Mocked<Pick<XaiOauthService, 'unwrapToken'>>;
  let momentum: jest.Mocked<
    Pick<
      SessionMomentumService,
      'recordTier' | 'recordCategory' | 'getRecentTiers' | 'getRecentCategories'
    >
  >;
  let limitCheck: jest.Mocked<Pick<LimitCheckService, 'checkLimits'>>;
  let fallbackService: jest.Mocked<
    Pick<ProxyFallbackService, 'tryForwardToProvider' | 'retryWireBody' | 'tryFallbacks'>
  >;
  let configService: ConfigService;
  let signatureCache: ThoughtSignatureCache;
  let thinkingCache: ThinkingBlockCache;
  let modelParamsService: { get: jest.Mock; list: jest.Mock; set: jest.Mock; delete: jest.Mock };
  let providerParamSpecs: { getSpecs: jest.Mock; list: jest.Mock };
  let autofixService: { maybeHeal: jest.Mock };
  let svc: ProxyService;
  let modelDiscovery: jest.Mocked<Pick<ModelDiscoveryService, 'getModelsForAgent'>>;

  beforeEach(() => {
    jest.clearAllMocks();

    const resolve = jest.fn();
    resolveService = {
      resolve,
      resolveLazy: jest.fn(async (agentId, tenantId, resolveInput, ...rest) => {
        const input = await resolveInput();
        return resolve(
          agentId,
          tenantId,
          input.messages,
          input.tools,
          input.tool_choice,
          input.max_tokens,
          ...rest,
        );
      }),
      resolveForTier: jest.fn(),
      resolveHeaderTier: jest.fn().mockResolvedValue(null),
      // Default: no connection pin configured — the route passes through.
      // Tests that exercise pinning override this per case.
      pinRouteKeyLabel: jest.fn(async (_agentId, _tenantId, route: ModelRoute) => route),
    };
    modelDiscovery = {
      getModelsForAgent: jest.fn().mockResolvedValue([]),
    };
    providerKeyService = {
      getProviderApiKey: jest.fn().mockResolvedValue('decrypted-key'),
      getProviderRegion: jest.fn().mockResolvedValue(null),
      getProviderKeyId: jest.fn().mockResolvedValue('up-default'),
      // Single key selection per request: apiKey, id, and region are all
      // projected from this one row so they can never diverge.
      selectProviderKey: jest.fn().mockResolvedValue({
        apiKey: 'decrypted-key',
        id: 'up-default',
        region: null,
        label: 'Default',
        priority: 0,
      }),
      hasRouteCredentials: jest.fn().mockResolvedValue(false),
    };
    openaiOauth = { unwrapToken: jest.fn().mockResolvedValue(null) };
    minimaxOauth = { unwrapToken: jest.fn().mockResolvedValue(null) };
    anthropicOauth = { unwrapToken: jest.fn().mockResolvedValue(null) };
    geminiOauth = { unwrapToken: jest.fn().mockResolvedValue(null) };
    kiroOauth = { unwrapToken: jest.fn().mockResolvedValue(null) };
    xaiOauth = { unwrapToken: jest.fn().mockResolvedValue(null) };
    momentum = {
      recordTier: jest.fn(),
      recordCategory: jest.fn(),
      getRecentTiers: jest.fn().mockReturnValue([]),
      getRecentCategories: jest.fn().mockReturnValue([]),
    };
    limitCheck = { checkLimits: jest.fn().mockResolvedValue(null) };
    fallbackService = {
      tryForwardToProvider: jest.fn(),
      retryWireBody: jest.fn(),
      tryFallbacks: jest.fn(),
    };
    configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    signatureCache = {
      retrieve: jest.fn().mockReturnValue(null),
    } as unknown as ThoughtSignatureCache;
    thinkingCache = { retrieve: jest.fn().mockReturnValue(null) } as unknown as ThinkingBlockCache;
    modelParamsService = {
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      set: jest.fn(),
      delete: jest.fn(),
    };
    providerParamSpecs = {
      getSpecs: jest.fn(async (provider: string, authType: string, model: string) =>
        getProviderParamSpecs(specCatalog, provider, authType as AuthType, model),
      ),
      list: jest.fn().mockResolvedValue(specCatalog),
    };
    autofixService = { maybeHeal: jest.fn().mockResolvedValue(null) };

    svc = new ProxyService(
      resolveService as unknown as ResolveService,
      modelDiscovery as unknown as ModelDiscoveryService,
      providerKeyService as unknown as ProviderKeyService,
      openaiOauth as unknown as OpenaiOauthService,
      minimaxOauth as unknown as MinimaxOauthService,
      anthropicOauth as unknown as AnthropicOauthService,
      geminiOauth as unknown as GeminiOauthService,
      kiroOauth as unknown as KiroOauthService,
      xaiOauth as unknown as XaiOauthService,
      momentum as unknown as SessionMomentumService,
      limitCheck as unknown as LimitCheckService,
      fallbackService as unknown as ProxyFallbackService,
      configService,
      signatureCache,
      thinkingCache,
      modelParamsService as unknown as AgentModelParamsService,
      providerParamSpecs as unknown as ProviderParamSpecService,
      autofixService as unknown as AutofixService,
    );
  });

  const baseOpts = (overrides: Partial<Parameters<ProxyService['proxyRequest']>[0]> = {}) => ({
    agentId: 'agent-1',
    userId: 'user-1',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    sessionKey: 'sess-1',
    sessionCacheKey: 'cache-sess-1',
    providerCacheKey: 'provider-cache-sess-1',
    sessionMomentumKey: 'momentum-sess-1',
    tenantId: 'tenant-1',
    agentName: 'demo-agent',
    ...overrides,
  });

  describe('payload validation', () => {
    // A ManifestError, not a BadRequestException: the controller uses the type to
    // record the row as `request` origin instead of blaming the provider.
    it('throws a ManifestError M300 when messages is missing', async () => {
      await expect(svc.proxyRequest(baseOpts({ body: {} as never }))).rejects.toThrow(
        ManifestError,
      );
      await expect(svc.proxyRequest(baseOpts({ body: {} as never }))).rejects.toMatchObject({
        code: 'M300',
      });
    });

    it('throws a ManifestError M300 when messages is empty', async () => {
      await expect(svc.proxyRequest(baseOpts({ body: { messages: [] } as never }))).rejects.toThrow(
        ManifestError,
      );
    });

    it('keeps the M300 rejection a 400 for the caller', async () => {
      await expect(
        svc.proxyRequest(baseOpts({ body: { messages: [] } as never })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects Responses requests without input or instructions', async () => {
      await expect(
        svc.proxyRequest(baseOpts({ apiMode: 'responses', body: {} } as never)),
      ).rejects.toMatchObject({ code: 'M300', status: 400 });

      await expect(
        svc.proxyRequest(
          baseOpts({ apiMode: 'responses', body: { instructions: '   ' } } as never),
        ),
      ).rejects.toMatchObject({ code: 'M300', status: 400 });
    });

    it('accepts string and object items in Responses input arrays', () => {
      const validatePayload = (
        svc as unknown as {
          validatePayload: (body: Record<string, unknown>, apiMode: string) => void;
        }
      ).validatePayload.bind(svc);

      expect(() => validatePayload({ input: ['Hello'] }, 'responses')).not.toThrow();
      expect(() =>
        validatePayload({ input: [{ role: 'user', content: 'Hello' }] }, 'responses'),
      ).not.toThrow();
    });

    it('forwards long message arrays unchanged', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const messages = Array.from({ length: 1001 }, (_, index) => ({
        role: 'user',
        content: `message-${index}`,
      }));
      const body = { messages };

      await expect(svc.proxyRequest(baseOpts({ body } as never))).resolves.toBeDefined();
      expect(body.messages).toHaveLength(1001);
      expect(fallbackService.tryForwardToProvider.mock.calls[0][0].body).toBe(body);
    });

    it("hands the caller's anthropic-beta header to the forward", async () => {
      // Manifest builds upstream headers from scratch, so without this the
      // caller's beta flags never reach Anthropic and every beta-gated body
      // field comes back as `Extra inputs are not permitted`.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('anthropic', 'subscription', 'claude-sonnet-4-20250514'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });

      await svc.proxyRequest(
        baseOpts({ headers: { 'anthropic-beta': 'structured-outputs-2025-11-13' } } as never),
      );

      expect(fallbackService.tryForwardToProvider.mock.calls[0][0].clientAnthropicBeta).toBe(
        'structured-outputs-2025-11-13',
      );
    });

    it('replaces null content with empty string', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: null,
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const body = { messages: [{ role: 'user', content: null }] };
      const result = await svc.proxyRequest(baseOpts({ body } as never));
      // Routing was called — sanitized message reached the resolver.
      expect(resolveService.resolve).toHaveBeenCalled();
      expect(result.forward.response.status).toBeGreaterThanOrEqual(200);
    });

    it('replaces null content on the forwarded body when routing uses a redacted copy', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const body = { messages: [{ role: 'user', content: null }] };
      const routingBody = { messages: [{ role: 'user', content: null }] };

      await svc.proxyRequest(baseOpts({ body, routingBody } as never));

      expect(body.messages[0].content).toBe('');
      expect(routingBody.messages[0].content).toBe('');
      expect(fallbackService.tryForwardToProvider.mock.calls[0][0].body).toBe(body);
    });
  });

  describe('autofix integration', () => {
    const routableResolve = () =>
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
    const fwd = (
      status: number,
      wireRequestBody: Record<string, unknown> = { model: 'gpt-4o' },
      wireApiMode: 'chat_completions' | 'responses' | 'messages' = 'chat_completions',
    ) => ({
      response: okResponse(status),
      wireRequestBody,
      wireApiMode,
      retryWireBody: jest.fn(),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });

    it('uses the healed forward and attaches the autofix record when maybeHeal succeeds', async () => {
      routableResolve();
      const healed = fwd(200);
      fallbackService.tryForwardToProvider.mockResolvedValue(fwd(400));
      const record = { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] };
      autofixService.maybeHeal.mockResolvedValue({ forward: healed, record });

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      expect(result.autofix).toBe(record);
      expect(autofixService.maybeHeal).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', authType: 'api_key' }),
      );
    });

    it('retries the patched same-model wire body without rebuilding it', async () => {
      routableResolve();
      const healed = fwd(200);
      const failed = fwd(400, { model: 'gpt-4o', max_tokens: 7 });
      fallbackService.tryForwardToProvider.mockResolvedValueOnce(failed);
      fallbackService.retryWireBody.mockResolvedValueOnce(healed);
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => {
          const forward = await params.reforward({ model: 'gpt-4o', max_tokens: 5 });
          return {
            forward,
            record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
          };
        },
      );

      const result = await svc.proxyRequest(
        baseOpts({ body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] } }),
      );

      expect(result.forward).toBe(healed);
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(1);
      expect(fallbackService.retryWireBody).toHaveBeenCalledWith(
        failed,
        { model: 'gpt-4o', max_tokens: 5 },
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4o',
          authType: 'api_key',
        }),
      );
    });

    it('reports the captured provider body and provider-facing API mode to Autofix', async () => {
      routableResolve();
      const wireBody = {
        model: 'claude-opus-4-8',
        thinking: { type: 'adaptive', budget_tokens: 8192 },
      };
      fallbackService.tryForwardToProvider.mockResolvedValueOnce(fwd(400, wireBody, 'messages'));

      await svc.proxyRequest(baseOpts());

      expect(autofixService.maybeHeal).toHaveBeenCalledWith(
        expect.objectContaining({
          apiMode: 'messages',
          requestBody: wireBody,
        }),
      );
      expect(autofixService.maybeHeal.mock.calls[0][0]).not.toHaveProperty('resolvedModel');
    });

    it('sends native Gemini failures to Autofix with the exact provider body', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('gemini', 'api_key', 'gemini-2.5-flash'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const wireRequestBody = {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 32_000, topP: 1 },
      };
      fallbackService.tryForwardToProvider.mockResolvedValueOnce({
        response: okResponse(400),
        wireRequestBody,
        wireRequestUrl:
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        wireFormat: 'google_generate_content',
        retryWireBody: jest.fn(),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(baseOpts());

      expect(autofixService.maybeHeal).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          apiMode: 'chat_completions',
          requestBody: wireRequestBody,
        }),
      );
      expect(autofixService.maybeHeal.mock.calls[0][0].requestBody).not.toHaveProperty('model');
    });

    it('re-resolves routing and forwards to the newly-resolved route when the heal changes the model (M5)', async () => {
      routableResolve();
      const healed = fwd(200);
      // Primary forward fails; the re-resolved forward for the new model succeeds.
      fallbackService.tryForwardToProvider
        .mockResolvedValueOnce(fwd(400))
        .mockResolvedValueOnce(healed);
      // The healed body targets a DIFFERENT model. In chat_completions mode a
      // concrete (non-"auto") model id re-resolves via the explicit-model path:
      // modelDiscovery.getModelsForAgent + routeForOpenAiModelId. Publish a model
      // whose OpenAI-compatible id matches so the re-resolve finds a route.
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => {
          const forward = await params.reforward({
            model: 'openai/gpt-4o-mini',
            max_output_tokens: 5,
          });
          return {
            forward,
            record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
          };
        },
      );

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      // Re-resolve happened: getModelsForAgent was consulted for the healed model
      // (the primary route used resolveService.resolve, never getModelsForAgent).
      expect(modelDiscovery.getModelsForAgent).toHaveBeenCalledWith('tenant-1', 'agent-1');
      // Credentials were re-selected for the re-resolved provider.
      expect(providerKeyService.selectProviderKey).toHaveBeenCalledWith(
        'tenant-1',
        'openai',
        'api_key',
        undefined,
        'agent-1',
      );
      // A second forward went to the newly-resolved model.
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(2);
      const reforwardOpts = fallbackService.tryForwardToProvider.mock.calls[1][0];
      expect(reforwardOpts.model).toBe('gpt-4o-mini');
      expect(reforwardOpts.provider).toBe('openai');
    });

    it('routes a native Autofix remap through the original subscription auth type', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-5.4'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const healed = fwd(200, { model: 'gpt-5.5' });
      fallbackService.tryForwardToProvider
        .mockResolvedValueOnce(fwd(400, { model: 'gpt-5.4' }))
        .mockResolvedValueOnce(healed);
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-5.5', provider: 'openai', authType: 'api_key' }),
        discoveredModel({ id: 'gpt-5.5', provider: 'openai', authType: 'subscription' }),
      ]);
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => ({
          forward: await params.reforward({ model: 'gpt-5.5', max_output_tokens: 5 }),
          record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
        }),
      );

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(2);
      expect(fallbackService.tryForwardToProvider.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-5.5',
          body: expect.objectContaining({ model: 'gpt-5.5' }),
        }),
      );
    });

    it('keeps a native remap body on the original subscription transport when discovery is stale', async () => {
      const failed = fwd(400, { model: 'gpt-5.4' });
      const healed = fwd(200, { model: 'gpt-5.5' });
      fallbackService.tryForwardToProvider.mockResolvedValueOnce(failed);
      fallbackService.retryWireBody.mockResolvedValueOnce(healed);
      modelDiscovery.getModelsForAgent.mockResolvedValue([]);
      resolveService.resolve.mockResolvedValueOnce({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-5.4'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => ({
          forward: await params.reforward({ model: 'gpt-5.5', max_output_tokens: 5 }),
          record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
        }),
      );

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(1);
      expect(fallbackService.retryWireBody).toHaveBeenCalledWith(
        failed,
        { model: 'gpt-5.5', max_output_tokens: 5 },
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.5',
          authType: 'subscription',
        }),
      );
    });

    it('keeps legacy suffixed Autofix remaps idempotent', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-5.4'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const healed = fwd(200, { model: 'gpt-5.5' });
      fallbackService.tryForwardToProvider
        .mockResolvedValueOnce(fwd(400, { model: 'gpt-5.4' }))
        .mockResolvedValueOnce(healed);
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-5.5', provider: 'openai', authType: 'subscription' }),
      ]);
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => ({
          forward: await params.reforward({
            model: 'openai/gpt-5.5-subscription',
            max_output_tokens: 5,
          }),
          record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
        }),
      );

      await svc.proxyRequest(baseOpts());

      expect(fallbackService.tryForwardToProvider.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          authType: 'subscription',
          model: 'gpt-5.5',
          body: expect.objectContaining({ model: 'openai/gpt-5.5-subscription' }),
        }),
      );
    });

    it('re-resolves an uncatalogued healed model through connected-provider passthrough', async () => {
      routableResolve();
      const healed = fwd(200, { model: 'gpt-new' });
      fallbackService.tryForwardToProvider
        .mockResolvedValueOnce(fwd(404))
        .mockResolvedValueOnce(healed);
      modelDiscovery.getModelsForAgent.mockResolvedValue([]);
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'openai' && candidate.authType === 'api_key',
      );
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => ({
          forward: await params.reforward({ model: 'openai/gpt-new', max_output_tokens: 5 }),
          record: { outcome: 'healed', attempts: 1, original_http_status: 404, chain: [] },
        }),
      );

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      expect(providerKeyService.hasRouteCredentials).toHaveBeenCalledWith(
        'tenant-1',
        { provider: 'openai', authType: 'api_key', model: 'gpt-new' },
        'agent-1',
      );
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(2);
      expect(fallbackService.tryForwardToProvider.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          provider: 'openai',
          authType: 'api_key',
          model: 'gpt-new',
        }),
      );
    });

    it('retries on the original transport when the heal changes to a model that no longer resolves (M5 no-route)', async () => {
      routableResolve();
      const failed = fwd(400);
      const healed = fwd(200);
      fallbackService.tryForwardToProvider.mockResolvedValueOnce(failed);
      fallbackService.retryWireBody.mockResolvedValueOnce(healed);
      // No discovered models → the healed model resolves to no route (a stale
      // per-tenant catalog, typically — the provider may still serve it). The
      // original forward's transport is proven, so the reforward pins the healed
      // body there instead of synthesizing a 502.
      modelDiscovery.getModelsForAgent.mockResolvedValue([]);
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: null,
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      resolveService.resolve.mockResolvedValueOnce({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      let reforwardResult: { response: Response } | undefined;
      autofixService.maybeHeal.mockImplementation(
        async (params: {
          reforward: (b: Record<string, unknown>) => Promise<{ response: Response }>;
        }) => {
          reforwardResult = await params.reforward({
            model: 'ghost/unknown-model',
            max_output_tokens: 5,
          });
          return {
            forward: reforwardResult,
            record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
          };
        },
      );

      const result = await svc.proxyRequest(baseOpts());

      // The healed body went out on the original provider's transport with the
      // healed model pinned — the provider judges the model, not the cache.
      expect(reforwardResult).toBe(healed);
      expect(fallbackService.retryWireBody).toHaveBeenCalledWith(
        failed,
        { model: 'ghost/unknown-model', max_output_tokens: 5 },
        expect.objectContaining({
          provider: 'openai',
          model: 'ghost/unknown-model',
          authType: 'api_key',
        }),
      );
      // Only the primary forward reached tryForwardToProvider — the re-resolve
      // found no route and fell back to the pinned wire retry.
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(1);
      expect(result.forward).toBeDefined();
    });

    it('keeps the synthetic 502 when the original forward has no wire transport to pin', async () => {
      // Unreachable via proxyRequest (the maybeHeal gate requires retryWireBody)
      // but the fallback guards it type-level: no transport → no invented
      // provider call, surface the synthetic 502.
      const failed = { ...fwd(400), retryWireBody: undefined };
      const result = await (
        svc as unknown as {
          retryHealedOnOriginalTransport: (
            healedBody: Record<string, unknown>,
            originalForward: unknown,
            ctx: { provider: string; model: string },
            reason: string,
          ) => Promise<{ response: Response }>;
        }
      ).retryHealedOnOriginalTransport(
        { model: 'ghost/unknown-model' },
        failed,
        { provider: 'openai', model: 'gpt-4o' },
        'no route resolved for the healed model',
      );

      expect(result.response.status).toBe(502);
      expect(fallbackService.retryWireBody).not.toHaveBeenCalled();
      expect(await result.response.text()).toContain('Autofix');
    });

    it('uses the original model when a pinned healed retry omits the model', async () => {
      const failed = fwd(400);
      const healed = fwd(200);
      fallbackService.retryWireBody.mockResolvedValueOnce(healed);

      const result = await (
        svc as unknown as {
          retryHealedOnOriginalTransport: (
            healedBody: Record<string, unknown>,
            originalForward: unknown,
            ctx: { provider: string; model: string },
            reason: string,
          ) => Promise<{ response: Response }>;
        }
      ).retryHealedOnOriginalTransport(
        { max_output_tokens: 5 },
        failed,
        { provider: 'openai', model: 'gpt-4o' },
        'no route resolved for the healed model',
      );

      expect(result).toBe(healed);
      expect(fallbackService.retryWireBody).toHaveBeenCalledWith(
        failed,
        { max_output_tokens: 5 },
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4o',
        }),
      );
    });

    it('retries on the original transport when the re-resolved model has a route but no provider key (M5 no-credentials)', async () => {
      routableResolve();
      const failed = fwd(400);
      const healed = fwd(200);
      fallbackService.tryForwardToProvider.mockResolvedValueOnce(failed);
      fallbackService.retryWireBody.mockResolvedValueOnce(healed);
      // The healed model DOES resolve to a route, but the connection for it is
      // gone: selectProviderKey succeeds for the primary attempt, then returns
      // null on the re-resolve so resolveCredentials yields no key. The original
      // transport still holds a working credential — retry there.
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);
      providerKeyService.selectProviderKey
        .mockResolvedValueOnce({
          apiKey: 'decrypted-key',
          id: 'up-default',
          region: null,
          label: 'Default',
          priority: 0,
        })
        .mockResolvedValue(null);
      let reforwardResult: { response: Response } | undefined;
      autofixService.maybeHeal.mockImplementation(
        async (params: {
          reforward: (b: Record<string, unknown>) => Promise<{ response: Response }>;
        }) => {
          reforwardResult = await params.reforward({
            model: 'openai/gpt-4o-mini',
            max_output_tokens: 5,
          });
          return {
            forward: reforwardResult,
            record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
          };
        },
      );

      const result = await svc.proxyRequest(baseOpts());

      // A route was found (getModelsForAgent + a second selectProviderKey call),
      // but the missing key falls back to the pinned wire retry, not a 502.
      expect(reforwardResult).toBe(healed);
      expect(providerKeyService.selectProviderKey).toHaveBeenCalledTimes(2);
      expect(fallbackService.retryWireBody).toHaveBeenCalledWith(
        failed,
        { model: 'openai/gpt-4o-mini', max_output_tokens: 5 },
        expect.objectContaining({
          provider: 'openai',
          model: 'openai/gpt-4o-mini',
          authType: 'api_key',
        }),
      );
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(1);
      expect(result.forward).toBeDefined();
    });

    it('takes the same-model branch when the heal drops the model field entirely', async () => {
      routableResolve();
      const healed = fwd(200);
      const failed = fwd(400);
      fallbackService.tryForwardToProvider.mockResolvedValueOnce(failed);
      fallbackService.retryWireBody.mockResolvedValueOnce(healed);
      // Healed body has no `model` → healedModel is undefined → reforwardHealed
      // falls through to the same-model branch (reuses the primary route).
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => {
          const forward = await params.reforward({ max_output_tokens: 5 });
          return {
            forward,
            record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
          };
        },
      );

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledTimes(1);
      // No re-resolve — the same-model branch never consults getModelsForAgent.
      expect(modelDiscovery.getModelsForAgent).not.toHaveBeenCalled();
      expect(fallbackService.retryWireBody).toHaveBeenCalledWith(
        failed,
        { max_output_tokens: 5 },
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4o',
          authType: 'api_key',
        }),
      );
    });

    it('re-resolves via scoring (not the explicit-model path) when the heal switches the model to auto (M5)', async () => {
      // Primary request has no model → originalModel undefined. The heal sets
      // model="auto", which differs → model-changed branch → forwardResolvedHealed
      // re-resolves through the SCORING path (auto is not an explicit override),
      // so the re-resolved forward carries a defined paramMergeContext.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const healed = fwd(200);
      fallbackService.tryForwardToProvider
        .mockResolvedValueOnce(fwd(400))
        .mockResolvedValueOnce(healed);
      autofixService.maybeHeal.mockImplementation(
        async (params: { reforward: (b: Record<string, unknown>) => Promise<unknown> }) => {
          // A patched body still carries the original messages, so the scoring
          // re-resolve for model="auto" has something to score.
          const forward = await params.reforward({
            model: 'auto',
            messages: [{ role: 'user', content: 'hi' }],
            max_output_tokens: 5,
          });
          return {
            forward,
            record: { outcome: 'healed', attempts: 1, original_http_status: 400, chain: [] },
          };
        },
      );

      const result = await svc.proxyRequest(baseOpts());

      expect(result.forward).toBe(healed);
      // resolveService.resolve ran a SECOND time for the re-resolve (primary + heal).
      expect(resolveService.resolve).toHaveBeenCalledTimes(2);
      // The explicit-model path (getModelsForAgent) was never taken by the re-resolve.
      expect(modelDiscovery.getModelsForAgent).not.toHaveBeenCalled();
      const reforwardOpts = fallbackService.tryForwardToProvider.mock.calls[1][0];
      expect(reforwardOpts.model).toBe('gpt-4o');
      // Non-explicit re-resolve → defined param-merge context for the healed forward.
      expect(reforwardOpts.paramMergeContext).toEqual({
        agentId: 'agent-1',
        scopeKey: 'tier:standard',
      });
    });
  });

  describe('autofix healed streaming retry', () => {
    // The real AutofixService, so the request verdict and the Phoenix outcome
    // report are the ones production derives from the retry.
    let healingClient: { heal: jest.Mock; reportOutcome: jest.Mock };

    beforeEach(() => {
      // clearAllMocks keeps implementations; start each test from a clean peek.
      mockedPeek.mockReset();
      healingClient = {
        heal: jest.fn().mockResolvedValue({
          status: 'patched',
          issueId: 'issue-1',
          patchId: 'patch-1',
          healAttemptId: 'heal-1',
          healedBody: { model: 'gpt-4o', max_tokens: 5 },
        }),
        reportOutcome: jest.fn().mockResolvedValue({ healAttemptId: 'heal-1' }),
      };
      const realAutofix = new AutofixService(
        healingClient as unknown as HealingClient,
        { findOne: jest.fn().mockResolvedValue({ id: 'agent-1', autofix_enabled: true }) } as never,
        { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      );
      (svc as unknown as { autofixService: AutofixService }).autofixService = realAutofix;
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'api_key', 'claude')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockImplementation(
        async () =>
          ({
            response: new Response('{"error":{"message":"bad param"}}', { status: 400 }),
            wireRequestBody: { model: 'gpt-4o', max_tokens: 7 },
            wireApiMode: 'chat_completions',
            retryWireBody: jest.fn(),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
          }) as never,
      );
      fallbackService.retryWireBody.mockResolvedValue({
        response: new Response(new ReadableStream(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      } as never);
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: { response: okResponse(), isGoogle: false, isAnthropic: true, isChatGpt: false },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
        },
        failures: [],
      } as never);
    });

    const streamOpts = () =>
      baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }], stream: true } });

    it('does not credit Autofix when the healed stream fails warm-up and a fallback serves', async () => {
      mockedPeek.mockResolvedValue({
        ok: false,
        reason: 'timeout',
        message: 'No data within 15000ms',
      } as never);

      const result = await svc.proxyRequest(streamOpts());

      expect(result.meta.fallbackFromModel).toBe('gpt-4o');
      expect(deriveAutofixStatus(result.autofix)).toBe('retry_failed');
      const retry = result.autofix?.chain.find((entry) => entry.origin === 'autofix');
      expect(retry?.http_status).toBe(502);
      expect(healingClient.reportOutcome).toHaveBeenCalledWith(
        'heal-1',
        expect.objectContaining({
          retryStatusCode: 502,
          error: expect.objectContaining({
            message: expect.stringContaining('No data within 15000ms'),
          }),
        }),
        expect.anything(),
      );
    });

    it('still credits Autofix when the healed stream delivers data', async () => {
      mockedPeek.mockImplementation(async () => ({ ok: true, stream: new ReadableStream() }));

      const result = await svc.proxyRequest(streamOpts());

      expect(result.meta.fallbackFromModel).toBeUndefined();
      expect(result.forward.response.status).toBe(200);
      expect(deriveAutofixStatus(result.autofix)).toBe('retry_succeeded');
      expect(healingClient.reportOutcome).toHaveBeenCalledWith(
        'heal-1',
        { retryStatusCode: 200 },
        expect.anything(),
      );
      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
    });

    it('only warms up a healed retry that returned a streaming body', async () => {
      fallbackService.retryWireBody
        .mockResolvedValueOnce({
          response: new Response('{"error":{"message":"still bad"}}', { status: 400 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        } as never)
        .mockResolvedValueOnce({
          response: new Response(null, { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        } as never);

      const failed = await svc.proxyRequest(streamOpts());
      expect(deriveAutofixStatus(failed.autofix)).toBe('retry_failed');
      expect(failed.meta.fallbackFromModel).toBe('gpt-4o');

      const bodiless = await svc.proxyRequest(streamOpts());
      expect(deriveAutofixStatus(bodiless.autofix)).toBe('retry_succeeded');
      expect(mockedPeek).not.toHaveBeenCalled();
    });
  });

  describe('limit enforcement', () => {
    it('returns a friendly limit response when checkLimits flags an excess', async () => {
      limitCheck.checkLimits.mockResolvedValue({
        metricType: 'cost',
        actual: 500,
        threshold: 100,
        period: 'monthly',
      } as never);
      const result = await svc.proxyRequest(baseOpts());
      expect(result.forward.response.status).toBe(200);
      const body = await result.forward.response.text();
      expect(body).toContain('M200');
    });

    it('formats token-based limits without a dollar sign', async () => {
      limitCheck.checkLimits.mockResolvedValue({
        metricType: 'tokens',
        actual: 1_000,
        threshold: 500,
        period: 'daily',
      } as never);
      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();
      expect(body).toContain('M200');
    });

    it('skips limit checks when agentName is missing', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: null,
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      await svc.proxyRequest({ ...baseOpts(), agentName: undefined });
      expect(limitCheck.checkLimits).not.toHaveBeenCalled();
    });
  });

  describe('no route resolved', () => {
    it('returns a friendly no-provider response', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: null,
        fallback_routes: null,
        confidence: 0,
        score: 0,
        reason: 'scored',
      });
      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();
      expect(body).toContain('M101');
    });

    it('returns M302 when a pinned override names an unavailable model', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: null,
        fallback_routes: null,
        confidence: 0,
        score: 0,
        reason: 'scored',
        override_model_unavailable: 'gpt-6-astra',
      });
      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();
      expect(body).toContain('M302');
      expect(body).toContain('gpt-6-astra');
      expect(body).not.toContain('M101');
      expect(result.meta).toMatchObject({
        reason: 'model_not_available',
        manifest_error_code: 'M302',
      });
    });
  });

  describe('no credentials', () => {
    it('returns the M100 friendly response when no key exists', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      providerKeyService.selectProviderKey.mockResolvedValue(null);
      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();
      expect(body).toContain('M100');
      expect(body).toContain('No openai API key yet');
    });

    it('does NOT start a provider attempt when credentials fail with no fallback routes (no orphan row)', async () => {
      // With no chain to record it, a synthetic attempt would INSERT a pending
      // agent_messages row that nothing ever completes. The Manifest stub is the
      // sole record, so no provider attempt must be started.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      providerKeyService.selectProviderKey.mockResolvedValue(null);
      const startProviderAttempt = jest.fn(() => ({
        id: 'attempt-1',
        attemptNumber: 1,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
      }));

      const result = await svc.proxyRequest(baseOpts({ startProviderAttempt }));

      expect(startProviderAttempt).not.toHaveBeenCalled();
      expect(await result.forward.response.text()).toContain('M100');
    });

    it('starts the synthetic primary attempt only when a fallback chain will run', async () => {
      // Fallback routes exist → the chain records/completes the primary
      // credential-failure attempt, so starting it here is safe.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'api_key', 'claude-sonnet-4')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      providerKeyService.selectProviderKey.mockResolvedValue(null);
      fallbackService.tryFallbacks.mockResolvedValue({ success: null, failures: [] });
      const startProviderAttempt = jest.fn(() => ({
        id: 'attempt-1',
        attemptNumber: 1,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
      }));

      await svc.proxyRequest(baseOpts({ startProviderAttempt }));

      expect(startProviderAttempt).toHaveBeenCalledTimes(1);
      expect(startProviderAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'gpt-4o' }),
      );
    });

    it('returns M102 when a subscription OAuth blob cannot be refreshed', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-5.5'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      // Valid compact OAuth blob shape — unwrapToken fails (dead refresh).
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: JSON.stringify({ t: 'access', r: 'refresh', e: 0 }),
        id: 'up-oai',
        region: null,
        label: 'Default',
        priority: 0,
      });
      openaiOauth.unwrapToken.mockResolvedValue(null);

      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();

      expect(body).toContain('M102');
      expect(body).toContain('subscription credentials could not be refreshed');
      expect(body).toContain('openai');
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
    });

    it('enters the normal fallback chain when primary credentials fail', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-5.5'),
        fallback_routes: [
          route('minimax', 'api_key', 'MiniMax-M3'),
          route('zai', 'api_key', 'glm-5'),
        ],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: JSON.stringify({ t: 'access', r: 'refresh', e: 0 }),
        id: 'up-oai',
        region: null,
        label: 'Default',
        priority: 0,
      });
      openaiOauth.unwrapToken.mockResolvedValue(null);
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(200),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
          },
          model: 'MiniMax-M3',
          provider: 'minimax',
          fallbackIndex: 0,
          authType: 'api_key',
          tenantProviderId: 'up-mm',
        },
        failures: [],
      });

      const result = await svc.proxyRequest(baseOpts());

      // Primary is not rewritten to minimax — fallback chain is used instead.
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(fallbackService.tryFallbacks).toHaveBeenCalled();
      const call = fallbackService.tryFallbacks.mock.calls[0];
      expect(call[2]).toEqual(['MiniMax-M3', 'glm-5']); // fallback models
      expect(call[6]).toBe('gpt-5.5'); // primary model
      expect(call[8]).toBe('openai'); // primary provider
      expect(call[9]).toBe('subscription');
      expect(result.meta.fallbackFromModel).toBe('gpt-5.5');
      expect(result.meta.provider).toBe('minimax');
      expect(result.meta.primaryErrorBody).toContain('M102');
      expect(result.forward.response.status).toBe(200);
    });

    it('returns the primary M102 body when the fallback chain is exhausted', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-5.5'),
        fallback_routes: [route('minimax', 'api_key', 'MiniMax-M3')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: JSON.stringify({ t: 'access', r: 'refresh', e: 0 }),
        id: 'up-oai',
        region: null,
        label: 'Default',
        priority: 0,
      });
      openaiOauth.unwrapToken.mockResolvedValue(null);
      fallbackService.tryFallbacks.mockResolvedValue({ success: null, failures: [] });

      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();

      // Exhausted chain keeps the primary synthetic 401 (same as HTTP fallback
      // exhaustion) — the M102 message is on the body for attempt recording.
      expect(result.forward.response.status).toBe(401);
      expect(body).toContain('M102');
      expect(body).toContain('openai');
      expect(fallbackService.tryFallbacks).toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
    });

    it('returns the primary M100 body when the whole chain is dry (no keys)', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-5.5'),
        fallback_routes: [route('minimax', 'api_key', 'MiniMax-M3')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      providerKeyService.selectProviderKey.mockResolvedValue(null);
      fallbackService.tryFallbacks.mockResolvedValue({ success: null, failures: [] });

      const result = await svc.proxyRequest(baseOpts());
      const body = await result.forward.response.text();

      expect(result.forward.response.status).toBe(401);
      expect(body).toContain('M100');
      expect(body).toContain('openai');
      expect(fallbackService.tryFallbacks).toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
    });
  });

  describe('explicit model routing', () => {
    beforeEach(() => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('anthropic', 'api_key', 'claude-sonnet-4-5'),
        fallback_routes: [route('gemini', 'api_key', 'gemini-2.5-flash')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
    });

    it('routes a provider-qualified API-key model from the authenticated model list', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);

      const result = await svc.proxyRequest(
        baseOpts({
          body: {
            model: 'openai/gpt-4o-mini',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.2,
          },
        }),
      );

      expect(modelDiscovery.getModelsForAgent).toHaveBeenCalledWith('tenant-1', 'agent-1');
      expect(resolveService.resolve).not.toHaveBeenCalled();
      expect(providerKeyService.selectProviderKey).toHaveBeenCalledWith(
        'tenant-1',
        'openai',
        'api_key',
        undefined,
        'agent-1',
      );
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          authType: 'api_key',
          model: 'gpt-4o-mini',
          body: expect.objectContaining({ temperature: 0.2 }),
          paramMergeContext: undefined,
        }),
      );
      expect(modelParamsService.get).not.toHaveBeenCalled();
      expect(providerParamSpecs.getSpecs).not.toHaveBeenCalled();
      expect(result.meta).toMatchObject({
        tier: 'direct',
        reason: 'direct',
        provider: 'openai',
        auth_type: 'api_key',
        model: 'gpt-4o-mini',
      });
      expect(result.meta.request_params).toBeNull();
    });

    it('routes subscription IDs by removing only the SDK suffix', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-5.5', provider: 'openai', authType: 'subscription' }),
      ]);

      await svc.proxyRequest(
        baseOpts({
          body: {
            model: 'openai/gpt-5.5-subscription',
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(providerKeyService.selectProviderKey).toHaveBeenCalledWith(
        'tenant-1',
        'openai',
        'subscription',
        undefined,
        'agent-1',
      );
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-5.5',
        }),
      );
    });

    it('preserves slash-containing provider-native model IDs', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({
          id: 'anthropic/claude-sonnet-4.5',
          provider: 'openrouter',
          authType: 'api_key',
        }),
      ]);

      await svc.proxyRequest(
        baseOpts({
          body: {
            model: 'openrouter/anthropic/claude-sonnet-4.5',
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openrouter',
          authType: 'api_key',
          model: 'anthropic/claude-sonnet-4.5',
        }),
      );
    });

    it('routes custom model IDs unchanged', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({
          id: 'custom:provider-1/model-a',
          provider: 'custom:provider-1',
          authType: 'api_key',
        }),
      ]);

      await svc.proxyRequest(
        baseOpts({
          body: {
            model: 'custom:provider-1/model-a',
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'custom:provider-1',
          authType: 'api_key',
          model: 'custom:provider-1/model-a',
        }),
      );
    });

    it('leaves auto on the existing resolver path', async () => {
      await svc.proxyRequest(
        baseOpts({
          body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );

      expect(modelDiscovery.getModelsForAgent).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          authType: 'api_key',
          model: 'claude-sonnet-4-5',
        }),
      );
    });

    it('routes a bare provider-native model name to the one connection carrying it', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);

      await svc.proxyRequest(
        baseOpts({
          body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );

      expect(resolveService.resolve).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', authType: 'api_key', model: 'gpt-4o-mini' }),
      );
    });

    it('returns model-not-available for a model no connection carries', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);

      const result = await svc.proxyRequest(
        baseOpts({
          body: { model: 'some-retired-model', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );
      const body = await result.forward.response.text();

      expect(resolveService.resolve).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(body).toContain('M302');
      expect(body).toContain('some-retired-model');
      expect(body).toContain('not available for this agent');
      expect(body).not.toContain('M101');
      expect(result.meta).toMatchObject({
        reason: 'model_not_available',
        manifest_error_code: 'M302',
      });
      expect(autofixService.maybeHeal).not.toHaveBeenCalled();
    });

    it('prefers the subscription when one provider carries a bare name on both auths', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'api_key' }),
        discoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'subscription' }),
      ]);

      const result = await svc.proxyRequest(
        baseOpts({ body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } }),
      );

      expect(resolveService.resolve).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', authType: 'subscription', model: 'gpt-4o' }),
      );
      expect(result.meta.manifest_error_code).toBeUndefined();
    });

    it('surfaces a subscription failure to the caller without falling back to the api_key', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'api_key' }),
        discoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'subscription' }),
      ]);
      // Break the subscription credentials: the caller pinned the model, so
      // the error is theirs to see — Manifest must not meter the key instead.
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: JSON.stringify({ t: 'access', r: 'refresh', e: 0 }),
        id: 'up-oai',
        region: null,
        label: 'Default',
        priority: 0,
      });
      openaiOauth.unwrapToken.mockResolvedValue(null);

      const result = await svc.proxyRequest(
        baseOpts({ body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } }),
      );
      const body = await result.forward.response.text();

      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
      expect(body).toContain('M102');
      expect(body).toContain('subscription credentials could not be refreshed');
    });

    it('returns model-not-available when two providers carry the same bare name', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'subscription' }),
        discoveredModel({ id: 'gpt-4o', provider: 'azure', authType: 'api_key' }),
      ]);

      const result = await svc.proxyRequest(
        baseOpts({ body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } }),
      );
      const body = await result.forward.response.text();

      expect(resolveService.resolve).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(body).toContain('M302');
      expect(body).toContain('gpt-4o');
    });

    it('forwards an uncatalogued provider-qualified model through a connected provider', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'openai' && candidate.authType === 'api_key',
      );

      const result = await svc.proxyRequest(
        baseOpts({
          body: { model: 'openai/gpt-new', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          authType: 'api_key',
          model: 'gpt-new',
        }),
      );
      expect(result.meta).toMatchObject({
        tier: 'direct',
        provider: 'openai',
        auth_type: 'api_key',
        model: 'gpt-new',
      });
      expect(result.meta.manifest_error_code).toBeUndefined();
    });

    it('preserves the provider-native path when passing an uncatalogued gateway model through', async () => {
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'openrouter' && candidate.authType === 'api_key',
      );

      await svc.proxyRequest(
        baseOpts({
          body: {
            model: 'openrouter/anthropic/claude-new',
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openrouter',
          authType: 'api_key',
          model: 'anthropic/claude-new',
        }),
      );
    });

    it('uses a connected subscription for an uncatalogued subscription model id', async () => {
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'openai' && candidate.authType === 'subscription',
      );

      await svc.proxyRequest(
        baseOpts({
          body: {
            model: 'openai/gpt-new-subscription',
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          authType: 'subscription',
          model: 'gpt-new',
        }),
      );
    });

    it('forwards an uncatalogued bare model only when one inferred auth route is connected', async () => {
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'anthropic' && candidate.authType === 'subscription',
      );

      await svc.proxyRequest(
        baseOpts({
          apiMode: 'messages',
          body: {
            model: 'claude-new',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          authType: 'subscription',
          model: 'claude-new',
        }),
      );
    });

    it('keeps M302 for an uncatalogued bare model spanning multiple auth connections', async () => {
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'openai' &&
          (candidate.authType === 'api_key' || candidate.authType === 'subscription'),
      );

      const result = await svc.proxyRequest(
        baseOpts({
          body: { model: 'gpt-new', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );
      const body = await result.forward.response.text();

      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(body).toContain('M302');
      expect(result.meta.manifest_error_code).toBe('M302');
      expect(autofixService.maybeHeal).not.toHaveBeenCalled();
    });

    it('sends the real provider model-not-found response to Autofix', async () => {
      providerKeyService.hasRouteCredentials.mockImplementation(
        async (_tenantId, candidate) =>
          candidate.provider === 'openai' && candidate.authType === 'api_key',
      );
      const wireRequestBody = {
        model: 'gpt-new',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const providerFailure = {
        response: new Response(
          JSON.stringify({
            error: {
              message: 'The model `gpt-new` does not exist',
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
        wireRequestBody,
        wireApiMode: 'chat_completions' as const,
        retryWireBody: jest.fn(),
        providerCallStarted: true,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
      fallbackService.tryForwardToProvider.mockResolvedValue(providerFailure);

      const result = await svc.proxyRequest(
        baseOpts({
          body: { model: 'openai/gpt-new', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );

      expect(autofixService.maybeHeal).toHaveBeenCalledWith(
        expect.objectContaining({
          forward: providerFailure,
          provider: 'openai',
          model: 'gpt-new',
          authType: 'api_key',
          requestBody: wireRequestBody,
        }),
      );
      expect(result.forward).toBe(providerFailure);
      expect(result.meta.manifest_error_code).toBeUndefined();
    });

    // A header rule is an override the operator configured on purpose; the
    // `model` field is mandatory in every OpenAI SDK, so it cannot outrank it.
    it('lets a matching header tier outrank the explicit model', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);
      resolveService.resolveHeaderTier.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-5.4-nano'),
        fallback_routes: null,
        confidence: 1,
        score: 0,
        reason: 'header-match',
        header_tier_id: 'ht-1',
        header_tier_name: 'Groceries',
      });

      await svc.proxyRequest(
        baseOpts({
          body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
          headers: { 'x-manifest-tag': 'groceries' },
        }),
      );

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'gpt-5.4-nano' }),
      );
    });

    it('routes the explicit model when no header tier matches', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);

      await svc.proxyRequest(
        baseOpts({
          body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
          headers: { 'x-manifest-tag': 'unmatched' },
        }),
      );

      expect(resolveService.resolveHeaderTier).toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'gpt-4o-mini' }),
      );
    });

    it.each([
      ['provider-qualified', 'openai/gpt-5.5', 'openai', 'gpt-5.5'],
      ['provider-native', 'claude-haiku-4-5', 'anthropic', 'claude-haiku-4-5'],
    ])(
      'routes a %s model from an Anthropic Messages request',
      async (_kind, requestedModel, provider, model) => {
        modelDiscovery.getModelsForAgent.mockResolvedValue([
          discoveredModel({ id: model, provider, authType: 'api_key' }),
        ]);

        await svc.proxyRequest(
          baseOpts({
            apiMode: 'messages',
            body: {
              model: requestedModel,
              max_tokens: 32,
              messages: [{ role: 'user', content: 'hi' }],
            },
          }),
        );

        expect(modelDiscovery.getModelsForAgent).toHaveBeenCalledWith('tenant-1', 'agent-1');
        expect(resolveService.resolveLazy).not.toHaveBeenCalled();
        expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            provider,
            authType: 'api_key',
            model,
          }),
        );
      },
    );

    it('returns model-not-available for an unknown Anthropic Messages model', async () => {
      const result = await svc.proxyRequest(
        baseOpts({
          apiMode: 'messages',
          body: {
            model: 'bogus/does-not-exist',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );
      const body = await result.forward.response.text();

      expect(resolveService.resolveLazy).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).not.toHaveBeenCalled();
      expect(body).toContain('M302');
      expect(body).toContain('bogus/does-not-exist');
      expect(result.meta).toMatchObject({
        reason: 'model_not_available',
        manifest_error_code: 'M302',
      });
    });

    it('leaves auto on the existing Anthropic Messages resolver path', async () => {
      await svc.proxyRequest(
        baseOpts({
          apiMode: 'messages',
          body: {
            model: 'auto',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          },
        }),
      );

      expect(modelDiscovery.getModelsForAgent).not.toHaveBeenCalled();
      expect(resolveService.resolveLazy).toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          authType: 'api_key',
          model: 'claude-sonnet-4-5',
        }),
      );
    });

    it('does not trigger Manifest fallbacks for explicit model failures', async () => {
      modelDiscovery.getModelsForAgent.mockResolvedValue([
        discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
      ]);
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('upstream broken', { status: 502 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await svc.proxyRequest(
        baseOpts({
          body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        }),
      );

      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
      expect(result.forward.response.status).toBe(502);
      expect(result.meta).toMatchObject({
        tier: 'direct',
        reason: 'direct',
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
      expect(result.meta.fallbackFromModel).toBeUndefined();
    });

    /**
     * Regression (#key-label-pin): an explicit `model` bypasses tier
     * resolution, so it used to drop the operator's connection pin and bill
     * whichever key sorted first.
     */
    describe('connection pin', () => {
      const connections = [
        { id: 'up-default', label: 'Default', priority: 0, apiKey: 'sk-default', region: null },
        { id: 'up-work', label: 'Work', priority: 1, apiKey: 'sk-work', region: null },
      ];

      beforeEach(() => {
        modelDiscovery.getModelsForAgent.mockResolvedValue([
          discoveredModel({ id: 'gpt-4o-mini', provider: 'openai', authType: 'api_key' }),
        ]);
        // Mirrors ProviderKeyService.selectProviderKey: case-insensitive label
        // match, else the first (priority-ordered) key.
        providerKeyService.selectProviderKey.mockImplementation(
          async (_tenantId, _provider, _authType, label) =>
            connections.find((c) => c.label.toLowerCase() === label?.toLowerCase()) ??
            connections[0],
        );
      });

      it("uses the default tier's pinned connection for a concrete model name", async () => {
        resolveService.pinRouteKeyLabel.mockImplementation(async (_a, _t, route) => ({
          ...route,
          keyLabel: 'Work',
        }));

        const result = await svc.proxyRequest(
          baseOpts({
            body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
          }),
        );

        expect(resolveService.pinRouteKeyLabel).toHaveBeenCalledWith(
          'agent-1',
          'tenant-1',
          expect.objectContaining({ provider: 'openai', authType: 'api_key' }),
        );
        expect(providerKeyService.selectProviderKey).toHaveBeenCalledWith(
          'tenant-1',
          'openai',
          'api_key',
          'Work',
          'agent-1',
        );
        expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: 'sk-work',
            providerKeyLabel: 'Work',
            tenantProviderId: 'up-work',
          }),
        );
        expect(result.meta).toMatchObject({
          provider_key_label: 'Work',
          tenantProviderId: 'up-work',
        });
      });

      // A pin naming a renamed/deleted connection still serves the default key
      // (selectProviderKey's documented fallback) — the recorded label must
      // then name the row that was really used, not the dangling pin.
      it('records the connection actually used when the pin is stale', async () => {
        resolveService.pinRouteKeyLabel.mockImplementation(async (_a, _t, route) => ({
          ...route,
          keyLabel: 'Retired',
        }));

        const result = await svc.proxyRequest(
          baseOpts({
            body: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
          }),
        );

        expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: 'sk-default', tenantProviderId: 'up-default' }),
        );
        expect(result.meta).toMatchObject({
          provider_key_label: 'Default',
          tenantProviderId: 'up-default',
        });
      });
    });
  });

  describe('happy path forward', () => {
    it('uses the redacted routing body for scoring while forwarding the original body', async () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,aGVsbG8=' },
              },
            ],
          },
        ],
        stream: false,
      };
      const routingBody = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image' },
              {
                type: 'image_url',
                image_url: { url: '[inline image: image/png, 5 bytes, 8 base64 chars]' },
              },
            ],
          },
        ],
        stream: false,
      };
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(baseOpts({ body, routingBody }));

      const [, , scoringMessages] = resolveService.resolve.mock.calls[0];
      expect(scoringMessages).toEqual(routingBody.messages);
      expect(fallbackService.tryForwardToProvider.mock.calls[0][0].body).toBe(body);
    });

    it('reuses one converted Responses body for routing and forwarding', async () => {
      const body = {
        input: 'Describe this image',
        tools: [
          {
            type: 'function',
            name: 'inspect_image',
            parameters: { type: 'object', properties: {} },
          },
        ],
        stream: false,
      };
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const validateSpy = jest.spyOn(
        svc as unknown as { validatePayload: (body: Record<string, unknown>) => void },
        'validatePayload',
      );
      const convertSpy = jest.spyOn(
        svc as unknown as {
          toChatBody: (apiMode: string, body: Record<string, unknown>) => Record<string, unknown>;
        },
        'toChatBody',
      );

      await svc.proxyRequest(baseOpts({ body, apiMode: 'responses' } as never));

      const resolveChatBody = fallbackService.tryForwardToProvider.mock.calls[0][0].resolveChatBody;
      expect(resolveChatBody).toBeDefined();
      const forwardedBody = await resolveChatBody!();
      const repeatedBody = await resolveChatBody!();
      expect(validateSpy).toHaveBeenCalledTimes(1);
      expect(convertSpy).toHaveBeenCalledTimes(1);
      expect(repeatedBody).toBe(forwardedBody);
      expect(forwardedBody.messages).toEqual([{ role: 'user', content: 'Describe this image' }]);
      expect(resolveService.resolve.mock.calls[0][3]).toEqual([
        {
          type: 'function',
          function: {
            name: 'inspect_image',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]);
    });

    it('returns the forward result and records tier momentum on a 200 non-stream response', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await svc.proxyRequest(baseOpts());
      expect(result.meta.tier).toBe('standard');
      expect(result.meta.model).toBe('gpt-4o');
      expect(result.meta.provider).toBe('openai');
      expect(momentum.recordTier).toHaveBeenCalledWith('momentum-sess-1', 'standard');
    });

    it('skips routing momentum when the caller did not supply a session key', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(baseOpts({ sessionMomentumKey: undefined }));

      expect(momentum.getRecentTiers).not.toHaveBeenCalled();
      expect(momentum.getRecentCategories).not.toHaveBeenCalled();
      expect(momentum.recordTier).not.toHaveBeenCalled();
      expect(momentum.recordCategory).not.toHaveBeenCalled();
    });

    it('passes the raw stored OpenAI OAuth blob alongside the unwrapped access token', async () => {
      const rawBlob = JSON.stringify({
        t: 'cached-access',
        r: 'refresh-token',
        e: Date.now() + 10 * 60 * 1000,
      });
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: { ...route('openai', 'subscription', 'gpt-5.3-codex'), keyLabel: 'Work' },
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      // The single key selection surfaces the stored OAuth blob; the subscription
      // re-read path then re-fetches the freshest blob for the 401-retry rawApiKey.
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: rawBlob,
        id: 'up-default',
        region: null,
        label: 'Work',
        priority: 0,
      });
      providerKeyService.getProviderApiKey.mockResolvedValue(rawBlob);
      openaiOauth.unwrapToken.mockResolvedValue('cached-access');
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      });

      await svc.proxyRequest(baseOpts());

      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          authType: 'subscription',
          apiKey: 'cached-access',
          rawApiKey: rawBlob,
          providerKeyLabel: 'Work',
          agentId: 'agent-1',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('passes the latest stored OAuth blob after preflight refresh rotates tokens', async () => {
      const staleBlob = JSON.stringify({
        t: 'stale-access',
        r: 'stale-refresh',
        e: Date.now() - 10 * 60 * 1000,
      });
      const refreshedBlob = JSON.stringify({
        t: 'fresh-access',
        r: 'rotated-refresh',
        e: Date.now() + 10 * 60 * 1000,
      });
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: { ...route('openai', 'subscription', 'gpt-5.3-codex'), keyLabel: 'Work' },
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      // selectProviderKey surfaces the stale blob (used for the preflight unwrap);
      // the subscription re-read then returns the rotated blob for the retry path.
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: staleBlob,
        id: 'up-default',
        region: null,
        label: 'Work',
        priority: 0,
      });
      providerKeyService.getProviderApiKey.mockResolvedValue(refreshedBlob);
      openaiOauth.unwrapToken.mockResolvedValue('fresh-access');
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      });

      await svc.proxyRequest(baseOpts());

      // Single selection + a single subscription re-read for the freshest blob.
      expect(providerKeyService.selectProviderKey).toHaveBeenCalledTimes(1);
      expect(providerKeyService.getProviderApiKey).toHaveBeenCalledTimes(1);
      expect(fallbackService.tryForwardToProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          authType: 'subscription',
          apiKey: 'fresh-access',
          rawApiKey: refreshedBlob,
          providerKeyLabel: 'Work',
        }),
      );
    });

    it('records the specificity category when the route originates from specificity', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 0,
        reason: 'specificity',
        specificity_category: 'coding',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      await svc.proxyRequest(baseOpts());
      expect(momentum.recordCategory).toHaveBeenCalledWith('momentum-sess-1', 'coding');
    });

    it('skips category recording for unknown values', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 0,
        reason: 'specificity',
        specificity_category: 'not-a-category' as never,
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      await svc.proxyRequest(baseOpts());
      expect(momentum.recordCategory).not.toHaveBeenCalled();
    });

    it('hands the fallback service a paramMergeContext carrying the agent and route scope', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('deepseek', 'api_key', 'deepseek-v4-flash'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(baseOpts());
      const call = fallbackService.tryForwardToProvider.mock.calls[0][0];
      // Body stays raw — the merge happens per-attempt inside the fallback
      // service so each fallback iteration looks up its own scoped route.
      expect(call.body).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
      expect(call.paramMergeContext).toEqual({ agentId: 'agent-1', scopeKey: 'tier:standard' });
    });

    it('looks up the primary route model params for the snapshot', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('deepseek', 'api_key', 'deepseek-v4-flash'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      modelParamsService.get.mockResolvedValueOnce({ thinking: { type: 'enabled' } });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(baseOpts());
      expect(modelParamsService.get).toHaveBeenCalledWith(
        'agent-1',
        'tier:standard',
        'deepseek',
        'api_key',
        'deepseek-v4-flash',
      );
    });

    // Snapshot lookup must use the same normalized model id as the forward.
    // Anthropic strips dots (claude-sonnet-4.6 -> claude-sonnet-4-6); using
    // route.model would key the snapshot off a different row than the wire,
    // letting metadata drift from what was actually sent.
    it('snapshot lookup uses the normalized model id for Anthropic so it matches the forward', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('anthropic', 'api_key', 'claude-sonnet-4.6'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });

      await svc.proxyRequest(baseOpts());
      expect(modelParamsService.get).toHaveBeenCalledWith(
        'agent-1',
        'tier:standard',
        'anthropic',
        'api_key',
        'claude-sonnet-4-6',
      );
    });

    it('passes the inbound body through unchanged so the per-attempt merge can re-merge each fallback', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('deepseek', 'api_key', 'deepseek-v4-flash'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(
        baseOpts({
          body: {
            messages: [{ role: 'user', content: 'hi' }],
            thinking: { type: 'enabled' },
          } as never,
        }),
      );
      // The body still carries the client-supplied thinking field; the
      // fallback service applies the resolved Manifest params last.
      expect(fallbackService.tryForwardToProvider.mock.calls[0][0].body.thinking).toEqual({
        type: 'enabled',
      });
    });

    it('does not record momentum for non-scoring tiers (e.g. "default")', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'default',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 1,
        score: 0,
        reason: 'default',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      await svc.proxyRequest(baseOpts());
      expect(momentum.recordTier).not.toHaveBeenCalled();
    });

    // Telemetry snapshot proofs. The `RoutingMeta.request_params` field
    // drives the per-row Model Parameters accordion in the dashboard; these
    // tests pin (a) it gets populated for the primary provider on success,
    // (b) the snapshot is re-derived per provider so a fallback record
    // never carries another vendor's knob, and (c) providers without a
    // known param key (today: anything that isn't DeepSeek for `thinking`)
    // produce a null snapshot so existing rows stay clean.
    it("populates meta.request_params with the provider's effective default for known keys (DeepSeek thinking enabled)", async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('deepseek', 'api_key', 'deepseek-v4-flash'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const result = await svc.proxyRequest(baseOpts());
      // No saved per-model params for this attempt, so the snapshot
      // records the provider's own natural API default. DeepSeek's
      // silent default is `enabled`.
      expect(result.meta.request_params).toEqual({ thinking: { type: 'enabled' } });
    });

    it("snapshot reflects the user's stored override when present", async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('deepseek', 'api_key', 'deepseek-v4-flash'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      modelParamsService.get.mockResolvedValueOnce({ thinking: { type: 'enabled' } });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const result = await svc.proxyRequest(baseOpts());
      expect(result.meta.request_params).toEqual({ thinking: { type: 'enabled' } });
    });

    it('snapshot is null when the resolved model has no DB-backed param specs', async () => {
      // Forward-compat property: models that never appear in the DB-backed
      // spec catalog produce a null snapshot. New params light up by adding
      // MPS catalog entries — no proxy code needed.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const result = await svc.proxyRequest(baseOpts());
      expect(result.meta.request_params).toBeNull();
    });
  });

  describe('fallback chain on non-2xx responses', () => {
    beforeEach(() => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'api_key', 'claude')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
    });

    it('triggers the fallback chain on a 502 response', async () => {
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('upstream broken', { status: 502 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
        },
        failures: [],
      } as never);

      const result = await svc.proxyRequest(baseOpts());
      expect(result.meta.fallbackFromModel).toBe('gpt-4o');
      expect(result.meta.provider).toBe('anthropic');
      expect(result.meta.primaryProvider).toBe('openai');
    });

    it('triggers the fallback chain on a provider timeout response', async () => {
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('upstream timed out', { status: 504 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
        },
        failures: [],
      } as never);

      const result = await svc.proxyRequest(baseOpts());

      expect(fallbackService.tryFallbacks).toHaveBeenCalled();
      expect(result.forward.response.status).toBe(200);
      expect(result.meta.fallbackFromModel).toBe('gpt-4o');
    });

    it('triggers fallback on provider context length errors', async () => {
      const message =
        "This model's maximum context length is 262144 tokens. However, your messages resulted in 334146 tokens.";
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response(
          JSON.stringify({
            error: {
              message,
              code: 'context_length_exceeded',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
        },
        failures: [],
      } as never);

      const result = await svc.proxyRequest(baseOpts());

      expect(fallbackService.tryFallbacks).toHaveBeenCalled();
      expect(result.forward.response.status).toBe(200);
      expect(result.meta.fallbackFromModel).toBe('gpt-4o');
      expect(result.meta.provider).toBe('anthropic');
    });

    it('returns the successful fallback auth_type, not the primary auth_type (#1173)', async () => {
      // Mixed-auth chain: primary openai/api_key fails, fallback
      // anthropic/subscription succeeds. The recorder reads meta.auth_type to
      // compute cost_usd (subscription => 0, api_key => priced). Returning
      // the primary's auth_type here charges or zeros the wrong row.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'subscription', 'claude')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('rate limited', { status: 429 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
          authType: 'subscription',
        },
        failures: [],
      } as never);

      const result = await svc.proxyRequest(baseOpts());
      // Successful fallback row needs the FALLBACK's auth_type for correct cost.
      expect(result.meta.auth_type).toBe('subscription');
      // Primary failure row (recorded later by the response handler) needs the
      // PRIMARY's auth_type — preserved separately so we don't lose it.
      expect(result.meta.primaryAuthType).toBe('api_key');
    });

    it('records the api_key fallback auth_type when a subscription primary fails (#1173 inverse)', async () => {
      // Inverse of the previous case: subscription primary fails to a billed
      // api_key fallback. Without the fix, the success row would carry
      // auth_type=subscription and write cost_usd=0 for what was actually
      // a paid API call.
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'subscription', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'api_key', 'claude')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('subscription expired', { status: 503 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
          authType: 'api_key',
        },
        failures: [],
      } as never);

      const result = await svc.proxyRequest(baseOpts());
      expect(result.meta.auth_type).toBe('api_key');
      expect(result.meta.primaryAuthType).toBe('subscription');
    });

    it('does not trigger fallback when the primary returns 200', async () => {
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(200),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const result = await svc.proxyRequest(baseOpts());
      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
      expect(result.forward.response.status).toBe(200);
    });

    it('returns the primary error rebuilt when all fallbacks fail', async () => {
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('upstream broken', { status: 503 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: null,
        failures: [
          {
            model: 'claude',
            provider: 'anthropic',
            fallbackIndex: 0,
            status: 503,
            errorBody: 'fallback also broken',
          },
        ],
      } as never);

      const result = await svc.proxyRequest(baseOpts());
      expect(result.forward.response.status).toBe(503);
      expect(result.failedFallbacks).toHaveLength(1);
    });

    it('falls through to the resolver-provided fallback_routes', async () => {
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('boom', { status: 500 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
        },
        failures: [],
      } as never);

      await svc.proxyRequest(baseOpts());
      expect(fallbackService.tryFallbacks).toHaveBeenCalled();
    });

    it('skips non-stream fallback routes when response mode is stream', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [
          route('openai', 'api_key', 'gpt-image-1'),
          route('anthropic', 'api_key', 'claude'),
        ],
        response_mode: 'stream',
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('boom', { status: 500 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        attempt: { id: 'primary-attempt' } as never,
        providerCallStarted: true,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: null,
        failures: [],
      } as never);

      const result = await svc.proxyRequest(baseOpts());

      const call = fallbackService.tryFallbacks.mock.calls[0];
      expect(call[2]).toEqual(['claude']);
      expect(call[14]).toEqual([route('anthropic', 'api_key', 'claude')]);
      // When every eligible fallback fails before invoking a provider, the
      // terminal response still records the primary provider call.
      expect(result.meta.attempt).toEqual({ id: 'primary-attempt' });
      expect(result.meta.providerCallStarted).toBe(true);
    });

    it('does not retry a lifted stream fallback as its own fallback', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('anthropic', 'api_key', 'claude'),
        fallback_routes: null,
        response_mode: 'stream',
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('boom', { status: 500 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await svc.proxyRequest(baseOpts());

      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
      expect(result.forward.response.status).toBe(500);
    });

    it('does not reload persisted fallbacks when the resolver returned null', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        // This route represents a configured fallback promoted to primary.
        route: route('anthropic', 'api_key', 'claude'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('boom', { status: 500 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await svc.proxyRequest(baseOpts());
      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
      expect(result.forward.response.status).toBe(500);
    });

    it('returns the primary error when the resolver provides no fallback routes', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: new Response('boom', { status: 500 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await svc.proxyRequest(baseOpts());
      // tryFallbacks not called because fallbackRoutes is empty.
      expect(fallbackService.tryFallbacks).not.toHaveBeenCalled();
      expect(result.forward.response.status).toBe(500);
    });
  });

  describe('stream warmup', () => {
    beforeEach(() => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: [route('anthropic', 'api_key', 'claude')],
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
    });

    it('returns the peeked stream when warmup succeeds', async () => {
      const streamRes = new Response(new ReadableStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      const attempt = { id: 'attempt-stream' } as never;
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: streamRes,
        attempt,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      mockedPeek.mockResolvedValue({
        ok: true,
        stream: new ReadableStream(),
      } as never);

      const result = await svc.proxyRequest({
        ...baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }], stream: true } }),
      });
      expect(result.forward.response.status).toBe(200);
      expect(result.forward.attempt).toBe(attempt);
      expect(mockedPeek).toHaveBeenCalledWith(streamRes.body, 15_000);
      expect(momentum.recordTier).toHaveBeenCalled();
    });

    it('falls back to the chain when warmup fails', async () => {
      const streamRes = new Response(new ReadableStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: streamRes,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      mockedPeek.mockResolvedValue({
        ok: false,
        reason: 'timeout',
        message: 'peek timeout',
      } as never);
      fallbackService.tryFallbacks.mockResolvedValue({
        success: {
          forward: {
            response: okResponse(),
            isGoogle: false,
            isAnthropic: true,
            isChatGpt: false,
          },
          model: 'claude',
          provider: 'anthropic',
          fallbackIndex: 0,
        },
        failures: [],
      } as never);

      const result = await svc.proxyRequest(
        baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }], stream: true } }),
      );
      expect(result.meta.fallbackFromModel).toBe('gpt-4o');
    });

    it('returns the synthetic 502 when warmup fails and no fallbacks are available', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const streamRes = new Response(new ReadableStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: streamRes,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      mockedPeek.mockResolvedValue({
        ok: false,
        reason: 'closed',
        message: 'closed before data',
      } as never);

      const result = await svc.proxyRequest(
        baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }], stream: true } }),
      );
      expect(result.forward.response.status).toBe(502);
    });
    it('preserves isResponses on the peeked stream (warmup success path)', async () => {
      const streamRes = new Response(new ReadableStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: streamRes,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        isResponses: true,
      });
      mockedPeek.mockResolvedValue({ ok: true, stream: new ReadableStream() } as never);

      const result = await svc.proxyRequest(
        baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }], stream: true } }),
      );
      expect(result.forward.isResponses).toBe(true);
    });

    it('preserves isResponses on the synthetic 502 forward (warmup failure, no fallbacks)', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const streamRes = new Response(new ReadableStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: streamRes,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        isResponses: true,
      });
      mockedPeek.mockResolvedValue({
        ok: false,
        reason: 'closed',
        message: 'closed before data',
      } as never);

      const result = await svc.proxyRequest(
        baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }], stream: true } }),
      );
      expect(result.forward.isResponses).toBe(true);
    });

    it('preserves isResponses on the rebuilt forward when fallbacks are exhausted', async () => {
      const streamRes = new Response('upstream error', {
        status: 500,
        headers: { 'content-type': 'text/event-stream' },
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: streamRes,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        isResponses: true,
      });
      fallbackService.tryFallbacks.mockResolvedValue({
        success: null,
        failures: [{ model: 'claude', provider: 'anthropic', status: 500, error: 'upstream' }],
      } as never);

      const result = await svc.proxyRequest(
        baseOpts({ body: { messages: [{ role: 'user', content: 'hi' }] } }),
      );
      expect(result.forward.isResponses).toBe(true);
    });
  });

  describe('routing dispatch', () => {
    it('treats non-array messages from a healed body as empty scorer input', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      const resolveRouting = (
        svc as unknown as {
          resolveRouting: (
            agentId: string,
            tenantId: string,
            body: Record<string, unknown>,
            resolveChatBody: undefined,
            sessionKey: string,
            specificityOverride: undefined,
            headers: undefined,
            apiMode: 'chat_completions',
          ) => Promise<unknown>;
        }
      ).resolveRouting.bind(svc);

      await resolveRouting(
        'agent-1',
        'tenant-1',
        { messages: { malformed: true } },
        undefined,
        'session-1',
        undefined,
        undefined,
        'chat_completions',
      );

      expect(resolveService.resolve.mock.calls[0][2]).toEqual([]);
    });

    it('keeps native Messages unconverted when routing does not request scorer input', async () => {
      resolveService.resolveLazy.mockResolvedValue({
        tier: 'default',
        route: route('anthropic', 'api_key', 'claude-sonnet-4-5'),
        fallback_routes: null,
        confidence: 1,
        score: 0,
        reason: 'default',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });
      const convertSpy = jest.spyOn(
        svc as unknown as {
          toChatBody: (apiMode: string, body: Record<string, unknown>) => Record<string, unknown>;
        },
        'toChatBody',
      );

      await svc.proxyRequest(
        baseOpts({
          apiMode: 'messages',
          body: {
            model: 'auto',
            messages: [{ role: 'user', content: 'Hello' }],
          },
        } as never),
      );

      expect(convertSpy).not.toHaveBeenCalled();
      expect(fallbackService.tryForwardToProvider.mock.calls[0][0].body).toEqual({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('invokes resolveForTier with simple when the last user message contains HEARTBEAT_OK', async () => {
      resolveService.resolveForTier.mockResolvedValue({
        tier: 'simple',
        route: route('openai', 'api_key', 'gpt-4o-mini'),
        fallback_routes: null,
        confidence: 1,
        score: 0,
        reason: 'heartbeat',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(
        baseOpts({
          body: { messages: [{ role: 'user', content: 'HEARTBEAT_OK' }] },
        }),
      );
      expect(resolveService.resolveForTier).toHaveBeenCalledWith('agent-1', 'tenant-1', 'simple');
      expect(resolveService.resolve).not.toHaveBeenCalled();
    });

    it('detects Responses heartbeats without resolving a Chat Completions body', async () => {
      resolveService.resolveForTier.mockResolvedValue({
        tier: 'simple',
        route: route('openai', 'api_key', 'gpt-4o-mini'),
        fallback_routes: null,
        confidence: 1,
        score: 0,
        reason: 'heartbeat',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const convertSpy = jest.spyOn(
        svc as unknown as {
          toChatBody: (apiMode: string, body: Record<string, unknown>) => Record<string, unknown>;
        },
        'toChatBody',
      );

      await svc.proxyRequest(
        baseOpts({
          apiMode: 'responses',
          body: { input: 'HEARTBEAT_OK' },
        } as never),
      );

      expect(resolveService.resolveForTier).toHaveBeenCalledWith('agent-1', 'tenant-1', 'simple');
      expect(convertSpy).not.toHaveBeenCalled();
    });

    it('detects Responses heartbeats across native input item shapes', () => {
      const detectHeartbeatBody = (
        svc as unknown as {
          detectHeartbeatBody: (body: Record<string, unknown>, apiMode: string) => boolean;
        }
      ).detectHeartbeatBody.bind(svc);

      expect(detectHeartbeatBody({}, 'responses')).toBe(false);
      expect(detectHeartbeatBody({ messages: 'invalid' }, 'chat_completions')).toBe(false);
      expect(detectHeartbeatBody({ input: ['HEARTBEAT_OK'] }, 'responses')).toBe(true);
      expect(detectHeartbeatBody({ input: ['HEARTBEAT_OK', 42] }, 'responses')).toBe(true);
      expect(detectHeartbeatBody({ input: [{ content: 'HEARTBEAT_OK' }] }, 'responses')).toBe(true);
      expect(
        detectHeartbeatBody({ input: [{ role: 'user', content: 'HEARTBEAT_OK' }] }, 'responses'),
      ).toBe(true);
      expect(
        detectHeartbeatBody(
          { input: [{ role: 'user', content: { custom: 'object' } }] },
          'responses',
        ),
      ).toBe(false);
      expect(
        detectHeartbeatBody(
          {
            input: [
              null,
              [],
              { type: 'function_call' },
              { type: 'function_call_output' },
              { role: 'assistant', content: 'HEARTBEAT_OK' },
              {
                role: 'user',
                content: [null, 'ignored', [], { text: 'HEARTBEAT_OK' }],
              },
            ],
          },
          'responses',
        ),
      ).toBe(true);
      expect(
        detectHeartbeatBody(
          {
            input: [{ type: 'function_call' }, { role: 'assistant', content: 'HEARTBEAT_OK' }],
          },
          'responses',
        ),
      ).toBe(false);
    });

    it('detects HEARTBEAT_OK in array-content user messages', async () => {
      resolveService.resolveForTier.mockResolvedValue({
        tier: 'simple',
        route: route('openai', 'api_key', 'gpt-4o-mini'),
        fallback_routes: null,
        confidence: 1,
        score: 0,
        reason: 'heartbeat',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(
        baseOpts({
          body: {
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'something HEARTBEAT_OK' }],
              },
            ],
          },
        }),
      );
      expect(resolveService.resolveForTier).toHaveBeenCalledWith('agent-1', 'tenant-1', 'simple');
    });

    it('does not detect heartbeat when no user message exists', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(
        baseOpts({
          body: { messages: [{ role: 'system', content: 'sys-only' }] },
        }),
      );
      // No user message — fall to resolve(), not resolveForTier.
      expect(resolveService.resolve).toHaveBeenCalled();
    });

    it('returns false from heartbeat detection for non-string non-array content', async () => {
      // content is an object (e.g. an image-only payload) — falls through to
      // `return false` so we route via the regular resolver instead of
      // resolveForTier('simple').
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await svc.proxyRequest(
        baseOpts({
          body: {
            messages: [{ role: 'user', content: { custom: 'object' } }],
          },
        } as never),
      );
      expect(resolveService.resolveForTier).not.toHaveBeenCalled();
      expect(resolveService.resolve).toHaveBeenCalled();
    });

    it('exercises the per-request signature and thinking lookup closures', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockImplementation(async (opts) => {
        // Invoke the lookups so coverage hits the closure bodies.
        opts.signatureLookup?.('tool-call-1');
        opts.thinkingLookup?.('first-use-1');
        return {
          response: okResponse(),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        };
      });

      await svc.proxyRequest(baseOpts());
      expect(signatureCache.retrieve).toHaveBeenCalledWith('cache-sess-1', 'tool-call-1');
      expect(thinkingCache.retrieve).toHaveBeenCalledWith('cache-sess-1', 'first-use-1');
    });

    it('strips system / developer roles when scoring', async () => {
      resolveService.resolve.mockResolvedValue({
        tier: 'standard',
        route: route('openai', 'api_key', 'gpt-4o'),
        fallback_routes: null,
        confidence: 0.9,
        score: 5,
        reason: 'scored',
      });
      fallbackService.tryForwardToProvider.mockResolvedValue({
        response: okResponse(),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      await svc.proxyRequest(
        baseOpts({
          body: {
            messages: [
              { role: 'system', content: 'long-system-prompt' },
              { role: 'developer', content: 'developer-prompt' },
              { role: 'user', content: 'real-question' },
            ],
          },
        }),
      );
      const [, , scoringMessages] = resolveService.resolve.mock.calls[0];
      expect((scoringMessages as Array<{ role: string }>).every((m) => m.role === 'user')).toBe(
        true,
      );
    });
  });
});
