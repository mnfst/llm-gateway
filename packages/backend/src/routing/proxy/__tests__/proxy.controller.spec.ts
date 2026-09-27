import { HttpException, Logger } from '@nestjs/common';
import { FREE_PLAN_REQUESTS_PER_MONTH } from 'manifest-shared';
import { ManifestError } from '../../../common/errors/manifest-error';
import { ProxyController } from '../proxy.controller';
import { ProxyMessageRecorder } from '../proxy-message-recorder';
import { IngestEventBusService } from '../../../common/services/ingest-event-bus.service';
import { ThoughtSignatureCache } from '../thought-signature-cache';
import { ThinkingBlockCache } from '../thinking-block-cache';
import { ReasoningContentCache } from '../reasoning-content-cache';
import { ResponsesSseError } from '../chatgpt-adapter';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';
import type { StartProviderAttempt } from '../proxy-types';
import { buildProxySessionScope } from '../proxy-session-scope';

/**
 * Flush enough microtasks for the recorder's fire-and-forget chain to
 * complete. The chain is: `canonicalizeAgentMessageKeys` → `messageRepo.insert`
 * → `.catch(...)` — three awaits in sequence. Ten rounds of `Promise.resolve`
 * is deterministic (no timer involved) and forgiving if the chain grows.
 */
async function flushRecorderMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function mockResponse(): {
  res: Record<string, jest.Mock | boolean | number>;
  written: string[];
  headers: Record<string, string>;
  statusCode: number;
} {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  let statusCode = 200;
  const res: Record<string, jest.Mock | boolean | number> = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      written.push(chunk);
    }),
    end: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
    status: jest.fn().mockImplementation((code: number) => {
      statusCode = code;
      return res;
    }),
    once: jest.fn(),
    writableEnded: false,
  };
  return {
    res,
    written,
    headers,
    get statusCode() {
      return statusCode;
    },
  };
}

function mockRequest(
  body: Record<string, unknown>,
  userId = 'user-1',
  headers: Record<string, string> = {},
  tenantId = 'tenant-1',
) {
  return {
    ingestionContext: {
      userId,
      tenantId,
      agentId: 'agent-1',
      agentName: 'test-agent',
    },
    body,
    headers,
    ip: '127.0.0.1',
  };
}

function makeDiscoveredModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: 0.0000025,
    outputPricePerToken: 0.00001,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 4,
    authType: 'api_key',
    ...overrides,
  };
}

function makeInterruptedSseResponse(
  firstChunk: string,
  options?: { onFirstChunk?: () => void; error?: Error },
): Response {
  const encoder = new TextEncoder();
  let sentFirstChunk = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentFirstChunk) {
        sentFirstChunk = true;
        controller.enqueue(encoder.encode(firstChunk));
        options?.onFirstChunk?.();
        return;
      }
      controller.error(options?.error ?? new Error('mid-stream failure'));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('ProxyController', () => {
  let controller: ProxyController;
  let proxyService: { proxyRequest: jest.Mock };
  let rateLimiter: {
    checkLimit: jest.Mock;
    checkIpLimit: jest.Mock;
    recordSuccess: jest.Mock;
    acquireSlot: jest.Mock;
    releaseSlot: jest.Mock;
  };
  let providerClient: {
    convertGoogleResponse: jest.Mock;
    convertGoogleStreamChunk: jest.Mock;
    convertAnthropicResponse: jest.Mock;
    convertAnthropicStreamChunk: jest.Mock;
  };
  let mockMessageManager: {
    transaction: jest.Mock;
    getRepository: jest.Mock;
    query: jest.Mock;
  };
  let mockMessageRepo: {
    insert: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let mockPricingCache: { getByModel: jest.Mock };
  let modelDiscovery: { getModelsForAgent: jest.Mock };
  let providerParamSpecs: { getCapabilities: jest.Mock };
  let modelsDevSync: { lookupModelCapabilities: jest.Mock };
  let recorder: ProxyMessageRecorder;
  let planService: { assertWithinRequestLimit: jest.Mock };
  let observationReporter: { report: jest.Mock };
  let recordingConfig: { isRecording: jest.Mock };
  let attemptRecording: { available: boolean; save: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    proxyService = { proxyRequest: jest.fn() };
    planService = { assertWithinRequestLimit: jest.fn().mockResolvedValue(undefined) };
    rateLimiter = {
      checkLimit: jest.fn(),
      checkIpLimit: jest.fn(),
      recordSuccess: jest.fn(),
      acquireSlot: jest.fn(),
      releaseSlot: jest.fn(),
    };
    providerClient = {
      convertGoogleResponse: jest.fn(),
      convertGoogleStreamChunk: jest.fn(),
      convertAnthropicResponse: jest.fn(),
      convertAnthropicStreamChunk: jest.fn(),
    };
    mockMessageManager = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(mockMessageManager),
      ),
      getRepository: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    mockMessageRepo = {
      insert: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      manager: { transaction: mockMessageManager.transaction },
    };
    mockMessageManager.getRepository.mockReturnValue(mockMessageRepo);
    mockPricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
    modelDiscovery = {
      getModelsForAgent: jest.fn().mockResolvedValue([]),
    };
    providerParamSpecs = { getCapabilities: jest.fn().mockResolvedValue(null) };
    modelsDevSync = { lookupModelCapabilities: jest.fn().mockReturnValue(null) };
    observationReporter = { report: jest.fn() };
    recordingConfig = { isRecording: jest.fn().mockResolvedValue(false) };
    attemptRecording = {
      available: true,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const mockCustomProviders = {
      canonicalizeAgentMessageKeys: jest
        .fn()
        .mockImplementation(
          async (_agentId: string, provider: string | null, model: string | null) => ({
            provider: provider ?? null,
            model: model ?? null,
          }),
        ),
    };
    recorder = new ProxyMessageRecorder(
      mockMessageRepo as never,
      mockPricingCache as never,
      { emit: jest.fn() } as unknown as IngestEventBusService,
      mockCustomProviders as never,
      {
        getCostPerRequest: jest.fn().mockReturnValue(null),
        resolveCostPerRequest: jest.fn().mockResolvedValue(null),
      } as never,
    );
    controller = new ProxyController(
      proxyService as never,
      rateLimiter as never,
      providerClient as never,
      recorder,
      new ThoughtSignatureCache(),
      new ThinkingBlockCache(),
      new ReasoningContentCache(),
      modelDiscovery as never,
      planService as never,
      observationReporter as never,
      providerParamSpecs as never,
      modelsDevSync as never,
      recordingConfig as never,
      attemptRecording as never,
    );
  });

  afterEach(() => {
    recorder.onModuleDestroy();
  });

  it('should expose /v1/models as an OpenAI-compatible list with the Manifest auto route', async () => {
    await expect(controller.models(mockRequest({}) as never)).resolves.toEqual({
      object: 'list',
      data: [
        {
          id: 'auto',
          object: 'model',
          created: 0,
          owned_by: 'manifest',
        },
      ],
    });
    expect(modelDiscovery.getModelsForAgent).toHaveBeenCalledWith('tenant-1', 'agent-1');
  });

  it('should include authenticated agent models using provider-qualified ids', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'api_key' }),
      makeDiscoveredModel({ id: 'gpt-4o', provider: 'openrouter', authType: 'api_key' }),
      makeDiscoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'subscription' }),
      makeDiscoveredModel({
        id: 'opencode-go/glm-5.1',
        provider: 'opencode-go',
        authType: 'subscription',
      }),
      makeDiscoveredModel({
        id: 'custom:provider-1/model-a',
        provider: 'custom:provider-1',
        authType: 'api_key',
      }),
      makeDiscoveredModel({
        id: 'custom:provider-2/alibaba/qwen-3-14b',
        provider: 'custom:provider-2',
        providerName: 'Vercel AI Gateway',
        providerAlias: 'vercel-ai-gateway',
        authType: 'api_key',
      }),
      makeDiscoveredModel({ id: 'gpt-4o', provider: 'openai', authType: 'api_key' }),
    ]);

    await expect(controller.models(mockRequest({}) as never)).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        { id: 'openai/gpt-4o', object: 'model', created: 0, owned_by: 'openai' },
        { id: 'openrouter/gpt-4o', object: 'model', created: 0, owned_by: 'openrouter' },
        {
          id: 'openai/gpt-4o-subscription',
          object: 'model',
          created: 0,
          owned_by: 'openai',
        },
        {
          id: 'opencode-go/glm-5.1-subscription',
          object: 'model',
          created: 0,
          owned_by: 'opencode-go',
        },
        {
          id: 'custom:provider-1/model-a',
          object: 'model',
          created: 0,
          owned_by: 'custom:provider-1',
        },
        {
          id: 'vercel-ai-gateway/alibaba/qwen-3-14b',
          object: 'model',
          created: 0,
          owned_by: 'Vercel AI Gateway',
        },
      ],
    });
  });

  it('should keep the default /v1/models shape unchanged when optional metadata exists', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({
        id: 'gpt-4o',
        provider: 'openai',
        inputPricePerToken: 2.5 / 1_000_000,
        outputPricePerToken: 10 / 1_000_000,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: ['text', 'image', 'stream', 'tools'],
        supportedEndpoints: ['/responses'],
      }),
    ]);

    await expect(controller.models(mockRequest({}) as never)).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        { id: 'openai/gpt-4o', object: 'model', created: 0, owned_by: 'openai' },
      ],
    });
  });

  it('should expose provider-native route metadata when requested', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({
        id: 'opencode-go/glm-5.1',
        provider: 'opencode-go',
        authType: 'subscription',
      }),
    ]);

    await expect(
      controller.models(mockRequest({}) as never, undefined, undefined, 'true'),
    ).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        {
          id: 'opencode-go/glm-5.1-subscription',
          object: 'model',
          created: 0,
          owned_by: 'opencode-go',
          provider_model_id: 'opencode-go/glm-5.1',
          auth_type: 'subscription',
        },
      ],
    });
  });

  it('should expose capability metadata when ?capabilities=true, preserving subscription ids', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({
        id: 'gpt-5.4-mini',
        provider: 'openai',
        authType: 'subscription',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: ['text', 'image', 'stream', 'tools'],
        supportedEndpoints: ['/responses'],
      }),
    ]);

    await expect(controller.models(mockRequest({}) as never, 'true')).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        {
          id: 'openai/gpt-5.4-mini-subscription',
          object: 'model',
          created: 0,
          owned_by: 'openai',
          capabilities: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            features: ['stream', 'tools'],
            supported_endpoints: ['/responses'],
          },
        },
      ],
    });
  });

  it('should expose costs in USD per million tokens when ?cost=true', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({
        id: 'gpt-5.4-mini',
        provider: 'openai',
        authType: 'subscription',
        inputPricePerToken: 0.25 / 1_000_000,
        outputPricePerToken: 2 / 1_000_000,
      }),
      makeDiscoveredModel({
        id: 'free-model',
        provider: 'openrouter',
        inputPricePerToken: 0,
        outputPricePerToken: 0,
      }),
    ]);

    await expect(controller.models(mockRequest({}) as never, undefined, 'true')).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        {
          id: 'openai/gpt-5.4-mini-subscription',
          object: 'model',
          created: 0,
          owned_by: 'openai',
          cost: { input: 0.25, output: 2 },
        },
        {
          id: 'openrouter/free-model',
          object: 'model',
          created: 0,
          owned_by: 'openrouter',
          cost: { input: 0, output: 0 },
        },
      ],
    });
  });

  it('should omit unknown cost values and ignore values other than ?cost=true', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({
        id: 'input-only',
        inputPricePerToken: 1 / 1_000_000,
        outputPricePerToken: null,
      }),
      makeDiscoveredModel({
        id: 'output-only',
        inputPricePerToken: null,
        outputPricePerToken: 3 / 1_000_000,
      }),
      makeDiscoveredModel({
        id: 'unknown',
        inputPricePerToken: Number.NaN,
        outputPricePerToken: -1,
      }),
    ]);

    const withCosts = await controller.models(mockRequest({}) as never, undefined, 'true');
    expect(withCosts.data).toEqual([
      { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
      {
        id: 'openai/input-only',
        object: 'model',
        created: 0,
        owned_by: 'openai',
        cost: { input: 1 },
      },
      {
        id: 'openai/output-only',
        object: 'model',
        created: 0,
        owned_by: 'openai',
        cost: { output: 3 },
      },
      { id: 'openai/unknown', object: 'model', created: 0, owned_by: 'openai' },
    ]);

    const withoutCosts = await controller.models(mockRequest({}) as never, undefined, '1');
    expect(withoutCosts.data.every((model) => !('cost' in model))).toBe(true);
  });

  it('should omit the capabilities field for models with unknown metadata and for auto', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({ id: 'mystery-model', provider: 'kiro' }),
      // No discovery-time modalities: the curated known-modalities fallback
      // must supply them even when cached_models predate the curated list.
      makeDiscoveredModel({
        id: 'gpt-5.3-codex-spark',
        provider: 'openai',
        authType: 'subscription',
      }),
    ]);

    await expect(controller.models(mockRequest({}) as never, 'true')).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        { id: 'kiro/mystery-model', object: 'model', created: 0, owned_by: 'kiro' },
        {
          id: 'openai/gpt-5.3-codex-spark-subscription',
          object: 'model',
          created: 0,
          owned_by: 'openai',
          capabilities: {
            input_modalities: ['text'],
            output_modalities: ['text'],
            // OpenAI is a streaming-endpoint provider, so the same heuristic
            // the routing model picker uses asserts stream support here. The
            // curated fallback additionally confirms tools support.
            features: ['stream', 'tools'],
          },
        },
      ],
    });
  });

  it('should resolve capabilities from the same sources as the routing model picker', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({ id: 'gpt-4o', provider: 'openai' }),
    ]);
    providerParamSpecs.getCapabilities.mockResolvedValue(['tools']);
    modelsDevSync.lookupModelCapabilities.mockReturnValue({
      id: 'gpt-4o',
      name: 'GPT-4o',
      inputPricePerToken: null,
      outputPricePerToken: null,
      capabilities: ['text', 'image'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    });

    await expect(controller.models(mockRequest({}) as never, 'true')).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        {
          id: 'openai/gpt-4o',
          object: 'model',
          created: 0,
          owned_by: 'openai',
          capabilities: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            features: ['tools', 'stream'],
          },
        },
      ],
    });
    expect(providerParamSpecs.getCapabilities).toHaveBeenCalledWith('openai', 'api_key', 'gpt-4o');
    expect(modelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('should expose capabilities and cost when both query parameters are true', async () => {
    modelDiscovery.getModelsForAgent.mockResolvedValue([
      makeDiscoveredModel({
        id: 'gpt-4o',
        provider: 'openai',
        inputPricePerToken: 2.5 / 1_000_000,
        outputPricePerToken: 10 / 1_000_000,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: ['text', 'image', 'stream', 'tools'],
      }),
    ]);

    await expect(controller.models(mockRequest({}) as never, 'true', 'true')).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'auto', object: 'model', created: 0, owned_by: 'manifest' },
        {
          id: 'openai/gpt-4o',
          object: 'model',
          created: 0,
          owned_by: 'openai',
          capabilities: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            features: ['stream', 'tools'],
          },
          cost: { input: 2.5, output: 10 },
        },
      ],
    });
  });

  it('should return JSON response for non-streaming OpenAI provider', async () => {
    const responseBody = { choices: [{ message: { content: 'hello' } }] };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res, headers } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(responseBody);
    expect(headers['X-Manifest-Tier']).toBe('simple');
    expect(headers['X-Manifest-Model']).toBe('gpt-4o');
    expect(headers['X-Manifest-Provider']).toBe('OpenAI');
    expect(headers['X-Manifest-Confidence']).toBe('0.9');
    expect(headers['X-Manifest-Reason']).toBe('scored');
  });

  it('routes a native Phoenix replay through the requested subscription connection', async () => {
    const responseBody = { choices: [{ message: { content: 'hello' } }] };
    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: new Response(JSON.stringify(responseBody), { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'direct',
        model: 'gpt-5.5',
        provider: 'openai',
        auth_type: 'subscription',
        confidence: 1,
        reason: 'direct',
      },
    });
    const body = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] };
    const req = mockRequest(body, 'user-1', {
      'x-manifest-provider': 'openai',
      'x-manifest-auth-type': 'subscription',
    });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(proxyService.proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body,
        routingBody: {
          model: 'openai/gpt-5.5-subscription',
          messages: [{ role: 'user', content: 'hi' }],
        },
      }),
    );
  });

  it.each([
    ['chatCompletions', 'chat_completions', { messages: [{ role: 'user', content: 'hi' }] }],
    ['responses', 'responses', { input: 'hi' }],
    ['messages', 'messages', { max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }],
  ] as const)(
    'stamps the API surface of /v1/%s on the pending Request',
    async (route, expectedApiMode, body) => {
      const mockProviderResp = new Response(
        JSON.stringify({ choices: [{ message: { content: 'hello' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'simple', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.9 },
      });
      const pending = jest.spyOn(recorder, 'recordPendingRequest').mockResolvedValue(undefined);
      const { res } = mockResponse();

      await controller[route](mockRequest({ ...body }) as never, res as never);

      expect(pending).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiMode: expectedApiMode }),
      );
    },
  );

  it('records the exact provider request and response on its Provider Attempt', async () => {
    recordingConfig.isRecording.mockResolvedValue(true);
    const responseBody = {
      choices: [{ message: { role: 'assistant', content: 'recorded reply' } }],
    };
    const callerBody = { model: 'auto', messages: [{ role: 'user', content: 'record this' }] };
    const providerBody = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'record this' }],
    };
    proxyService.proxyRequest.mockImplementation(
      async (options: { startProviderAttempt: StartProviderAttempt }) => {
        const attempt = options.startProviderAttempt({
          provider: 'openai',
          model: 'gpt-4o',
          authType: 'api_key',
        });
        attempt.startRecording?.({
          requestBody: providerBody,
          wireFormat: 'openai_chat_completions',
        });
        return {
          forward: {
            response: new Response(JSON.stringify(responseBody), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
            attempt,
          },
          meta: {
            tier: 'simple',
            model: 'gpt-4o',
            provider: 'OpenAI',
            confidence: 0.9,
            reason: 'scored',
            attempt,
          },
        };
      },
    );
    const { res } = mockResponse();

    await controller.chatCompletions(mockRequest(callerBody) as never, res as never);

    expect(recordingConfig.isRecording).toHaveBeenCalledWith('agent-1');
    expect(attemptRecording.save).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(String),
      expect.any(String),
      {
        version: 1,
        wire_format: 'openai_chat_completions',
        request_body: providerBody,
        response_body: {
          type: 'json',
          body: responseBody,
        },
      },
    );
  });

  it('reserves cooldown order without inserting a pending provider-call row', async () => {
    const pendingAttempt = jest.spyOn(recorder, 'recordPendingProviderAttempt');
    let cooldownAttemptNumber: number | undefined;
    let fallbackAttemptNumber: number | undefined;
    proxyService.proxyRequest.mockImplementation(
      async (options: { startProviderAttempt: StartProviderAttempt }) => {
        const cooldown = options.startProviderAttempt({
          provider: 'anthropic',
          model: 'claude-opus-5',
          authType: 'subscription',
          providerCallStarted: false,
        });
        const fallback = options.startProviderAttempt({
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          authType: 'api_key',
        });
        cooldownAttemptNumber = cooldown.attemptNumber;
        fallbackAttemptNumber = fallback.attemptNumber;
        return {
          forward: {
            response: new Response('{"choices":[]}', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
            attempt: fallback,
          },
          meta: {
            tier: 'default',
            model: 'deepseek-v4-flash',
            provider: 'deepseek',
            confidence: 0.9,
            reason: 'scored',
            attempt: fallback,
          },
        };
      },
    );
    const { res } = mockResponse();

    await controller.chatCompletions(
      mockRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }) as never,
      res as never,
    );

    expect(cooldownAttemptNumber).toBe(1);
    expect(fallbackAttemptNumber).toBe(2);
    expect(pendingAttempt).toHaveBeenCalledTimes(1);
    expect(pendingAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ attemptNumber: 2 }),
      expect.objectContaining({ provider: 'deepseek' }),
    );
  });

  it('keeps Autofix original and retry payloads on separate Provider Attempts', async () => {
    recordingConfig.isRecording.mockResolvedValue(true);
    const originalBody = { model: 'gpt-4o', messages: [], unsupported: true };
    const retryBody = { model: 'gpt-4o', messages: [] };
    const originalResponse = { error: { message: 'unsupported parameter' } };
    const retryResponse = { choices: [{ message: { content: 'fixed' } }] };

    proxyService.proxyRequest.mockImplementation(
      async (options: { startProviderAttempt: StartProviderAttempt }) => {
        const original = options.startProviderAttempt({
          provider: 'openai',
          model: 'gpt-4o',
        });
        original.startRecording?.({
          requestBody: originalBody,
          wireFormat: 'openai_chat_completions',
        });
        await original.finishRecording?.({ type: 'json', body: originalResponse });

        const retry = options.startProviderAttempt({
          provider: 'openai',
          model: 'gpt-4o',
        });
        retry.startRecording?.({
          requestBody: retryBody,
          wireFormat: 'openai_chat_completions',
        });

        return {
          forward: {
            response: new Response(JSON.stringify(retryResponse), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
            attempt: retry,
          },
          meta: {
            tier: 'simple',
            model: 'gpt-4o',
            provider: 'openai',
            confidence: 0.9,
            reason: 'auto-fix',
            attempt: retry,
          },
        };
      },
    );

    const { res } = mockResponse();
    await controller.chatCompletions(
      mockRequest({ model: 'auto', messages: [] }) as never,
      res as never,
    );

    expect(res.json).toHaveBeenCalledWith(retryResponse);
    expect(attemptRecording.save).toHaveBeenCalledTimes(2);
    const [originalSave, retrySave] = attemptRecording.save.mock.calls;
    expect(originalSave[1]).toBe(retrySave[1]);
    expect(originalSave[2]).not.toBe(retrySave[2]);
    expect(originalSave[3]).toEqual({
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: originalBody,
      response_body: { type: 'json', body: originalResponse },
    });
    expect(retrySave[3]).toEqual({
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: retryBody,
      response_body: { type: 'json', body: retryResponse },
    });
  });

  it('keeps routing when the recording config lookup fails', async () => {
    recordingConfig.isRecording.mockRejectedValueOnce(new Error('recording unavailable'));
    proxyService.proxyRequest.mockRejectedValueOnce(new HttpException('Too many requests', 429));
    const { res } = mockResponse();

    await controller.chatCompletions(mockRequest({ messages: [] }) as never, res as never);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(attemptRecording.save).not.toHaveBeenCalled();
  });

  it('keeps serving a captured response when saving its recording fails', async () => {
    recordingConfig.isRecording.mockResolvedValue(true);
    attemptRecording.save.mockRejectedValueOnce(new Error('recording unavailable'));
    const responseBody = { choices: [{ message: { content: 'still served' } }] };
    proxyService.proxyRequest.mockImplementation(
      async (options: { startProviderAttempt: StartProviderAttempt }) => {
        const attempt = options.startProviderAttempt({
          provider: 'openai',
          model: 'gpt-4o',
        });
        attempt.startRecording?.({
          requestBody: { model: 'gpt-4o', messages: [] },
          wireFormat: 'openai_chat_completions',
        });
        return {
          forward: {
            response: new Response(JSON.stringify(responseBody), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
            attempt,
          },
          meta: {
            tier: 'simple',
            model: 'gpt-4o',
            provider: 'openai',
            confidence: 0.9,
            reason: 'scored',
            attempt,
          },
        };
      },
    );
    const { res } = mockResponse();

    await controller.chatCompletions(mockRequest({ messages: [] }) as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(responseBody);
    expect(attemptRecording.save).toHaveBeenCalledTimes(1);
  });

  it('keeps routing when pending Request recording fails and tracks the provider attempt', async () => {
    jest.spyOn(recorder, 'recordPendingRequest').mockRejectedValueOnce(new Error('request write'));
    proxyService.proxyRequest.mockImplementation(
      async (opts: {
        startProviderAttempt: (start: {
          provider: string;
          model: string;
          authType?: string;
          tenantProviderId?: string;
        }) => {
          pendingWrite: Promise<boolean>;
          completeFailure?: (failure: {
            status: number;
            errorBody: string;
            superseded: boolean;
          }) => Promise<void>;
        };
      }) => {
        const attempt = opts.startProviderAttempt({
          provider: 'openai',
          model: 'gpt-4o',
          authType: 'api_key',
          tenantProviderId: 'connection-1',
        });
        await attempt.pendingWrite;
        await attempt.completeFailure?.({
          status: 429,
          errorBody: 'retrying',
          superseded: true,
        });
        return {
          forward: {
            response: new Response('{"choices":[]}', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
          },
          meta: {
            tier: 'simple',
            model: 'gpt-4o',
            provider: 'openai',
            confidence: 0.9,
            reason: 'scored',
          },
        };
      },
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        auth_type: 'api_key',
        tenant_provider_id: 'connection-1',
      }),
    );
    expect(mockMessageRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ status: 'failed', error_http_status: 429, superseded: true }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('keeps routing when pending Attempt writes and completion writes fail', async () => {
    jest
      .spyOn(recorder, 'recordPendingProviderAttempt')
      .mockRejectedValueOnce(new Error('attempt insert'));
    jest
      .spyOn(recorder, 'completePendingProviderFailure')
      .mockRejectedValueOnce(new Error('attempt update'));
    proxyService.proxyRequest.mockImplementation(
      async (opts: { startProviderAttempt: StartProviderAttempt }) => {
        const attempt = opts.startProviderAttempt({ provider: 'openai', model: 'gpt-4o' });
        await attempt.pendingWrite;
        await attempt.completeFailure?.({ status: 500, errorBody: 'failed', superseded: false });
        return {
          forward: {
            response: new Response('{"choices":[]}', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
            isGoogle: false,
            isAnthropic: false,
            isChatGpt: false,
          },
          meta: {
            tier: 'simple',
            model: 'gpt-4o',
            provider: 'openai',
            confidence: 0.9,
            reason: 'scored',
          },
        };
      },
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('enforces the plan request limit before routing and records a Manifest policy row', async () => {
    const block = new HttpException(
      {
        statusCode: 402,
        code: 'PLAN_LIMIT_REQUESTS',
        limit: FREE_PLAN_REQUESTS_PER_MONTH,
        used: FREE_PLAN_REQUESTS_PER_MONTH,
      },
      402,
    );
    planService.assertWithinRequestLimit.mockRejectedValueOnce(block);
    const recordSpy = jest.spyOn(recorder, 'recordManifestBlockedRequest');

    const req = mockRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    // The gate runs BEFORE the try/catch, so the 402 propagates to
    // ProxyExceptionFilter instead of the local handleProxyError.
    await expect(controller.chatCompletions(req as never, res as never)).rejects.toBe(block);
    await flushRecorderMicrotasks();

    // Gate ran before rate limiting / routing. The recorded row is classified as
    // Manifest policy, which PlanService excludes from billable request counts.
    expect(planService.assertWithinRequestLimit).toHaveBeenCalledWith(req.ingestionContext);
    expect(rateLimiter.checkLimit).not.toHaveBeenCalled();
    expect(proxyService.proxyRequest).not.toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledWith(
      req.ingestionContext,
      expect.objectContaining({
        httpStatus: 402,
        errorMessage: 'Free plan monthly request limit reached',
        reason: 'plan_request_limit_exceeded',
        model: 'auto',
      }),
    );
    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error_http_status: 402,
        routing_reason: 'plan_request_limit_exceeded',
        error_origin: 'policy',
        error_class: 'plan_request_limit_exceeded',
      }),
    );
  });

  it('routes a non-402 plan-lookup error through the normal proxy error handler', async () => {
    // A subscription/tenant lookup failure is Manifest's own bug (M500), not a
    // provider failure — it must be recorded + normalized, never thrown raw
    // (which would 500 the caller) and never blamed on the provider.
    planService.assertWithinRequestLimit.mockRejectedValueOnce(new Error('subscription db down'));
    const manifestSpy = jest.spyOn(recorder, 'recordManifestBlockedRequest');
    const providerSpy = jest.spyOn(recorder, 'recordProviderError');

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(providerSpy).not.toHaveBeenCalled();
    expect(manifestSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        errorCode: 'M500',
        reason: 'manifest_internal_error',
        httpStatus: 500,
        // The real internal message, not the friendly text the caller sees.
        errorMessage: expect.stringContaining('subscription db down'),
      }),
    );
    expect(proxyService.proxyRequest).not.toHaveBeenCalled();
  });

  it('should expose /v1/responses and convert chat completions output to Responses format', async () => {
    const responseBody = {
      created: 1234,
      model: 'gpt-4o',
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ input: 'hi' });
    const { res } = mockResponse();

    await controller.responses(req as never, res as never);

    expect(proxyService.proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ apiMode: 'responses', body: { input: 'hi' } }),
    );
    const json = (res.json as jest.Mock).mock.calls[0][0];
    expect(json.object).toBe('response');
    expect(json.output[0].content[0]).toEqual({
      type: 'output_text',
      text: 'hello',
      annotations: [],
    });
    expect(json.usage.input_tokens).toBe(4);
  });

  it('should expose /v1/messages and convert chat completions output to Anthropic Messages format', async () => {
    const responseBody = {
      id: 'cc_1',
      model: 'claude-sonnet-4',
      choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'claude-sonnet-4',
        provider: 'Anthropic',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({
      model: 'claude-sonnet-4',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { res } = mockResponse();

    await controller.messages(req as never, res as never);

    expect(proxyService.proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ apiMode: 'messages' }),
    );
    const json = (res.json as jest.Mock).mock.calls[0][0];
    expect(json.type).toBe('message');
    expect(json.role).toBe('assistant');
    expect(json.content).toEqual([{ type: 'text', text: 'hi there' }]);
    expect(json.stop_reason).toBe('end_turn');
    expect(json.usage).toMatchObject({ input_tokens: 4, output_tokens: 2 });
  });

  it('preserves an Anthropic 400 diagnostic on /v1/messages in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const providerError = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: '`temperature` is deprecated for this model.',
        },
      };
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response(JSON.stringify(providerError), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
          isGoogle: false,
          isAnthropic: true,
          isChatGpt: false,
        },
        meta: {
          tier: 'complex',
          model: 'claude-opus-4-1',
          provider: 'Anthropic',
          confidence: 1,
          reason: 'explicit-model',
        },
      });

      const req = mockRequest({
        model: 'claude-opus-4-1',
        max_tokens: 64,
        temperature: 0.1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const { res } = mockResponse();

      await controller.messages(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        type: 'error',
        error: expect.objectContaining({
          type: 'invalid_request_error',
          message: '`temperature` is deprecated for this model.',
          status: 400,
          source: 'provider',
        }),
      });
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
    }
  });

  it('should pass through native Responses JSON bodies', async () => {
    const responseBody = {
      id: 'resp_1',
      object: 'response',
      output: [{ type: 'message' }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        isResponses: true,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ input: 'hi' });
    const { res } = mockResponse();

    await controller.responses(req as never, res as never);

    expect(res.json).toHaveBeenCalledWith(responseBody);
  });

  it('should convert Google response for non-streaming', async () => {
    const googleBody = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
    const convertedBody = { choices: [{ message: { content: 'hi' } }] };

    const mockProviderResp = new Response(JSON.stringify(googleBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: true, isAnthropic: false, isChatGpt: false },
      meta: {
        tier: 'standard',
        model: 'gemini-2.0-flash',
        provider: 'Google',
        confidence: 0.8,
        reason: 'scored',
      },
    });
    providerClient.convertGoogleResponse.mockReturnValue(convertedBody);

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(providerClient.convertGoogleResponse).toHaveBeenCalledWith(
      googleBody,
      'gemini-2.0-flash',
    );
    expect(res.json).toHaveBeenCalledWith(convertedBody);
  });

  it('should convert Anthropic response for non-streaming', async () => {
    const anthropicBody = {
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const convertedBody = { choices: [{ message: { content: 'hello' } }] };

    const mockProviderResp = new Response(JSON.stringify(anthropicBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: false, isAnthropic: true, isChatGpt: false },
      meta: {
        tier: 'complex',
        model: 'claude-sonnet-4-20250514',
        provider: 'Anthropic',
        confidence: 0.9,
        reason: 'scored',
      },
    });
    providerClient.convertAnthropicResponse.mockReturnValue(convertedBody);

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(providerClient.convertAnthropicResponse).toHaveBeenCalledWith(
      anthropicBody,
      'claude-sonnet-4-20250514',
    );
    expect(res.json).toHaveBeenCalledWith(convertedBody);
  });

  it('should collect ChatGPT SSE response for non-streaming', async () => {
    const sseText =
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n' +
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8},"output":[{"type":"message"}]}}\n\n';
    const collectedBody = {
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };

    const mockProviderResp = new Response(sseText, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: false, isAnthropic: false, isChatGpt: true },
      meta: {
        tier: 'standard',
        model: 'gpt-5.3-codex',
        provider: 'OpenAI',
        confidence: 0.8,
        reason: 'scored',
      },
    });
    (providerClient as Record<string, jest.Mock>).collectChatGptSseResponse = jest
      .fn()
      .mockReturnValue(collectedBody);

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(
      (providerClient as Record<string, jest.Mock>).collectChatGptSseResponse,
    ).toHaveBeenCalledWith(sseText, 'gpt-5.3-codex');
    expect(res.json).toHaveBeenCalledWith(collectedBody);
  });

  it('should record route metadata when collected SSE response fails after routing', async () => {
    const sseText = 'event: error\ndata: {"error":{"message":"too large"}}\n\n';
    const errorBody = JSON.stringify({
      error: {
        message: 'Your input exceeds the context window of this model.',
        code: 'context_length_exceeded',
        type: 'invalid_request_error',
      },
    });
    const mockProviderResp = new Response(sseText, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: true,
      },
      meta: {
        tier: 'standard',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        confidence: 0.8,
        reason: 'scored',
        auth_type: 'subscription',
        provider_key_label: 'Work',
        tenantProviderId: 'tenant-provider-1',
        request_params: { reasoning_effort: 'medium' },
        header_tier_id: 'header-tier-1',
        header_tier_name: 'Premium',
        header_tier_color: 'indigo',
      },
    });
    (providerClient as Record<string, jest.Mock>).collectChatGptSseResponse = jest
      .fn()
      .mockImplementation(() => {
        throw new ResponsesSseError(
          'Your input exceeds the context window of this model.',
          400,
          errorBody,
        );
      });

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await flushRecorderMicrotasks();

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error_http_status: 400,
        error_message: errorBody,
        model: 'gpt-5.3-codex',
        provider: 'openai',
        routing_tier: 'standard',
        routing_reason: 'scored',
        auth_type: 'subscription',
        provider_key_label: 'Work',
        tenant_provider_id: 'tenant-provider-1',
        request_params: { reasoning_effort: 'medium' },
        header_tier_id: 'header-tier-1',
        header_tier_name: 'Premium',
        header_tier_color: 'indigo',
      }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.3-codex',
      }),
    });
  });

  describe('post-routing M500 rows', () => {
    const failAfterRouting = (meta: Record<string, unknown>) => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response('data: {}\n\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        },
        meta,
      });
      (providerClient as Record<string, jest.Mock>).collectChatGptSseResponse = jest
        .fn()
        .mockImplementation(() => {
          throw new Error('adapter bug');
        });
    };

    it('keeps the tier and header tier the request was routed through', async () => {
      failAfterRouting({
        tier: 'standard',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        confidence: 0.8,
        reason: 'header-match',
        specificity_category: 'coding',
        header_tier_id: 'header-tier-1',
        header_tier_name: 'Program Weeks',
        header_tier_color: 'indigo',
      });
      const manifestSpy = jest.spyOn(recorder, 'recordManifestBlockedRequest');

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();
      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(manifestSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          errorCode: 'M500',
          routing: {
            tier: 'standard',
            specificityCategory: 'coding',
            headerTierId: 'header-tier-1',
            headerTierName: 'Program Weeks',
            headerTierColor: 'indigo',
          },
        }),
      );
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_code: 'M500',
          provider: null,
          routing_tier: 'standard',
          specificity_category: 'coding',
          header_tier_id: 'header-tier-1',
          header_tier_name: 'Program Weeks',
          header_tier_color: 'indigo',
        }),
      );
    });

    it("does not stamp a friendly stub's placeholder tier", async () => {
      failAfterRouting({
        tier: 'simple',
        model: 'manifest',
        provider: 'manifest',
        confidence: 1,
        reason: 'manifest_internal_error',
      });
      const manifestSpy = jest.spyOn(recorder, 'recordManifestBlockedRequest');

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();
      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(manifestSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ routing: expect.anything() }),
      );
    });
  });

  it('should record message with zero tokens when response reports zero usage', async () => {
    const responseBody = {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ input_tokens: 0, output_tokens: 0, status: 'success' }),
    );
  });

  it('should record message with zero tokens when response has no usage', async () => {
    const responseBody = { choices: [{ message: { content: 'hello' } }] };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 0,
        output_tokens: 0,
        status: 'success',
        model: 'gpt-4o',
      }),
    );
  });

  it('should record usage data on fallback success', async () => {
    const responseBody = {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 500, completion_tokens: 200 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
        fallbackFromModel: 'claude-sonnet-4-20250514',
        fallbackIndex: 0,
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setTimeout(r, 10));

    const insertCalls = mockMessageRepo.insert.mock.calls;
    const successRecord = insertCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).status === 'success' &&
        (call[0] as Record<string, unknown>).input_tokens === 500,
    );
    expect(successRecord).toBeDefined();
    const record = successRecord![0] as Record<string, unknown>;
    expect(record.output_tokens).toBe(200);
    expect(record.fallback_from_model).toBe('claude-sonnet-4-20250514');
    expect(record.fallback_index).toBe(0);
  });

  it('should compute cost on fallback success when pricing is available', async () => {
    mockPricingCache.getByModel.mockReturnValue({
      input_price_per_token: 0.000005,
      output_price_per_token: 0.00002,
    });

    const responseBody = {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 800, completion_tokens: 300 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: false, isAnthropic: false },
      meta: {
        tier: 'standard',
        model: 'deepseek-chat',
        provider: 'DeepSeek',
        confidence: 0.8,
        reason: 'scored',
        fallbackFromModel: 'gpt-4o',
        fallbackIndex: 0,
        primaryErrorStatus: 401,
        primaryErrorBody: 'Unauthorized',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setTimeout(r, 10));

    const insertCalls = mockMessageRepo.insert.mock.calls;
    const successRecord = insertCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).status === 'success' &&
        (call[0] as Record<string, unknown>).input_tokens === 800,
    );
    expect(successRecord).toBeDefined();
    const record = successRecord![0] as Record<string, unknown>;
    expect(record.output_tokens).toBe(300);
    expect(record.cost_usd).toBe(800 * 0.000005 + 300 * 0.00002);
    expect(record.fallback_from_model).toBe('gpt-4o');
    expect(record.fallback_index).toBe(0);
  });

  it('should warn when recordSuccessMessage fails', async () => {
    mockMessageRepo.insert.mockRejectedValue(new Error('DB write failed'));

    const responseBody = {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setTimeout(r, 10));

    // The catch handler should log a warning, not throw
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should forward provider error status and body', async () => {
    const errorBody = '{"error": "rate limit"}';
    const mockProviderResp = new Response(errorBody, {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'standard',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.8,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: 'rate limit',
        type: 'rate_limit_error',
        code: null,
        status: 429,
        source: 'provider',
        provider: 'OpenAI',
        model: 'gpt-4o',
      }),
    });
  });

  it('should report the provider-facing body and API mode to Phoenix', async () => {
    const wireRequestBody = {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'test' }],
      thinking: { type: 'adaptive', budget_tokens: 8192 },
    };
    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: new Response('{"error":"invalid thinking"}', { status: 400 }),
        wireRequestBody,
        wireRequestUrl: 'https://api.anthropic.com/v1/messages',
        wireFormat: 'anthropic_messages',
        wireApiMode: 'messages',
        retryWireBody: jest.fn(),
        isGoogle: false,
        isAnthropic: true,
        isChatGpt: false,
      },
      meta: {
        tier: 'standard',
        model: 'claude-opus-4-8',
        provider: 'Anthropic',
        auth_type: 'api_key',
        confidence: 0.8,
        reason: 'scored',
      },
    });

    const req = mockRequest({
      model: 'auto',
      messages: [{ role: 'user', content: 'test' }],
    });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(observationReporter.report).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-4-8',
        provider: 'Anthropic',
        authType: 'api_key',
        apiMode: 'messages',
        requestBody: wireRequestBody,
        providerWire: {
          format: 'anthropic_messages',
          url: 'https://api.anthropic.com/v1/messages',
          body: wireRequestBody,
        },
      }),
    );
    expect(observationReporter.report.mock.calls[0][0]).not.toHaveProperty('resolvedModel');
  });

  it('reports native Gemini failures with model metadata outside the exact provider body', async () => {
    const wireRequestBody = {
      contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      generationConfig: { maxOutputTokens: 32000, topP: 1, temperature: 1 },
    };
    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: new Response('{"error":{"message":"model unavailable"}}', { status: 404 }),
        wireRequestBody,
        wireRequestUrl:
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
        wireFormat: 'google_generate_content',
        wireApiMode: undefined,
        isGoogle: true,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'standard',
        model: 'gemini-2.5-flash-lite',
        provider: 'Gemini',
        auth_type: 'api_key',
        confidence: 0.8,
        reason: 'scored',
      },
    });

    const req = mockRequest({ model: 'auto', messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();
    await controller.chatCompletions(req as never, res as never);

    expect(observationReporter.report).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash-lite',
        apiMode: 'chat_completions',
        requestBody: wireRequestBody,
        providerWire: {
          format: 'google_generate_content',
          url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
          body: wireRequestBody,
        },
      }),
    );
    expect(observationReporter.report.mock.calls[0][0].requestBody).not.toHaveProperty('model');
  });

  it('should handle 500 errors from proxyService as friendly chat message', async () => {
    proxyService.proxyRequest.mockRejectedValue(new Error('Internal failure'));

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] }, 'user-1', {
      accept: 'text/event-stream',
    });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'chat.completion',
        choices: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              content: expect.stringContaining('[🦚 Manifest M500]'),
            }),
          }),
        ]),
      }),
    );
  });

  it('should return HTTP 500 with structured envelope for non-chat clients', async () => {
    proxyService.proxyRequest.mockRejectedValue(new Error('Internal failure'));

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          type: 'server_error',
          message: expect.stringContaining('internal error'),
        }),
      }),
    );
  });

  it('should surface collected Responses SSE failures as OpenAI-compatible errors', async () => {
    proxyService.proxyRequest.mockRejectedValue(
      new ResponsesSseError(
        'Model unavailable',
        404,
        JSON.stringify({
          error: {
            message: 'Model unavailable',
            code: 'model_not_found',
            type: 'invalid_request_error',
          },
        }),
      ),
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: 'Model unavailable',
        type: 'invalid_request_error',
        code: 'model_not_found',
        status: 404,
        source: 'provider',
      }),
    });
  });

  it('scrubs provider credentials out of the logged Responses SSE failure', async () => {
    // A ChatGPT-family SSE failure carries the raw upstream body, which on a
    // 401 can contain the caller's own key.
    const key = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
    const leaky = JSON.stringify({
      error: { message: `invalid x-api-key: ${key}`, type: 'authentication_error' },
    });
    proxyService.proxyRequest.mockRejectedValue(new ResponsesSseError(leaky, 401, leaky));
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    errorSpy.mockRestore();
    expect(logged).toContain('Proxy error:');
    expect(logged).toContain('[REDACTED]');
    expect(logged).not.toContain(key);
  });

  it('should forward HttpException as friendly chat message', async () => {
    proxyService.proxyRequest.mockRejectedValue(
      new HttpException('Bad request: messages required', 400),
    );

    const req = mockRequest({}, 'user-1', { accept: 'text/event-stream' });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        object: 'chat.completion',
        choices: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              content: 'Bad request: messages required',
            }),
          }),
        ]),
      }),
    );
  });

  it('should return HTTP 400 with structured envelope when caller is non-chat', async () => {
    proxyService.proxyRequest.mockRejectedValue(
      new HttpException('Bad request: messages required', 400),
    );

    const req = mockRequest({});
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          type: 'invalid_request_error',
          message: 'Bad request: messages required',
        }),
      }),
    );
  });

  it('should record rate_limited agent_message on 429', async () => {
    proxyService.proxyRequest.mockRejectedValue(
      new HttpException('Too many requests — wait a few seconds and retry.', 429),
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await flushRecorderMicrotasks();

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        agent_id: 'agent-1',
        agent_name: 'test-agent',
        status: 'failed',
        error_class: 'rate_limit',
        input_tokens: 0,
        output_tokens: 0,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('should record error message on 500 from catch block', async () => {
    proxyService.proxyRequest.mockRejectedValue(new Error('Internal failure'));

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    // Wait for fire-and-forget promise
    await new Promise((r) => setTimeout(r, 10));

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error_message: 'Internal failure',
      }),
    );
  });

  it('should record agent_message on 400 errors from catch block', async () => {
    proxyService.proxyRequest.mockRejectedValue(new HttpException('Bad request', 400));

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await flushRecorderMicrotasks();

    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error_message: 'Bad request',
      }),
    );
  });

  it('should apply cooldown for repeated 429 errors from same agent', async () => {
    const limitError = new HttpException({ error: { message: 'Limit exceeded' } }, 429);
    proxyService.proxyRequest.mockRejectedValue(limitError);

    // First 429
    const req1 = mockRequest({ messages: [{ role: 'user', content: 'a' }] });
    const { res: res1 } = mockResponse();
    await controller.chatCompletions(req1 as never, res1 as never);

    // Second 429 (same agent) — within cooldown window, should be deduplicated
    const req2 = mockRequest({ messages: [{ role: 'user', content: 'b' }] });
    const { res: res2 } = mockResponse();
    await controller.chatCompletions(req2 as never, res2 as never);

    expect(mockMessageRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('should use x-session-key header when present', async () => {
    const responseBody = { choices: [] };
    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: new Response(JSON.stringify(responseBody), { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    req.headers = { 'x-session-key': 'my-session' };
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    const scope = buildProxySessionScope('tenant-1', 'agent-1', 'my-session');
    expect(proxyService.proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        userId: 'user-1',
        body: req.body,
        sessionKey: 'my-session',
        sessionCacheKey: scope.cacheKey,
        providerCacheKey: scope.providerCacheKey,
        sessionMomentumKey: scope.momentumKey,
        tenantId: 'tenant-1',
        agentName: 'test-agent',
        signal: expect.any(AbortSignal),
        headers: expect.any(Object),
      }),
    );
  });

  it('should default session key to "default" when header is absent', async () => {
    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    const scope = buildProxySessionScope('tenant-1', 'agent-1', undefined);
    expect(proxyService.proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        userId: 'user-1',
        body: req.body,
        sessionKey: 'default',
        sessionCacheKey: scope.cacheKey,
        providerCacheKey: undefined,
        sessionMomentumKey: undefined,
        tenantId: 'tenant-1',
        agentName: 'test-agent',
        signal: expect.any(AbortSignal),
        headers: expect.any(Object),
      }),
    );
  });

  describe('rate limiting', () => {
    it('should call checkLimit and acquireSlot before proxying', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'simple', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.9 },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(rateLimiter.checkLimit).toHaveBeenCalledWith('tenant-1');
      expect(rateLimiter.acquireSlot).toHaveBeenCalledWith('tenant-1');
    });

    it('should releaseSlot even when proxyService throws', async () => {
      proxyService.proxyRequest.mockRejectedValue(new Error('fail'));

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(rateLimiter.releaseSlot).toHaveBeenCalledWith('tenant-1');
    });

    it('should not call proxyService when checkLimit throws', async () => {
      rateLimiter.checkLimit.mockImplementation(() => {
        throw new HttpException('Too many requests', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(proxyService.proxyRequest).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
    });

    it('should return a stable public envelope for provider 429 errors', async () => {
      rateLimiter.checkLimit.mockImplementation(() => {
        throw new HttpException('Too many requests', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        error: { message: 'Rate limited by upstream provider', type: 'rate_limit_error' },
      });
    });

    it('should not expose structured exception details on 429', async () => {
      rateLimiter.checkLimit.mockImplementation(() => {
        throw new HttpException(
          {
            error: {
              message: '<script>alert("leak")</script>',
              stack: 'Error: secret stack trace',
            },
          },
          429,
        );
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        error: { message: 'Rate limited by upstream provider', type: 'rate_limit_error' },
      });
    });

    it('should NOT releaseSlot when checkLimit throws (slot never acquired)', async () => {
      rateLimiter.checkLimit.mockImplementation(() => {
        throw new HttpException('Rate limit exceeded', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(rateLimiter.acquireSlot).not.toHaveBeenCalled();
      expect(rateLimiter.releaseSlot).not.toHaveBeenCalled();
    });

    it('should NOT releaseSlot when acquireSlot throws (slot never acquired)', async () => {
      rateLimiter.acquireSlot.mockImplementation(() => {
        throw new HttpException('Too many concurrent requests', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(rateLimiter.checkLimit).toHaveBeenCalled();
      expect(rateLimiter.releaseSlot).not.toHaveBeenCalled();
    });

    it('should record local rate-limit blocks as Manifest policy rows', async () => {
      // The real limiter throws a ManifestError — that type is what tells the
      // controller this 429 is Manifest's, not a provider's.
      rateLimiter.checkLimit.mockImplementation(() => {
        throw new ManifestError('M201', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          tenant_id: 'tenant-1',
          error_http_status: 429,
          routing_reason: 'manifest_rate_limited',
          error_origin: 'policy',
          error_class: 'rate_limit',
          error_code: 'M201',
        }),
      );
    });

    it('names which limit fired: per-IP is M202, not the per-user reason', async () => {
      rateLimiter.checkIpLimit.mockImplementation(() => {
        throw new ManifestError('M202', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_code: 'M202',
          routing_reason: 'manifest_ip_rate_limited',
          error_origin: 'policy',
        }),
      );
    });

    it('names which limit fired: concurrency is M203', async () => {
      rateLimiter.acquireSlot.mockImplementation(() => {
        throw new ManifestError('M203', 429);
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_code: 'M203',
          routing_reason: 'manifest_concurrency_limited',
        }),
      );
    });
  });

  describe('Manifest-authored failures', () => {
    it('records a malformed body (M300) on the request origin, not the provider', async () => {
      proxyService.proxyRequest.mockRejectedValueOnce(new ManifestError('M300', 400));
      const providerSpy = jest.spyOn(recorder, 'recordProviderError');

      const req = mockRequest({ messages: [] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(providerSpy).not.toHaveBeenCalled();
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_code: 'M300',
          error_http_status: 400,
          error_origin: 'request',
          error_class: 'invalid_request',
          provider: null,
          routing_tier: null,
        }),
      );
    });

    it('never records an unauthenticated auth failure — there is no agent to attribute it to', async () => {
      // M005 reaches the proxy only via the guard, which throws before any tenant
      // resolves. If it ever surfaced here it must still write nothing.
      proxyService.proxyRequest.mockRejectedValueOnce(new ManifestError('M005', 401));

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(mockMessageRepo.insert).not.toHaveBeenCalled();
    });

    it('swallows a recorder failure on the stub path rather than failing the response', async () => {
      jest
        .spyOn(recorder, 'recordManifestBlockedRequest')
        .mockRejectedValueOnce(new Error('db down'));
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'no key' } }],
              usage: { prompt_tokens: 0, completion_tokens: 0 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'manifest',
          provider: 'manifest',
          confidence: 1,
          reason: 'no_provider',
          manifest_error_code: 'M101',
          manifest_error_message: '[🦚 Manifest M101] No providers set up yet.',
        },
        failedFallbacks: [],
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await expect(controller.chatCompletions(req as never, res as never)).resolves.toBeUndefined();
      await flushRecorderMicrotasks();

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('records an HTTP-200 friendly stub as a failed setup row, not a success', async () => {
      // What the user saw in the dashboard as "Failed: Setup": the proxy answered
      // 200 with a canned assistant message because no provider key was present.
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'no key' } }],
              usage: { prompt_tokens: 0, completion_tokens: 0 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'manifest',
          provider: 'manifest',
          confidence: 1,
          reason: 'no_provider_key',
          manifest_error_code: 'M100',
          manifest_error_message: '[🦚 Manifest M100] No anthropic API key yet.',
        },
        failedFallbacks: [],
      });
      const successSpy = jest.spyOn(recorder, 'recordSuccessMessage');

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }], model: 'auto' });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(successSpy).not.toHaveBeenCalled();
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_code: 'M100',
          error_message: '[🦚 Manifest M100] No anthropic API key yet.',
          error_origin: 'config',
          error_class: 'no_provider_key',
          model: 'auto',
          provider: null,
          routing_tier: null,
        }),
      );
    });
  });

  describe('provider error recording', () => {
    it('should record error message on 403 provider response', async () => {
      const errorBody = '{"error":{"message":"Key limit exceeded"}}';
      const mockProviderResp = new Response(errorBody, {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 'tenant-1',
          agent_id: 'agent-1',
          status: 'failed',
          error_message: errorBody,
          model: 'gpt-4o',
          routing_tier: 'standard',
          input_tokens: 0,
          output_tokens: 0,
        }),
      );
    });

    it('should record rate_limited on 429 provider response', async () => {
      const errorBody = '{"error":"rate limit"}';
      const mockProviderResp = new Response(errorBody, {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_class: 'rate_limit',
          model: 'gpt-4o',
          routing_tier: 'standard',
        }),
      );
    });

    it('should record error on 500 provider response', async () => {
      const errorBody = 'Internal server error';
      const mockProviderResp = new Response(errorBody, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'complex',
          model: 'claude-opus-4',
          provider: 'Anthropic',
          confidence: 0.9,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          model: 'claude-opus-4',
          routing_tier: 'complex',
        }),
      );
    });

    it('should handle messageRepo.insert failure gracefully on provider error', async () => {
      mockMessageRepo.insert.mockRejectedValue(new Error('DB write failed'));

      const mockProviderResp = new Response('{"error":"bad request"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      // Should not throw even though insert fails
      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({
          message: 'bad request',
          type: 'invalid_request_error',
          code: null,
          status: 400,
          source: 'provider',
        }),
      });
    });

    it('should record every 429 provider response without cooldown', async () => {
      const makeResp = () =>
        new Response('{"error":"rate limit"}', {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });

      proxyService.proxyRequest.mockResolvedValue({
        forward: { response: makeResp(), isGoogle: false, isAnthropic: false, isChatGpt: false },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req1 = mockRequest({ messages: [{ role: 'user', content: 'a' }] });
      const { res: res1 } = mockResponse();
      await controller.chatCompletions(req1 as never, res1 as never);
      await new Promise((r) => setTimeout(r, 10));

      proxyService.proxyRequest.mockResolvedValue({
        forward: { response: makeResp(), isGoogle: false, isAnthropic: false, isChatGpt: false },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req2 = mockRequest({ messages: [{ role: 'user', content: 'b' }] });
      const { res: res2 } = mockResponse();
      await controller.chatCompletions(req2 as never, res2 as never);
      await new Promise((r) => setTimeout(r, 10));

      // Second 429 is within cooldown window, only first is recorded
      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('should store trace_id from traceparent header in error records', async () => {
      const errorBody = '{"error":{"message":"Unauthorized"}}';
      const mockProviderResp = new Response(errorBody, {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: { response: mockProviderResp, isGoogle: false },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] }, 'user-1', {
        traceparent: '00-abcdef1234567890abcdef1234567890-1234567890abcdef-01',
      });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          trace_id: 'abcdef1234567890abcdef1234567890',
          status: 'failed',
        }),
      );
    });

    it('should store null trace_id when traceparent header is absent', async () => {
      const errorBody = '{"error":"bad"}';
      const mockProviderResp = new Response(errorBody, {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: { response: mockProviderResp, isGoogle: false },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          trace_id: null,
        }),
      );
    });

    it('should store null trace_id when traceparent has less than 2 parts', async () => {
      const errorBody = '{"error":"bad"}';
      const mockProviderResp = new Response(errorBody, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] }, 'user-1', {
        traceparent: 'invalidnodashes',
      });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          trace_id: null,
        }),
      );
    });

    it('should truncate long error messages to 2000 chars', async () => {
      const longError = 'x'.repeat(3000);
      const mockProviderResp = new Response(longError, {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          error_message: 'x'.repeat(2000),
        }),
      );
    });
  });

  describe('client disconnect', () => {
    it('should register close listener on response', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'simple', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.9 },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.once).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should pass AbortSignal to proxyService', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response('{}', { status: 200 }),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'simple', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.9 },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      const opts = proxyService.proxyRequest.mock.calls[0][0] as { signal?: AbortSignal };
      expect(opts.signal).toBeInstanceOf(AbortSignal);
      expect(opts.signal!.aborted).toBe(false);
    });

    it('should silently end response when client disconnects', async () => {
      const abortController = new AbortController();
      proxyService.proxyRequest.mockImplementation(async () => {
        abortController.abort();
        throw new Error('aborted');
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      // Capture the close callback and wire it to our AbortController
      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') {
          abortController.signal.addEventListener('abort', cb);
        }
      });

      await controller.chatCompletions(req as never, res as never);

      expect(res.end).toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should not call res.end on abort when writableEnded is already true', async () => {
      const abortController = new AbortController();
      proxyService.proxyRequest.mockImplementation(async () => {
        abortController.abort();
        throw new Error('aborted');
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();
      res.writableEnded = true;

      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') {
          abortController.signal.addEventListener('abort', cb);
        }
      });

      await controller.chatCompletions(req as never, res as never);

      expect(res.end).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('should still release slot when client disconnects', async () => {
      const abortController = new AbortController();
      proxyService.proxyRequest.mockImplementation(async () => {
        abortController.abort();
        throw new Error('aborted');
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') {
          abortController.signal.addEventListener('abort', cb);
        }
      });

      await controller.chatCompletions(req as never, res as never);

      expect(rateLimiter.releaseSlot).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('error handling edge cases', () => {
    it('should mask error message for 500+ status codes as friendly chat message', async () => {
      proxyService.proxyRequest.mockRejectedValue(new Error('Sensitive internal error details'));

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'user-1', {
        accept: 'text/event-stream',
      });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          object: 'chat.completion',
          choices: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                content: expect.stringContaining('[🦚 Manifest M500]'),
              }),
            }),
          ]),
        }),
      );
    });

    it('should expose original message for client errors as friendly chat message', async () => {
      proxyService.proxyRequest.mockRejectedValue(
        new HttpException('messages array is required', 400),
      );

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'user-1', {
        accept: 'text/event-stream',
      });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                content: 'messages array is required',
              }),
            }),
          ]),
        }),
      );
    });

    it('should handle non-Error throw as friendly chat message', async () => {
      proxyService.proxyRequest.mockRejectedValue('string error');

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'user-1', {
        accept: 'text/event-stream',
      });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          object: 'chat.completion',
          choices: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                content: expect.stringContaining('[🦚 Manifest M500]'),
              }),
            }),
          ]),
        }),
      );
    });

    it('should forward provider error response and preserve content-type from provider', async () => {
      // Plain text so the generic 5xx message is asserted independently of NODE_ENV.
      const mockProviderResp = new Response('bad gateway', {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res, headers } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({
          message: 'Upstream provider returned bad gateway',
          type: 'server_error',
          code: null,
          status: 502,
          source: 'provider',
        }),
      });
      // Meta headers should still be set
      expect(headers['X-Manifest-Provider']).toBe('OpenAI');
    });

    it('records success when the caller closes after finish_reason but before upstream EOF', async () => {
      let closeListener: (() => void) | undefined;
      const successSpy = jest.spyOn(recorder, 'recordSuccessMessage');
      const cancelledSpy = jest.spyOn(recorder, 'recordCancelledRequest');
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: makeInterruptedSseResponse(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            { onFirstChunk: () => closeListener?.(), error: new Error('aborted') },
          ),
          wireFormat: 'openai_chat_completions',
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const { res, written } = mockResponse();
      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') closeListener = cb;
      });

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(written.join('')).toContain('"finish_reason":"stop"');
      expect(cancelledSpy).not.toHaveBeenCalled();
      expect(successSpy).toHaveBeenCalled();
    });

    it('records cancelled when the caller closes before a terminal provider event', async () => {
      let closeListener: (() => void) | undefined;
      const successSpy = jest.spyOn(recorder, 'recordSuccessMessage');
      const cancelledSpy = jest.spyOn(recorder, 'recordCancelledRequest');
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: makeInterruptedSseResponse(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
            { onFirstChunk: () => closeListener?.(), error: new Error('aborted') },
          ),
          wireFormat: 'openai_chat_completions',
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const { res } = mockResponse();
      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') closeListener = cb;
      });

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      expect(successSpy).not.toHaveBeenCalled();
      expect(cancelledSpy).toHaveBeenCalled();
    });

    it('cancels earlier pending attempts when the caller closes mid fallback chain', async () => {
      let closeListener: (() => void) | undefined;
      const cancelledSpy = jest.spyOn(recorder, 'recordCancelledRequest');
      const attemptIds: string[] = [];
      proxyService.proxyRequest.mockImplementation(
        async (options: { startProviderAttempt: StartProviderAttempt }) => {
          const primary = options.startProviderAttempt({ provider: 'openai', model: 'gpt-4o' });
          const cooldown = options.startProviderAttempt({
            provider: 'anthropic',
            model: 'claude-opus-5',
            providerCallStarted: false,
          });
          const fallback = options.startProviderAttempt({
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
          });
          attemptIds.push(primary.id, cooldown.id, fallback.id);
          // The primary failed, the chain moved on, then the caller hung up and
          // the fallback call rejected with the aborted signal.
          closeListener?.();
          throw new DOMException('This operation was aborted', 'AbortError');
        },
      );
      const { res } = mockResponse();
      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') closeListener = cb;
      });

      await controller.chatCompletions(
        mockRequest({ messages: [{ role: 'user', content: 'hi' }] }) as never,
        res as never,
      );
      await flushRecorderMicrotasks();

      const [primaryId, cooldownId, fallbackId] = attemptIds;
      expect(cancelledSpy).toHaveBeenCalledTimes(1);
      // recordCancelledRequest completes the last attempt; the sweep's
      // pending-guarded update on it is then a no-op.
      expect(mockMessageRepo.update).toHaveBeenCalledWith(
        { id: fallbackId },
        expect.objectContaining({ status: 'cancelled' }),
      );
      // The primary row must not stay pending, and only a still-pending row
      // is touched so a terminal write that already landed wins.
      expect(mockMessageRepo.update).toHaveBeenCalledWith(
        { id: primaryId, status: 'pending' },
        expect.objectContaining({ status: 'cancelled', error_message: null }),
      );
      // A cooldown skip never inserted a row, so there is nothing to cancel.
      const touched = mockMessageRepo.update.mock.calls.map(
        ([criteria]) => (criteria as { id: string }).id,
      );
      expect(touched).not.toContain(cooldownId);
    });

    it('cancels the last attempt when recordCancelledRequest fails to write it', async () => {
      let closeListener: (() => void) | undefined;
      jest.spyOn(recorder, 'recordCancelledRequest').mockRejectedValue(new Error('db down'));
      let lastId: string | undefined;
      proxyService.proxyRequest.mockImplementation(
        async (options: { startProviderAttempt: StartProviderAttempt }) => {
          options.startProviderAttempt({ provider: 'openai', model: 'gpt-4o' });
          lastId = options.startProviderAttempt({
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
          }).id;
          closeListener?.();
          throw new DOMException('This operation was aborted', 'AbortError');
        },
      );
      const { res } = mockResponse();
      (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') closeListener = cb;
      });

      await controller.chatCompletions(
        mockRequest({ messages: [{ role: 'user', content: 'hi' }] }) as never,
        res as never,
      );

      expect(mockMessageRepo.update).toHaveBeenCalledWith(
        { id: lastId, status: 'pending' },
        expect.objectContaining({ status: 'cancelled' }),
      );
      expect(rateLimiter.releaseSlot).toHaveBeenCalled();
    });

    it('should emit a terminal SSE error when the upstream dies after the first chunk', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: makeInterruptedSseResponse(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          ),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const { res, written } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      const payload = written.join('');
      expect(payload).toContain('"content":"hello"');
      expect(payload).toContain('Upstream provider stream was interrupted.');
      expect(payload).toContain('"code":"stream_interrupted"');
      expect(payload).toContain('data: [DONE]');
      expect(res.end).toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          // Provider Attempts keep the canonical storage status; the parent
          // Request carries the caller-visible error outcome and taxonomy.
          status: 'failed',
          error_http_status: 503,
          error_origin: 'transport',
          error_class: 'network',
          provider: 'OpenAI',
          model: 'gpt-4o',
        }),
      );
    });

    it('normalizes provider-declared SSE errors and records their message', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response(
            'data: {"error":{"message":"Provider quota exhausted","status":429}}\n\n',
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
          wireFormat: 'openai_chat_completions',
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
        },
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const { res, written } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await flushRecorderMicrotasks();

      const payload = written.join('');
      expect(payload).toContain('Provider quota exhausted');
      expect(payload).toContain('"code":"upstream_error"');
      expect(payload).toContain('data: [DONE]');
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_message: 'Provider quota exhausted',
          error_http_status: 429,
          error_origin: 'provider',
          error_class: 'rate_limit',
        }),
      );
    });

    it('should emit a sequenced Responses error when a converted chat stream dies', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: makeInterruptedSseResponse(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          ),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
          isResponses: false,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });

      const req = mockRequest({ input: 'hi', stream: true });
      const { res, written } = mockResponse();

      await controller.responses(req as never, res as never);

      const payload = written.join('');
      expect(payload).toContain('event: error');
      expect(payload).toContain('"type":"error"');
      expect(payload).toContain('"code":"stream_interrupted"');
      expect(payload).toContain('Upstream provider stream was interrupted.');
      expect(payload).toContain('"sequence_number":5');
      expect(res.end).toHaveBeenCalled();
    });

    it('should continue the upstream sequence for a native Responses stream error', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: makeInterruptedSseResponse(
            'event: response.output_text.delta\n' +
              'data: {"type":"response.output_text.delta","sequence_number":41,"delta":"hello"}\n\n',
          ),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
          isResponses: true,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });

      const req = mockRequest({ input: 'hi', stream: true });
      const { res, written } = mockResponse();

      await controller.responses(req as never, res as never);

      const payload = written.join('');
      expect(payload).toContain('"sequence_number":41');
      expect(payload).toContain('event: error');
      expect(payload).toContain('"sequence_number":42');
      expect(res.end).toHaveBeenCalled();
    });

    it('should emit an Anthropic error when a converted chat stream dies', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: makeInterruptedSseResponse(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
          ),
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'claude-sonnet-4',
          provider: 'OpenAI',
          confidence: 0.8,
        },
      });

      const req = mockRequest({
        model: 'claude-sonnet-4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const { res, written } = mockResponse();

      await controller.messages(req as never, res as never);

      const payload = written.join('');
      expect(payload).toContain('event: error');
      expect(payload).toContain('"type":"api_error"');
      expect(payload).toContain('Upstream provider stream was interrupted.');
      expect(payload).not.toContain('message_stop');
      expect(res.end).toHaveBeenCalled();
    });

    it('should not call res.end when headers sent and writableEnded is true', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response('data: {"candidates":[]}\n\n', { status: 200 }),
          isGoogle: true,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: { tier: 'standard', model: 'gpt-4o', provider: 'OpenAI', confidence: 0.8 },
      });
      providerClient.convertGoogleStreamChunk.mockImplementation(() => {
        throw new Error('stream transform failed');
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const { res } = mockResponse();

      (res.end as jest.Mock).mockImplementation(() => {
        res.writableEnded = true;
      });

      await controller.chatCompletions(req as never, res as never);

      expect(res.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordRateLimited edge cases', () => {
    it('should handle messageRepo.insert failure gracefully', async () => {
      mockMessageRepo.insert.mockRejectedValue(new Error('DB connection failed'));

      proxyService.proxyRequest.mockRejectedValue(new HttpException('Rate limit exceeded', 429));

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      // Should not throw even though insert fails
      await controller.chatCompletions(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it('should allow recording after cooldown expires', async () => {
      const limitError = new HttpException('Limit exceeded', 429);
      proxyService.proxyRequest.mockRejectedValue(limitError);

      // First 429 — should record
      const req1 = mockRequest({ messages: [{ role: 'user', content: 'a' }] });
      const { res: res1 } = mockResponse();
      await controller.chatCompletions(req1 as never, res1 as never);
      await flushRecorderMicrotasks();
      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(1);

      // Expire the cooldown entry directly instead of advancing fake
      // timers — fake timers would also freeze the microtask flush we
      // rely on to wait for the recorder's fire-and-forget insert.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (recorder as any).rateLimitCooldown as Map<string, number>;
      map.set('tenant-1:agent-1', Date.now() - 120_000);

      // Second 429 after cooldown — should record again
      const req2 = mockRequest({ messages: [{ role: 'user', content: 'b' }] });
      const { res: res2 } = mockResponse();
      await controller.chatCompletions(req2 as never, res2 as never);
      await flushRecorderMicrotasks();
      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(2);
    });

    it('should allow recording for different agents within cooldown', async () => {
      const limitError = new HttpException('Limit exceeded', 429);
      proxyService.proxyRequest.mockRejectedValue(limitError);

      // First agent
      const req1 = mockRequest({ messages: [{ role: 'user', content: 'a' }] });
      const { res: res1 } = mockResponse();
      await controller.chatCompletions(req1 as never, res1 as never);

      // Different agent (different agentId means different cooldown key)
      const req2 = {
        ingestionContext: {
          userId: 'user-1',
          tenantId: 'tenant-1',
          agentId: 'agent-2',
          agentName: 'other-agent',
        },
        body: { messages: [{ role: 'user', content: 'b' }] },
        headers: {},
      };
      const { res: res2 } = mockResponse();
      await controller.chatCompletions(req2 as never, res2 as never);
      await flushRecorderMicrotasks();

      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe('rateLimitCooldown eviction', () => {
    it('should evict expired cooldown entries when map exceeds max size', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cooldownMap = (recorder as any).rateLimitCooldown as Map<string, number>;
      const now = Date.now();

      // Pre-fill with MAX_COOLDOWN_ENTRIES + 1 expired entries to exceed the limit.
      // Use keys that do NOT match the request's tenant-1:agent-1 key.
      for (let i = 0; i < 1001; i++) {
        cooldownMap.set(`t-${i}:a-${i}`, now - 120_000); // expired (>60s ago)
      }

      expect(cooldownMap.size).toBe(1001);

      // Trigger a 429 provider error - this adds the tenant-1:agent-1 key,
      // bringing size to 1002, which triggers eviction of expired entries
      const mockProviderResp = new Response('{"error":"rate limit"}', {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 50));

      // All 1001 expired entries should have been evicted, leaving only the fresh one
      expect(cooldownMap.size).toBe(1);
      expect(cooldownMap.has('tenant-1:agent-1')).toBe(true);
    });
  });

  describe('periodic cooldown cleanup', () => {
    it('periodic timer evicts expired cooldown entries', () => {
      jest.useFakeTimers();
      recorder.onModuleDestroy(); // stop timer from beforeEach recorder

      const timedRecorder = new ProxyMessageRecorder(
        mockMessageRepo as never,
        mockPricingCache as never,
        { emit: jest.fn() } as unknown as IngestEventBusService,
        {
          canonicalizeAgentMessageKeys: jest
            .fn()
            .mockImplementation(
              async (_agentId: string, provider: string | null, model: string | null) => ({
                provider: provider ?? null,
                model: model ?? null,
              }),
            ),
        } as never,
        {
          getCostPerRequest: jest.fn().mockReturnValue(null),
          resolveCostPerRequest: jest.fn().mockResolvedValue(null),
        } as never,
      );

      const cooldownMap = (timedRecorder as any).rateLimitCooldown as Map<string, number>;
      cooldownMap.set('t:a', Date.now() - 120_000); // expired

      jest.advanceTimersByTime(60_000);
      expect(cooldownMap.size).toBe(0);

      timedRecorder.onModuleDestroy();
      jest.useRealTimers();
    });

    it('onModuleDestroy stops the periodic cleanup timer', () => {
      jest.useFakeTimers();
      recorder.onModuleDestroy(); // stop timer from beforeEach recorder

      const timedRecorder = new ProxyMessageRecorder(
        mockMessageRepo as never,
        mockPricingCache as never,
        { emit: jest.fn() } as unknown as IngestEventBusService,
        {
          canonicalizeAgentMessageKeys: jest
            .fn()
            .mockImplementation(
              async (_agentId: string, provider: string | null, model: string | null) => ({
                provider: provider ?? null,
                model: model ?? null,
              }),
            ),
        } as never,
        {
          getCostPerRequest: jest.fn().mockReturnValue(null),
          resolveCostPerRequest: jest.fn().mockResolvedValue(null),
        } as never,
      );

      timedRecorder.onModuleDestroy();

      const cooldownMap = (timedRecorder as any).rateLimitCooldown as Map<string, number>;
      cooldownMap.set('t:a', Date.now() - 120_000);

      jest.advanceTimersByTime(120_000);
      expect(cooldownMap.size).toBe(1); // not evicted because timer stopped

      jest.useRealTimers();
    });
  });

  describe('seenTenants bounded Map with TTL', () => {
    const makeProxyResult = () => ({
      forward: {
        response: new Response('{}', { status: 200 }),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: { tier: 'simple' as const, model: 'gpt-4o', provider: 'OpenAI', confidence: 0.9 },
    });

    it('should evict oldest tenant when MAX_SEEN_TENANTS is reached', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seenTenants = (controller as any).seenTenants as Map<string, number>;

      const now = Date.now();
      for (let i = 0; i < 9_999; i++) {
        seenTenants.set(`prefill-tenant-${i}`, now);
      }

      proxyService.proxyRequest.mockResolvedValue(makeProxyResult());
      const req1 = mockRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        'user-9999',
        {},
        'tenant-9999',
      );
      const { res: res1 } = mockResponse();
      await controller.chatCompletions(req1 as never, res1 as never);

      expect(seenTenants.size).toBe(10_000);

      proxyService.proxyRequest.mockResolvedValue(makeProxyResult());
      const req2 = mockRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        'user-10000',
        {},
        'tenant-10000',
      );
      const { res: res2 } = mockResponse();
      await controller.chatCompletions(req2 as never, res2 as never);

      expect(seenTenants.size).toBe(10_000);
      expect(seenTenants.has('prefill-tenant-0')).toBe(false);
      expect(seenTenants.has('tenant-10000')).toBe(true);
    });

    it('should evict expired entries older than 24 hours', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seenTenants = (controller as any).seenTenants as Map<string, number>;

      const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
      seenTenants.set('old-tenant-1', twentyFiveHoursAgo);
      seenTenants.set('old-tenant-2', twentyFiveHoursAgo);
      seenTenants.set('recent-tenant', Date.now());

      proxyService.proxyRequest.mockResolvedValue(makeProxyResult());
      const req = mockRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        'new-user',
        {},
        'new-tenant',
      );
      const { res } = mockResponse();
      await controller.chatCompletions(req as never, res as never);

      expect(seenTenants.has('old-tenant-1')).toBe(false);
      expect(seenTenants.has('old-tenant-2')).toBe(false);
      expect(seenTenants.has('recent-tenant')).toBe(true);
      expect(seenTenants.has('new-tenant')).toBe(true);
    });
  });

  describe('streaming', () => {
    function createMockStreamResponse(chunks: string[]): Response {
      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream({
        pull(ctrl) {
          if (index < chunks.length) {
            ctrl.enqueue(encoder.encode(chunks[index]));
            index++;
          } else {
            ctrl.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    it('should pipe streaming responses directly for non-Google', async () => {
      const mockProviderResp = createMockStreamResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      ]);

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      });
      const { res, written, headers } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(headers['Content-Type']).toBe('text/event-stream');
      expect(headers['X-Manifest-Tier']).toBe('standard');
      expect(written.length).toBeGreaterThan(0);
    });

    it('should transform Anthropic streaming through createAnthropicStreamTransformer', async () => {
      const mockProviderResp = createMockStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      ]);

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: true,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'claude-sonnet-4-20250514',
          provider: 'Anthropic',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const mockTransformer = jest.fn((chunk: string) => {
        if (chunk.includes('message_start'))
          return 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
        if (chunk.includes('text_delta'))
          return 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
        return null;
      });
      (providerClient as Record<string, jest.Mock>).createAnthropicStreamTransformer = jest
        .fn()
        .mockReturnValue(mockTransformer);

      const req = mockRequest({
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      });
      const { res, written } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(
        (providerClient as Record<string, jest.Mock>).createAnthropicStreamTransformer,
      ).toHaveBeenCalledWith('claude-sonnet-4-20250514', expect.any(Function));
      expect(written.some((w) => w.includes('content'))).toBe(true);
    });

    it('should transform Google streaming through convertGoogleStreamChunk', async () => {
      const mockProviderResp = createMockStreamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
      ]);

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: true,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gemini-2.0-flash',
          provider: 'Google',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      providerClient.convertGoogleStreamChunk.mockReturnValue({
        chunk: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        signatures: [],
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      });
      const { res, written } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(providerClient.convertGoogleStreamChunk).toHaveBeenCalled();
      // Should include transformed content and [DONE]
      expect(written.some((w) => w.includes('delta'))).toBe(true);
    });

    it('should transform ChatGPT streaming through the per-stream transformer', async () => {
      const mockProviderResp = createMockStreamResponse([
        'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
      ]);

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: true,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-5.3-codex',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const transformer = jest
        .fn()
        .mockReturnValue('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      (providerClient as Record<string, jest.Mock>).createChatGptStreamTransformer = jest
        .fn()
        .mockReturnValue(transformer);

      const req = mockRequest({
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      });
      const { res, written } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(transformer).toHaveBeenCalled();
      expect(written.some((w) => w.includes('delta'))).toBe(true);
    });

    it('should close stream on error after headers sent', async () => {
      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: new Response('data: {"candidates":[]}\n\n', { status: 200 }),
          isGoogle: true,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });
      providerClient.convertGoogleStreamChunk.mockImplementation(() => {
        throw new Error('stream transform failed');
      });

      const req = mockRequest({
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(res.end).toHaveBeenCalledTimes(2);
    });
  });

  describe('fallback headers', () => {
    it('should set fallback headers when meta has fallbackFromModel', async () => {
      const responseBody = { choices: [{ message: { content: 'hello' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'claude-sonnet-4',
          provider: 'Anthropic',
          confidence: 0.8,
          reason: 'scored',
          fallbackFromModel: 'gpt-4o',
          fallbackIndex: 0,
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res, headers } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(headers['X-Manifest-Fallback-From']).toBe('gpt-4o');
      expect(headers['X-Manifest-Fallback-Index']).toBe('0');
      expect(headers['X-Manifest-Model']).toBe('claude-sonnet-4');
    });

    it('should not set fallback headers when meta has no fallbackFromModel', async () => {
      const responseBody = { choices: [{ message: { content: 'hello' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res, headers } = mockResponse();

      await controller.chatCompletions(req as never, res as never);

      expect(headers['X-Manifest-Fallback-From']).toBeUndefined();
      expect(headers['X-Manifest-Fallback-Index']).toBeUndefined();
    });

    it('should record primary failure and fallback success when fallback was used', async () => {
      const responseBody = { choices: [{ message: { content: 'hello' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'deepseek-chat',
          provider: 'DeepSeek',
          confidence: 0.8,
          reason: 'scored',
          fallbackFromModel: 'gemini-2.5-flash-lite',
          fallbackIndex: 0,
          primaryErrorStatus: 400,
          primaryErrorBody: '{"error":"bad request from primary"}',
          auth_type: 'subscription',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(2);

      // Primary failure recorded with actual error body
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          superseded: true,
          model: 'gemini-2.5-flash-lite',
          routing_tier: 'simple',
          trace_id: null,
          error_message: '{"error":"bad request from primary"}',
        }),
      );

      // Fallback success recorded with auth_type and cost_usd
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          model: 'deepseek-chat',
          routing_tier: 'simple',
          fallback_from_model: 'gemini-2.5-flash-lite',
          fallback_index: 0,
          auth_type: 'subscription',
          cost_usd: 0,
        }),
      );
    });

    it('should record intermediate failures as fallback_error when chain succeeds', async () => {
      const responseBody = { choices: [{ message: { content: 'ok' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'claude-sonnet-4',
          provider: 'Anthropic',
          confidence: 0.8,
          reason: 'scored',
          fallbackFromModel: 'gemini-flash',
          fallbackIndex: 2,
          primaryErrorStatus: 500,
        },
        failedFallbacks: [
          {
            model: 'deepseek-chat',
            provider: 'DeepSeek',
            fallbackIndex: 0,
            status: 429,
            errorBody: 'rate limited',
          },
          {
            model: 'gpt-4o-mini',
            provider: 'OpenAI',
            fallbackIndex: 1,
            status: 500,
            errorBody: 'server error',
          },
        ],
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      // 3 inserts: primary failure + 1 batched failed-fallbacks + fallback success
      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(3);

      // Intermediate failures batched into a single insert with both rows
      expect(mockMessageRepo.insert).toHaveBeenCalledWith([
        expect.objectContaining({
          model: 'deepseek-chat',
          status: 'failed',
          superseded: true,
          fallback_from_model: 'gemini-flash',
          fallback_index: 0,
        }),
        expect.objectContaining({
          model: 'gpt-4o-mini',
          status: 'failed',
          superseded: true,
          fallback_from_model: 'gemini-flash',
          fallback_index: 1,
        }),
      ]);
    });

    it('should record message with zero tokens when response has no usage data', async () => {
      const responseBody = { choices: [{ message: { content: 'hello' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'gpt-4o',
          provider: 'OpenAI',
          confidence: 0.8,
          reason: 'scored',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          input_tokens: 0,
          output_tokens: 0,
          status: 'success',
          model: 'gpt-4o',
        }),
      );
    });

    it('should include fallback fields in error recording when fallback was used', async () => {
      const errorBody = '{"error":"bad request"}';
      const mockProviderResp = new Response(errorBody, {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'standard',
          model: 'claude-sonnet-4',
          provider: 'Anthropic',
          confidence: 0.8,
          reason: 'scored',
          fallbackFromModel: 'gpt-4o',
          fallbackIndex: 1,
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'test' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          fallback_from_model: 'gpt-4o',
          fallback_index: 1,
        }),
      );
    });

    it('should record failed fallback attempts as separate messages', async () => {
      const mockProviderResp = new Response('primary error', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'gemini-flash',
          provider: 'Google',
          confidence: 0.9,
          reason: 'scored',
        },
        failedFallbacks: [
          {
            model: 'deepseek-chat',
            provider: 'DeepSeek',
            fallbackIndex: 0,
            status: 401,
            errorBody: 'auth fail',
          },
        ],
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res, headers } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      // 2 inserts: primary as fallback_error + last fallback as error
      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(2);
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-flash',
          status: 'failed',
          superseded: true,
          error_message: 'primary error',
        }),
      );
      expect(mockMessageRepo.insert).toHaveBeenCalledWith([
        expect.objectContaining({
          model: 'deepseek-chat',
          status: 'failed',
          fallback_from_model: 'gemini-flash',
          fallback_index: 0,
          error_message: 'auth fail',
        }),
      ]);
      expect(headers['X-Manifest-Fallback-Exhausted']).toBe('true');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'server_error',
            code: null,
            source: 'provider',
          }),
        }),
      );
    });

    it('should handle DB failure in recordFailedFallbacks when all fallbacks fail', async () => {
      mockMessageRepo.insert.mockRejectedValue(new Error('DB write failed'));

      const mockProviderResp = new Response('primary error', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'gemini-flash',
          provider: 'Google',
          confidence: 0.9,
          reason: 'scored',
        },
        failedFallbacks: [
          {
            model: 'deepseek-chat',
            provider: 'DeepSeek',
            fallbackIndex: 0,
            status: 500,
            errorBody: 'fail 1',
          },
        ],
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      // Should not throw even though all inserts fail
      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 50));

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'server_error',
            code: null,
            source: 'provider',
            status: 502,
          }),
        }),
      );
    });

    it('should handle DB failure in recordPrimaryFailure on successful fallback', async () => {
      mockMessageRepo.insert.mockRejectedValue(new Error('DB write failed'));

      const responseBody = { choices: [{ message: { content: 'hello' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'deepseek-chat',
          provider: 'DeepSeek',
          confidence: 0.8,
          reason: 'scored',
          fallbackFromModel: 'gemini-flash',
          fallbackIndex: 0,
          primaryErrorStatus: 500,
          primaryErrorBody: 'primary failed',
        },
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      // Should not throw even though inserts fail
      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 50));

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(responseBody);
    });

    it('should handle DB failure in recordFailedFallbacks on successful fallback with intermediates', async () => {
      mockMessageRepo.insert.mockRejectedValue(new Error('DB write failed'));

      const responseBody = { choices: [{ message: { content: 'ok' } }] };
      const mockProviderResp = new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'claude-sonnet-4',
          provider: 'Anthropic',
          confidence: 0.8,
          reason: 'scored',
          fallbackFromModel: 'gemini-flash',
          fallbackIndex: 2,
          primaryErrorStatus: 500,
        },
        failedFallbacks: [
          {
            model: 'deepseek-chat',
            provider: 'DeepSeek',
            fallbackIndex: 0,
            status: 500,
            errorBody: 'fail 1',
          },
        ],
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      // Should not throw even though inserts fail
      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 50));

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(responseBody);
    });

    it('should mark intermediate failures as handled when all fallbacks fail', async () => {
      const mockProviderResp = new Response('primary error', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });

      proxyService.proxyRequest.mockResolvedValue({
        forward: {
          response: mockProviderResp,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        meta: {
          tier: 'simple',
          model: 'gemini-flash',
          provider: 'Google',
          confidence: 0.9,
          reason: 'scored',
        },
        failedFallbacks: [
          {
            model: 'deepseek-chat',
            provider: 'DeepSeek',
            fallbackIndex: 0,
            status: 500,
            errorBody: 'fail 1',
          },
          {
            model: 'gpt-4o-mini',
            provider: 'OpenAI',
            fallbackIndex: 1,
            status: 500,
            errorBody: 'fail 2',
          },
        ],
      });

      const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
      const { res } = mockResponse();

      await controller.chatCompletions(req as never, res as never);
      await new Promise((r) => setTimeout(r, 10));

      // 2 inserts: primary (fallback_error) + 1 batched failed-fallbacks (2 rows)
      expect(mockMessageRepo.insert).toHaveBeenCalledTimes(2);
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-flash',
          status: 'failed',
          superseded: true,
        }),
      );
      expect(mockMessageRepo.insert).toHaveBeenCalledWith([
        expect.objectContaining({
          model: 'deepseek-chat',
          status: 'failed',
          superseded: true,
          fallback_index: 0,
        }),
        expect.objectContaining({
          model: 'gpt-4o-mini',
          status: 'failed',
          fallback_index: 1,
        }),
      ]);
    });
  });

  it('should pass authType to recordFailedFallbacks when all fallbacks fail', async () => {
    const mockProviderResp = new Response('primary error', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: {
        response: mockProviderResp,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      },
      meta: {
        tier: 'simple',
        model: 'gemini-flash',
        provider: 'Google',
        confidence: 0.9,
        reason: 'scored',
        auth_type: 'subscription',
      },
      failedFallbacks: [
        {
          model: 'deepseek-chat',
          provider: 'DeepSeek',
          fallbackIndex: 0,
          status: 500,
          errorBody: 'fail 1',
        },
      ],
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res } = mockResponse();

    await controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setTimeout(r, 50));

    // Fallback failure recorded with auth_type from meta (batched as array)
    expect(mockMessageRepo.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        model: 'deepseek-chat',
        auth_type: 'subscription',
      }),
    ]);
    // Primary failure also recorded with auth_type
    expect(mockMessageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-flash',
        status: 'failed',
        superseded: true,
        auth_type: 'subscription',
      }),
    );
  });

  it('should return primary error status with fallback_exhausted flag and X-Manifest-Fallback-Exhausted header', async () => {
    const mockProviderResp = new Response('primary error', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: false, isAnthropic: false },
      meta: {
        tier: 'standard',
        model: 'gpt-4o',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
      failedFallbacks: [
        {
          model: 'claude-sonnet-4',
          provider: 'Anthropic',
          fallbackIndex: 0,
          status: 503,
          errorBody: 'overloaded',
        },
        {
          model: 'deepseek-chat',
          provider: 'DeepSeek',
          fallbackIndex: 1,
          status: 500,
          errorBody: 'server error',
        },
      ],
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res, headers } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(headers['X-Manifest-Fallback-Exhausted']).toBe('true');
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        type: 'server_error',
        code: null,
        source: 'provider',
        status: 502,
        fallback_exhausted: true,
        primary_model: 'gpt-4o',
        primary_provider: 'OpenAI',
        attempted_fallbacks: [
          expect.objectContaining({ model: 'claude-sonnet-4', provider: 'Anthropic', status: 503 }),
          expect.objectContaining({ model: 'deepseek-chat', provider: 'DeepSeek', status: 500 }),
        ],
      }),
    });
  });

  it('should NOT set X-Manifest-Fallback-Exhausted when error has no failed fallbacks', async () => {
    const mockProviderResp = new Response('bad request', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: false, isAnthropic: false },
      meta: {
        tier: 'simple',
        model: 'gpt-4o-mini',
        provider: 'OpenAI',
        confidence: 0.9,
        reason: 'scored',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res, headers } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(headers['X-Manifest-Fallback-Exhausted']).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ type: 'invalid_request_error', code: null }),
      }),
    );
  });

  it('should NOT set X-Manifest-Fallback-Exhausted when a fallback succeeded', async () => {
    const responseBody = { choices: [{ message: { content: 'hello' } }] };
    const mockProviderResp = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    proxyService.proxyRequest.mockResolvedValue({
      forward: { response: mockProviderResp, isGoogle: false, isAnthropic: false },
      meta: {
        tier: 'simple',
        model: 'deepseek-chat',
        provider: 'DeepSeek',
        confidence: 0.8,
        reason: 'scored',
        fallbackFromModel: 'gemini-flash',
        fallbackIndex: 0,
        primaryErrorStatus: 500,
        primaryErrorBody: 'primary failed',
      },
    });

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const { res, headers } = mockResponse();

    await controller.chatCompletions(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(headers['X-Manifest-Fallback-Exhausted']).toBeUndefined();
  });
});
