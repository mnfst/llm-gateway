import { Repository } from 'typeorm';
import { ProxyFallbackService, normalizeProviderModel } from '../proxy-fallback.service';
import { resolveApiKey } from '../oauth-credentials';
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
import { ReasoningContentCache } from '../reasoning-content-cache';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { AgentModelParamsService } from '../../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../../routing-core/provider-param-spec.service';
import { AutofixService } from '../../autofix/autofix.service';
import { CredentialHealthService } from '../../routing-core/credential-health.service';
import { getProviderParamSpecs, type ProviderParamSpecCatalog } from 'manifest-shared';

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

describe('ProxyFallbackService', () => {
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
  let modelParamsService: jest.Mocked<AgentModelParamsService>;
  let providerParamSpecs: jest.Mocked<ProviderParamSpecService>;
  let reasoningCache: jest.Mocked<Pick<ReasoningContentCache, 'prepareRequest'>>;
  let autofixService: jest.Mocked<AutofixService>;
  let credentialHealth: CredentialHealthService;

  beforeEach(() => {
    providerKeyService = {
      getProviderApiKey: jest.fn(),
      getProviderKeyId: jest.fn().mockResolvedValue('up-fallback'),
      getDefaultKeyLabel: jest.fn().mockResolvedValue(undefined),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      findProviderForModel: jest.fn().mockResolvedValue(undefined),
      getProviderRegion: jest.fn().mockResolvedValue(null),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      // Single key selection per attempt. By default the unified row composes
      // its fields from the other (legacy) mocks so existing test setups that
      // only drive getProviderApiKey/getProviderRegion/getProviderKeyId keep
      // working: the apiKey forwarded, the id stamped, and the region all come
      // from this one object. Tests that need divergent rows override it.
      selectProviderKey: jest.fn(
        async (
          tenantId: string,
          provider: string,
          authType?: string,
          label?: string,
          agentId?: string,
        ) => {
          const apiKey = await providerKeyService.getProviderApiKey(
            tenantId,
            provider,
            authType as never,
            label,
            agentId,
          );
          if (apiKey === null || apiKey === undefined) return null;
          const id = await providerKeyService.getProviderKeyId(
            tenantId,
            provider,
            authType as never,
            label,
            agentId,
          );
          const region = await providerKeyService.getProviderRegion(
            tenantId,
            provider,
            authType as never,
            label,
            agentId,
          );
          return {
            apiKey,
            id,
            region,
            label: label ?? 'Default',
            priority: 0,
          };
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
      getCopilotToken: jest.fn().mockResolvedValue('tid=copilot-session-token'),
    } as unknown as jest.Mocked<CopilotTokenService>;

    pricingCache = {
      getByModel: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<ModelPricingCacheService>;

    modelParamsService = {
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      set: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<AgentModelParamsService>;

    providerParamSpecs = {
      getSpecs: jest.fn(async (provider: string, authType: string, model: string) =>
        getProviderParamSpecs(specCatalog, provider, authType as 'api_key' | 'subscription', model),
      ),
      list: jest.fn().mockResolvedValue(specCatalog),
    } as unknown as jest.Mocked<ProviderParamSpecService>;

    reasoningCache = {
      prepareRequest: jest.fn(
        async (
          requestBody: Record<string, unknown>,
          _sessionKey: string,
          _endpointKey: string | null,
          _model: string,
        ) => requestBody,
      ),
    };

    autofixService = {
      isRepairable: jest.fn().mockReturnValue(false),
      maybeHeal: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AutofixService>;

    credentialHealth = new CredentialHealthService();

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
      reasoningCache as unknown as ReasoningContentCache,
      autofixService,
      credentialHealth,
    );
  });

  const body = { messages: [{ role: 'user', content: 'Hello' }], stream: false };

  describe('tryForwardToProvider', () => {
    it('returns forward result on success', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await service.tryForwardToProvider({
        provider: 'OpenAI',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        sessionKey: 'sess-1',
      });

      expect(result.response.ok).toBe(true);
    });

    it('passes Anthropic thinking lookup with route-specific replay context', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });
      const thinkingLookup = jest.fn();

      await service.tryForwardToProvider({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: 'anthropic/claude-sonnet-4.5',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        thinkingLookup,
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          thinkingLookup,
          thinkingRouteContext: {
            provider: 'anthropic',
            authType: 'subscription',
            model: 'anthropic/claude-sonnet-4.5',
          },
        }),
      );
    });

    it.each([
      {
        provider: 'openai',
        rawBlob: JSON.stringify({
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
        }),
        setup: () => openaiOauth.unwrapToken.mockResolvedValue('fresh-openai-token'),
        unwrap: () => openaiOauth.unwrapToken,
        expectedApiKey: 'fresh-openai-token',
      },
      {
        provider: 'minimax',
        rawBlob: JSON.stringify({
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
          u: 'https://api.minimax.io/anthropic/v1',
        }),
        setup: () =>
          minimaxOauth.unwrapToken.mockResolvedValue({
            t: 'fresh-minimax-token',
            r: 'refresh-token',
            e: Date.now() + 60 * 60 * 1000,
            u: 'https://api.minimax.io/anthropic/v1',
          }),
        unwrap: () => minimaxOauth.unwrapToken,
        expectedApiKey: 'fresh-minimax-token',
      },
      {
        provider: 'anthropic',
        rawBlob: JSON.stringify({
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
        }),
        setup: () => anthropicOauth.unwrapToken.mockResolvedValue('fresh-anthropic-token'),
        unwrap: () => anthropicOauth.unwrapToken,
        expectedApiKey: 'fresh-anthropic-token',
      },
      {
        provider: 'gemini',
        rawBlob: JSON.stringify({
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
          u: 'project-123',
        }),
        setup: () => geminiOauth.unwrapToken.mockResolvedValue('fresh-gemini-token'),
        unwrap: () => geminiOauth.unwrapToken,
        expectedApiKey: 'fresh-gemini-token',
        expectedProviderResource: 'project-123',
      },
      {
        provider: 'kiro',
        rawBlob: JSON.stringify({
          source: 'kiro-oidc',
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
          cid: 'client-id',
          cs: 'client-secret',
          region: 'us-east-1',
        }),
        setup: () => kiroOauth.unwrapToken.mockResolvedValue('fresh-kiro-token'),
        unwrap: () => kiroOauth.unwrapToken,
        expectedApiKey: 'fresh-kiro-token',
      },
      {
        provider: 'xai',
        rawBlob: JSON.stringify({
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
        }),
        setup: () => xaiOauth.unwrapToken.mockResolvedValue('fresh-xai-token'),
        unwrap: () => xaiOauth.unwrapToken,
        expectedApiKey: 'fresh-xai-token',
      },
    ])(
      'refreshes and retries rejected $provider OAuth subscription tokens',
      async ({ provider, rawBlob, setup, unwrap, expectedApiKey, expectedProviderResource }) => {
        setup();
        const completeFailure = jest.fn().mockResolvedValue(undefined);
        let attemptNumber = 0;
        const startProviderAttempt = jest.fn(() => ({
          id: `attempt-${attemptNumber + 1}`,
          attemptNumber: ++attemptNumber,
          startedAtMs: Date.now(),
          startedAt: new Date().toISOString(),
          pendingWrite: Promise.resolve(true),
          completeFailure,
        }));
        providerClient.forward
          .mockResolvedValueOnce({
            response: new Response('unauthorized', { status: 401 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: provider === 'openai',
          })
          .mockResolvedValueOnce({
            response: new Response('{"ok":true}', { status: 200 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: provider === 'openai',
          });

        const result = await service.tryForwardToProvider({
          provider,
          apiKey: 'old-access-token',
          rawApiKey: rawBlob,
          providerKeyLabel: 'Work',
          agentId: 'agent-1',
          tenantId: 'tenant-1',
          model: `${provider}-model`,
          body,
          stream: false,
          sessionKey: 'sess-1',
          authType: 'subscription',
          startProviderAttempt,
        });

        expect(result.response.status).toBe(200);
        expect(providerClient.forward).toHaveBeenCalledTimes(2);
        expect(startProviderAttempt).toHaveBeenCalledTimes(2);
        expect(result.attempt?.attemptNumber).toBe(2);
        expect(completeFailure).toHaveBeenCalledWith({
          status: 401,
          errorBody: 'unauthorized',
          superseded: true,
        });
        expect(providerClient.forward.mock.calls[0][0].apiKey).toBe('old-access-token');
        expect(providerClient.forward.mock.calls[1][0].apiKey).toBe(expectedApiKey);
        expect(providerClient.forward.mock.calls[1][0].providerResource).toBe(
          expectedProviderResource,
        );

        const expiredBlob = JSON.parse(unwrap().mock.calls[0][0] as string) as {
          e: number;
          source?: string;
        };
        expect(expiredBlob.e).toBe(0);
        if (provider === 'kiro') expect(expiredBlob.source).toBe('kiro-oidc');
        expect(unwrap().mock.calls[0][3]).toBe('Work');
      },
    );

    it('does not refresh non-OAuth subscription strings after an upstream 401', async () => {
      providerClient.forward.mockResolvedValueOnce({
        response: new Response('unauthorized', { status: 401 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      });
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined as unknown as void);

      const result = await service.tryForwardToProvider({
        provider: 'openai',
        apiKey: 'sk-plain-subscription-token',
        rawApiKey: 'sk-plain-subscription-token',
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
      });

      expect(result.response.status).toBe(401);
      expect(openaiOauth.unwrapToken).not.toHaveBeenCalled();
      expect(providerClient.forward).toHaveBeenCalledTimes(1);
      // The refresh decision must be visible in logs (#2883).
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot be refreshed'));
    });

    it('keeps the original rejected-token response readable when refresh cannot recover', async () => {
      const errorBody = 'unauthorized';
      providerClient.forward.mockResolvedValue({
        response: new Response(errorBody, { status: 401 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      });

      const result = await service.tryForwardToProvider({
        provider: 'openai',
        apiKey: 'invalidated-access',
        rawApiKey: JSON.stringify({
          t: 'invalidated-access',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
        }),
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
      });

      expect(result.response.status).toBe(401);
      await expect(result.response.text()).resolves.toBe(errorBody);
      expect(providerClient.forward).toHaveBeenCalledTimes(1);
    });

    // A 401 is an auth failure, not a transient one: once a subscription token
    // is known dead, every later request must skip the upstream round-trip and
    // go straight to the fallback chain (issue #2883).
    describe('rejected subscription credentials', () => {
      const deadBlob = JSON.stringify({
        t: 'invalidated-access',
        r: 'refresh-token',
        e: Date.now() + 10 * 60 * 1000,
      });

      const forwardOpts = () => ({
        provider: 'openai',
        apiKey: 'invalidated-access',
        rawApiKey: deadBlob,
        providerKeyLabel: 'Work',
        tenantProviderId: 'up-work',
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription' as const,
      });

      it('marks the credential and short-circuits the next request without an upstream call', async () => {
        openaiOauth.unwrapToken.mockResolvedValue(null);
        providerClient.forward.mockResolvedValue({
          response: new Response('unauthorized', { status: 401 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        });

        const first = await service.tryForwardToProvider(forwardOpts());
        expect(first.response.status).toBe(401);
        expect(providerClient.forward).toHaveBeenCalledTimes(1);
        expect(credentialHealth.isRejected('up-work', deadBlob)).toBe(true);

        const second = await service.tryForwardToProvider(forwardOpts());

        expect(second.response.status).toBe(401);
        await expect(second.response.text()).resolves.toContain('re-authentication');
        // No second upstream call — the dead credential is skipped locally.
        expect(providerClient.forward).toHaveBeenCalledTimes(1);
        expect(second.providerCallStarted).toBe(false);
      });

      it('leaves a credential healthy when the forced refresh recovers the request', async () => {
        openaiOauth.unwrapToken.mockResolvedValue('fresh-access');
        providerClient.forward
          .mockResolvedValueOnce({
            response: new Response('unauthorized', { status: 401 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: true,
          })
          .mockResolvedValueOnce({
            response: new Response('{"ok":true}', { status: 200 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: true,
          });

        const result = await service.tryForwardToProvider(forwardOpts());

        expect(result.response.status).toBe(200);
        expect(credentialHealth.isRejected('up-work', deadBlob)).toBe(false);
      });

      it('tracks a still-rejected retry against the refreshed credential', async () => {
        const refreshedBlob = JSON.stringify({
          t: 'refreshed-access',
          r: 'refreshed-refresh',
          e: Date.now() + 3_600_000,
        });
        openaiOauth.unwrapToken.mockResolvedValue('refreshed-access');
        providerClient.forward
          .mockResolvedValueOnce({
            response: new Response('unauthorized', { status: 401 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: true,
          })
          .mockResolvedValueOnce({
            response: new Response('still unauthorized', { status: 401 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: true,
          });
        // The forced refresh persisted a rotated token; the proxy re-reads it
        // so the next request resolves the same fingerprint that was marked.
        providerKeyService.getProviderApiKey.mockResolvedValue(refreshedBlob);

        const result = await service.tryForwardToProvider(forwardOpts());

        expect(result.response.status).toBe(401);
        expect(providerClient.forward).toHaveBeenCalledTimes(2);
        expect(credentialHealth.isRejected('up-work', refreshedBlob)).toBe(true);
        expect(credentialHealth.isRejected('up-work', deadBlob)).toBe(false);
      });

      it('resumes forwarding once the credential is replaced (re-auth)', async () => {
        openaiOauth.unwrapToken.mockResolvedValue(null);
        providerClient.forward.mockResolvedValue({
          response: new Response('unauthorized', { status: 401 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        });

        await service.tryForwardToProvider(forwardOpts());
        expect(providerClient.forward).toHaveBeenCalledTimes(1);

        const reauthedBlob = JSON.stringify({
          t: 'new-access',
          r: 'new-refresh',
          e: Date.now() + 10 * 60 * 1000,
        });
        await service.tryForwardToProvider({
          ...forwardOpts(),
          apiKey: 'new-access',
          rawApiKey: reauthedBlob,
        });

        // The replaced credential is not the rejected one, so it is tried.
        expect(providerClient.forward).toHaveBeenCalledTimes(2);
      });

      it('records the skipped attempt and omits the label when none was pinned', async () => {
        const completeFailure = jest.fn().mockResolvedValue(undefined);
        const attempt = {
          id: 'attempt-skip',
          attemptNumber: 1,
          startedAtMs: Date.now(),
          startedAt: new Date().toISOString(),
          pendingWrite: Promise.resolve(true),
          completeFailure,
        };
        openaiOauth.unwrapToken.mockResolvedValue(null);
        providerClient.forward.mockResolvedValue({
          response: new Response('unauthorized', { status: 401 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        });
        // First call marks the credential rejected.
        await service.tryForwardToProvider(forwardOpts());

        const startProviderAttempt = jest.fn(() => attempt);
        const result = await service.tryForwardToProvider({
          ...forwardOpts(),
          providerKeyLabel: undefined,
          startProviderAttempt,
        });

        await expect(result.response.text()).resolves.toContain(
          'Subscription credential for openai',
        );
        expect(startProviderAttempt).toHaveBeenCalledWith(
          expect.objectContaining({ providerCallStarted: false }),
        );
        expect(attempt).toEqual(expect.objectContaining({ completedAtMs: expect.any(Number) }));
        expect(result.providerCallStarted).toBe(false);
      });
    });

    it('catches transport errors and returns synthetic response', async () => {
      providerClient.forward.mockRejectedValue(new Error('fetch failed'));
      const attempt = {
        id: 'attempt-transport',
        attemptNumber: 1,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
      };

      const result = await service.tryForwardToProvider({
        provider: 'OpenAI',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        sessionKey: 'sess-1',
        startProviderAttempt: jest.fn(() => attempt),
      });

      expect(result.response.ok).toBe(false);
      expect(result.response.status).toBe(503);
      expect(result.attempt).toBe(attempt);
      expect(attempt).toEqual(expect.objectContaining({ completedAtMs: expect.any(Number) }));
    });

    it('returns a tagged transport failure when an OAuth retry cannot connect', async () => {
      openaiOauth.unwrapToken.mockResolvedValue('fresh-access-token');
      const completeFailure = jest.fn().mockResolvedValue(undefined);
      let attemptNumber = 0;
      const attempts: Array<{
        id: string;
        attemptNumber: number;
        startedAtMs: number;
        startedAt: string;
        pendingWrite: Promise<boolean>;
        completeFailure: jest.Mock;
        completedAtMs?: number;
      }> = [];
      const startProviderAttempt = jest.fn(() => {
        const attempt = {
          id: `attempt-${attemptNumber + 1}`,
          attemptNumber: ++attemptNumber,
          startedAtMs: Date.now(),
          startedAt: new Date().toISOString(),
          pendingWrite: Promise.resolve(true),
          completeFailure,
        };
        attempts.push(attempt);
        return attempt;
      });
      providerClient.forward
        .mockResolvedValueOnce({
          response: {
            status: 401,
            clone: () => ({ text: () => Promise.reject(new Error('body unavailable')) }),
          } as unknown as Response,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        })
        .mockRejectedValueOnce(new Error('fetch failed'));

      const result = await service.tryForwardToProvider({
        provider: 'openai',
        apiKey: 'old-access-token',
        rawApiKey: JSON.stringify({
          t: 'old-access-token',
          r: 'refresh-token',
          e: Date.now() + 10 * 60 * 1000,
        }),
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        startProviderAttempt,
      });

      expect(result.response.status).toBe(503);
      expect(result.attempt).toBe(attempts[1]);
      expect(result.providerCallStarted).toBe(true);
      expect(completeFailure).toHaveBeenCalledWith({
        status: 401,
        errorBody: 'OAuth token rejected',
        superseded: true,
      });
    });

    it('rethrows non-transport errors', async () => {
      providerClient.forward.mockRejectedValue(new Error('boom'));

      await expect(
        service.tryForwardToProvider({
          provider: 'OpenAI',
          apiKey: 'sk-test',
          model: 'gpt-4o',
          body,
          stream: false,
          sessionKey: 'sess-1',
        }),
      ).rejects.toThrow('boom');
    });

    it('merges the per-route saved params into the outbound body when the attempt has a configured row', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      modelParamsService.get.mockResolvedValueOnce({ thinking: { type: 'disabled' } });

      await service.tryForwardToProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        body: { messages: [{ role: 'user', content: 'hi' }] },
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
        paramMergeContext: { agentId: 'agent-1', scopeKey: 'tier:default' },
      });

      expect(modelParamsService.get).toHaveBeenCalledWith(
        'agent-1',
        'tier:default',
        'deepseek',
        'api_key',
        'deepseek-v4-flash',
      );
      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ thinking: { type: 'disabled' } }),
        }),
      );
    });

    it('merges params into a lazy cross-protocol body once per attempt', async () => {
      const convertedBody = { messages: [{ role: 'user', content: 'hi' }] };
      const resolveChatBody = jest.fn().mockResolvedValue(convertedBody);
      modelParamsService.get.mockResolvedValue({ thinking: { type: 'disabled' } });
      providerClient.forward.mockImplementation(async (options) => {
        const first = await options.resolveChatBody!();
        const second = await options.resolveChatBody!();
        expect(second).toBe(first);
        expect(first).toEqual({
          ...convertedBody,
          thinking: { type: 'disabled' },
        });
        return {
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        };
      });

      await service.tryForwardToProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        body: { input: 'hi' },
        resolveChatBody,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
        apiMode: 'responses',
        paramMergeContext: { agentId: 'agent-1', scopeKey: 'tier:default' },
      });

      expect(resolveChatBody).toHaveBeenCalledTimes(1);
    });

    it('per-attempt lookup leaves other providers untouched (no cross-provider leak)', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });
      // Anthropic has no row in agent_model_params, so the lookup returns null
      // and the body passes through unmodified — no provider filter needed
      // because storage is already route-scoped.
      modelParamsService.get.mockResolvedValueOnce(null);

      await service.tryForwardToProvider({
        provider: 'anthropic',
        apiKey: 'sk-anthropic',
        model: 'claude-sonnet-4',
        body: { messages: [{ role: 'user', content: 'hi' }] },
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
        paramMergeContext: { agentId: 'agent-1', scopeKey: 'tier:default' },
      });

      const forwarded = providerClient.forward.mock.calls[0][0];
      expect(forwarded.body.thinking).toBeUndefined();
    });

    it('lets saved Manifest params override inbound body fields at the same path', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      modelParamsService.get.mockResolvedValueOnce({ thinking: { type: 'disabled' } });

      await service.tryForwardToProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        body: {
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'enabled' },
        },
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
        paramMergeContext: { agentId: 'agent-1', scopeKey: 'tier:default' },
      });

      const forwarded = providerClient.forward.mock.calls[0][0];
      expect(forwarded.body.thinking).toEqual({ type: 'disabled' });
    });

    it('skips the lookup when paramMergeContext is omitted (e.g. legacy callers)', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash',
        body: { messages: [{ role: 'user', content: 'hi' }] },
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
      });

      expect(modelParamsService.get).not.toHaveBeenCalled();
    });

    it('re-injects shared reasoning_content before forwarding to compatible providers', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const requestBody = {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };
      const enrichedBody = {
        messages: [
          {
            ...requestBody.messages[0],
            reasoning_content: 'shared thinking',
          },
        ],
      };
      reasoningCache.prepareRequest.mockResolvedValueOnce(enrichedBody);

      await service.tryForwardToProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        body: requestBody,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
      });

      expect(reasoningCache.prepareRequest).toHaveBeenCalledWith(
        requestBody,
        'sess-1',
        'deepseek',
        'deepseek-chat',
      );
      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({ body: enrichedBody }),
      );
    });

    it('reads the reasoning cache with the scoped key the response handler wrote with', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const requestBody = {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };

      await service.tryForwardToProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        body: requestBody,
        stream: false,
        sessionKey: 'sess-1',
        reasoningCacheKey: 'v1:scoped-digest',
        authType: 'api_key',
      });

      // Stored entries live under the scoped key; reading with the raw caller
      // session key misses every one of them and DeepSeek 400s on the empty
      // replay it then receives.
      expect(reasoningCache.prepareRequest).toHaveBeenCalledWith(
        requestBody,
        'v1:scoped-digest',
        'deepseek',
        'deepseek-chat',
      );
    });

    it('rethrows when signal is aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      providerClient.forward.mockRejectedValue(new Error('aborted'));

      await expect(
        service.tryForwardToProvider({
          provider: 'OpenAI',
          apiKey: 'sk-test',
          model: 'gpt-4o',
          body,
          stream: false,
          sessionKey: 'sess-1',
          signal: ac.signal,
        }),
      ).rejects.toThrow('aborted');
    });

    it('returns timeout response for TimeoutError', async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      providerClient.forward.mockRejectedValue(err);

      const result = await service.tryForwardToProvider({
        provider: 'OpenAI',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        sessionKey: 'sess-1',
      });

      expect(result.response.status).toBe(504);
    });

    it('adds x-grok-conv-id header for xai provider', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-2',
        body,
        stream: false,
        sessionKey: 'my-session',
        providerCacheKey: 'v1:scoped-session',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'xai',
          apiKey: 'sk-xai',
          model: 'grok-2',
          body,
          stream: false,
          extraHeaders: {
            'x-grok-conv-id': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
          },
          sessionKey: 'my-session',
          providerCacheKey: 'v1:scoped-session',
        }),
      );
    });

    it('omits provider cache headers without an explicit scoped key', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-2',
        body,
        stream: false,
        sessionKey: 'default',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          extraHeaders: undefined,
          providerCacheKey: undefined,
        }),
      );
    });

    it('adds x-opencode-session header for opencode-go with a scoped session key', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'opencode-go',
        apiKey: 'sk-oc',
        model: 'opencode-go/deepseek-v4-flash',
        body,
        stream: false,
        sessionKey: 'my-session',
        providerCacheKey: 'v1:scoped-session',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          extraHeaders: {
            'x-opencode-session': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
          },
        }),
      );
    });

    it('adds a stable agent-scoped x-opencode-session when the caller sent no session key', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const forwardTwice = async () =>
        service.tryForwardToProvider({
          provider: 'opencode-go',
          apiKey: 'sk-oc',
          model: 'opencode-go/deepseek-v4-flash',
          body,
          stream: false,
          sessionKey: 'default',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
        });
      await forwardTwice();
      await forwardTwice();

      const calls = providerClient.forward.mock.calls.map(
        ([opts]: [{ extraHeaders?: Record<string, string> }]) =>
          opts.extraHeaders?.['x-opencode-session'],
      );
      expect(calls[0]).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(calls[1]).toBe(calls[0]);
    });

    it('omits x-opencode-session without a session key or agent identity', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'opencode-go',
        apiKey: 'sk-oc',
        model: 'opencode-go/deepseek-v4-flash',
        body,
        stream: false,
        sessionKey: 'default',
      });

      const forwardArgs = providerClient.forward.mock.calls[0][0];
      expect(forwardArgs.extraHeaders?.['x-opencode-session']).toBeUndefined();
    });

    it('exchanges copilot token before forwarding', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'copilot',
        apiKey: 'ghu_token',
        model: 'copilot/claude-sonnet-4.6',
        body,
        stream: false,
        sessionKey: 'sess-1',
      });

      expect(copilotToken.getCopilotToken).toHaveBeenCalledWith('ghu_token');
      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'copilot',
          apiKey: 'tid=copilot-session-token',
          model: 'claude-sonnet-4.6',
          body,
          stream: false,
          sessionKey: 'sess-1',
        }),
      );
    });

    it('builds custom endpoint for custom providers', async () => {
      customProviderRepo.findOne.mockResolvedValue({
        id: 'cp-1',
        base_url: 'https://api.groq.com/openai/v1',
      } as never);
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'custom:cp-1',
        apiKey: 'key',
        model: 'custom:cp-1/llama',
        body,
        stream: false,
        sessionKey: 'sess-1',
        tenantId: 'tenant-1',
      });

      // The custom-provider row is fetched scoped to the caller's tenant so a
      // foreign custom:<id> can never have its base_url read here.
      expect(customProviderRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'cp-1', tenant_id: 'tenant-1' },
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'custom:cp-1',
          apiKey: 'key',
          model: 'llama',
          body,
          stream: false,
          customEndpoint: expect.objectContaining({ baseUrl: 'https://api.groq.com/openai' }),
          sessionKey: 'sess-1',
        }),
      );
    });

    it('skips the custom-provider lookup entirely when no tenantId is supplied (fail closed)', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      // Without a tenantId, `tenant_id: undefined` would be stripped by TypeORM
      // and degrade to an unscoped lookup. The guard must skip the query instead.
      await service.tryForwardToProvider({
        provider: 'custom:cp-1',
        apiKey: 'key',
        model: 'custom:cp-1/llama',
        body,
        stream: false,
        sessionKey: 'sess-1',
      });

      expect(customProviderRepo.findOne).not.toHaveBeenCalled();
    });

    it('routes Anthropic-kind custom providers to /v1/messages with anthropic format', async () => {
      customProviderRepo.findOne.mockResolvedValue({
        id: 'cp-anth',
        base_url: 'https://api.anthropic.com',
        api_kind: 'anthropic',
      } as never);
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'custom:cp-anth',
        apiKey: 'sk-ant-key',
        model: 'custom:cp-anth/claude-sonnet-4-5',
        body,
        stream: false,
        sessionKey: 'sess-1',
        tenantId: 'tenant-1',
      });

      const forwardArgs = providerClient.forward.mock.calls[0][0];
      expect(forwardArgs.model).toBe('claude-sonnet-4-5');
      expect(forwardArgs.customEndpoint).toMatchObject({
        baseUrl: 'https://api.anthropic.com',
        format: 'anthropic',
      });
      expect(forwardArgs.customEndpoint?.buildPath('claude-sonnet-4-5')).toBe('/v1/messages');
    });

    it('uses minimax subscription base URL override', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'minimax',
        apiKey: 'token',
        model: 'MiniMax-M2.5',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        resourceUrl: 'https://api.minimax.io/anthropic/v1',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'minimax',
          apiKey: 'token',
          model: 'MiniMax-M2.5',
          body,
          stream: false,
          customEndpoint: expect.objectContaining({
            baseUrl: 'https://api.minimax.io/anthropic/v1',
            format: 'anthropic',
          }),
          authType: 'subscription',
          sessionKey: 'sess-1',
        }),
      );
    });

    it('ignores invalid minimax resource URL', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'minimax',
        apiKey: 'token',
        model: 'MiniMax-M2.5',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        resourceUrl: 'not-a-valid-url',
      });

      // Should forward without custom endpoint
      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'minimax',
          apiKey: 'token',
          model: 'MiniMax-M2.5',
          body,
          stream: false,
          authType: 'subscription',
          sessionKey: 'sess-1',
        }),
      );
    });

    it('falls back to providerRegion=cn for pasted minimax subscription tokens', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'minimax',
        apiKey: 'sk-cp-cn-token',
        model: 'MiniMax-M2.5',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'cn',
        // resourceUrl is intentionally absent — paste-token path has no OAuth blob
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          customEndpoint: expect.objectContaining({
            baseUrl: 'https://api.minimaxi.com/anthropic/v1',
            format: 'anthropic',
          }),
        }),
      );
    });

    it('strips the minimax/ vendor prefix on subscription routes (custom endpoint or not)', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'minimax',
        apiKey: 'sk-cp-cn-token',
        model: 'minimax/MiniMax-M2.7',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'cn',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'MiniMax-M2.7',
        }),
      );
    });

    it('does NOT override the endpoint for global region (built-in minimax-subscription already targets api.minimax.io)', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'minimax',
        apiKey: 'sk-cp-global-token',
        model: 'MiniMax-M2.5',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'global',
      });

      const call = providerClient.forward.mock.calls[0][0];
      expect(call.customEndpoint).toBeUndefined();
    });

    it('routes Z.ai subscription region=cn to the China Coding Plan endpoint', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'zai',
        apiKey: 'zai-sub-key',
        model: 'glm-5.1',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'cn',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          customEndpoint: expect.objectContaining({
            baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
            format: 'openai',
          }),
        }),
      );
    });

    it('leaves Z.ai subscription region=global on the built-in outside-China endpoint', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'zai',
        apiKey: 'zai-sub-key',
        model: 'glm-5.1',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'global',
      });

      const call = providerClient.forward.mock.calls[0][0];
      expect(call.customEndpoint).toBeUndefined();
    });

    it('strips Z.ai vendor prefixes on subscription routes before endpoint overrides', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'zai',
        apiKey: 'zai-sub-key',
        model: 'z-ai/glm-5.1',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'cn',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'glm-5.1',
        }),
      );
    });

    it('routes Xiaomi MiMo Token Plan region=ams to the Europe endpoint', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'xiaomi',
        apiKey: 'tp-mimo-token',
        model: 'mimo-v2.5-pro',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'ams',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          customEndpoint: expect.objectContaining({
            baseUrl: 'https://token-plan-ams.xiaomimimo.com',
            format: 'openai',
          }),
        }),
      );
    });

    it('strips Xiaomi vendor prefixes on Token Plan subscription routes before endpoint overrides', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'xiaomi',
        apiKey: 'tp-mimo-token',
        model: 'xiaomi/mimo-v2.5-pro',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        providerRegion: 'ams',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mimo-v2.5-pro',
        }),
      );
    });
  });

  describe('retryWireBody', () => {
    it('delegates the healed body to the captured provider transport', async () => {
      const healedBody = { model: 'gpt-4o', max_tokens: 128 };
      const retried = {
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
      const retryWireBody = jest.fn().mockResolvedValue(retried);
      const original = {
        response: new Response('{}', { status: 400 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        retryWireBody,
      };

      await expect(service.retryWireBody(original, healedBody)).resolves.toBe(retried);
      expect(retryWireBody).toHaveBeenCalledWith(healedBody);
      expect(providerClient.forward).not.toHaveBeenCalled();
    });

    it('tracks the provider attempt for an exact wire-body retry', async () => {
      const healedBody = { model: 'gpt-4o', max_tokens: 128 };
      const attempt = {
        id: 'attempt-2',
        attemptNumber: 2,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
      };
      const startProviderAttempt = jest.fn(() => attempt);
      const retryWireBody = jest.fn().mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const original = {
        response: new Response('{}', { status: 400 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        retryWireBody,
      };

      const result = await service.retryWireBody(original, healedBody, {
        provider: 'openai',
        model: 'gpt-4o',
        authType: 'api_key',
        tenantProviderId: 'connection-1',
        providerKeyLabel: 'Work',
        startProviderAttempt,
      });

      // The retry rides the same connection as the original call, so the
      // pending attempt row it opens must name that connection's label too.
      expect(startProviderAttempt).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4o',
        authType: 'api_key',
        tenantProviderId: 'connection-1',
        keyLabel: 'Work',
      });
      expect(result.attempt).toBe(attempt);
      expect(result.providerCallStarted).toBe(true);
      expect(attempt).toEqual(expect.objectContaining({ completedAtMs: expect.any(Number) }));
      expect(providerClient.forward).not.toHaveBeenCalled();
    });

    it('tracks transport failures from an exact wire-body retry', async () => {
      const healedBody = { model: 'gpt-4o', max_tokens: 128 };
      const attempt = {
        id: 'attempt-2',
        attemptNumber: 2,
        startedAtMs: Date.now(),
        startedAt: new Date().toISOString(),
        pendingWrite: Promise.resolve(true),
      };
      const retryWireBody = jest.fn().mockRejectedValue(new Error('fetch failed'));
      const original = {
        response: new Response('{}', { status: 400 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        retryWireBody,
      };

      const result = await service.retryWireBody(original, healedBody, {
        provider: 'openai',
        model: 'gpt-4o',
        authType: 'api_key',
        tenantProviderId: 'connection-1',
        startProviderAttempt: jest.fn(() => attempt),
      });

      expect(result.response.status).toBe(503);
      await expect(result.response.json()).resolves.toEqual({
        error: { message: 'Failed to reach upstream provider' },
      });
      expect(result.attempt).toBe(attempt);
      expect(result.providerCallStarted).toBe(true);
      expect(attempt).toEqual(expect.objectContaining({ completedAtMs: expect.any(Number) }));
      expect(providerClient.forward).not.toHaveBeenCalled();
    });

    it('records a route cooldown when the healed retry is rate-limited', async () => {
      const retryWireBody = jest.fn().mockResolvedValue({
        response: new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      const original = {
        response: new Response('{}', { status: 400 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        retryWireBody,
      };

      await service.retryWireBody(
        original,
        { model: 'gpt-4o' },
        {
          provider: 'openai',
          model: 'gpt-4o',
          authType: 'api_key',
          agentId: 'agent-1',
          providerKeyLabel: 'Work',
        },
      );

      // The next attempt on the same route must honor the cooldown instead of
      // hammering a provider that just rate-limited the healed retry.
      const next = await service.tryForwardToProvider({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
        agentId: 'agent-1',
        providerKeyLabel: 'Work',
      });

      expect(next.response.status).toBe(429);
      expect(next.providerCallStarted).toBe(false);
      expect(providerClient.forward).not.toHaveBeenCalled();
    });
  });

  describe('tryFallbacks', () => {
    it('returns success on first successful fallback', async () => {
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });
      pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['claude-sonnet-4'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).not.toBeNull();
      expect(result.success!.model).toBe('claude-sonnet-4');
      expect(result.success!.provider).toBe('Anthropic');
      expect(result.success!.fallbackIndex).toBe(0);
      expect(result.failures).toHaveLength(0);
    });

    it('returns null success when all fallbacks fail', async () => {
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-test');
      providerClient.forward.mockResolvedValue({
        response: new Response('error', { status: 500 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['model-a'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).toBeNull();
      expect(result.failures).toHaveLength(1);
    });

    it('skips models with no provider data', async () => {
      pricingCache.getByModel.mockReturnValue(null as never);
      providerKeyService.findProviderForModel.mockResolvedValue(undefined);

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['unknown-model'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).toBeNull();
      expect(result.failures).toHaveLength(0);
      expect(providerClient.forward).not.toHaveBeenCalled();
    });

    it('records a credential failure when a model has no API key', async () => {
      pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);
      providerKeyService.getProviderApiKey.mockResolvedValue(null);

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['claude-sonnet-4'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).toBeNull();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        provider: 'Anthropic',
        model: 'claude-sonnet-4',
        status: 401,
        providerCallStarted: true,
      });
      expect(result.failures[0].errorBody).toContain('M100');
      expect(providerClient.forward).not.toHaveBeenCalled();
    });

    it('resolves custom provider from model prefix', async () => {
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-custom');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['custom:cp-1/my-model'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).not.toBeNull();
      expect(result.success!.provider).toBe('custom:cp-1');
    });

    it('tries alternate auth_type for same provider when primary failed (#1272)', async () => {
      providerKeyService.getAuthType.mockImplementation(
        async (_agentId: string, _provider: string, exclude?: Set<string>) => {
          if (exclude && exclude.has('subscription')) return 'api_key';
          return 'subscription';
        },
      );
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-api-key');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      });
      pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['claude-sonnet-4'],
        body,
        false,
        'sess-1',
        'gpt-4o',
        undefined,
        'anthropic',
        'subscription',
      );

      expect(result.success).not.toBeNull();
      // getAuthType should have been called with the exclusion set
      expect(providerKeyService.getAuthType).toHaveBeenCalledWith(
        'tenant-1',
        'Anthropic',
        new Set(['subscription']),
        'agent-1',
      );
      // getProviderApiKey should use the alternate auth type. The 4th arg is
      // the optional providerKeyLabel — undefined when the fallback entry
      // has no `||<label>` suffix.
      expect(providerKeyService.getProviderApiKey).toHaveBeenCalledWith(
        'tenant-1',
        'Anthropic',
        'api_key',
        undefined,
        'agent-1',
      );
    });

    it('forwards keyLabel from a structured fallback route to getProviderApiKey', async () => {
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-work-key');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      // Structured route (ModelRoute[]) is the canonical fallback shape now.
      // keyLabel rides along with each route — no more `||<label>` parsing.
      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['gemini-2.5-flash'],
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
        [{ provider: 'Google', authType: 'api_key', model: 'gemini-2.5-flash', keyLabel: 'Work' }],
      );

      expect(result.success).not.toBeNull();
      expect(providerKeyService.getProviderApiKey).toHaveBeenCalledWith(
        'tenant-1',
        'Google',
        'api_key',
        'Work',
        'agent-1',
      );
      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-2.5-flash' }),
      );
    });

    it('uses the selected default key label for unpinned structured subscription fallbacks', async () => {
      const rawBlob = JSON.stringify({
        t: 'cached-access',
        r: 'refresh-token',
        e: Date.now() + 10 * 60 * 1000,
      });
      // The single key selection resolves the unpinned subscription label to the
      // selected row's own label ('Work'), which then flows into the OAuth unwrap
      // and the subscription re-read path.
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: rawBlob,
        id: 'up-fallback',
        region: null,
        label: 'Work',
        priority: 0,
      });
      providerKeyService.getProviderApiKey.mockResolvedValue(rawBlob);
      openaiOauth.unwrapToken.mockResolvedValue('fresh-access');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      });

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['gpt-5.3-codex'],
        body,
        false,
        'sess-1',
        'claude-sonnet-4',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ provider: 'openai', authType: 'subscription', model: 'gpt-5.3-codex' }],
      );

      expect(result.success).not.toBeNull();
      expect(providerKeyService.getAuthType).not.toHaveBeenCalled();
      // Unpinned: selectProviderKey is called with no label and returns the row
      // whose label resolves the subscription credential lookups.
      expect(providerKeyService.selectProviderKey).toHaveBeenCalledWith(
        'tenant-1',
        'openai',
        'subscription',
        undefined,
        'agent-1',
      );
      expect(providerKeyService.getProviderApiKey).toHaveBeenCalledWith(
        'tenant-1',
        'openai',
        'subscription',
        'Work',
        'agent-1',
      );
      expect(openaiOauth.unwrapToken).toHaveBeenCalledWith(rawBlob, 'agent-1', 'tenant-1', 'Work');
    });

    it('uses the latest stored OAuth blob for fallback retries after preflight refresh', async () => {
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
      providerKeyService.getProviderApiKey
        .mockResolvedValueOnce(staleBlob)
        .mockResolvedValueOnce(refreshedBlob)
        .mockResolvedValueOnce(refreshedBlob);
      openaiOauth.unwrapToken
        .mockResolvedValueOnce('fresh-access')
        .mockResolvedValueOnce('recovered-access');
      providerClient.forward
        .mockResolvedValueOnce({
          response: new Response('unauthorized', { status: 401 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        })
        .mockResolvedValueOnce({
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        });
      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['gpt-5.3-codex'],
        body,
        false,
        'sess-1',
        'claude-sonnet-4',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [
          {
            provider: 'openai',
            authType: 'subscription',
            model: 'gpt-5.3-codex',
            keyLabel: 'Work',
          },
        ],
      );

      expect(result.success).not.toBeNull();
      // Resolve, the post-refresh re-read, and the post-retry health re-read.
      expect(providerKeyService.getProviderApiKey).toHaveBeenCalledTimes(3);
      expect(providerClient.forward).toHaveBeenCalledTimes(2);
      expect(providerClient.forward.mock.calls[0][0].apiKey).toBe('fresh-access');
      expect(providerClient.forward.mock.calls[1][0].apiKey).toBe('recovered-access');

      const forcedRefreshBlob = JSON.parse(openaiOauth.unwrapToken.mock.calls[1][0] as string) as {
        e: number;
        r: string;
        t: string;
      };
      expect(forcedRefreshBlob).toMatchObject({
        e: 0,
        r: 'rotated-refresh',
        t: 'fresh-access',
      });
      expect(openaiOauth.unwrapToken.mock.calls[1][3]).toBe('Work');
    });

    it('uses the selected default subscription key label when refreshing legacy fallbacks', async () => {
      const rawBlob = JSON.stringify({
        t: 'cached-access',
        r: 'refresh-token',
        e: Date.now() + 10 * 60 * 1000,
      });
      providerKeyService.getAuthType.mockResolvedValue('subscription');
      // The selected row's own label ('Work') resolves the unpinned subscription
      // credential lookups; getDefaultKeyLabel is no longer consulted.
      providerKeyService.selectProviderKey.mockResolvedValue({
        apiKey: rawBlob,
        id: 'up-fallback',
        region: null,
        label: 'Work',
        priority: 0,
      });
      providerKeyService.getProviderApiKey.mockResolvedValue(rawBlob);
      pricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' } as never);
      openaiOauth.unwrapToken.mockResolvedValue('fresh-access');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      });

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['gpt-5.3-codex'],
        body,
        false,
        'sess-1',
        'claude-sonnet-4',
      );

      expect(result.success).not.toBeNull();
      // Legacy (string) fallback resolves the provider from pricing ('OpenAI'),
      // then selectProviderKey returns the row whose label drives the lookups.
      expect(providerKeyService.selectProviderKey).toHaveBeenCalledWith(
        'tenant-1',
        'OpenAI',
        'subscription',
        undefined,
        'agent-1',
      );
      expect(providerKeyService.getProviderApiKey).toHaveBeenCalledWith(
        'tenant-1',
        'OpenAI',
        'subscription',
        'Work',
        'agent-1',
      );
      expect(openaiOauth.unwrapToken).toHaveBeenCalledWith(rawBlob, 'agent-1', 'tenant-1', 'Work');
    });

    it('does not exclude auth types for different provider', async () => {
      providerKeyService.getAuthType.mockResolvedValue('api_key');
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-test');
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });
      pricingCache.getByModel.mockReturnValue({ provider: 'OpenAI' } as never);

      await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['gpt-4o'],
        body,
        false,
        'sess-1',
        'claude-sonnet-4',
        undefined,
        'anthropic',
        'subscription',
      );

      // OpenAI is a different provider, so no exclusion set should be passed
      expect(providerKeyService.getAuthType).toHaveBeenCalledWith(
        'tenant-1',
        'OpenAI',
        undefined,
        'agent-1',
      );
    });

    it('accumulates failed auth types across same-provider fallbacks', async () => {
      providerKeyService.getAuthType
        .mockResolvedValueOnce('api_key')
        .mockResolvedValueOnce('api_key');
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-test');
      providerClient.forward
        .mockResolvedValueOnce({
          response: new Response('error', { status: 401 }),
          isGoogle: false,
          isAnthropic: true,
          isChatGpt: false,
        })
        .mockResolvedValueOnce({
          response: new Response('error', { status: 401 }),
          isGoogle: false,
          isAnthropic: true,
          isChatGpt: false,
        });
      pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);

      await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['claude-sonnet-4', 'claude-haiku-3.5'],
        body,
        false,
        'sess-1',
        'gpt-4o',
        undefined,
        'anthropic',
        'subscription',
      );

      // First call: exclusion contains 'subscription' (from primary)
      expect(providerKeyService.getAuthType).toHaveBeenNthCalledWith(
        1,
        'tenant-1',
        'Anthropic',
        new Set(['subscription']),
        'agent-1',
      );
      // Second call: exclusion now also contains 'api_key' (from first fallback failure)
      expect(providerKeyService.getAuthType).toHaveBeenNthCalledWith(
        2,
        'tenant-1',
        'Anthropic',
        new Set(['subscription', 'api_key']),
        'agent-1',
      );
    });

    it('continues chain when upstream returns 424 (no longer a sentinel)', async () => {
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-test');
      providerClient.forward
        .mockResolvedValueOnce({
          response: new Response('upstream 424', { status: 424 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        })
        .mockResolvedValueOnce({
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        });
      pricingCache.getByModel.mockReturnValue({ provider: 'Anthropic' } as never);

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['model-a', 'model-b'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).not.toBeNull();
      expect(result.success!.model).toBe('model-b');
      expect(result.success!.fallbackIndex).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].status).toBe(424);
      expect(providerClient.forward).toHaveBeenCalledTimes(2);
    });

    it('falls through to findProviderForModel when inferred prefix provider is inactive (#1383)', async () => {
      // Model has 'anthropic/' prefix but Anthropic is disabled
      providerKeyService.hasActiveProvider.mockResolvedValue(false);
      // findProviderForModel correctly maps to OpenRouter
      providerKeyService.findProviderForModel.mockResolvedValue('openrouter');
      providerKeyService.getProviderApiKey.mockResolvedValue('sk-or');
      pricingCache.getByModel.mockReturnValue(null as never);
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

      const result = await service.tryFallbacks(
        'agent-1',
        'tenant-1',
        ['anthropic/claude-sonnet-4'],
        body,
        false,
        'sess-1',
        'gpt-4o',
      );

      expect(result.success).not.toBeNull();
      expect(result.success!.provider).toBe('openrouter');
      expect(providerKeyService.hasActiveProvider).toHaveBeenCalledWith(
        'tenant-1',
        'anthropic',
        'agent-1',
      );
    });

    describe('Autofix on fallback hops', () => {
      const failedForwardWithWire = (status: number, withRetry = true): Record<string, unknown> => {
        const retryWireBody = jest.fn().mockResolvedValue({
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        });
        return {
          response: new Response(
            JSON.stringify({ error: { message: 'This response_format type is unavailable now' } }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
          wireRequestBody: { model: 'deepseek-flash', messages: [] },
          wireApiMode: 'chat_completions',
          ...(withRetry ? { retryWireBody } : {}),
          providerCallStarted: true,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        };
      };

      const runFallback = (): Promise<{
        success: { forward: unknown; provider: string; autofix?: unknown } | null;
        failures: Array<{
          status: number;
          errorBody: string;
          provider: string;
          autofixRole?: string;
          autofix?: unknown;
        }>;
      }> =>
        service.tryFallbacks(
          'agent-1',
          'tenant-1',
          ['deepseek-flash'],
          body,
          false,
          'sess-1',
          'gpt-4o',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'chat_completions',
          undefined,
          [{ provider: 'opencode-go', authType: 'api_key', model: 'deepseek-flash' }],
        ) as never;

      it('heals a repairable failed fallback hop and returns the healed retry', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        const failedForward = failedForwardWithWire(400);
        providerClient.forward.mockResolvedValue(failedForward as never);

        const healedForward = {
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        };
        autofixService.isRepairable.mockReturnValue(true);
        const record = {
          groupId: 'g',
          outcome: 'healed' as const,
          original_http_status: 400,
          chain: [
            { attempt: 0, origin: 'original' as const, request: {}, http_status: 400 },
            { attempt: 1, origin: 'autofix' as const, request: {}, http_status: 200 },
          ],
        };
        autofixService.maybeHeal.mockResolvedValue({
          forward: healedForward as never,
          record,
        });

        const result = await runFallback();

        expect(result.success).not.toBeNull();
        expect(result.success!.forward).toBe(healedForward);
        expect(result.success!.provider).toBe('opencode-go');
        // The fallback's own Phoenix audit travels with the winning retry.
        expect(result.success!.autofix).toBe(record);
        // The hop that failed first is still recorded for the audit trail.
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatchObject({ status: 400, provider: 'opencode-go' });
        expect(result.failures[0].errorBody).toContain('response_format');
        expect(result.failures[0].autofixRole).toBe('original');

        const healArgs = autofixService.maybeHeal.mock.calls[0][0];
        expect(healArgs).toMatchObject({
          provider: 'opencode-go',
          model: 'deepseek-flash',
          authType: 'api_key',
          apiMode: 'chat_completions',
        });
        // The reforward must reuse the SAME fallback transport, not re-resolve
        // routing back to the primary.
        await healArgs.reforward({ model: 'deepseek-flash', messages: [] });
        expect(failedForward.retryWireBody as jest.Mock).toHaveBeenCalled();
      });

      it('records a normal fallback failure when Autofix has no patch', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        providerClient.forward.mockResolvedValue(failedForwardWithWire(400) as never);
        autofixService.isRepairable.mockReturnValue(true);
        autofixService.maybeHeal.mockResolvedValue(null);

        const result = await runFallback();

        expect(result.success).toBeNull();
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].status).toBe(400);
        expect(autofixService.maybeHeal).toHaveBeenCalledTimes(1);
      });

      it('does not consult Autofix for a non-repairable fallback status', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        providerClient.forward.mockResolvedValue(failedForwardWithWire(500) as never);

        const result = await runFallback();

        expect(result.success).toBeNull();
        expect(result.failures).toHaveLength(1);
        expect(autofixService.maybeHeal).not.toHaveBeenCalled();
      });

      it('does not consult Autofix when the fallback forward cannot be retried', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        providerClient.forward.mockResolvedValue(failedForwardWithWire(400, false) as never);
        autofixService.isRepairable.mockReturnValue(true);

        const result = await runFallback();

        expect(result.success).toBeNull();
        expect(result.failures).toHaveLength(1);
        expect(autofixService.maybeHeal).not.toHaveBeenCalled();
      });

      it('records both the original hop and the failed retry when a patch does not clear the error', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        providerClient.forward.mockResolvedValue(failedForwardWithWire(400) as never);
        autofixService.isRepairable.mockReturnValue(true);
        const record = {
          groupId: 'g',
          outcome: 'exhausted' as const,
          original_http_status: 400,
          chain: [
            { attempt: 0, origin: 'original' as const, request: {}, http_status: 400 },
            { attempt: 1, origin: 'autofix' as const, request: {}, http_status: 400 },
          ],
        };
        autofixService.maybeHeal.mockResolvedValue({
          forward: {
            response: new Response('still broken', { status: 400 }),
            attempt: { id: 'retry-attempt' },
            providerCallStarted: true,
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
          } as never,
          record,
        });

        const result = await runFallback();

        expect(result.success).toBeNull();
        // Both provider attempts get a terminal row. The original must not be
        // left dangling pending after Autofix consumed its response.
        expect(result.failures).toHaveLength(2);
        expect(result.failures[0]).toMatchObject({ status: 400, autofixRole: 'original' });
        expect(result.failures[1]).toMatchObject({ status: 400, autofixRole: 'retry' });
        expect(result.failures[0].errorBody).toContain('response_format');
        expect(result.failures[1].errorBody).toBe('still broken');
      });

      it('skips Autofix when the fallback has no resolvable api mode', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        const failedForward = failedForwardWithWire(400);
        delete failedForward.wireApiMode;
        providerClient.forward.mockResolvedValue(failedForward as never);
        autofixService.isRepairable.mockReturnValue(true);

        const result = await service.tryFallbacks(
          'agent-1',
          'tenant-1',
          ['deepseek-flash'],
          body,
          false,
          'sess-1',
          'gpt-4o',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined, // apiMode
          undefined,
          [{ provider: 'opencode-go', authType: 'api_key', model: 'deepseek-flash' }],
        );

        expect(result.success).toBeNull();
        expect(result.failures).toHaveLength(1);
        expect(autofixService.maybeHeal).not.toHaveBeenCalled();
      });

      it('stamps the Phoenix decision on an unfixable fallback hop', async () => {
        providerKeyService.getProviderApiKey.mockResolvedValue('sk-ant');
        providerClient.forward.mockResolvedValue(failedForwardWithWire(400) as never);
        autofixService.isRepairable.mockReturnValue(true);
        const record = {
          groupId: 'g',
          outcome: 'unfixable' as const,
          original_http_status: 400,
          chain: [
            {
              attempt: 0,
              origin: 'original' as const,
              request: {},
              http_status: 400,
              issue_id: 'issue-1',
              operations: [{ type: 'drop_param' }],
            },
          ],
        };
        autofixService.maybeHeal.mockResolvedValue({
          forward: {
            response: new Response('still broken', { status: 400 }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
            providerCallStarted: true,
          } as never,
          record,
        });

        const result = await runFallback();

        expect(result.success).toBeNull();
        // No retry was sent, so this is the original hop and it still carries
        // Phoenix's decision for the audit trail.
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatchObject({ status: 400, autofixRole: 'original' });
        expect(result.failures[0].autofix).toBe(record);
      });
    });
  });

  describe('normalizeProviderModel', () => {
    it('normalizes Anthropic dotted model IDs', () => {
      expect(normalizeProviderModel('Anthropic', 'claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
      expect(normalizeProviderModel('anthropic', 'claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    });

    it('passes through non-Anthropic models unchanged', () => {
      expect(normalizeProviderModel('OpenAI', 'gpt-4o')).toBe('gpt-4o');
    });
  });

  describe('resolveApiKey', () => {
    it('unwraps OpenAI subscription token', async () => {
      openaiOauth.unwrapToken.mockResolvedValue('access-token');

      const result = await resolveApiKey(
        'openai',
        'blob',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
        'Work',
      );

      expect(result.apiKey).toBe('access-token');
      expect(openaiOauth.unwrapToken).toHaveBeenCalledWith('blob', 'agent-1', 'tenant-1', 'Work');
    });

    it('unwraps MiniMax subscription token with resource URL', async () => {
      minimaxOauth.unwrapToken.mockResolvedValue({
        t: 'mm-token',
        r: 'mm-refresh',
        e: Date.now() + 60000,
        u: 'https://api.minimax.io',
      });

      const result = await resolveApiKey(
        'minimax',
        'blob',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('mm-token');
      expect(result.resourceUrl).toBe('https://api.minimax.io');
    });

    it('returns original key for non-subscription auth', async () => {
      const result = await resolveApiKey(
        'openai',
        'sk-key',
        'api_key',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('sk-key');
      expect(openaiOauth.unwrapToken).not.toHaveBeenCalled();
    });

    it('returns null for an OpenAI OAuth blob when unwrap returns null', async () => {
      openaiOauth.unwrapToken.mockResolvedValue(null);
      const blob = JSON.stringify({ t: 'old', r: 'refresh', e: Date.now() - 1000 });

      const result = await resolveApiKey(
        'openai',
        blob,
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBeNull();
    });

    it('unwraps Anthropic subscription token via the OAuth blob path', async () => {
      anthropicOauth.unwrapToken.mockResolvedValue('access-claude');

      const result = await resolveApiKey(
        'anthropic',
        'blob',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('access-claude');
      expect(anthropicOauth.unwrapToken).toHaveBeenCalledWith(
        'blob',
        'agent-1',
        'tenant-1',
        undefined,
      );
    });

    it('returns the original key when Anthropic unwrap returns null', async () => {
      anthropicOauth.unwrapToken.mockResolvedValue(null);

      const result = await resolveApiKey(
        'anthropic',
        'sk-ant-legacy',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('sk-ant-legacy');
      expect(kiroOauth.unwrapToken).not.toHaveBeenCalled();
    });

    it('unwraps Kiro CLI OAuth subscription tokens', async () => {
      kiroOauth.unwrapToken.mockResolvedValue('kiro-access');

      const result = await resolveApiKey(
        'kiro',
        'blob',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('kiro-access');
      expect(kiroOauth.unwrapToken).toHaveBeenCalledWith('blob', 'agent-1', 'tenant-1', undefined);
    });

    it('does not unwrap for non-OAuth subscription providers (e.g. Qwen)', async () => {
      const result = await resolveApiKey(
        'qwen',
        'qwen-key',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('qwen-key');
      expect(openaiOauth.unwrapToken).not.toHaveBeenCalled();
      expect(minimaxOauth.unwrapToken).not.toHaveBeenCalled();
      expect(anthropicOauth.unwrapToken).not.toHaveBeenCalled();
      expect(kiroOauth.unwrapToken).not.toHaveBeenCalled();
      expect(xaiOauth.unwrapToken).not.toHaveBeenCalled();
    });

    it('unwraps xAI OAuth subscription tokens', async () => {
      xaiOauth.unwrapToken.mockResolvedValue('xai-access');

      const result = await resolveApiKey(
        'xai',
        'blob',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('xai-access');
      expect(xaiOauth.unwrapToken).toHaveBeenCalledWith('blob', 'agent-1', 'tenant-1', undefined);
    });

    it('returns original key when MiniMax unwrap returns null', async () => {
      minimaxOauth.unwrapToken.mockResolvedValue(null);

      const result = await resolveApiKey(
        'minimax',
        'blob',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('blob');
    });

    it('returns Z.ai subscription API key unchanged (no OAuth unwrap)', async () => {
      const result = await resolveApiKey(
        'zai',
        'zai-sub-key',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('zai-sub-key');
      expect(result.resourceUrl).toBeUndefined();
      expect(openaiOauth.unwrapToken).not.toHaveBeenCalled();
      expect(minimaxOauth.unwrapToken).not.toHaveBeenCalled();
      expect(anthropicOauth.unwrapToken).not.toHaveBeenCalled();
      expect(kiroOauth.unwrapToken).not.toHaveBeenCalled();
      expect(xaiOauth.unwrapToken).not.toHaveBeenCalled();
    });

    it('unwraps Gemini subscription token and reads project id from blob.u', async () => {
      geminiOauth.unwrapToken.mockResolvedValue('fresh-access-token');
      const blob = JSON.stringify({
        t: 'old-token',
        r: 'refresh',
        e: Date.now() + 3600000,
        u: 'proj-789',
      });

      const result = await resolveApiKey(
        'gemini',
        blob,
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('fresh-access-token');
      expect(result.resourceUrl).toBe('proj-789');
      expect(geminiOauth.unwrapToken).toHaveBeenCalledWith(blob, 'agent-1', 'tenant-1', undefined);
    });

    it('returns null when Gemini unwrapToken cannot recover a stored OAuth blob', async () => {
      geminiOauth.unwrapToken.mockResolvedValue(null);
      const blob = JSON.stringify({ t: 'token', r: 'r', e: Date.now() + 1000, u: 'proj-x' });

      const result = await resolveApiKey(
        'gemini',
        blob,
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBeNull();
    });

    it('returns resourceUrl as undefined when the Gemini blob is not parseable JSON', async () => {
      geminiOauth.unwrapToken.mockResolvedValue('fresh-token');

      const result = await resolveApiKey(
        'gemini',
        'not-valid-json',
        'subscription',
        'agent-1',
        'tenant-1',
        openaiOauth,
        minimaxOauth,
        anthropicOauth,
        geminiOauth,
        kiroOauth,
        xaiOauth,
      );

      expect(result.apiKey).toBe('fresh-token');
      expect(result.resourceUrl).toBeUndefined();
    });
  });

  describe('tryForwardToProvider with Gemini subscription', () => {
    it('passes providerResource to providerClient.forward for gemini subscription', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
        isCodeAssist: true,
      });

      await service.tryForwardToProvider({
        provider: 'gemini',
        apiKey: 'token',
        model: 'gemini-2.5-pro',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'subscription',
        resourceUrl: 'proj-code-assist-123',
      });

      expect(providerClient.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          providerResource: 'proj-code-assist-123',
        }),
      );
    });

    it('does not pass providerResource for non-subscription gemini', async () => {
      providerClient.forward.mockResolvedValue({
        response: new Response('{}', { status: 200 }),
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      });

      await service.tryForwardToProvider({
        provider: 'gemini',
        apiKey: 'AIza-key',
        model: 'gemini-2.5-pro',
        body,
        stream: false,
        sessionKey: 'sess-1',
        authType: 'api_key',
      });

      const callArg = providerClient.forward.mock.calls[0][0];
      expect(callArg.providerResource).toBeUndefined();
    });
  });
});
