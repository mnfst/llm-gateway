import { Repository } from 'typeorm';
import type { ModelRoute } from 'manifest-shared';
import { getProviderParamSpecs, type ProviderParamSpecCatalog } from 'manifest-shared';
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
 * A reasoning effort saved on the tier reaches `ProviderClient.forward` only
 * after the fallback service merges it into the body, so the Bedrock Runtime
 * GPT reroute has to see it there (mnfst/llm-gateway#3107).
 */

const LUNA = 'us.openai.gpt-6-luna';
const KIMI = 'global.moonshotai.kimi-k3';
const RUNTIME = 'https://bedrock-runtime.us-east-1.amazonaws.com';

const specCatalog: ProviderParamSpecCatalog = [LUNA, KIMI].map((model) => ({
  provider: 'bedrock',
  authType: 'api_key' as const,
  model,
  params: [
    {
      path: 'reasoning_effort',
      type: 'enum' as const,
      label: 'Reasoning effort',
      description: 'How hard the model reasons before it answers.',
      values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      group: 'reasoning' as const,
    },
  ],
}));

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Look up the current weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
];

describe('ProxyFallbackService: Bedrock Runtime GPT with a tier reasoning effort', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  const previousSwitch = process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'];
  const originalFetch = global.fetch;
  let service: ProxyFallbackService;
  let modelParamsService: jest.Mocked<AgentModelParamsService>;
  let providerRegion: string | null;
  let fetchMock: jest.Mock;

  const route = (model: string): ModelRoute => ({
    provider: 'bedrock',
    authType: 'api_key',
    model,
  });

  const requests = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url: url as string,
      body: JSON.parse((init as { body: string }).body) as Record<string, unknown>,
    }));

  /** Runs the chain with the tier parameters of `scopeKey: tier:default`. */
  const runChain = (models: string[], body: Record<string, unknown>) =>
    service.tryFallbacks(
      'agent-1',
      'tenant-1',
      models,
      body,
      false,
      'sess-1',
      'primary-model',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'chat_completions',
      undefined,
      models.map(route),
      { agentId: 'agent-1', scopeKey: 'tier:default' },
    );

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    delete process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'];
    providerRegion = null;

    const providerKeyService = {
      getProviderApiKey: jest.fn().mockResolvedValue('bedrock-api-key-test'),
      getProviderKeyId: jest.fn().mockResolvedValue('up-bedrock'),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      findProviderForModel: jest.fn().mockResolvedValue(undefined),
      getProviderRegion: jest.fn(async () => providerRegion),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      selectProviderKey: jest.fn(async () => ({
        apiKey: 'bedrock-api-key-test',
        id: 'up-bedrock',
        region: providerRegion,
        label: 'Default',
        priority: 0,
      })),
    } as unknown as jest.Mocked<ProviderKeyService>;

    const oauthStub = { unwrapToken: jest.fn().mockResolvedValue(null) };

    modelParamsService = {
      get: jest.fn(async (_agentId, _scopeKey, _provider, _authType, model) =>
        model === LUNA ? { reasoning_effort: 'high' } : null,
      ),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<AgentModelParamsService>;

    service = new ProxyFallbackService(
      providerKeyService,
      { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<CustomProvider>,
      oauthStub as unknown as OpenaiOauthService,
      oauthStub as unknown as MinimaxOauthService,
      oauthStub as unknown as AnthropicOauthService,
      oauthStub as unknown as GeminiOauthService,
      oauthStub as unknown as KiroOauthService,
      oauthStub as unknown as XaiOauthService,
      new ProviderClient(),
      { getCopilotToken: jest.fn() } as unknown as CopilotTokenService,
      { getByModel: jest.fn().mockReturnValue(null) } as unknown as ModelPricingCacheService,
      modelParamsService,
      {
        getSpecs: jest.fn(async (provider: string, authType: string, model: string) =>
          getProviderParamSpecs(specCatalog, provider, authType as 'api_key', model),
        ),
        list: jest.fn().mockResolvedValue(specCatalog),
      } as unknown as ProviderParamSpecService,
      new ReasoningContentCache(),
      {
        isRepairable: jest.fn().mockReturnValue(false),
        maybeHeal: jest.fn(),
      } as unknown as AutofixService,
    );

    // The luna hop fails so the chain moves on to the next hop.
    fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { model?: string };
      if (sent.model === LUNA) {
        return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
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
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (previousSwitch === undefined) delete process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'];
    else process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'] = previousSwitch;
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  describe.each([
    ['the default connection', null],
    ['a stored region connection', 'us-east-1'],
  ])('on %s', (_label, region) => {
    beforeEach(() => {
      providerRegion = region;
    });

    it('sends luna to Responses when the tier effort high meets function tools, and kimi stays on chat', async () => {
      const result = await runChain([LUNA, KIMI], {
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools,
        stream: false,
      });

      const sent = requests();
      expect(sent).toHaveLength(2);

      expect(sent[0].url).toBe(`${RUNTIME}/openai/v1/responses`);
      expect(sent[0].body.model).toBe(LUNA);
      expect(sent[0].body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      expect(sent[0].body.tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Look up the current weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]);
      expect(sent[0].body).not.toHaveProperty('messages');
      expect(sent[0].body).not.toHaveProperty('reasoning_effort');

      expect(sent[1].url).toBe(`${RUNTIME}/openai/v1/chat/completions`);
      expect(sent[1].body.model).toBe(KIMI);
      expect(sent[1].body.messages).toBeDefined();
      expect(sent[1].body.tools).toEqual(tools);
      expect(sent[1].body).not.toHaveProperty('input');
      expect(sent[1].body).not.toHaveProperty('reasoning_effort');

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({ provider: 'bedrock', status: 503 });
      expect(result.success).toMatchObject({ provider: 'bedrock', model: KIMI });
    });

    it('keeps luna on chat when the tier effort is high but the request has no tools', async () => {
      await runChain([LUNA], {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      });

      const [sent] = requests();
      expect(sent.url).toBe(`${RUNTIME}/openai/v1/chat/completions`);
      expect(sent.body.reasoning_effort).toBe('high');
      expect(sent.body).not.toHaveProperty('input');
    });

    it('keeps luna on chat when the tier effort is none', async () => {
      modelParamsService.get.mockImplementation(async () => ({ reasoning_effort: 'none' }));

      await runChain([LUNA], {
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools,
        stream: false,
      });

      const [sent] = requests();
      expect(sent.url).toBe(`${RUNTIME}/openai/v1/chat/completions`);
      expect(sent.body.reasoning_effort).toBe('none');
      expect(sent.body.tools).toEqual(tools);
    });

    it('keeps luna on chat with the tier effort when the kill switch is off', async () => {
      process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'] = 'false';

      await runChain([LUNA], {
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools,
        stream: false,
      });

      const [sent] = requests();
      expect(sent.url).toBe(`${RUNTIME}/openai/v1/chat/completions`);
      expect(sent.body.reasoning_effort).toBe('high');
    });
  });
});
