import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { PlaygroundService } from './playground.service';
import { CustomProviderService } from '../routing/custom-provider/custom-provider.service';
import { OpencodeGoCatalogService } from '../model-discovery/opencode-go-catalog.service';
import type { ProviderClient } from '../routing/proxy/provider-client';
import type { ProviderKeyService } from '../routing/routing-core/provider-key.service';
import type { PlaygroundAgentService } from './playground-agent.service';
import type { OpenaiOauthService } from '../routing/oauth/openai/openai-oauth.service';
import type { MinimaxOauthService } from '../routing/oauth/minimax/minimax-oauth.service';
import type { AnthropicOauthService } from '../routing/oauth/anthropic/anthropic-oauth.service';
import type { GeminiOauthService } from '../routing/oauth/gemini/gemini-oauth.service';
import type { KiroOauthService } from '../routing/oauth/kiro/kiro-oauth.service';
import type { XaiOauthService } from '../routing/oauth/xai/xai-oauth.service';
import type { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import type { IngestEventBusService } from '../common/services/ingest-event-bus.service';
import type { PlaygroundHistoryService } from './playground-history.service';
import type { Repository } from 'typeorm';
import type { AgentMessage } from '../entities/agent-message.entity';
import type { CustomProvider } from '../entities/custom-provider.entity';
import type { RunPlaygroundDto } from './dto/run-playground.dto';
import type { TenantContext } from '../common/decorators/tenant-context.decorator';

const AGENT = { id: 'agent-1', tenant_id: 'tenant-1', name: 'demo' };
// The request context threaded into runStream. The Playground agent resolves to
// AGENT (tenant_id 'tenant-1'); ctx.userId is audit-only attribution.
const CTX: TenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
const DEFAULT_PROVIDER_KEY = {
  id: 'key-1',
  label: 'Default',
  priority: 0,
  apiKey: 'sk-test',
  region: null,
};

function makeDto(overrides: Partial<RunPlaygroundDto> = {}): RunPlaygroundDto {
  return {
    agentName: 'demo',
    model: 'openai/gpt-4o',
    provider: 'openai',
    authType: 'api_key',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as RunPlaygroundDto;
}

/** Mock Express Response capturing the SSE write stream + JSON error body. */
interface MockRes {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  flushHeaders: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
  headersSent: boolean;
  writableEnded: boolean;
  _written: string[];
  _json: unknown;
  _status: number | null;
  _closeHandler: (() => void) | null;
}

function mockRes(): MockRes {
  const res: MockRes = {
    status: jest.fn((code: number) => {
      res._status = code;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res._json = body;
      return res;
    }),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      res._written.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
      return res;
    }),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === 'close') res._closeHandler = handler;
      return res;
    }),
    headersSent: false,
    writableEnded: false,
    _written: [],
    _json: undefined,
    _status: null,
    _closeHandler: null,
  };
  return res;
}

/** Narrow the structural mock to the Express Response the service expects. */
const asRes = (r: MockRes): ExpressResponse => r as unknown as ExpressResponse;

/** Parse the SSE events written to a MockRes back into typed objects. */
function parseSse(res: MockRes): Array<Record<string, unknown>> {
  const joined = res._written.join('');
  const events: Array<Record<string, unknown>> = [];
  for (const block of joined.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (line) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
  }
  return events;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function okStream(
  chunks: string[],
  headers: Record<string, string> = {},
): {
  response: { ok: true; status: 200; headers: Headers; body: ReadableStream<Uint8Array> };
  isGoogle: boolean;
  isAnthropic: boolean;
  isChatGpt: boolean;
} {
  return {
    response: {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream', ...headers }),
      body: sseStream(chunks),
    },
    isGoogle: false,
    isAnthropic: false,
    isChatGpt: false,
  };
}

function errorForward(status: number, bodyText: string) {
  return {
    response: {
      ok: false,
      status,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(bodyText),
      body: null,
    },
    isGoogle: false,
    isAnthropic: false,
    isChatGpt: false,
  };
}

interface Mocks {
  customProviders: { canonicalizeAgentMessageKeys: jest.Mock };
  opencodeGoCatalog: { resolveCostPerRequest: jest.Mock };
  playgroundAgent: { resolve: jest.Mock };
  providerKeyService: {
    hasActiveProvider: jest.Mock;
    getAuthType: jest.Mock;
    getProviderKeys: jest.Mock;
    getProviderApiKey: jest.Mock;
  };
  providerClient: {
    forward: jest.Mock;
    convertGoogleStreamChunk: jest.Mock;
    createAnthropicStreamTransformer: jest.Mock;
    createChatGptStreamTransformer: jest.Mock;
  };
  openaiOauth: { unwrapToken: jest.Mock };
  minimaxOauth: { unwrapToken: jest.Mock };
  anthropicOauth: { unwrapToken: jest.Mock };
  geminiOauth: { unwrapToken: jest.Mock };
  kiroOauth: { unwrapToken: jest.Mock };
  xaiOauth: { unwrapToken: jest.Mock };
  pricingCache: { getByModel: jest.Mock };
  eventBus: { emit: jest.Mock };
  history: { saveColumn: jest.Mock };
  messageRepo: {
    insert: jest.Mock;
    manager?: { getRepository: jest.Mock };
  };
  customProviderRepo: { findOne: jest.Mock };
}

function buildService(mocks: Partial<Mocks> = {}): { service: PlaygroundService; mocks: Mocks } {
  const full: Mocks = {
    playgroundAgent: {
      resolve: jest.fn().mockResolvedValue(AGENT),
    },
    providerKeyService: {
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      getProviderKeys: jest.fn().mockResolvedValue([DEFAULT_PROVIDER_KEY]),
      getProviderApiKey: jest.fn().mockResolvedValue(DEFAULT_PROVIDER_KEY.apiKey),
    },
    providerClient: {
      forward: jest.fn(),
      convertGoogleStreamChunk: jest.fn(),
      createAnthropicStreamTransformer: jest.fn(),
      createChatGptStreamTransformer: jest.fn(),
    },
    openaiOauth: { unwrapToken: jest.fn().mockResolvedValue(null) },
    minimaxOauth: { unwrapToken: jest.fn().mockResolvedValue(null) },
    anthropicOauth: { unwrapToken: jest.fn().mockResolvedValue(null) },
    geminiOauth: { unwrapToken: jest.fn().mockResolvedValue(null) },
    kiroOauth: { unwrapToken: jest.fn().mockResolvedValue(null) },
    xaiOauth: { unwrapToken: jest.fn().mockResolvedValue(null) },
    pricingCache: {
      getByModel: jest.fn().mockReturnValue({
        input_price_per_token: 0.000001,
        output_price_per_token: 0.000002,
      }),
    },
    eventBus: { emit: jest.fn() },
    history: { saveColumn: jest.fn().mockResolvedValue('col-1') },
    messageRepo: { insert: jest.fn().mockResolvedValue(undefined) },
    customProviderRepo: { findOne: jest.fn().mockResolvedValue(null) },
    customProviders: {
      canonicalizeAgentMessageKeys: jest
        .fn()
        .mockImplementation((_t: string, provider: string | null, model: string | null) =>
          Promise.resolve({ provider, model }),
        ),
    },
    opencodeGoCatalog: { resolveCostPerRequest: jest.fn().mockResolvedValue(null) },
    ...mocks,
  };
  const service = new PlaygroundService(
    full.playgroundAgent as unknown as PlaygroundAgentService,
    full.providerKeyService as unknown as ProviderKeyService,
    full.providerClient as unknown as ProviderClient,
    full.openaiOauth as unknown as OpenaiOauthService,
    full.minimaxOauth as unknown as MinimaxOauthService,
    full.anthropicOauth as unknown as AnthropicOauthService,
    full.geminiOauth as unknown as GeminiOauthService,
    full.kiroOauth as unknown as KiroOauthService,
    full.xaiOauth as unknown as XaiOauthService,
    full.pricingCache as unknown as ModelPricingCacheService,
    full.eventBus as unknown as IngestEventBusService,
    full.history as unknown as PlaygroundHistoryService,
    full.messageRepo as unknown as Repository<AgentMessage>,
    full.customProviderRepo as unknown as Repository<CustomProvider>,
    full.customProviders as unknown as CustomProviderService,
    full.opencodeGoCatalog as unknown as OpencodeGoCatalogService,
  );
  return { service, mocks: full };
}

describe('PlaygroundService.runStream', () => {
  it('streams deltas, computes cost, records success, persists a column and ends with a done event', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const events = parseSse(res);
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.map((d) => d.text)).toEqual(['hel', 'lo']);

    const done = events.find((e) => e.type === 'done') as Record<string, unknown>;
    expect(done).toBeDefined();
    expect(done.content).toBe('hello');
    expect(done.columnId).toBe('col-1');
    const metrics = done.metrics as Record<string, number | null>;
    expect(metrics.inputTokens).toBe(10);
    expect(metrics.outputTokens).toBe(5);
    expect(metrics.cost).toBeCloseTo(10 * 0.000001 + 5 * 0.000002);
    expect(metrics.tokensPerSec).not.toBeNull();
    expect(typeof metrics.ttftMs).toBe('number');

    expect(res.end).toHaveBeenCalled();
    expect(mocks.messageRepo.insert).toHaveBeenCalledTimes(1);
    const row = mocks.messageRepo.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      routing_tier: 'playground',
      routing_reason: null,
      status: 'success',
      provider: 'openai',
      model: 'openai/gpt-4o',
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(mocks.eventBus.emit).toHaveBeenCalledWith(AGENT.tenant_id);
    expect(mocks.history.saveColumn).toHaveBeenCalledTimes(1);
    expect(mocks.history.saveColumn.mock.calls[0][0]).toMatchObject({
      prompt: 'hi',
      status: 'success',
      content: 'hello',
    });
  });

  it('resolves a custom provider endpoint and forwards the raw (unprefixed) model name', async () => {
    const { service, mocks } = buildService();
    mocks.customProviderRepo.findOne.mockResolvedValue({
      id: 'abc',
      base_url: 'https://nebius.example/v1',
      api_kind: 'openai',
    });
    mocks.providerClient.forward.mockResolvedValue(
      okStream(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ provider: 'custom:abc', model: 'custom:abc/meta-llama/Llama-3.1-8B' }),
      asRes(res),
    );

    const call = mocks.providerClient.forward.mock.calls[0][0] as Record<string, unknown>;
    expect(call.provider).toBe('custom:abc');
    expect(call.customEndpoint).toBeDefined();
    // Prefix stripped — the custom endpoint expects the bare upstream model id.
    expect(call.model).toBe('meta-llama/Llama-3.1-8B');
    // The custom-provider row is fetched scoped to the caller's tenant, so
    // another tenant's custom:<id> can never be resolved here.
    expect(mocks.customProviderRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'abc', tenant_id: AGENT.tenant_id },
    });
  });

  it('routes MiniMax subscription requests through the region base URL from the OAuth resource_url', async () => {
    const { service, mocks } = buildService();
    mocks.minimaxOauth.unwrapToken.mockResolvedValue({
      t: 'mm-access',
      r: 'mm-refresh',
      e: Date.now() + 60_000,
      u: 'https://api.minimaxi.com/anthropic',
    });
    mocks.providerClient.forward.mockResolvedValue(
      okStream(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ provider: 'minimax', authType: 'subscription', model: 'minimax/abab' }),
      asRes(res),
    );

    const call = mocks.providerClient.forward.mock.calls[0][0] as Record<string, unknown>;
    expect(call.apiKey).toBe('mm-access');
    expect(call.customEndpoint).toBeDefined();
    expect((call.customEndpoint as { baseUrl?: string }).baseUrl).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    );
    // Custom endpoint forwards the model verbatim, so the `minimax/` prefix
    // must be stripped or the subscription endpoint 404s.
    expect(call.model).toBe('abab');
  });

  it('ignores an invalid MiniMax subscription resource URL instead of building an endpoint', async () => {
    const { service, mocks } = buildService();
    mocks.minimaxOauth.unwrapToken.mockResolvedValue({
      t: 'mm-access',
      r: 'mm-refresh',
      e: Date.now() + 60_000,
      u: 'https://evil.example/anthropic',
    });
    mocks.providerClient.forward.mockResolvedValue(
      okStream(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ provider: 'minimax', authType: 'subscription', model: 'minimax/abab' }),
      asRes(res),
    );

    const call = mocks.providerClient.forward.mock.calls[0][0] as Record<string, unknown>;
    expect(call.customEndpoint).toBeUndefined();
  });

  it('returns 404 when a subscription OAuth blob can no longer be unwrapped', async () => {
    const { service, mocks } = buildService();
    // Stored value is a real OAuth blob, but unwrap fails (e.g. invalidated) —
    // resolveApiKey returns a null apiKey, which must surface as a 404.
    mocks.providerKeyService.getProviderKeys.mockResolvedValue([
      { ...DEFAULT_PROVIDER_KEY, apiKey: JSON.stringify({ t: 'a', r: 'b', e: 123 }) },
    ]);
    mocks.openaiOauth.unwrapToken.mockResolvedValue(null);
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ provider: 'openai', authType: 'subscription' }),
      asRes(res),
    );

    expect(res._status).toBe(404);
    expect(mocks.providerClient.forward).not.toHaveBeenCalled();
  });

  it('defaults all token counts to 0 when the stream reports no usage block', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue(
      okStream(['data: {"choices":[{"delta":{"content":"only text, no usage"}}]}\n\n']),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    const metrics = done.metrics as Record<string, number | null>;
    expect(metrics.inputTokens).toBe(0);
    expect(metrics.outputTokens).toBe(0);
    expect(metrics.cost).toBeNull();
    const row = mocks.messageRepo.insert.mock.calls[0][0];
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cache_creation_tokens).toBe(0);
  });

  it('does not write a JSON error when headers were already sent (sendPreStreamError guard)', async () => {
    const { service, mocks } = buildService();
    const res = mockRes();
    res.headersSent = true;
    // Provider connected but key missing → sendPreStreamError path.
    mocks.providerKeyService.getProviderKeys.mockResolvedValue([]);

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('does not record a transport failure when the client disconnects before forward resolves', async () => {
    const { service, mocks } = buildService();
    const res = mockRes();
    mocks.providerClient.forward.mockImplementation(async () => {
      res._closeHandler?.();
      throw new Error('client aborted');
    });

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(mocks.messageRepo.insert).not.toHaveBeenCalled();
    expect(mocks.history.saveColumn).not.toHaveBeenCalled();
    expect(mocks.eventBus.emit).not.toHaveBeenCalled();
  });

  it('swallows recordError insert failures that throw an Error on the upstream-error path', async () => {
    const { service, mocks } = buildService();
    mocks.messageRepo.insert.mockRejectedValueOnce(new Error('telemetry insert blew up'));
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 500,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue('upstream 500'),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    // recordError's catch swallowed the Error; the user still gets the 502.
    expect(res._status).toBe(502);
    expect((res._json as { message: string }).message).toContain('Provider returned 500');
  });

  it('tokensPerSec is null when no output tokens were produced', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":0}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    expect((done.metrics as Record<string, unknown>).tokensPerSec).toBeNull();
  });

  it('sends a 404 JSON error (no stream) when the provider is not connected', async () => {
    const requestInsert = jest.fn().mockResolvedValue(undefined);
    const { service, mocks } = buildService({
      providerKeyService: {
        hasActiveProvider: jest.fn().mockResolvedValue(false),
        getAuthType: jest.fn(),
        getProviderKeys: jest.fn(),
        getProviderApiKey: jest.fn(),
      },
      messageRepo: {
        insert: jest.fn(),
        manager: { getRepository: jest.fn(() => ({ insert: requestInsert })) },
      },
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(404);
    expect(res._json).toMatchObject({ statusCode: 404 });
    expect((res._json as { message: string }).message).toContain('not connected');
    expect(res.write).not.toHaveBeenCalled();
    expect(requestInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_origin: 'config' }),
    );
    expect(mocks.messageRepo.insert).not.toHaveBeenCalled();
  });

  it('sends a 404 JSON error when no usable API key is found', async () => {
    const { service } = buildService({
      providerKeyService: {
        hasActiveProvider: jest.fn().mockResolvedValue(true),
        getAuthType: jest.fn().mockResolvedValue('api_key'),
        getProviderKeys: jest.fn().mockResolvedValue([]),
        getProviderApiKey: jest.fn(),
      },
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(404);
    expect((res._json as { message: string }).message).toContain('No usable API key');
  });

  it('resolves authType from the key service when the dto omits it', async () => {
    const { service, mocks } = buildService();
    mocks.providerKeyService.getAuthType.mockResolvedValue('subscription');
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto({ authType: undefined }), asRes(res));

    expect(mocks.providerKeyService.getAuthType).toHaveBeenCalledWith(
      AGENT.tenant_id,
      'openai',
      undefined,
      AGENT.id,
    );
    // subscription auth → cost is 0, not null
    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    expect((done.metrics as Record<string, unknown>).cost).toBe(0);
    expect(mocks.messageRepo.insert.mock.calls[0][0].auth_type).toBe('subscription');
  });

  it('bills an OpenCode Go subscription run at its per-request rate, not $0', async () => {
    // The recorder resolves this rate from the OpenCode Go catalogue. Without
    // the same lookup here the playground records $0 for a run that really
    // costs money, and the two cost writers disagree about the same provider.
    const { service, mocks } = buildService();
    mocks.providerKeyService.getAuthType.mockResolvedValue('subscription');
    mocks.opencodeGoCatalog.resolveCostPerRequest.mockResolvedValue(0.04);
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ provider: 'opencode-go', authType: 'subscription' }),
      asRes(res),
    );

    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    expect((done.metrics as Record<string, unknown>).cost).toBe(0.04);
  });

  it('records a known $0 for a tile-connected local runtime', async () => {
    // llama.cpp reaches us as `custom:<uuid>`; only the canonical provider
    // says it is local. Checking the raw name records `null` — "not known" —
    // for inference that is free by construction, while the proxy recorder
    // records 0 for the very same run.
    const { service, mocks } = buildService();
    mocks.customProviders.canonicalizeAgentMessageKeys.mockResolvedValue({
      provider: 'llamacpp',
      model: 'llamacpp/qwen2.5-0.5b-q4.gguf',
    });
    mocks.pricingCache.getByModel.mockReturnValue(undefined);
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto({ provider: 'custom:cp-llamacpp' }), asRes(res));

    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    expect((done.metrics as Record<string, unknown>).cost).toBe(0);
  });

  it('completes the run when the custom-provider lookup fails after the answer streamed', async () => {
    // By this point the client already has its answer. A metadata lookup that
    // throws must not retro-actively turn a delivered run into an error one;
    // it only costs the local/subscription refinement, so the run falls back
    // to the raw provider name and prices from the catalogue as usual.
    const { service, mocks } = buildService();
    mocks.customProviders.canonicalizeAgentMessageKeys.mockRejectedValue(new Error('db down'));
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto({ provider: 'custom:cp-llamacpp' }), asRes(res));

    const events = parseSse(res);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const done = events.find((e) => e.type === 'done') as Record<string, unknown>;
    expect((done.metrics as Record<string, unknown>).cost).toBeCloseTo(0.000008, 10);
  });

  it('falls back to the request provider when canonicalization resolves no name', async () => {
    // `canonicalizeAgentMessageKeys` returns a null provider for a row it
    // cannot attribute. Passing that null on as the local check would read as
    // "not local" by accident rather than by lookup, so the raw name stands in.
    const { service, mocks } = buildService();
    mocks.customProviders.canonicalizeAgentMessageKeys.mockResolvedValue({
      provider: null,
      model: null,
    });
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto({ provider: 'openai' }), asRes(res));

    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    expect((done.metrics as Record<string, unknown>).cost).toBeCloseTo(0.000008, 10);
  });

  it('resolves a tenant-less run against no tenant instead of crashing', async () => {
    // A fresh account has no tenant until its first agent exists, and the
    // Playground is reachable before that. There are no custom providers to
    // resolve, so the lookup degrades to the raw name.
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(
      { tenantId: null, userId: 'user-1' } as TenantContext,
      makeDto({ provider: 'openai' }),
      asRes(res),
    );

    expect(mocks.customProviders.canonicalizeAgentMessageKeys).toHaveBeenCalledWith(
      '',
      'openai',
      expect.any(String),
    );
    expect(parseSse(res).some((e) => e.type === 'error')).toBe(false);
  });

  it('bills a run that leaves a peak window mid-stream at the rate it started on', async () => {
    // Only Date is faked: the stream reader still needs real timers to drain.
    // The run opens at 09:59 UTC inside the peak band and closes at 10:01
    // outside it. The proxy recorder bills such a run from its start, so
    // pricing the Playground from the completion time would put two different
    // numbers on the same request.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'setInterval',
        'setImmediate',
        'clearTimeout',
        'clearInterval',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
        'performance',
      ],
    });
    try {
      // 2026-08-21 is a Friday, so the weekday-only band applies.
      jest.setSystemTime(new Date('2026-08-21T09:59:00Z'));
      const { service, mocks } = buildService();
      mocks.pricingCache.getByModel.mockReturnValue({
        input_price_per_token: 0.000001,
        output_price_per_token: 0.000002,
        time_tiers: [
          {
            windows: ['09:00-10:00'],
            days: [1, 2, 3, 4, 5],
            input_price_per_token: 0.00001,
            output_price_per_token: 0.00002,
            cache_read_price_per_token: null,
            cache_write_price_per_token: null,
          },
        ],
      });
      mocks.providerClient.forward.mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-21T10:01:00Z'));
        return okStream([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        ]);
      });
      const res = mockRes();

      await service.runStream(CTX, makeDto({ provider: 'deepseek' }), asRes(res));

      const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
      // Peak: 4 x $0.00001 + 2 x $0.00002. Off-peak would be $0.000008.
      expect((done.metrics as Record<string, unknown>).cost).toBeCloseTo(0.00008, 10);
    } finally {
      jest.useRealTimers();
    }
  });

  it('unwraps OpenAI OAuth blobs before forwarding subscription Playground requests', async () => {
    const oauthBlob = JSON.stringify({
      t: 'stored-access-token',
      r: 'refresh-token',
      e: Date.now() + 10 * 60 * 1000,
    });
    const { service, mocks } = buildService();
    mocks.providerKeyService.getProviderKeys.mockResolvedValue([
      { ...DEFAULT_PROVIDER_KEY, label: 'Work', apiKey: oauthBlob },
    ]);
    mocks.providerKeyService.getProviderApiKey.mockResolvedValue(oauthBlob);
    mocks.openaiOauth.unwrapToken.mockResolvedValue('fresh-access-token');
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ model: 'gpt-5.5', authType: 'subscription' }),
      asRes(res),
    );

    expect(mocks.providerKeyService.getProviderKeys).toHaveBeenCalledWith(
      AGENT.tenant_id,
      'openai',
      'subscription',
      AGENT.id,
    );
    expect(mocks.openaiOauth.unwrapToken).toHaveBeenCalledWith(
      oauthBlob,
      AGENT.id,
      AGENT.tenant_id,
      'Work',
    );
    expect(mocks.providerClient.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.5',
        authType: 'subscription',
        apiKey: 'fresh-access-token',
      }),
    );
    expect(res._status).toBeNull();
  });

  it('forces an OpenAI OAuth refresh and retries when Playground receives a 401', async () => {
    const oauthBlob = JSON.stringify({
      t: 'stored-access-token',
      r: 'refresh-token',
      e: Date.now() - 10 * 60 * 1000,
    });
    const refreshedBlob = JSON.stringify({
      t: 'fresh-access-token',
      r: 'rotated-refresh-token',
      e: Date.now() + 10 * 60 * 1000,
    });
    const { service, mocks } = buildService();
    mocks.providerKeyService.getProviderKeys.mockResolvedValue([
      { ...DEFAULT_PROVIDER_KEY, label: 'Work', apiKey: oauthBlob },
    ]);
    mocks.providerKeyService.getProviderApiKey.mockResolvedValue(refreshedBlob);
    mocks.openaiOauth.unwrapToken
      .mockResolvedValueOnce('fresh-access-token')
      .mockResolvedValueOnce('refreshed-access-token');
    mocks.providerClient.forward
      .mockResolvedValueOnce(errorForward(401, 'expired token'))
      .mockResolvedValueOnce(
        okStream([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n',
        ]),
      );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ model: 'gpt-5.5', authType: 'subscription' }),
      asRes(res),
    );

    expect(mocks.providerClient.forward).toHaveBeenCalledTimes(2);
    expect(mocks.providerClient.forward.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      authType: 'subscription',
      apiKey: 'fresh-access-token',
    });
    expect(mocks.providerClient.forward.mock.calls[1][0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      authType: 'subscription',
      apiKey: 'refreshed-access-token',
    });
    const forcedRefreshBlob = JSON.parse(mocks.openaiOauth.unwrapToken.mock.calls[1][0]) as Record<
      string,
      unknown
    >;
    expect(forcedRefreshBlob).toMatchObject({
      t: 'fresh-access-token',
      r: 'rotated-refresh-token',
      e: 0,
    });
    expect(mocks.openaiOauth.unwrapToken).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      AGENT.id,
      AGENT.tenant_id,
      'Work',
    );
    expect(res._status).toBeNull();
  });

  it('maps an HttpException thrown during preflight to its status', async () => {
    const { service } = buildService({
      playgroundAgent: {
        resolve: jest.fn().mockRejectedValue(new NotFoundException('agent gone')),
      },
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(404);
    expect((res._json as { message: string }).message).toBe('agent gone');
  });

  it('maps a non-404 HttpException during preflight to its status (e.g. 403)', async () => {
    const { service } = buildService({
      playgroundAgent: {
        resolve: jest.fn().mockRejectedValue(new ForbiddenException('nope')),
      },
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(403);
  });

  it('maps a non-HttpException preflight failure to 500', async () => {
    const { service } = buildService({
      playgroundAgent: {
        resolve: jest.fn().mockRejectedValue(new Error('boom')),
      },
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(500);
    expect((res._json as { message: string }).message).toBe('boom');
  });

  it('records a resolved-agent preflight failure as an internal request rejection', async () => {
    const requestInsert = jest.fn().mockResolvedValue(undefined);
    const { service, mocks } = buildService({
      messageRepo: {
        insert: jest.fn(),
        manager: { getRepository: jest.fn(() => ({ insert: requestInsert })) },
      },
    });
    mocks.providerKeyService.getProviderKeys.mockRejectedValue(new Error('key service down'));
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(500);
    expect(requestInsert).toHaveBeenCalledWith(
      expect.objectContaining({ error_origin: 'internal', error_http_status: 500 }),
    );
  });

  it('keeps responding when preflight rejection telemetry fails', async () => {
    const requestInsert = jest.fn().mockRejectedValue('telemetry unavailable');
    const { service, mocks } = buildService({
      messageRepo: {
        insert: jest.fn(),
        manager: { getRepository: jest.fn(() => ({ insert: requestInsert })) },
      },
    });
    mocks.providerKeyService.getProviderKeys.mockRejectedValue(new ForbiddenException('blocked'));
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(403);
    expect(requestInsert).toHaveBeenCalledWith(
      expect.objectContaining({ error_origin: 'config', error_http_status: 403 }),
    );
  });

  it('stringifies a non-Error preflight rejection', async () => {
    const { service } = buildService({
      playgroundAgent: {
        resolve: jest.fn().mockRejectedValue('weird-string'),
      },
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(500);
    expect((res._json as { message: string }).message).toBe('weird-string');
  });

  it('returns 502 JSON when forward() throws (Error)', async () => {
    const requestInsert = jest.fn().mockResolvedValue(undefined);
    const { service, mocks } = buildService({
      messageRepo: {
        insert: jest.fn().mockResolvedValue(undefined),
        manager: { getRepository: jest.fn(() => ({ insert: requestInsert })) },
      },
    });
    mocks.providerClient.forward.mockRejectedValue(new Error('connection refused'));
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(502);
    expect((res._json as { message: string }).message).toContain('connection refused');
    expect(requestInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_origin: 'transport' }),
    );
    expect(mocks.messageRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error_origin: 'transport' }),
    );
  });

  it('returns 502 JSON when forward() throws a non-Error', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockRejectedValue('not-an-error');
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(502);
    expect((res._json as { message: string }).message).toContain('not-an-error');
  });

  it('records an error row + history column and returns 502 on an upstream non-2xx', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 429,
        headers: new Headers({ 'x-request-id': 'abc' }),
        text: jest.fn().mockResolvedValue('rate limited'),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(502);
    expect((res._json as { message: string }).message).toContain('Provider returned 429');
    expect(mocks.messageRepo.insert).toHaveBeenCalledTimes(1);
    expect(mocks.messageRepo.insert.mock.calls[0][0]).toMatchObject({
      routing_tier: 'playground',
      status: 'failed',
      error_http_status: 429,
    });
    expect(mocks.history.saveColumn).toHaveBeenCalledTimes(1);
    expect(mocks.history.saveColumn.mock.calls[0][0]).toMatchObject({ status: 'error' });
  });

  it('truncates a non-2xx error body to a status-only message when blank', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 500,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue('   '),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect((res._json as { message: string }).message).toBe('Provider returned 500');
  });

  it('emits an error event and ends the stream when an OK response has no body', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const events = parseSse(res);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      message: 'Provider returned an empty stream',
    });
    expect(res.end).toHaveBeenCalled();
  });

  it('emits a terminal error event when the stream itself throws (post-commit failure)', async () => {
    const { service, mocks } = buildService();
    const failingBody = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream blew up mid-flight');
      },
    });
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: failingBody,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const events = parseSse(res);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const errEvent = events.find((e) => e.type === 'error') as Record<string, unknown>;
    expect(errEvent.message).toContain('stream blew up mid-flight');
    expect(mocks.messageRepo.insert).toHaveBeenCalledTimes(1);
    expect(mocks.messageRepo.insert.mock.calls[0][0]).toMatchObject({ status: 'failed' });
    expect(mocks.history.saveColumn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
    expect(res.end).toHaveBeenCalled();
  });

  // The service registers `res.on('close', () => abort.abort())` *before* it
  // touches `forward.response.body`. A ReadableStream calls `pull` eagerly at
  // construction (highWaterMark 1), so building the stream inline would run
  // `pull` before the close handler exists. Exposing `body` via a lazy getter
  // defers stream construction until the service reads it — i.e. after the
  // close handler is wired — which is what lets us fire a realistic abort.
  function abortingForward(res: MockRes, opts: { endFirst?: boolean } = {}) {
    return {
      response: {
        ok: true,
        status: 200 as const,
        headers: new Headers(),
        get body(): ReadableStream<Uint8Array> {
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (opts.endFirst) res.writableEnded = true;
              // Client disconnected: Express would fire 'close' → abort().
              res._closeHandler?.();
              controller.error(new Error('aborted'));
            },
          });
        },
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    };
  }

  it('does not record or emit when the request was aborted mid-stream', async () => {
    const { service, mocks } = buildService();
    const res = mockRes();
    mocks.providerClient.forward.mockResolvedValue(abortingForward(res));

    await service.runStream(CTX, makeDto(), asRes(res));

    // Aborted → no error event, no telemetry row, no history column, just end().
    expect(mocks.messageRepo.insert).not.toHaveBeenCalled();
    expect(mocks.history.saveColumn).not.toHaveBeenCalled();
    expect(parseSse(res).some((e) => e.type === 'error')).toBe(false);
    expect(res.end).toHaveBeenCalled();
  });

  it('does not double-end the stream when an abort happens after the response already ended', async () => {
    const { service, mocks } = buildService();
    const res = mockRes();
    mocks.providerClient.forward.mockResolvedValue(abortingForward(res, { endFirst: true }));

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not re-end the stream on a post-commit failure when it already ended', async () => {
    const { service, mocks } = buildService();
    const res = mockRes();
    const failingBody = new ReadableStream<Uint8Array>({
      pull() {
        res.writableEnded = true;
        throw new Error('late failure');
      },
    });
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: failingBody,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });

    await service.runStream(CTX, makeDto(), asRes(res));

    // recordError + saveColumn still run, but res.end() must not be called twice.
    expect(mocks.messageRepo.insert).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error thrown by the stream on the post-commit path', async () => {
    const { service, mocks } = buildService();
    const failingBody = new ReadableStream<Uint8Array>({
      pull() {
        throw 'string-failure';
      },
    });
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: failingBody,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const errEvent = parseSse(res).find((e) => e.type === 'error') as Record<string, unknown>;
    expect(errEvent.message).toBe('string-failure');
  });

  it('does not crash when recordSuccess insert fails — the user still gets a done event', async () => {
    const { service, mocks } = buildService();
    mocks.messageRepo.insert.mockRejectedValueOnce(new Error('agent_messages broke'));
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const events = parseSse(res);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(mocks.history.saveColumn).toHaveBeenCalledTimes(1);
  });

  it('swallows recordError insert failures (non-Error) on the upstream-error path', async () => {
    const { service, mocks } = buildService();
    mocks.messageRepo.insert.mockRejectedValueOnce('weird');
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 503,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue('upstream down'),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(res._status).toBe(502);
    expect((res._json as { message: string }).message).toContain('Provider returned 503');
  });

  it('swallows recordSuccess insert failures that throw a non-Error', async () => {
    const { service, mocks } = buildService();
    mocks.messageRepo.insert.mockRejectedValueOnce('weird-success-failure');
    mocks.providerClient.forward.mockResolvedValue(
      okStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      ]),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    expect(parseSse(res).some((e) => e.type === 'done')).toBe(true);
  });

  it('only forwards whitelisted response headers in the done event', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue(
      okStream(
        [
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        ],
        {
          'x-ratelimit-remaining': '99',
          'set-cookie': 'leaked=1',
          'x-request-id': 'abc',
        },
      ),
    );
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const done = parseSse(res).find((e) => e.type === 'done') as Record<string, unknown>;
    const headers = done.headers as Record<string, string>;
    expect(headers['x-ratelimit-remaining']).toBe('99');
    expect(headers['x-request-id']).toBe('abc');
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('passes sanitized request headers through to the provider client', async () => {
    const { service, mocks } = buildService();
    mocks.providerClient.forward.mockResolvedValue(
      okStream(['data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n']),
    );
    const res = mockRes();

    await service.runStream(
      CTX,
      makeDto({ requestHeaders: { 'X-Custom': 'keep', authorization: 'drop-me' } }),
      asRes(res),
    );

    const forwardArgs = mocks.providerClient.forward.mock.calls[0][0];
    // sanitizeRequestHeaders preserves the original key casing and drops the
    // blocked Authorization header.
    expect(forwardArgs.extraHeaders['X-Custom']).toBe('keep');
    expect(forwardArgs.extraHeaders.authorization).toBeUndefined();
    expect(forwardArgs.stream).toBe(true);
  });

  it('send() is a no-op once the response has ended (no write after end)', async () => {
    const { service, mocks } = buildService();
    // Stream that ends the response itself before the done event would be sent.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'),
        );
        res.writableEnded = true;
        controller.close();
      },
    });
    const res = mockRes();
    mocks.providerClient.forward.mockResolvedValue({
      response: { ok: true, status: 200, headers: new Headers(), body },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });

    await service.runStream(CTX, makeDto(), asRes(res));

    // writableEnded was true before send({type:'done'}) — nothing extra written.
    expect(res._written).toEqual([]);
  });
});
