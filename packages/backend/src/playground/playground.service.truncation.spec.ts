import type { Response as ExpressResponse } from 'express';
import { PlaygroundService } from './playground.service';
import { CustomProviderService } from '../routing/custom-provider/custom-provider.service';
import { OpencodeGoCatalogService } from '../model-discovery/opencode-go-catalog.service';
import type { ProviderClient } from '../routing/proxy/provider-client';
import type { ProviderKeyService } from '../routing/routing-core/provider-key.service';
import type { PlaygroundAgentService } from './playground-agent.service';
import type { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import type { IngestEventBusService } from '../common/services/ingest-event-bus.service';
import type { PlaygroundHistoryService } from './playground-history.service';
import type { OpenaiOauthService } from '../routing/oauth/openai/openai-oauth.service';
import type { MinimaxOauthService } from '../routing/oauth/minimax/minimax-oauth.service';
import type { AnthropicOauthService } from '../routing/oauth/anthropic/anthropic-oauth.service';
import type { GeminiOauthService } from '../routing/oauth/gemini/gemini-oauth.service';
import type { KiroOauthService } from '../routing/oauth/kiro/kiro-oauth.service';
import type { XaiOauthService } from '../routing/oauth/xai/xai-oauth.service';
import type { Repository } from 'typeorm';
import type { AgentMessage } from '../entities/agent-message.entity';
import type { CustomProvider } from '../entities/custom-provider.entity';
import type { RunPlaygroundDto } from './dto/run-playground.dto';
import type { TenantContext } from '../common/decorators/tenant-context.decorator';

const AGENT = { id: 'agent-1', tenant_id: 'tenant-1', name: 'demo' };
const CTX: TenantContext = { tenantId: 'tenant-1', userId: 'user-1' };

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

const asRes = (r: MockRes): ExpressResponse => r as unknown as ExpressResponse;

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
  messageRepo: { insert: jest.Mock };
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
      getProviderKeys: jest.fn().mockResolvedValue([{ apiKey: 'sk-test', label: 'Default' }]),
      getProviderApiKey: jest.fn().mockResolvedValue('sk-test'),
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

describe('PlaygroundService.runStream — error body truncation', () => {
  it('truncates long error bodies to a safe length for SSE response and history column', async () => {
    const { service, mocks } = buildService();
    // 10KB body — 10,000 'A's. The service should:
    //   1) truncate to 500 chars for the JSON response + history error message
    //   2) truncate to 2000 chars for the persisted agent_messages.error_message
    const longBody = 'A'.repeat(10_000);
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 502,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(longBody),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    // --- 1. The user-facing JSON response must NOT contain the full body. ---
    expect(res._status).toBe(502);
    const message = (res._json as { message: string }).message;
    expect(message.startsWith('Provider returned 502: ')).toBe(true);
    // Prefix "Provider returned 502: " (23 chars) + max 500 chars snippet
    // = at most 523 chars. The full 10KB body must NOT leak through.
    expect(message.length).toBeLessThanOrEqual(523);
    expect(message.length).toBeLessThan(longBody.length);
    // Snippet content after the prefix should be exactly 500 chars of 'A'.
    const snippet = message.slice('Provider returned 502: '.length);
    expect(snippet.length).toBe(500);
    expect(snippet).toBe('A'.repeat(500));

    // --- 2. The history column receives the same truncated error message. ---
    expect(mocks.history.saveColumn).toHaveBeenCalledTimes(1);
    const column = mocks.history.saveColumn.mock.calls[0][0];
    expect(column.status).toBe('error');
    expect(column.errorMessage).toBe(message);
    expect((column.errorMessage as string).length).toBeLessThanOrEqual(523);

    // --- 3. The agent_messages row caps error_message to 2000 chars. ---
    // recordError uses errorBody.slice(0, 2000) on the raw body — the original
    // body is 10K 'A's, so the persisted value is exactly 2000 'A's.
    expect(mocks.messageRepo.insert).toHaveBeenCalledTimes(1);
    const row = mocks.messageRepo.insert.mock.calls[0][0];
    expect(row.status).toBe('failed');
    expect(row.error_http_status).toBe(502);
    expect((row.error_message as string).length).toBe(2000);
    expect(row.error_message).toBe('A'.repeat(2000));
    // Crucially, the full 10KB body never made it to the DB row either.
    expect((row.error_message as string).length).toBeLessThan(longBody.length);
  });

  it('trims whitespace from the truncated snippet so 500 trailing spaces collapse', async () => {
    const { service, mocks } = buildService();
    // 500 leading/trailing spaces + a payload in the middle. After slice(0,500)
    // the snippet is all whitespace and .trim() collapses it to '' — the
    // service must fall back to the status-only message form.
    const body = ' '.repeat(600) + 'real error text after the slice window';
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 500,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(body),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const message = (res._json as { message: string }).message;
    expect(message).toBe('Provider returned 500');
    // The history column gets the same status-only message — no whitespace
    // soup, and definitely none of the "real error text after the slice
    // window" payload that sits beyond the 500-char window.
    const column = mocks.history.saveColumn.mock.calls[0][0];
    expect(column.errorMessage).toBe('Provider returned 500');
    expect(column.errorMessage).not.toContain('real error text');
  });

  it('scrubs credentials echoed in the error body before they reach any sink', async () => {
    const { service, mocks } = buildService();
    // Some providers (e.g. Anthropic 401s) echo the submitted key back in the
    // error body. It must be redacted in the SSE response, the history column,
    // and the persisted agent_messages row.
    const leakyBody = JSON.stringify({
      error: { message: 'invalid x-api-key: sk-ant-abcdef0123456789ghij' },
    });
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 401,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(leakyBody),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const message = (res._json as { message: string }).message;
    expect(message).not.toContain('sk-ant-abcdef0123456789ghij');
    expect(message).toContain('[REDACTED]');

    const column = mocks.history.saveColumn.mock.calls[0][0];
    expect(column.errorMessage).not.toContain('sk-ant-abcdef0123456789ghij');
    expect(column.errorMessage).toContain('[REDACTED]');

    const row = mocks.messageRepo.insert.mock.calls[0][0];
    expect(row.error_message).not.toContain('sk-ant-abcdef0123456789ghij');
    expect(row.error_message).toContain('[REDACTED]');
  });

  it('preserves short error bodies verbatim (no over-truncation)', async () => {
    const { service, mocks } = buildService();
    const shortBody = 'quota exceeded';
    mocks.providerClient.forward.mockResolvedValue({
      response: {
        ok: false,
        status: 429,
        headers: new Headers(),
        text: jest.fn().mockResolvedValue(shortBody),
        body: null,
      },
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
    const res = mockRes();

    await service.runStream(CTX, makeDto(), asRes(res));

    const message = (res._json as { message: string }).message;
    expect(message).toBe('Provider returned 429: quota exceeded');
    const column = mocks.history.saveColumn.mock.calls[0][0];
    expect(column.errorMessage).toBe('Provider returned 429: quota exceeded');
    const row = mocks.messageRepo.insert.mock.calls[0][0];
    // Short bodies are stored verbatim (< 2000 char cap).
    expect(row.error_message).toBe(shortBody);
  });
});
