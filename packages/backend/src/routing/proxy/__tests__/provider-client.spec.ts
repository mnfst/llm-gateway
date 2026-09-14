import { Buffer } from 'node:buffer';
import { ProviderClient } from '../provider-client';
import { ManifestError } from '../../../common/errors/manifest-error';
import { buildCustomEndpoint, buildEndpointOverride } from '../provider-endpoints';
import { ThinkingBlockCache, type ThinkingBlockRouteContext } from '../thinking-block-cache';
import { ModelsDevReasoningCatalog } from '../reasoning-model-catalog';
import type { ProviderModelRegistryService } from '../../../model-discovery/provider-model-registry.service';

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

function kiroStringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name);
  const valueBytes = Buffer.from(value);
  const valueLength = Buffer.alloc(2);
  valueLength.writeUInt16BE(valueBytes.length, 0);
  return Buffer.concat([
    Buffer.from([nameBytes.length]),
    nameBytes,
    Buffer.from([7]),
    valueLength,
    valueBytes,
  ]);
}

function kiroEventFrame(eventType: string, payload: unknown, messageType = 'event'): Uint8Array {
  const headers = Buffer.concat([
    kiroStringHeader(':message-type', messageType),
    kiroStringHeader(':event-type', eventType),
  ]);
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12);
  payloadBytes.copy(frame, 12 + headers.length);
  return frame;
}

describe('ProviderClient', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  let client: ProviderClient;

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    client = new ProviderClient();
    mockFetch.mockReset();
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  const body = {
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
  };

  describe('OpenAI-compatible providers', () => {
    it('refuses to dial a built-in local provider from cloud', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';

      const request = client.forward({
        provider: 'ollama',
        apiKey: '',
        model: 'qwen2.5:0.5b',
        body,
        stream: false,
      });

      await expect(request).rejects.toMatchObject({ code: 'M303' });
      await expect(request).rejects.toBeInstanceOf(ManifestError);
      await expect(request).rejects.toThrow(
        'Built-in local providers are only available in self-hosted Manifest',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('builds correct URL and headers for openai', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-test',
            'Content-Type': 'application/json',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('gpt-4o');
      expect(sentBody.stream).toBe(false);
      expect(sentBody.temperature).toBe(0.7);
      expect(result.isAnthropic).toBe(false);
    });

    it('turns an empty non-streaming Chat Completions response into a provider failure', async () => {
      const upstreamBody = {
        id: 'chatcmpl-empty',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', tool_calls: [] },
            finish_reason: 'stop',
          },
        ],
      };
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(upstreamBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const finishRecording = jest.fn().mockResolvedValue(undefined);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        apiMode: 'chat_completions',
        attempt: {
          id: 'attempt-empty',
          attemptNumber: 1,
          startedAtMs: 0,
          startedAt: new Date(0).toISOString(),
          pendingWrite: Promise.resolve(true),
          finishRecording,
        },
      });

      expect(result.response.status).toBe(502);
      expect(finishRecording).toHaveBeenCalledWith({ type: 'json', body: upstreamBody });
      await expect(result.response.json()).resolves.toEqual({
        error: {
          message: 'Upstream provider returned an empty Chat Completions response',
          type: 'server_error',
          code: 'empty_response',
        },
      });
    });

    it('turns an empty choices list into a provider failure', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        apiMode: 'chat_completions',
      });

      expect(result.response.status).toBe(502);
      await expect(result.response.json()).resolves.toMatchObject({
        error: { code: 'empty_response' },
      });
    });

    it('records an empty retry response against the retry attempt', async () => {
      const retryBody = { choices: [] };
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Initial response' },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(retryBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const originalFinishRecording = jest.fn().mockResolvedValue(undefined);
      const retryFinishRecording = jest.fn().mockResolvedValue(undefined);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        apiMode: 'chat_completions',
        attempt: {
          id: 'attempt-original',
          attemptNumber: 1,
          startedAtMs: 0,
          startedAt: new Date(0).toISOString(),
          pendingWrite: Promise.resolve(true),
          finishRecording: originalFinishRecording,
        },
      });
      const retry = await result.retryWireBody!(body, {
        id: 'attempt-retry',
        attemptNumber: 2,
        startedAtMs: 1,
        startedAt: new Date(1).toISOString(),
        pendingWrite: Promise.resolve(true),
        finishRecording: retryFinishRecording,
      });

      expect(retry.response.status).toBe(502);
      expect(originalFinishRecording).not.toHaveBeenCalled();
      expect(retryFinishRecording).toHaveBeenCalledWith({ type: 'json', body: retryBody });
    });

    it.each([
      ['content', { role: 'assistant', content: 'Hello' }],
      [
        'tool call',
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        },
      ],
      [
        'provider output extension',
        { role: 'assistant', content: null, reasoning_content: 'Done' },
      ],
      ['audio output', { role: 'assistant', content: null, audio: { id: 'audio-1' } }],
    ])('keeps a Chat Completions response with %s', async (_label, message) => {
      const upstream = new Response(
        JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      mockFetch.mockResolvedValue(upstream);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        apiMode: 'chat_completions',
      });

      expect(result.response).toBe(upstream);
      expect(result.response.status).toBe(200);
    });

    it('leaves a malformed successful response unchanged', async () => {
      const upstream = new Response('not-json', { status: 200 });
      mockFetch.mockResolvedValue(upstream);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        apiMode: 'chat_completions',
      });

      expect(result.response).toBe(upstream);
    });

    it('keeps an empty completion stopped by a content filter', async () => {
      const upstream = new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null },
              finish_reason: 'content_filter',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      mockFetch.mockResolvedValue(upstream);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        apiMode: 'chat_completions',
      });

      expect(result.response).toBe(upstream);
    });

    it('does not inspect streaming Chat Completions responses', async () => {
      const upstream = new Response(
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
      mockFetch.mockResolvedValue(upstream);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: true,
        apiMode: 'chat_completions',
      });

      expect(result.response).toBe(upstream);
    });

    it('adds scoped prompt cache affinity for OpenAI without exposing the session', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        providerCacheKey: 'v1:tenant-agent-session-digest',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(sentBody.prompt_cache_key).not.toContain('tenant-agent-session');
    });

    it('keeps caller-supplied OpenAI prompt cache affinity', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: { ...body, prompt_cache_key: 'caller-conversation' },
        providerCacheKey: 'v1:tenant-agent-session-digest',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toBe('caller-conversation');
    });

    it('captures the wire body and retries a healed body without rebuilding it', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const first = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
      });
      const healedBody = {
        model: 'gpt-4o',
        messages: body.messages,
        healed_provider_extension: true,
      };
      const retry = await first.retryWireBody!(healedBody);

      expect(first.wireApiMode).toBe('chat_completions');
      expect(first.wireRequestBody).toEqual(JSON.parse(mockFetch.mock.calls[0][1].body));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual(healedBody);
      expect(retry.wireRequestBody).toBe(healedBody);
      expect(retry.retryWireBody).toBe(first.retryWireBody);
    });

    it('preserves image parts for OpenAI-compatible providers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const imageBody = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this.' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              },
            ],
          },
        ],
      };

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: imageBody,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toEqual(imageBody.messages);
      expect(sentBody.model).toBe('gpt-4o');
    });

    it('builds correct URL for deepseek', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const result = await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-chat',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.deepseek.com/v1/chat/completions',
        expect.any(Object),
      );
      expect(result.isAnthropic).toBe(false);
    });

    it('builds correct URL for mistral', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/chat/completions',
        expect.any(Object),
      );
    });

    it('adds stable Mistral prompt cache affinity without leaking identifiers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body,
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body,
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body,
        providerCacheKey: 'scoped-session-2',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const thirdBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(firstBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
      expect(thirdBody.prompt_cache_key).not.toBe(firstBody.prompt_cache_key);
      expect(firstBody.prompt_cache_key).not.toContain('sk-mi');
      expect(firstBody.prompt_cache_key).not.toContain('session-1');
    });

    it('keeps caller-supplied Mistral prompt cache keys', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body: { ...body, prompt_cache_key: 'caller-conversation' },
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toBe('caller-conversation');
    });

    it('omits Mistral prompt_cache_key when no session is available', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body,
        stream: false,
      });
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-large-latest',
        body,
        providerCacheKey: '   ',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBody.prompt_cache_key).toBeUndefined();
      expect(secondBody.prompt_cache_key).toBeUndefined();
    });

    it('adds stable Moonshot prompt cache affinity without leaking identifiers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-kimi',
        model: 'kimi-k2-latest',
        body,
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });
      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-kimi',
        model: 'kimi-k2-latest',
        body,
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
      expect(firstBody.prompt_cache_key).not.toContain('sk-kimi');
      expect(firstBody.prompt_cache_key).not.toContain('session-1');
    });

    it('keeps caller-supplied Moonshot prompt cache keys', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-kimi',
        model: 'kimi-k2-latest',
        body: { ...body, prompt_cache_key: 'caller-conversation' },
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toBe('caller-conversation');
    });

    it('omits Moonshot prompt_cache_key when no session is available', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-kimi',
        model: 'kimi-k2-latest',
        body,
        stream: false,
      });
      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-kimi',
        model: 'kimi-k2-latest',
        body,
        providerCacheKey: '   ',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBody.prompt_cache_key).toBeUndefined();
      expect(secondBody.prompt_cache_key).toBeUndefined();
    });

    it('adds stable Fireworks prompt cache affinity without leaking identifiers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'fireworks',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/kimi-k2-instruct-0905',
        body,
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });
      await client.forward({
        provider: 'fireworks',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/kimi-k2-instruct-0905',
        body,
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(secondBody.prompt_cache_key).toBe(firstBody.prompt_cache_key);
      expect(firstBody.prompt_cache_key).not.toContain('fw-key');
      expect(firstBody.prompt_cache_key).not.toContain('session-1');
    });

    it('keeps caller-supplied Fireworks prompt cache keys', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'fireworks',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/kimi-k2-instruct-0905',
        body: { ...body, prompt_cache_key: 'caller-conversation' },
        providerCacheKey: 'scoped-session-1',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toBe('caller-conversation');
    });

    it('omits Fireworks prompt_cache_key when no session is available', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'fireworks',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/kimi-k2-instruct-0905',
        body,
        stream: false,
      });
      await client.forward({
        provider: 'fireworks',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/kimi-k2-instruct-0905',
        body,
        providerCacheKey: '   ',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBody.prompt_cache_key).toBeUndefined();
      expect(secondBody.prompt_cache_key).toBeUndefined();
    });

    it('builds Bedrock Mantle chat completions requests with bearer API-key auth', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        model: 'mistral.ministral-3-8b-instruct',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer bedrock-api-key-test',
            'Content-Type': 'application/json',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('mistral.ministral-3-8b-instruct');
      expect(sentBody.stream).toBe(false);
      expect(result.isAnthropic).toBe(false);
      expect(result.isGoogle).toBe(false);
    });

    it.each([
      'openai.gpt-5.4',
      'openai.gpt-5.5',
      'openai.gpt-5.6-sol',
      'openai.gpt-5.6-terra',
      'openai.gpt-5.6-luna',
    ])('routes Bedrock %s through the namespaced Responses API', async (model) => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        model,
        body: { ...body, max_tokens: 1024 },
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer bedrock-api-key-test',
            'Content-Type': 'application/json',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe(model);
      expect(sentBody.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ]);
      expect(sentBody.max_output_tokens).toBe(1024);
      expect(sentBody.messages).toBeUndefined();
      expect(sentBody.stream).toBe(false);
      expect(result.isChatGpt).toBe(true);
      expect(result.wireApiMode).toBe('responses');
    });

    it('preserves Bedrock Responses conversion for a selected region', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        model: 'openai.gpt-5.6-luna',
        body: { ...body, max_tokens: 1024 },
        stream: false,
        customEndpoint: buildEndpointOverride(
          'https://bedrock-mantle.us-west-2.api.aws',
          'bedrock-responses',
        ),
      });

      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses',
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_output_tokens).toBe(1024);
      expect(sentBody.stream).toBe(false);
    });

    it('routes Bedrock Anthropic models through the Messages API', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        model: 'anthropic.claude-sonnet-5',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'x-api-key': 'bedrock-api-key-test',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('anthropic.claude-sonnet-5');
      expect(sentBody.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]);
      expect(result.isAnthropic).toBe(true);
      expect(result.wireApiMode).toBe('messages');
    });

    it('builds correct URL for moonshot', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-moon',
        model: 'kimi-k2',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.moonshot.ai/v1/chat/completions',
        expect.any(Object),
      );
    });

    it('builds correct URL for qwen', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'qwen',
        apiKey: 'sk-qwen',
        model: 'qwen3-235b-a22b',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-qwen',
            'Content-Type': 'application/json',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('qwen3-235b-a22b');
      expect(sentBody.stream).toBe(false);
    });

    it('builds correct URL for xai', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-3',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.x.ai/v1/chat/completions',
        expect.any(Object),
      );
    });

    it('builds correct URL for xiaomi', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'xiaomi',
        apiKey: 'sk-mimo-test',
        model: 'mimo-v2.5-pro',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.xiaomimimo.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-mimo-test',
            'Content-Type': 'application/json',
          },
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('mimo-v2.5-pro');
    });

    it('routes public Responses API requests for xAI to /v1/responses', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.3',
        body: {
          input: [{ role: 'user', content: 'Hello' }],
          reasoning: { effort: 'low' },
          stream: false,
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
        stream: false,
        apiMode: 'responses',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.x.ai/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-xai',
            'Content-Type': 'application/json',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).toMatchObject({
        model: 'grok-4.3',
        reasoning: { effort: 'low' },
        stream: false,
        store: false,
      });
      expect(sentBody.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ]);
      expect(sentBody.messages).toBeUndefined();
      expect(result.isResponses).toBe(true);
      expect(result.isChatGpt).toBe(false);
    });

    it('builds correct URL for openrouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or-test',
        model: 'openrouter/auto',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-or-test',
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://manifest.build',
            'X-Title': 'Manifest',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('openrouter/auto');
    });

    it('preserves the Gemini vendor prefix for Gemini Free LiteLLM requests', async () => {
      process.env['CREDITS_BASE_URL'] = 'https://credits.test';
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'gemini-free',
        apiKey: 'sk-virtual',
        model: 'gemini/gemini-2.5-flash',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://credits.test/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer sk-virtual' }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('gemini/gemini-2.5-flash');
    });

    it('builds Nous Portal requests without stripping vendor-prefixed model IDs', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'nous',
        apiKey: 'nous-api-key',
        model: 'anthropic/claude-sonnet-4.5',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://inference-api.nousresearch.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer nous-api-key',
            'Content-Type': 'application/json',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('anthropic/claude-sonnet-4.5');
    });

    it('sets stream=true when streaming', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream).toBe(true);
    });

    it('routes public Responses API requests for OpenAI to /v1/responses', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const resolveChatBody = jest
        .fn()
        .mockResolvedValue({ messages: [{ role: 'user', content: 'Hello' }], stream: false });

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: { input: 'Hello', stream: false },
        resolveChatBody,
        stream: false,
        apiMode: 'responses',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.any(Object),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).toMatchObject({
        input: 'Hello',
        model: 'gpt-4o',
        stream: false,
        store: false,
      });
      expect(sentBody.messages).toBeUndefined();
      expect(sentBody.instructions).toBeUndefined();
      expect(result.isResponses).toBe(true);
      expect(result.isChatGpt).toBe(false);
      expect(resolveChatBody).not.toHaveBeenCalled();
    });

    it('resolves a Responses conversion once for a Chat Completions endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const resolveChatBody = jest
        .fn()
        .mockResolvedValue({ messages: [{ role: 'user', content: 'Hello' }], stream: false });

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or-test',
        model: 'openai/gpt-4o',
        body: { input: 'Hello', stream: false },
        resolveChatBody,
        stream: false,
        apiMode: 'responses',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(resolveChatBody).toHaveBeenCalledTimes(1);
    });

    it('adds default instructions for subscription Responses requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5.4',
        body: { input: 'Hello', stream: false },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
        stream: false,
        authType: 'subscription',
        apiMode: 'responses',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.instructions).toBe('You are a helpful assistant.');
      expect(sentBody.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ]);
      expect(sentBody.stream).toBe(true);
    });

    it('resolves Anthropic Messages conversion for a Responses endpoint', async () => {
      // Regression: previously the chatgpt branch passed `body` directly into
      // toResponsesRequest, so a /v1/messages request hitting an
      // openai-responses endpoint would forward Anthropic-shaped tools and
      // drop the top-level system prompt.
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const resolveChatBody = jest.fn().mockResolvedValue({
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        model: 'o1-pro',
        metadata: { user_id: 'anthropic-responses-user' },
      });

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        // o1-pro is a Responses-only model, so the resolver routes it to the
        // chatgpt-format /v1/responses endpoint — that's the branch under test.
        model: 'o1-pro',
        body: {
          model: 'o1-pro',
          system: 'be brief',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { user_id: 'anthropic-responses-user' },
        },
        resolveChatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // toResponsesRequest pulls instructions out of chat-completions system
      // messages, proving the lazy conversion, not the raw Anthropic body, was forwarded.
      expect(sentBody.instructions).toBe('be brief');
      expect(sentBody.system).toBeUndefined();
      expect(sentBody.metadata).toBeUndefined();
      expect(sentBody.safety_identifier).toBe('anthropic-responses-user');
      expect(resolveChatBody).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['keeps a short identifier', 'user-123', 'user-123'],
      [
        'hashes an identifier longer than OpenAI allows',
        'anthropic-user-id-that-is-longer-than-the-openai-sixty-four-character-limit',
        '6415270ed2d8147603f504ee756f5d658dfdb277685889ddd9c09d5a64579699',
      ],
    ])('%s when translating Anthropic metadata to OpenAI', async (_label, userId, expected) => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const resolveChatBody = jest.fn().mockResolvedValue({
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: userId },
      });

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { user_id: userId },
        },
        resolveChatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.safety_identifier).toBe(expected);
      expect(sentBody.metadata).toBeUndefined();
      expect(sentBody.store).toBeUndefined();
    });

    it.each([
      ['an empty user ID', { user_id: '' }],
      ['no metadata object', undefined],
    ])('drops Anthropic metadata with %s', async (_label, metadata) => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          metadata,
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'hi' }],
          metadata,
        }),
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.metadata).toBeUndefined();
      expect(sentBody.safety_identifier).toBeUndefined();
    });

    it('translates adaptive Anthropic thinking to the OpenAI default reasoning effort', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const chatBody = {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      };

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5.6-sol',
        body: { model: 'gpt-5.6-sol', ...chatBody },
        resolveChatBody: async () => chatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).not.toHaveProperty('thinking');
      expect(sentBody).not.toHaveProperty('reasoning_effort');
    });

    it('translates disabled Anthropic thinking to reasoning_effort none for a reasoning model', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const reasoningClient = new ProviderClient(undefined, undefined, undefined, {
        isReasoningModel: () => true,
      } as unknown as ModelsDevReasoningCatalog);
      const chatBody = {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
      };

      await reasoningClient.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5.6-sol',
        body: { model: 'gpt-5.6-sol', ...chatBody },
        resolveChatBody: async () => chatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).not.toHaveProperty('thinking');
      expect(sentBody.reasoning_effort).toBe('none');
    });

    it('drops disabled Anthropic thinking without an effort tier for a non-reasoning model', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const chatBody = {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
      };

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: { model: 'gpt-4o', ...chatBody },
        resolveChatBody: async () => chatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).not.toHaveProperty('thinking');
      expect(sentBody).not.toHaveProperty('reasoning_effort');
    });

    it('leaves a caller-sent thinking param alone outside messages mode', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5.6-sol',
        body: {
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'adaptive' },
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.thinking).toEqual({ type: 'adaptive' });
    });

    it('forwards Anthropic-Messages inbound to an Anthropic upstream without OpenAI translation (issue #1886)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const anthropicBody = {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'find cats' }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { name: 'my_custom', input_schema: { type: 'object' } },
        ],
        top_k: 40,
        metadata: { user_id: 'anthropic-user' },
      };
      // This is what the routing layer would derive. Pass it as a resolver to
      // prove the native wire path never asks for it.
      const lossyChatBody = {
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'find cats' },
        ],
        tools: [
          { type: 'function', function: { name: 'web_search' } },
          { type: 'function', function: { name: 'my_custom', parameters: { type: 'object' } } },
        ],
        max_tokens: 1024,
      };
      const resolveChatBody = jest.fn().mockResolvedValue(lossyChatBody);

      const result = await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        body: anthropicBody,
        resolveChatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Server tool keeps its `type` discriminator — the bug from #1886.
      expect(sent.tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
      expect(sent.tools[0]).not.toHaveProperty('input_schema');
      // Custom tool keeps input_schema.
      expect(sent.tools[1]).toMatchObject({
        name: 'my_custom',
        input_schema: { type: 'object' },
      });
      // cache_control breakpoint lands on the last tool, as Anthropic expects.
      expect(sent.tools[1].cache_control).toEqual({ type: 'ephemeral' });
      // Anthropic-only fields survive verbatim.
      expect(sent.top_k).toBe(40);
      expect(sent.metadata).toEqual({ user_id: 'anthropic-user' });
      // System was promoted to a block array and got the cache_control breakpoint.
      expect(sent.system).toEqual([
        { type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } },
      ]);
      // Inbound body untouched (no surprise mutations).
      expect((anthropicBody.tools[1] as Record<string, unknown>).cache_control).toBeUndefined();
      expect(result.wireApiMode).toBe('messages');
      expect(result.wireRequestBody).toEqual(sent);
      expect(resolveChatBody).not.toHaveBeenCalled();
    });

    it('drops Anthropic provider-defined tools when forwarding Messages to a chat-completions provider (issue #2754)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const anthropicBody = {
        model: 'MiniMax-M2',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'find cats' }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { type: 'bash_20250124', name: 'bash' },
          {
            name: 'lookup',
            input_schema: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
        tool_choice: { type: 'tool', name: 'web_search' },
      };
      // What the routing layer derives from `anthropicBody` before forwarding.
      const chatBody = {
        model: 'MiniMax-M2',
        messages: [{ role: 'user', content: 'find cats' }],
        tools: [
          { type: 'function', function: { name: 'web_search' } },
          { type: 'function', function: { name: 'bash' } },
          { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
        ],
        tool_choice: { type: 'function', function: { name: 'web_search' } },
      };

      await client.forward({
        provider: 'minimax',
        apiKey: 'sk-test',
        model: 'MiniMax-M2',
        body: anthropicBody,
        resolveChatBody: jest.fn().mockResolvedValue(chatBody),
        stream: false,
        apiMode: 'messages',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Only the client tool the provider can actually run survives.
      expect(sent.tools).toEqual([
        { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
      ]);
      // tool_choice pinned to a dropped tool is relaxed to auto.
      expect(sent.tool_choice).toBe('auto');
    });

    it('omits the tools array entirely when every Anthropic tool is provider-executed', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const anthropicBody = {
        model: 'MiniMax-M2',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'find cats' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'any' },
      };
      const chatBody = {
        model: 'MiniMax-M2',
        messages: [{ role: 'user', content: 'find cats' }],
        tools: [{ type: 'function', function: { name: 'web_search' } }],
        tool_choice: 'required',
      };

      await client.forward({
        provider: 'minimax',
        apiKey: 'sk-test',
        model: 'MiniMax-M2',
        body: anthropicBody,
        resolveChatBody: jest.fn().mockResolvedValue(chatBody),
        stream: false,
        apiMode: 'messages',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent).not.toHaveProperty('tools');
      expect(sent.tool_choice).toBe('auto');
    });

    it('still uses toAnthropicRequest for chat_completions inbound forwarded to an Anthropic upstream', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        body: {
          model: 'claude-sonnet-4-5-20250929',
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'hi' },
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'lookup', parameters: { type: 'object' } },
            },
          ],
          max_tokens: 256,
        },
        stream: false,
        apiMode: 'chat_completions',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Translation happened: system pulled out of messages, function tool
      // re-emitted as Anthropic `{ name, input_schema }` shape.
      expect(sent.system[0].text).toBe('Be concise.');
      expect(sent.tools[0]).toMatchObject({ name: 'lookup', input_schema: { type: 'object' } });
    });

    it('returns structured-output metadata for Responses requests routed to Anthropic', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const schema = { type: 'object', properties: { title: { type: 'string' } } };

      const result = await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        body: {
          input: 'Return JSON.',
          text: {
            format: {
              type: 'json_schema',
              name: 'patient_summary',
              description: 'Patient summary',
              schema,
              strict: true,
            },
          },
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Return JSON.' }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'patient_summary',
              description: 'Patient summary',
              schema,
              strict: true,
            },
          },
        }),
        stream: false,
        apiMode: 'responses',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.tool_choice).toBeUndefined();
      expect(sent.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            additionalProperties: false,
          },
        },
      });
      expect(result.structuredOutputToolName).toBeUndefined();
      expect(result.responsesTextFormat).toEqual({
        type: 'json_schema',
        name: 'patient_summary',
        description: 'Patient summary',
        schema,
        strict: true,
      });
    });

    it('returns json_object text metadata for Responses requests routed to Anthropic', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        body: {
          input: 'Return JSON.',
          text: { format: { type: 'json_object' } },
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Return JSON.' }],
          response_format: { type: 'json_object' },
        }),
        stream: false,
        apiMode: 'responses',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.tool_choice).toBeUndefined();
      expect(sent.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: { type: 'object', additionalProperties: false },
        },
      });
      expect(result.structuredOutputToolName).toBeUndefined();
      expect(result.responsesTextFormat).toEqual({ type: 'json_object' });
    });

    it('does not attach structured metadata for text Responses formats routed to Anthropic', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        body: {
          input: 'Return text.',
          text: { format: { type: 'text' } },
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Return text.' }],
          response_format: { type: 'text' },
        }),
        stream: false,
        apiMode: 'responses',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.tool_choice).toBeUndefined();
      expect(result.structuredOutputToolName).toBeUndefined();
      expect(result.responsesTextFormat).toBeUndefined();
    });

    it('forwards Responses image inputs to Anthropic image content blocks', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        body: {
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'What is in this image?' },
                { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
              ],
            },
          ],
          stream: false,
        },
        resolveChatBody: async () => ({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is in this image?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              ],
            },
          ],
          stream: false,
        }),
        stream: false,
        apiMode: 'responses',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.input).toBeUndefined();
      expect(sent.messages[0].content).toEqual([
        { type: 'text', text: 'What is in this image?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
      ]);
    });

    it('strips Codex-unsupported params on the subscription Responses path', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5.4-mini',
        body: {
          input: 'Hello',
          stream: false,
          temperature: 0.3,
          top_p: 0.5,
          max_output_tokens: 50,
          metadata: { x: '1' },
          safety_identifier: 'probe',
          prompt_cache_retention: '24h',
          truncation: 'auto',
          store: true,
        },
        stream: false,
        authType: 'subscription',
        apiMode: 'responses',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent).not.toHaveProperty('temperature');
      expect(sent).not.toHaveProperty('top_p');
      expect(sent).not.toHaveProperty('max_output_tokens');
      expect(sent).not.toHaveProperty('metadata');
      expect(sent).not.toHaveProperty('safety_identifier');
      expect(sent).not.toHaveProperty('prompt_cache_retention');
      expect(sent).not.toHaveProperty('truncation');
      expect(sent.store).toBe(false);
    });

    it('keeps Codex-unsupported params for the openai-responses (api-key) path', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'codex-mini-latest',
        body: { input: 'Hello', temperature: 0.3, max_output_tokens: 50 },
        stream: false,
        apiMode: 'responses',
      });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.temperature).toBe(0.3);
      expect(sent.max_output_tokens).toBe(50);
    });

    it('uses normalized chat body for non-native Responses providers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        body: { input: 'Hello', stream: false },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
        stream: false,
        apiMode: 'responses',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.deepseek.com/v1/chat/completions',
        expect.any(Object),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(sentBody.input).toBeUndefined();
      expect(result.isResponses).toBe(false);
    });
  });

  describe('Anthropic provider', () => {
    it('uses native Messages API path and x-api-key header', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'x-api-key': 'sk-ant-test',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
        }),
      );

      expect(result.isAnthropic).toBe(true);
      expect(result.isGoogle).toBe(false);
    });

    it('does not include anthropic-beta header (caching is GA)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
        body,
        stream: false,
      });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('includes automatic cache_control in Anthropic API-key requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-4-20250514',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('converts request body to Anthropic format with model', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-4-20250514',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('claude-sonnet-4-20250514');
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.max_tokens).toBeDefined();
      // toAnthropicRequest correctly maps temperature from the original body
      expect(sentBody.temperature).toBe(0.7);
    });

    it('replays cached thinking only for a compatible Anthropic route context', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const thinkingBlock = {
        type: 'thinking',
        thinking: 'cached reasoning',
        signature: 'sig_cached',
      };
      const cache = new ThinkingBlockCache();
      cache.store('sess-1', 'toolu_first', [thinkingBlock], {
        provider: 'anthropic',
        authType: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });
      const thinkingLookup = jest.fn(
        (firstToolUseId: string, routeContext?: ThinkingBlockRouteContext) =>
          cache.retrieve('sess-1', firstToolUseId, routeContext),
      );
      const continuationBody = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'toolu_first',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"cats"}' },
              },
            ],
          },
        ],
      };

      await client.forward({
        provider: 'anthropic',
        apiKey: 'oauth-token',
        model: 'claude-opus-4-1-20250805',
        body: continuationBody,
        stream: false,
        authType: 'subscription',
        thinkingLookup,
      });

      await client.forward({
        provider: 'anthropic',
        apiKey: 'oauth-token',
        model: 'claude-sonnet-4-5-20250929',
        body: continuationBody,
        stream: false,
        authType: 'subscription',
        thinkingLookup,
      });

      const firstSent = JSON.parse(mockFetch.mock.calls[0][1].body);
      const firstContent = firstSent.messages[0].content as Array<Record<string, unknown>>;
      expect(firstContent.some((block) => block.type === 'thinking')).toBe(false);

      const secondSent = JSON.parse(mockFetch.mock.calls[1][1].body);
      const secondContent = secondSent.messages[0].content as Array<Record<string, unknown>>;
      expect(secondContent[0]).toEqual(thinkingBlock);
      expect(secondContent[1]).toMatchObject({ type: 'tool_use', id: 'toolu_first' });
      expect(thinkingLookup).toHaveBeenNthCalledWith(1, 'toolu_first', {
        provider: 'anthropic',
        authType: 'subscription',
        model: 'claude-opus-4-1-20250805',
      });
      expect(thinkingLookup).toHaveBeenNthCalledWith(2, 'toolu_first', {
        provider: 'anthropic',
        authType: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });
    });

    it('sets stream=true in body when streaming', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-4-20250514',
        body,
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream).toBe(true);
    });

    it('does not set stream when not streaming', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-4-20250514',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream).toBeUndefined();
    });

    it('injects automatic and block-level cache_control for subscription auth', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithSystem = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        tools: [{ type: 'function', function: { name: 'search', description: 'Search' } }],
      };

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-oat-token',
        model: 'claude-sonnet-4-20250514',
        body: bodyWithSystem,
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toEqual({ type: 'ephemeral' });
      const system = sentBody.system as Array<{ text?: string; cache_control?: unknown }>;
      // First system block is the subscription identity prompt
      expect(system[0].text).toContain('Claude agent');
      expect(system[0].cache_control).toBeUndefined();
      // The OAuth API accepts cache_control (the #1193 400s were caused by the
      // missing identity block, not caching), so subscription auth gets the
      // same breakpoints as API-key auth.
      expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
      const tools = sentBody.tools as Array<{ cache_control?: unknown }>;
      expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('includes automatic and block-level cache_control for regular Anthropic API key auth', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithSystem = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        tools: [{ type: 'function', function: { name: 'search', description: 'Search' } }],
      };

      await client.forward({
        provider: 'anthropic',
        apiKey: 'sk-ant-key',
        model: 'claude-sonnet-4-20250514',
        body: bodyWithSystem,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toEqual({ type: 'ephemeral' });
      const system = sentBody.system as Array<{ cache_control?: unknown }>;
      expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
      const tools = sentBody.tools as Array<{ cache_control?: unknown }>;
      expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('Google provider', () => {
    it('uses x-goog-api-key header and keeps key out of URL', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(url).toContain('gemini-2.0-flash:generateContent');
      expect(url).not.toContain('key=AIza-test');
      expect(url).not.toContain('alt=sse');
      expect(init.headers['x-goog-api-key']).toBe('AIza-test');
      expect(result.isGoogle).toBe(true);
      expect(result.isAnthropic).toBe(false);
      expect(result.wireApiMode).toBeUndefined();
      expect(result.wireFormat).toBe('google_generate_content');
      expect(result.wireRequestUrl).toBe(url);
      expect(result.wireRequestBody).toEqual(JSON.parse(mockFetch.mock.calls[0][1].body));
    });

    it('adds alt=sse for streaming', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body,
        stream: true,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('alt=sse');
    });

    it('converts request body to Gemini format', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.contents).toBeDefined();
      // Should not have OpenAI-style fields
      expect(sentBody.model).toBeUndefined();
      expect(sentBody.stream).toBeUndefined();
    });

    it('resolves a Responses conversion once for a Gemini endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const resolveChatBody = jest
        .fn()
        .mockResolvedValue({ messages: [{ role: 'user', content: 'Hello' }] });

      await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body: { input: 'Hello' },
        resolveChatBody,
        apiMode: 'responses',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
      expect(resolveChatBody).toHaveBeenCalledTimes(1);
    });

    it('maps image parts onto the Google request body', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this.' },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
                },
              ],
            },
          ],
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.contents[0].parts).toEqual([
        { text: 'Describe this.' },
        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
      ]);
    });
  });

  describe('ChatGPT subscription provider', () => {
    it('routes to chatgpt.com Codex backend with subscription authType', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5',
        body,
        stream: false,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(result.isChatGpt).toBe(true);
      expect(result.isGoogle).toBe(false);
      expect(result.isAnthropic).toBe(false);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['originator']).toBe('codex_cli_rs');
      expect(headers['Authorization']).toBe('Bearer oauth-token');
    });

    it('converts request body using toResponsesRequest', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithSystem = {
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      };
      await client.forward({
        provider: 'openai',
        apiKey: 'token',
        model: 'gpt-5.3-codex',
        body: bodyWithSystem,
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.instructions).toBe('Be helpful.');
      expect(sentBody.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ]);
      expect(sentBody.model).toBe('gpt-5.3-codex');
      expect(sentBody.stream).toBe(true);
      expect(sentBody.store).toBe(false);
    });

    it('forces upstream streaming when the caller sends stream:false (#2706)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5.6-sol',
        body: { ...body, stream: false },
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream).toBe(true);
    });

    it('sends default instructions when no system or developer prompt is present', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'token',
        model: 'gpt-5.1-codex-mini',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.instructions).toBe('You are a helpful assistant.');
    });

    it('maps reasoning_effort onto the Responses reasoning object with summary auto', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'token',
        model: 'gpt-5.6-sol',
        body: { messages: [{ role: 'user', content: 'Hello' }], reasoning_effort: 'xhigh' },
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    });

    it('translates disabled Anthropic thinking to Responses reasoning none', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const reasoningClient = new ProviderClient(undefined, undefined, undefined, {
        isReasoningModel: () => true,
      } as unknown as ModelsDevReasoningCatalog);
      const chatBody = {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
      };

      await reasoningClient.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'o1-pro',
        body: {
          model: 'o1-pro',
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'disabled' },
        },
        resolveChatBody: async () => chatBody,
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.reasoning).toEqual({ effort: 'none' });
      expect(sentBody).not.toHaveProperty('thinking');
    });

    it('does not translate disabled Anthropic thinking to Responses for a non-reasoning model', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'o1-pro',
        body: {
          model: 'o1-pro',
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'disabled' },
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'disabled' },
        }),
        stream: false,
        apiMode: 'messages',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).not.toHaveProperty('reasoning');
      expect(sentBody).not.toHaveProperty('thinking');
    });

    it('sets isChatGpt=false for regular OpenAI api_key auth', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
      });

      expect(result.isChatGpt).toBe(false);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('api.openai.com');
    });

    it('rejects an HTTP 200 Codex stream that completes without output', async () => {
      mockFetch.mockResolvedValue(
        new Response('event: response.completed\ndata: {"response":{"output":[]}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5',
        body,
        stream: true,
        authType: 'subscription',
      });

      expect(result.response.status).toBe(502);
      await expect(result.response.json()).resolves.toMatchObject({
        error: { code: 'empty_response' },
      });
    });

    it('does not apply Codex stream qualification to API-key Responses requests', async () => {
      const upstream = new Response('{"output":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      mockFetch.mockResolvedValue(upstream);

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
      });

      expect(result.response).toBe(upstream);
      expect(result.response.status).toBe(200);
    });
  });

  describe('resolveEndpoint - OpenAI Responses-only routing', () => {
    // When a user authenticates with a normal OpenAI API key but requests
    // a Codex / -pro / o1-pro / deep-research model, OpenAI rejects the call
    // on /v1/chat/completions. The proxy transparently swaps to /v1/responses.
    const responsesOnlyModels = [
      'gpt-5.3-codex',
      'gpt-5-codex',
      'gpt-5.1-codex-mini',
      'gpt-5.2-codex',
    ];

    it.each(responsesOnlyModels)(
      'routes api_key + Codex model %s to /v1/responses with chatgpt format',
      async (model) => {
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        const result = await client.forward({
          provider: 'openai',
          apiKey: 'sk-test',
          model,
          body,
          stream: false,
        });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toBe('https://api.openai.com/v1/responses');
        expect(result.isChatGpt).toBe(true);
        expect(result.isAnthropic).toBe(false);
        expect(result.isGoogle).toBe(false);

        // Plain openaiHeaders — Bearer + Content-Type only, no Codex CLI spoof.
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer sk-test');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['originator']).toBeUndefined();

        // Body is Responses-API shape (input/store/instructions), not Chat Completions.
        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(Array.isArray(sentBody.input)).toBe(true);
        expect(sentBody.store).toBe(false);
        expect(sentBody.instructions).toBeDefined();
        expect(sentBody.messages).toBeUndefined();
        expect(sentBody.model).toBe(model);
      },
    );

    const proModels = ['gpt-5-pro', 'gpt-5.2-pro', 'gpt-5.4-pro'];

    it.each(proModels)('routes api_key + %s to /v1/responses', async (model) => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model,
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(result.isChatGpt).toBe(true);
    });

    it('routes api_key + o1-pro to /v1/responses', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'o1-pro',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(result.isChatGpt).toBe(true);
    });

    it.each(['o3-deep-research', 'o4-mini-deep-research'])(
      'routes already-resolved api_key + %s to /v1/responses',
      async (model) => {
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        const result = await client.forward({
          provider: 'openai',
          apiKey: 'sk-test',
          model,
          body,
          stream: false,
        });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toBe('https://api.openai.com/v1/responses');
        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(sentBody.stream).toBe(false);
        expect(result.isChatGpt).toBe(true);
      },
    );

    it('detects Responses-only models after stripping an OpenRouter-style vendor prefix', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'openai/gpt-5.3-codex',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.openai.com/v1/responses');

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Vendor prefix is stripped before being sent to OpenAI.
      expect(sentBody.model).toBe('gpt-5.3-codex');
    });

    it('detects already-resolved o3-deep-research after stripping an OpenRouter-style vendor prefix', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'openai/o3-deep-research',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.openai.com/v1/responses');

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('o3-deep-research');
    });

    // Regression guard: models that DO support /v1/chat/completions must stay
    // on the default OpenAI endpoint — we must not over-match the regex.
    const chatCompatibleModels = [
      'gpt-5',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-5-chat-latest',
      'codex-mini-latest',
    ];

    it.each(chatCompatibleModels)('leaves api_key + %s on /v1/chat/completions', async (model) => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model,
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(result.isChatGpt).toBe(false);

      // Body is Chat Completions shape (messages array, not input array).
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.input).toBeUndefined();
      expect(sentBody.store).toBeUndefined();
    });

    it('keeps subscription + Codex on the Codex backend (subscription override wins)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      // Must stay on chatgpt.com/backend-api (subscription), NOT swap to api.openai.com.
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(url).not.toContain('api.openai.com');
      expect(result.isChatGpt).toBe(true);

      // Subscription spoofs the Codex CLI user agent; the api_key responses
      // path does not. This confirms we hit the subscription endpoint.
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['originator']).toBe('codex_cli_rs');
    });

    it('does not override custom endpoints when a Codex model is used through a custom provider', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const customEndpoint = {
        baseUrl: 'https://proxy.example.com/v1',
        buildHeaders: (key: string) => ({
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        }),
        buildPath: () => '/chat/completions',
        format: 'openai' as const,
      };

      const result = await client.forward({
        provider: 'custom:some-uuid',
        apiKey: 'sk-custom',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
        customEndpoint,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      // customEndpoint short-circuits resolveEndpoint — the Responses-only
      // branch must not fire and rewrite the URL to api.openai.com.
      expect(url).toBe('https://proxy.example.com/v1/chat/completions');
      expect(url).not.toContain('api.openai.com');
      expect(result.isChatGpt).toBe(false);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Still Chat Completions shape — the custom endpoint is openai format.
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.input).toBeUndefined();
    });
  });

  describe('resolveEndpoint - Copilot Responses-only routing (mnfst/manifest#1849)', () => {
    // GitHub Copilot serves Codex variants only at /responses; /chat/completions
    // returns "Unsupported API for model". Mirrors the OpenAI Responses-only swap.
    const copilotResponsesOnlyModels = [
      'gpt-5-codex',
      'gpt-5.2-codex',
      'gpt-5.3-codex',
      'gpt-5.1-codex-mini',
    ];
    const createClientWithCopilotMetadata = (models: Record<string, readonly string[]>) => {
      const registry: Pick<ProviderModelRegistryService, 'getModelMetadata'> = {
        getModelMetadata: jest.fn((provider: string, model: string) => {
          if (provider !== 'copilot') return null;
          const endpoints = models[model.toLowerCase()];
          return endpoints ? { id: model.toLowerCase(), supportedEndpoints: endpoints } : null;
        }),
      };
      return new ProviderClient(undefined, registry as unknown as ProviderModelRegistryService);
    };

    it.each(copilotResponsesOnlyModels)(
      'routes Copilot + Codex model %s to /responses with chatgpt format',
      async (model) => {
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        const result = await client.forward({
          provider: 'copilot',
          apiKey: 'tid=abc',
          model,
          body,
          stream: false,
        });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toBe('https://api.githubcopilot.com/responses');
        expect(result.isChatGpt).toBe(true);

        // Copilot headers preserved (Editor-Version etc.).
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer tid=abc');
        expect(headers['Copilot-Integration-Id']).toBe('vscode-chat');
        expect(headers['Editor-Version']).toBeDefined();

        // Body is Responses-API shape (input/store/instructions), not Chat Completions.
        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(Array.isArray(sentBody.input)).toBe(true);
        expect(sentBody.store).toBe(false);
        expect(sentBody.instructions).toBeDefined();
        expect(sentBody.messages).toBeUndefined();
        expect(sentBody.model).toBe(model);
      },
    );

    it('routes Copilot chat input to /responses when supported_endpoints excludes chat', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const metadataClient = createClientWithCopilotMetadata({
        'copilot/gpt-5.5': ['/responses', 'ws:/responses'],
      });

      const result = await metadataClient.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5.5',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.githubcopilot.com/responses');
      expect(result.isChatGpt).toBe(true);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(Array.isArray(sentBody.input)).toBe(true);
      expect(sentBody.messages).toBeUndefined();
      expect(sentBody.model).toBe('gpt-5.5');
    });

    it('keeps Copilot chat input on /chat/completions when chat is supported', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const metadataClient = createClientWithCopilotMetadata({
        'copilot/gpt-5.4': ['/responses', '/chat/completions', 'ws:/responses'],
      });

      const result = await metadataClient.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5.4',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.githubcopilot.com/chat/completions');
      expect(result.isChatGpt).toBe(false);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.input).toBeUndefined();
    });

    it('routes Copilot Responses input to /responses when supported', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const metadataClient = createClientWithCopilotMetadata({
        'copilot/gpt-5.4': ['/responses', '/chat/completions'],
      });

      const result = await metadataClient.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5.4',
        body: { input: 'Hello', stream: false },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
        stream: false,
        apiMode: 'responses',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.githubcopilot.com/responses');
      expect(result.isResponses).toBe(true);
    });

    it('routes Copilot Responses input to /chat/completions when only chat is supported', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const metadataClient = createClientWithCopilotMetadata({
        'copilot/claude-sonnet-4.6': ['/chat/completions', '/v1/messages'],
      });

      const result = await metadataClient.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'claude-sonnet-4.6',
        body: { input: 'Hello', stream: false },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
        stream: false,
        apiMode: 'responses',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.githubcopilot.com/chat/completions');
      expect(result.isChatGpt).toBe(false);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.input).toBeUndefined();
    });

    it('preserves reasoning and text params when converting Copilot Codex requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5.2-codex',
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          reasoning: { effort: 'high', summary: 'concise' },
          text: { verbosity: 'low' },
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.reasoning).toEqual({ effort: 'high', summary: 'concise' });
      expect(sentBody.text).toEqual({ verbosity: 'low' });
    });

    it('leaves non-Codex Copilot models on /chat/completions', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-4o',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.githubcopilot.com/chat/completions');
      expect(result.isChatGpt).toBe(false);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.input).toBeUndefined();
    });

    it('forces upstream stream:true so the SSE collector can normalise the response', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5.3-codex',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream).toBe(true);
    });

    it('overrides explicit stream:false from caller for copilot-responses', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5.3-codex',
        body: { ...body, stream: false },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Forced upstream so handleNonStreamResponse's SSE collector remains
      // the single source of truth — see mnfst/manifest#1849.
      expect(sentBody.stream).toBe(true);
    });

    it('maps max_tokens to max_output_tokens for Copilot Codex requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'copilot',
        apiKey: 'tid=abc',
        model: 'gpt-5-codex',
        body: { ...body, max_tokens: 2048 },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_output_tokens).toBe(2048);
      expect(sentBody.max_tokens).toBeUndefined();
    });

    it('maps max_tokens to max_output_tokens for OpenAI Codex (api-key) requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-5.3-codex',
        body: { ...body, max_tokens: 1024 },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_output_tokens).toBe(1024);
      expect(sentBody.max_tokens).toBeUndefined();
    });

    it('does NOT map max_tokens to max_output_tokens for ChatGPT subscription', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'oauth-token',
        model: 'gpt-5.3-codex',
        body: { ...body, max_tokens: 1024 },
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // ChatGPT subscription backend rejects max_output_tokens with
      // `unsupported_parameter`; never forward it on this path.
      expect(sentBody.max_output_tokens).toBeUndefined();
    });
  });

  describe('Z.ai subscription provider', () => {
    it('routes to Coding Plan endpoint with subscription authType', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'zai',
        apiKey: 'zai-sub-key',
        model: 'glm-5.1',
        body,
        stream: false,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer zai-sub-key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('routes to standard Z.ai endpoint for api_key auth', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'zai',
        apiKey: 'zai-key',
        model: 'glm-4.7',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    });
  });

  describe('Kimi Coding Plan subscription provider', () => {
    it('routes Moonshot subscription auth to Kimi Code Anthropic endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'moonshot',
        apiKey: 'kimi-code-key',
        model: 'kimi-for-coding',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.kimi.com/coding/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'x-api-key': 'kimi-code-key',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
        }),
      );

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('kimi-for-coding');
      expect(sentBody.stream).toBeUndefined();
      expect(sentBody.system).toBeUndefined();
      expect(result.isAnthropic).toBe(true);
    });

    it('maps max_completion_tokens to the Kimi Code Anthropic wire field', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'moonshot',
        apiKey: 'kimi-code-key',
        model: 'k3',
        body: { ...body, max_completion_tokens: 123 },
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('k3');
      expect(sentBody.max_tokens).toBe(123);
      expect(sentBody.max_completion_tokens).toBeUndefined();
    });

    it('keeps standard Moonshot API-key auth on the Moonshot OpenAI endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'moonshot',
        apiKey: 'sk-moon',
        model: 'kimi-k2',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
    });
  });

  describe('Qwen Token Plan subscription provider', () => {
    it('routes Qwen subscription auth to the Token Plan chat endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'qwen',
        apiKey: 'sk-sp-token-plan-key',
        model: 'qwen3.6-plus',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk-sp-token-plan-key',
            'Content-Type': 'application/json',
          },
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('qwen3.6-plus');
    });

    it('routes qwen3.7-max through the Token Plan Responses endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'qwen',
        apiKey: 'sk-sp-token-plan-key',
        model: 'qwen3.7-max',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses',
        expect.any(Object),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('qwen3.7-max');
      expect(sentBody.input).toBeDefined();
      expect(sentBody.messages).toBeUndefined();
      expect(result.isChatGpt).toBe(true);
    });

    it('routes inbound Responses API requests through the Token Plan Responses endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'qwen',
        apiKey: 'sk-sp-token-plan-key',
        model: 'qwen3.7-max',
        body: {
          input: [{ role: 'user', content: 'Hello' }],
          stream: false,
        },
        resolveChatBody: async () => ({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: false,
        }),
        stream: false,
        authType: 'subscription',
        apiMode: 'responses',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses',
        expect.any(Object),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('qwen3.7-max');
      expect(sentBody.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ]);
      expect(result.isResponses).toBe(true);
    });
  });

  describe('Xiaomi MiMo Token Plan subscription provider', () => {
    it('routes Xiaomi subscription auth to the Token Plan chat endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xiaomi',
        apiKey: 'tp-mimo-token',
        model: 'mimo-v2.5-pro',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer tp-mimo-token',
            'Content-Type': 'application/json',
          },
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('mimo-v2.5-pro');
    });
  });

  describe('Kilo API-key provider', () => {
    it('routes to the Kilo Gateway and preserves provider-prefixed model IDs', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'kilo',
        apiKey: 'kilo-token',
        model: 'anthropic/claude-sonnet-4.5',
        body,
        stream: false,
        authType: 'api-key',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.kilo.ai/api/gateway/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer kilo-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('anthropic/claude-sonnet-4.5');
    });

    it('preserves kilo-auto virtual model IDs', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'kilo',
        apiKey: 'kilo-token',
        model: 'kilo-auto/frontier',
        body,
        stream: false,
        authType: 'api-key',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('kilo-auto/frontier');
    });
  });

  describe('Kiro subscription provider', () => {
    it('routes to the Kiro AWS JSON event-stream endpoint', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );

      const result = await client.forward({
        provider: 'kiro',
        apiKey: 'ksk_test',
        model: 'kiro/auto',
        body,
        stream: true,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://q.us-east-1.amazonaws.com',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer ksk_test',
            'Content-Type': 'application/x-amz-json-1.0',
            'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
            'x-amzn-kiro-agent-mode': 'SUPERVISED',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.conversationState.currentMessage.userInputMessage).toMatchObject({
        content: 'Hello',
        origin: 'KIRO_CLI',
        modelId: 'auto',
      });
      expect(result.isGoogle).toBe(false);
      expect(result.isAnthropic).toBe(false);
      expect(result.isChatGpt).toBe(false);
      expect(result.response.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('converts Responses input once before forwarding to Kiro', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );
      const resolveChatBody = jest
        .fn()
        .mockResolvedValue({ messages: [{ role: 'user', content: 'Hello from Responses' }] });

      await client.forward({
        provider: 'kiro',
        apiKey: 'ksk_test',
        model: 'kiro/auto',
        body: { input: 'Hello from Responses' },
        resolveChatBody,
        stream: true,
        authType: 'subscription',
        apiMode: 'responses',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.conversationState.currentMessage.userInputMessage.content).toBe(
        'Hello from Responses',
      );
      expect(resolveChatBody).toHaveBeenCalledTimes(1);
    });

    it('forwards tools and returns Kiro tool calls end to end', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                kiroEventFrame('toolUseEvent', {
                  toolUseId: 'call_1',
                  name: 'bash',
                  input: '{"command":"ls"}',
                  stop: true,
                }),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );

      const result = await client.forward({
        provider: 'kiro',
        apiKey: 'ksk_test',
        model: 'kiro/auto',
        body: {
          messages: [
            { role: 'user', content: 'List files' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'bash', arguments: '{"command":"ls"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'bash',
                parameters: {
                  type: 'object',
                  properties: { command: { type: 'string' } },
                  additionalProperties: false,
                },
              },
            },
          ],
        },
        stream: true,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.conversationState.history).toEqual([
        { userInputMessage: { content: 'List files', origin: 'KIRO_CLI' } },
        {
          assistantResponseMessage: {
            content: '...',
            toolUses: [{ toolUseId: 'call_1', name: 'bash', input: { command: 'ls' } }],
          },
        },
      ]);
      const current = sentBody.conversationState.currentMessage.userInputMessage;
      expect(current.userInputMessageContext.tools).toEqual([
        {
          toolSpecification: {
            name: 'bash',
            description: 'Tool: bash',
            inputSchema: {
              json: {
                type: 'object',
                properties: { command: { type: 'string' } },
              },
            },
          },
        },
      ]);
      expect(current.userInputMessageContext.toolResults).toEqual([
        { toolUseId: 'call_1', status: 'success', content: [{ text: 'a.txt' }] },
      ]);

      const text = await result.response.text();
      expect(text).toContain('"id":"call_1"');
      expect(text).toContain('"name":"bash"');
      expect(text).toContain('"finish_reason":"tool_calls"');
    });
  });

  describe('OpenCode Go provider', () => {
    it('routes non-minimax models to OpenAI /v1/chat/completions', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/glm-5.1',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer og-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Model prefix is stripped before forwarding
      expect(sentBody.model).toBe('glm-5.1');
      expect(result.isAnthropic).toBe(false);
      expect(result.isChatGpt).toBe(false);
    });

    it('routes minimax-* models to Anthropic /v1/messages', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/minimax-m2.7',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'og-token',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('minimax-m2.7');
      expect(sentBody.cache_control).toBeUndefined();
      expect(result.isAnthropic).toBe(true);
    });

    it('also routes minimax-m2.5 to the Anthropic endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/minimax-m2.5',
        body,
        stream: false,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://opencode.ai/zen/go/v1/messages');
    });

    it('routes qwen3.7 models to Anthropic /v1/messages', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/qwen3.7-max',
        body,
        stream: true,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'og-token',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('qwen3.7-max');
      expect(sentBody.stream).toBe(true);
      expect(result.isAnthropic).toBe(true);
    });

    it('routes catalog-declared Anthropic models to /v1/messages', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const catalogClient = new ProviderClient({
        getFormat: jest.fn().mockReturnValue(null),
        resolveFormat: jest.fn().mockResolvedValue('anthropic'),
      } as any);

      await catalogClient.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/future-model',
        body,
        stream: true,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://opencode.ai/zen/go/v1/messages');
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('future-model');
    });

    it('routes catalog-declared Responses models to /v1/responses with chatgpt conversion', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const catalogClient = new ProviderClient({
        getFormat: jest.fn().mockReturnValue(null),
        resolveFormat: jest.fn().mockResolvedValue('responses'),
      } as any);

      const result = await catalogClient.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/grok-4.5',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/responses',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer og-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('grok-4.5');
      // Body is Responses-API shape (input/store), not Chat Completions.
      expect(Array.isArray(sentBody.input)).toBe(true);
      expect(sentBody.store).toBe(false);
      expect(sentBody.messages).toBeUndefined();
      expect(sentBody.stream).toBe(false);
      expect(result.isChatGpt).toBe(true);
      expect(result.isAnthropic).toBe(false);
    });

    it('maps max_tokens to max_output_tokens for OpenCode Go Responses models', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const catalogClient = new ProviderClient({
        resolveFormat: jest.fn().mockResolvedValue('responses'),
      } as any);

      await catalogClient.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/gpt-5.6-luna',
        body: { ...body, max_tokens: 1536 },
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/responses',
        expect.any(Object),
      );
      expect(sentBody.max_output_tokens).toBe(1536);
      expect(sentBody.max_tokens).toBeUndefined();
    });

    it('forwards native Responses requests for OpenCode Go Responses models', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const catalogClient = new ProviderClient({
        resolveFormat: jest.fn().mockResolvedValue('responses'),
      } as any);

      const result = await catalogClient.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/grok-4.5',
        body: { input: 'Hello', max_output_tokens: 50 },
        stream: false,
        authType: 'subscription',
        apiMode: 'responses',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://opencode.ai/zen/go/v1/responses');
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('grok-4.5');
      expect(sentBody.input).toBe('Hello');
      expect(sentBody.max_output_tokens).toBe(50);
      expect(result.isResponses).toBe(true);
    });

    it('uses catalog format over family fallback when available', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const catalogClient = new ProviderClient({
        resolveFormat: jest.fn().mockResolvedValue('openai'),
      } as any);

      await catalogClient.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/minimax-experimental',
        body,
        stream: true,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('minimax-experimental');
    });

    it('keeps mimo models on the OpenAI-compatible endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/mimo-v2.5-pro',
        body,
        stream: true,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('mimo-v2.5-pro');
      expect(sentBody.stream).toBe(true);
    });

    it('routes kimi-k2.5 through the OpenAI endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'opencode-go',
        apiKey: 'og-token',
        model: 'opencode-go/kimi-k2.5',
        body,
        stream: false,
        authType: 'subscription',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('kimi-k2.5');
    });
  });

  describe('OpenCode Zen provider', () => {
    it.each([
      ['claude-opus-4-7', 'claude-opus-4-7'],
      ['gpt-5.5', 'gpt-5.5'],
      ['qwen3.6-plus', 'qwen3.6-plus'],
    ])(
      'routes %s through the unified /v1/chat/completions endpoint with Bearer auth',
      async (modelName, expectedSentModel) => {
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        const result = await client.forward({
          provider: 'opencode-zen',
          apiKey: 'oz-token',
          model: `opencode-zen/${modelName}`,
          body,
          stream: false,
        });

        expect(mockFetch).toHaveBeenCalledWith(
          'https://opencode.ai/zen/v1/chat/completions',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer oz-token',
              'Content-Type': 'application/json',
            }),
          }),
        );
        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(sentBody.model).toBe(expectedSentModel);
        expect(result.isAnthropic).toBe(false);
        expect(result.isChatGpt).toBe(false);
        expect(result.isGoogle).toBe(false);
      },
    );

    it('routes gemini-* models to the dedicated generateContent endpoint with x-goog-api-key auth', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'opencode-zen',
        apiKey: 'oz-token',
        model: 'opencode-zen/gemini-3-flash',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://opencode.ai/zen/v1/models/gemini-3-flash:generateContent',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-goog-api-key': 'oz-token',
          }),
        }),
      );
      expect(result.isGoogle).toBe(true);
    });
  });

  describe('Command Code provider', () => {
    it('routes non-Claude models through the Provider API chat completions endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'commandcode',
        apiKey: 'user_test',
        model: 'commandcode/deepseek/deepseek-v4-flash',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.commandcode.ai/provider/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer user_test',
            'Content-Type': 'application/json',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('deepseek/deepseek-v4-flash');
      expect(result.isAnthropic).toBe(false);
      expect(result.isChatGpt).toBe(false);
      expect(result.isGoogle).toBe(false);
    });

    it('routes Claude models through the Provider API messages endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'commandcode',
        apiKey: 'user_test',
        model: 'commandcode/claude-sonnet-4-6',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.commandcode.ai/provider/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'user_test',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('claude-sonnet-4-6');
      expect(sentBody.system).toBeUndefined();
      expect(result.isAnthropic).toBe(true);
    });
  });

  describe('BytePlus provider', () => {
    it('routes subscription traffic through the ModelArk Coding Plan messages endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'byteplus',
        apiKey: 'bp-token',
        model: 'ark-code-latest',
        body,
        stream: false,
        authType: 'subscription',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ark.ap-southeast.bytepluses.com/api/coding/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer bp-token',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('ark-code-latest');
      expect(sentBody.system).toBeUndefined();
      expect(result.isAnthropic).toBe(true);
    });
  });

  describe('convertChatGptResponse', () => {
    it('delegates to fromResponsesResponse', () => {
      const data = {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello' }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      };
      const result = client.convertChatGptResponse(data, 'gpt-5');

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('gpt-5');
      const choices = result.choices as { message: { content: string } }[];
      expect(choices[0].message.content).toBe('Hello');
    });
  });

  describe('createChatGptStreamTransformer', () => {
    it('converts output_text delta to chat completion chunk', () => {
      const chunk = 'event: response.output_text.delta\ndata: {"delta":"Hi"}';
      const result = client.createChatGptStreamTransformer('gpt-5')(chunk);

      expect(result).toContain('data: ');
      expect(result).toContain('"chat.completion.chunk"');
    });

    it('returns null for irrelevant events', () => {
      const result = client.createChatGptStreamTransformer('gpt-5')(
        'event: response.created\ndata: {}',
      );
      expect(result).toBeNull();
    });
  });

  describe('OpenRouter prompt cache injection', () => {
    it('injects cache_control for anthropic/ models on openrouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithSystem = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'anthropic/claude-sonnet-4-20250514',
        body: bodyWithSystem,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toEqual({ type: 'ephemeral' });
      const sysMsg = sentBody.messages[0];
      expect(Array.isArray(sysMsg.content)).toBe(true);
      expect(sysMsg.content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('injects cache_control for direct-routed anthropic models on openrouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithSystem = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: '~anthropic/claude-sonnet-4-20250514',
        body: bodyWithSystem,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toEqual({ type: 'ephemeral' });
      expect(sentBody.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('keeps caller-supplied OpenRouter automatic cache control', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const cacheControl = { type: 'ephemeral', ttl: '1h' };

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'anthropic/claude-sonnet-4-20250514',
        body: {
          cache_control: cacheControl,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toEqual(cacheControl);
    });

    it('does not exceed the Anthropic cache control cap on OpenRouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const cacheControl = { type: 'ephemeral' };

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'anthropic/claude-sonnet-4-20250514',
        body: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'one', cache_control: cacheControl },
                { type: 'text', text: 'two', cache_control: cacheControl },
                { type: 'text', text: 'three', cache_control: cacheControl },
                { type: 'text', text: 'four', cache_control: cacheControl },
              ],
            },
          ],
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.cache_control).toBeUndefined();
    });

    it('injects message cache_control for google models on openrouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithUserReference = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Large reference block' },
        ],
      };
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'google/gemini-2.5-pro',
        body: bodyWithUserReference,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[0].content).toBe('You are helpful.');
      expect(sentBody.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('injects message cache_control for qwen models on openrouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithUserReference = {
        messages: [{ role: 'user', content: 'Large reference block' }],
      };
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'qwen/qwen3-coder-plus',
        body: bodyWithUserReference,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does not inject cache_control for non-anthropic models on openrouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const bodyWithSystem = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'openai/gpt-4o',
        body: bodyWithSystem,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(typeof sentBody.messages[0].content).toBe('string');
    });
  });

  describe('Qwen prompt cache injection', () => {
    it('injects cache_control for native Qwen requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'qwen',
        apiKey: 'sk-qwen',
        model: 'qwen3-coder-plus',
        body: {
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Large reference block' },
          ],
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[0].content).toBe('You are helpful.');
      expect(sentBody.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('injects cache_control for Qwen Token Plan chat-completions requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'qwen',
        authType: 'subscription',
        apiKey: 'sk-sp-qwen',
        model: 'qwen3-coder-plus',
        body: {
          messages: [{ role: 'user', content: 'Large reference block' }],
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
      );
      expect(sentBody.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('resolveEndpoint - xAI Responses-only routing', () => {
    const multiAgentModels = ['grok-4.20-multi-agent', 'grok-4.20-multi-agent-0309'];

    it.each(multiAgentModels)(
      'routes xAI multi-agent model %s to /v1/responses with chatgpt conversion',
      async (model) => {
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

        const result = await client.forward({
          provider: 'xai',
          apiKey: 'sk-xai',
          model,
          body,
          stream: false,
        });

        expect(mockFetch).toHaveBeenCalledWith('https://api.x.ai/v1/responses', expect.any(Object));

        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(sentBody.model).toBe(model);
        expect(sentBody.input).toEqual([
          { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        ]);
        expect(sentBody.store).toBe(false);
        expect(sentBody.messages).toBeUndefined();
        expect(result.isChatGpt).toBe(true);
        expect(result.isResponses).toBe(false);
      },
    );

    it('detects xAI Responses-only models after stripping a vendor prefix', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'xai/grok-4.20-multi-agent-0309',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.x.ai/v1/responses');

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('grok-4.20-multi-agent-0309');
    });

    it('maps max_tokens to max_output_tokens for xAI multi-agent requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.20-multi-agent',
        body: { ...body, max_tokens: 1536 },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(mockFetch).toHaveBeenCalledWith('https://api.x.ai/v1/responses', expect.any(Object));
      expect(sentBody.max_output_tokens).toBe(1536);
      expect(sentBody.max_tokens).toBeUndefined();
    });

    it('adds prompt_cache_key to xAI Responses requests from the Manifest session', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.20-multi-agent',
        body,
        providerCacheKey: 'scoped-session-xai',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(sentBody.prompt_cache_key).not.toContain('session-xai');
    });

    it('keeps caller-supplied prompt_cache_key for xAI Responses requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.20-multi-agent',
        body: { ...body, prompt_cache_key: 'caller-conversation' },
        providerCacheKey: 'scoped-session-xai',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toBe('caller-conversation');
    });

    it('omits prompt_cache_key for xAI Responses requests without a session', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.20-multi-agent',
        body,
        stream: false,
      });
      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.20-multi-agent',
        body,
        providerCacheKey: '   ',
        stream: false,
      });

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBody.prompt_cache_key).toBeUndefined();
      expect(secondBody.prompt_cache_key).toBeUndefined();
    });

    it('adds prompt_cache_key for native xAI Responses requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.3',
        apiMode: 'responses',
        body: { input: 'Hello' },
        providerCacheKey: 'scoped-native-session',
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
      expect(sentBody.prompt_cache_key).not.toContain('native-session');
      expect(sentBody.input).toBe('Hello');
    });

    it('leaves regular xAI models on /v1/chat/completions for Chat Completions requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-4.3',
        body,
        stream: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.x.ai/v1/chat/completions',
        expect.any(Object),
      );
      expect(result.isChatGpt).toBe(false);
      expect(result.isResponses).toBe(false);
    });
  });

  describe('Extra headers', () => {
    it('merges extraHeaders into outgoing request', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'xai',
        apiKey: 'sk-xai',
        model: 'grok-3',
        body,
        stream: false,
        extraHeaders: { 'x-grok-conv-id': 'session-123' },
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.headers['x-grok-conv-id']).toBe('session-123');
    });

    it('does not override base headers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        extraHeaders: { 'X-Custom': 'value' },
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.headers['Authorization']).toBe('Bearer sk-test');
      expect(fetchOptions.headers['X-Custom']).toBe('value');
    });
  });

  describe('Provider aliases', () => {
    it('resolves gemini to google endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'gemini',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body,
        stream: false,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(result.isGoogle).toBe(true);
    });
  });

  describe('AbortSignal passthrough', () => {
    it('uses timeout signal when no client signal provided', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeDefined();
      expect(fetchOptions.signal.aborted).toBe(false);
    });

    it('combines client signal with timeout signal', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const abortController = new AbortController();
      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        signal: abortController.signal,
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeDefined();
      expect(fetchOptions.signal.aborted).toBe(false);

      // Aborting the client signal should abort the combined signal
      abortController.abort();
      expect(fetchOptions.signal.aborted).toBe(true);
    });

    it('passes already-aborted signal correctly', async () => {
      const abortController = new AbortController();
      abortController.abort();

      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        signal: abortController.signal,
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal.aborted).toBe(true);
    });

    it('always provides a signal to fetch even without client signal', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeDefined();
      // The signal should be the timeout signal (not undefined)
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });

    it('provides signal for Google provider as well', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const ac = new AbortController();
      await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body,
        stream: false,
        signal: ac.signal,
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeDefined();
      expect(fetchOptions.signal.aborted).toBe(false);

      ac.abort();
      expect(fetchOptions.signal.aborted).toBe(true);
    });
  });

  describe('convertGoogleResponse', () => {
    it('delegates to fromGoogleResponse', () => {
      const googleBody = {
        candidates: [
          {
            content: { parts: [{ text: 'Hello' }] },
            finishReason: 'STOP',
          },
        ],
      };
      const result = client.convertGoogleResponse(googleBody, 'gemini-2.0-flash');

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('gemini-2.0-flash');
      const choices = result.choices as Array<{ message: { content: string } }>;
      expect(choices[0].message.content).toBe('Hello');
    });
  });

  describe('convertGoogleStreamChunk', () => {
    it('delegates to transformGoogleStreamChunk', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'Hi' }] },
          },
        ],
      });
      const result = client.convertGoogleStreamChunk(chunk, 'gemini-2.0-flash');

      expect(result.chunk).toContain('data: ');
      expect(result.chunk).toContain('"chat.completion.chunk"');
      expect(result.signatures).toEqual([]);
    });

    it('returns null chunk for empty input', () => {
      const result = client.convertGoogleStreamChunk('', 'gemini-2.0-flash');
      expect(result.chunk).toBeNull();
      expect(result.signatures).toEqual([]);
    });

    it('surfaces extracted signatures from functionCall parts', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'fn', args: {} },
                  thoughtSignature: 'sig_abc',
                },
              ],
            },
          },
        ],
      });
      const result = client.convertGoogleStreamChunk(chunk, 'gemini-3-pro-preview');
      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0].signature).toBe('sig_abc');
    });
  });

  describe('convertAnthropicResponse', () => {
    it('delegates to fromAnthropicResponse', () => {
      const anthropicBody = {
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const result = client.convertAnthropicResponse(anthropicBody, 'claude-sonnet-4-20250514');

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ message: { content: string } }>;
      expect(choices[0].message.content).toBe('Hello');
    });
  });

  describe('convertAnthropicStreamChunk', () => {
    it('delegates to transformAnthropicStreamChunk', () => {
      const chunk =
        'event: content_block_delta\n{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}';
      const result = client.convertAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');

      expect(result).toContain('data: ');
      expect(result).toContain('"chat.completion.chunk"');
    });

    it('returns null for ping chunk', () => {
      const result = client.convertAnthropicStreamChunk(
        'event: ping\n{"type":"ping"}',
        'claude-sonnet-4-20250514',
      );
      expect(result).toBeNull();
    });
  });

  describe('createAnthropicStreamTransformer', () => {
    it('creates a stateful transformer that processes Anthropic stream events', () => {
      const transformer = client.createAnthropicStreamTransformer('claude-sonnet-4-20250514');
      expect(typeof transformer).toBe('function');

      // Test with a message_start event
      const startChunk =
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}';
      const result = transformer(startChunk);
      expect(result).toContain('data: ');
      expect(result).toContain('"role":"assistant"');
    });
  });

  describe('URL masking', () => {
    it('keeps the Google API key out of the debug log entirely', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      // Spy on the logger to verify the URL has no key in it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debugSpy = jest.spyOn((client as any).logger, 'debug');

      await client.forward({
        provider: 'google',
        apiKey: 'AIzaSyABCDEF12345',
        model: 'gemini-2.0-flash',
        body,
        stream: false,
      });

      // Key is now sent in the x-goog-api-key header, never in the URL.
      expect(debugSpy).toHaveBeenCalledWith(expect.not.stringContaining('AIzaSyABCDEF12345'));
      expect(debugSpy).toHaveBeenCalledWith(expect.not.stringContaining('key='));

      debugSpy.mockRestore();
    });
  });

  describe('Request body construction', () => {
    it('includes model and stream in request body for OpenAI providers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('gpt-4o');
      expect(sentBody.stream).toBe(true);
      expect(sentBody.messages).toEqual(body.messages);
      expect(sentBody.temperature).toBe(0.7);
    });

    it('does not include model or stream for Google provider (uses Gemini format)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'google',
        apiKey: 'AIza-test',
        model: 'gemini-2.0-flash',
        body,
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBeUndefined();
      expect(sentBody.stream).toBeUndefined();
      expect(sentBody.contents).toBeDefined();
    });
  });

  describe('Vendor prefix stripping', () => {
    it('strips vendor prefix for non-OpenRouter providers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'anthropic/claude-sonnet-4',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('claude-sonnet-4');
    });

    it('preserves vendor prefix for OpenRouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'anthropic/claude-sonnet-4',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('anthropic/claude-sonnet-4');
    });

    it('preserves Ollama author-prefixed model names', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'ollama',
        apiKey: '',
        model: 'mdq100/qwen3.5-flash:35b',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('mdq100/qwen3.5-flash:35b');
    });

    it('preserves Ollama Cloud author-prefixed model names', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'ollama-cloud',
        apiKey: 'ollama-key',
        model: 'mdq100/qwen3.5-flash:35b',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('mdq100/qwen3.5-flash:35b');
    });

    it('preserves slash in Groq model names (e.g. meta-llama/...)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'groq',
        apiKey: 'gsk-test',
        model: 'meta-llama/llama-guard-4-12b',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('meta-llama/llama-guard-4-12b');
    });

    it('preserves NVIDIA NIM slash-prefixed model names', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'nvidia',
        apiKey: 'nvapi-test',
        model: 'nvidia/nemotron-3-super-120b-a12b',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    });

    it('preserves Hugging Face model names and routing suffixes', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'huggingface',
        apiKey: 'hf_test',
        model: 'openai/gpt-oss-120b:cheapest',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('openai/gpt-oss-120b:cheapest');
    });

    it('preserves Fireworks account model names', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'fireworks',
        apiKey: 'fw-test',
        model: 'accounts/fireworks/models/deepseek-v3p1',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('accounts/fireworks/models/deepseek-v3p1');
    });

    it('preserves Pioneer slash-prefixed model names', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'pioneer',
        apiKey: 'pio_sk_test',
        model: 'openai/gpt-oss-120b',
        body,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('openai/gpt-oss-120b');
    });

    it('preserves ClinePass provider-prefixed model names', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'cline-pass',
        apiKey: 'cp-token',
        model: 'cline-pass/deepseek-v4-flash',
        body,
        stream: false,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('cline-pass/deepseek-v4-flash');
    });
  });

  describe('Body wire normalization for non-OpenAI providers', () => {
    const bodyWithOpenAiFields = {
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      store: false,
      max_completion_tokens: 8192,
      metadata: { user: 'test' },
      service_tier: 'default',
      stream_options: { include_usage: true },
    };
    const makeBodyWithReasoningContent = () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: 'Hi',
          reasoning_content: 'Detailed internal reasoning',
        },
      ],
      temperature: 0.7,
    });
    const makeBodyWithReasoningDetails = () => ({
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: '4',
          reasoning_details: [{ type: 'thinking', thinking: 'add them', signature: 'sig-abc' }],
        },
      ],
      temperature: 0.7,
    });

    it('strips OpenAI-only fields for Mistral', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithOpenAiFields,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.store).toBeUndefined();
      expect(sentBody.metadata).toBeUndefined();
      expect(sentBody.service_tier).toBeUndefined();
      expect(sentBody.stream_options).toBeUndefined();
      expect(sentBody.messages).toEqual(bodyWithOpenAiFields.messages);
      expect(sentBody.temperature).toBe(0.7);
    });

    it('converts max_completion_tokens to max_tokens for non-OpenAI providers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithOpenAiFields,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_completion_tokens).toBeUndefined();
      expect(sentBody.max_tokens).toBe(8192);
    });

    it('does not overwrite existing max_tokens when converting', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithBoth = { ...bodyWithOpenAiFields, max_tokens: 4096 };
      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-chat',
        body: bodyWithBoth,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_tokens).toBe(4096);
      expect(sentBody.max_completion_tokens).toBeUndefined();
    });

    it('strips OpenAI-only fields for DeepSeek', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-chat',
        body: bodyWithOpenAiFields,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.store).toBeUndefined();
      expect(sentBody.service_tier).toBeUndefined();
    });

    it('preserves DeepSeek reasoning_effort in the provider-facing request', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-v4-pro',
        body: {
          messages: [{ role: 'user', content: 'Solve this carefully.' }],
          thinking: { type: 'enabled' },
          reasoning_effort: 'max',
        },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody).toMatchObject({
        model: 'deepseek-v4-pro',
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
      });
      expect(result.wireRequestBody).toEqual(sentBody);
    });

    it('preserves DeepSeek max_tokens above a possible provider limit', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-chat',
        body: { ...bodyWithOpenAiFields, max_tokens: 12000 },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_tokens).toBe(12000);
    });

    it('preserves non-positive DeepSeek max_tokens values for Autofix', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-chat',
        body: { ...bodyWithOpenAiFields, max_tokens: 0 },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_tokens).toBe(0);
    });

    it('preserves string DeepSeek max_tokens values for Autofix', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-chat',
        body: { ...bodyWithOpenAiFields, max_tokens: '9000' as unknown as number },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.max_tokens).toBe('9000');
    });

    it('preserves reasoning_content for Mistral Autofix without mutating the input', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningContent = makeBodyWithReasoningContent();

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithReasoningContent,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_content).toBe('Detailed internal reasoning');
      expect(bodyWithReasoningContent.messages[1].reasoning_content).toBe(
        'Detailed internal reasoning',
      );
    });

    it('preserves reasoning_content for DeepSeek reasoning models', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningContent = makeBodyWithReasoningContent();

      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-reasoner',
        body: bodyWithReasoningContent,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_content).toBe('Detailed internal reasoning');
    });

    it('preserves reasoning_content for native OpenAI Autofix', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningContent = makeBodyWithReasoningContent();

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: bodyWithReasoningContent,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_content).toBe('Detailed internal reasoning');
    });

    it('preserves reasoning_content for non-DeepSeek OpenRouter targets', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningContent = makeBodyWithReasoningContent();

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'openai/gpt-4o',
        body: bodyWithReasoningContent,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_content).toBe('Detailed internal reasoning');
    });

    it('preserves reasoning_content for DeepSeek models on OpenRouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningContent = makeBodyWithReasoningContent();

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'deepseek/deepseek-r1',
        body: bodyWithReasoningContent,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_content).toBe('Detailed internal reasoning');
    });

    it('strips reasoning_details for Mistral assistant messages without mutating the input', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningDetails = makeBodyWithReasoningDetails();

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'ministral-3b-2512',
        body: bodyWithReasoningDetails,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_details).toBeUndefined();
      expect(bodyWithReasoningDetails.messages[1].reasoning_details).toEqual([
        { type: 'thinking', thinking: 'add them', signature: 'sig-abc' },
      ]);
    });

    it('strips reasoning_details for native OpenAI targets', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningDetails = makeBodyWithReasoningDetails();

      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: bodyWithReasoningDetails,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_details).toBeUndefined();
    });

    it('strips reasoning_details for DeepSeek (does not support reasoning_details)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningDetails = makeBodyWithReasoningDetails();

      await client.forward({
        provider: 'deepseek',
        apiKey: 'sk-ds',
        model: 'deepseek-reasoner',
        body: bodyWithReasoningDetails,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_details).toBeUndefined();
    });

    it('preserves reasoning_details for OpenRouter targets', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithReasoningDetails = makeBodyWithReasoningDetails();

      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'minimax/minimax-m2.7',
        body: bodyWithReasoningDetails,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[1].reasoning_details).toEqual([
        { type: 'thinking', thinking: 'add them', signature: 'sig-abc' },
      ]);
    });

    it('leaves non-array messages unchanged during sanitization', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithNonArrayMessages = {
        messages: { role: 'assistant', reasoning_content: 'Detailed internal reasoning' },
        temperature: 0.7,
      };

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithNonArrayMessages as unknown as Record<string, unknown>,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages).toEqual(bodyWithNonArrayMessages.messages);
    });

    it('preserves non-object entries inside the messages array', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const bodyWithMixedMessages = {
        messages: [
          'unexpected-entry',
          { role: 'assistant', reasoning_content: 'Detailed internal reasoning' },
        ],
        temperature: 0.7,
      };

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithMixedMessages as unknown as Record<string, unknown>,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[0]).toBe('unexpected-entry');
      expect(sentBody.messages[1].reasoning_content).toBe('Detailed internal reasoning');
    });

    it('normalizes non-compliant tool call ids for Mistral while preserving references', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const originalToolCallId = 'call005AKQn2j5TEr4S6i3zNN59moT';
      const bodyWithToolCalls = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: originalToolCallId,
                type: 'function',
                function: { name: 'search', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: originalToolCallId,
            content: '{"status":"ok"}',
          },
        ],
      };

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithToolCalls as unknown as Record<string, unknown>,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const normalizedToolCallId = sentBody.messages[0].tool_calls[0].id;
      expect(normalizedToolCallId).toMatch(/^[A-Za-z0-9]{9}$/);
      expect(normalizedToolCallId).not.toBe(originalToolCallId);
      expect(sentBody.messages[1].tool_call_id).toBe(normalizedToolCallId);
      const originalAssistantMessage = bodyWithToolCalls.messages[0] as {
        tool_calls: Array<{ id: string }>;
      };
      expect(originalAssistantMessage.tool_calls[0].id).toBe(originalToolCallId);
      expect(bodyWithToolCalls.messages[1].tool_call_id).toBe(originalToolCallId);
    });

    it('preserves valid 9-character alphanumeric tool call ids for Mistral', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const validToolCallId = 'Ab12Cd34E';
      const bodyWithValidToolCallId = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: validToolCallId,
                type: 'function',
                function: { name: 'search', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: validToolCallId,
            content: '{"status":"ok"}',
          },
        ],
      };

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithValidToolCallId as unknown as Record<string, unknown>,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.messages[0].tool_calls[0].id).toBe(validToolCallId);
      expect(sentBody.messages[1].tool_call_id).toBe(validToolCallId);
    });

    it('does not rewrite later valid Mistral tool call ids when generated ids would collide', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      const invalidToolCallId = 'call005AKQn2j5TEr4S6i3zNN59moT';
      const validToolCallId = 'tc0000001';
      const bodyWithPotentialCollision = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: invalidToolCallId,
                type: 'function',
                function: { name: 'search', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: invalidToolCallId,
            content: '{"status":"invalid"}',
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: validToolCallId,
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: validToolCallId,
            content: '{"status":"valid"}',
          },
        ],
      };

      await client.forward({
        provider: 'mistral',
        apiKey: 'sk-mi',
        model: 'mistral-small',
        body: bodyWithPotentialCollision as unknown as Record<string, unknown>,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const normalizedInvalidId = sentBody.messages[0].tool_calls[0].id;
      expect(normalizedInvalidId).toMatch(/^[A-Za-z0-9]{9}$/);
      expect(normalizedInvalidId).not.toBe(validToolCallId);
      expect(sentBody.messages[1].tool_call_id).toBe(normalizedInvalidId);
      expect(sentBody.messages[2].tool_calls[0].id).toBe(validToolCallId);
      expect(sentBody.messages[3].tool_call_id).toBe(validToolCallId);
    });

    it('preserves all fields for OpenAI', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: bodyWithOpenAiFields,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.store).toBe(false);
      expect(sentBody.max_completion_tokens).toBe(8192);
      expect(sentBody.metadata).toEqual({ user: 'test' });
      expect(sentBody.safety_identifier).toBeUndefined();
    });

    it('preserves all fields for OpenRouter', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'openai/gpt-4o',
        body: bodyWithOpenAiFields,
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.store).toBe(false);
      expect(sentBody.max_completion_tokens).toBe(8192);
    });
  });

  describe('stream_options.include_usage injection', () => {
    it('injects stream_options.include_usage for OpenAI streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('injects stream_options.include_usage for OpenRouter streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'openai/gpt-4o',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('injects stream_options.include_usage for Ollama streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'ollama',
        apiKey: '',
        model: 'llama3',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('injects stream_options.include_usage for Ollama Cloud streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'ollama-cloud',
        apiKey: 'ollama-key',
        model: 'llama3',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('does not forward Anthropic-style thinking params to Ollama endpoints', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      for (const provider of ['ollama', 'ollama-cloud']) {
        mockFetch.mockClear();
        await client.forward({
          provider,
          apiKey: provider === 'ollama-cloud' ? 'ollama-key' : '',
          model: 'qwen3.5:9b-q4_K_M',
          body: {
            messages: [{ role: 'user', content: 'Hello' }],
            thinking: { type: 'enabled' },
            max_tokens: 4096,
          },
          stream: false,
        });

        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(sentBody).not.toHaveProperty('thinking');
        expect(sentBody).toEqual(
          expect.objectContaining({
            model: 'qwen3.5:9b-q4_K_M',
            max_tokens: 4096,
          }),
        );
      }
    });

    it('injects stream_options.include_usage for Groq streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'groq',
        apiKey: 'gsk-test',
        model: 'llama-3.3-70b-versatile',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('does not inject stream_options for non-streaming OpenAI requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: false,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toBeUndefined();
    });

    it.each([
      ['mistral', 'mistral-small'],
      ['deepseek', 'deepseek-chat'],
      ['moonshot', 'kimi-k2-0905-preview'],
      ['kilo', 'kilo-auto/free'],
      ['minimax', 'MiniMax-M2'],
      ['huggingface', 'openai/gpt-oss-120b'],
      ['nvidia', 'nvidia/nemotron-3-super-120b-a12b'],
      ['qwen', 'qwen-max'],
      ['xiaomi', 'mimo-v2.5-pro'],
      ['xai', 'grok-3'],
      ['zai', 'glm-4.6'],
      ['copilot', 'gpt-4o-copilot'],
      ['commandcode', 'commandcode/deepseek/deepseek-v4-flash'],
      ['opencode-go', 'claude-sonnet-4'],
      ['opencode-zen', 'qwen3.6-plus'],
    ])(
      'injects stream_options.include_usage for %s streaming requests',
      async (provider, model) => {
        mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
        await client.forward({
          provider,
          apiKey: 'sk-test',
          model,
          body: { messages: [{ role: 'user', content: 'Hello' }] },
          stream: true,
        });

        const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(sentBody.stream_options).toEqual({ include_usage: true });
      },
    );

    it('injects stream_options.include_usage for Z.AI subscription streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'zai',
        apiKey: 'sk-zai-sub',
        model: 'glm-4.6',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('injects stream_options.include_usage for Qwen Token Plan streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'qwen',
        apiKey: 'sk-sp-token-plan-key',
        model: 'qwen3.6-plus',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('injects stream_options.include_usage for Xiaomi MiMo Token Plan streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'xiaomi',
        apiKey: 'tp-mimo-token',
        model: 'mimo-v2.5-pro',
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        stream: true,
        authType: 'subscription',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('preserves existing stream_options fields when injecting include_usage', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await client.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body: {
          messages: [{ role: 'user', content: 'Hello' }],
          stream_options: { some_field: 'value' },
        },
        stream: true,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({
        some_field: 'value',
        include_usage: true,
      });
    });
  });

  describe('Custom endpoint', () => {
    it('uses custom endpoint instead of resolving by provider name', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const customEndpoint = {
        baseUrl: 'https://api.groq.com/openai/v1',
        buildHeaders: (key: string) => ({
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        }),
        buildPath: () => '/v1/chat/completions',
        format: 'openai' as const,
      };

      const result = await client.forward({
        provider: 'custom:abc-123',
        apiKey: 'gsk_test',
        model: 'llama-3.1-70b',
        body,
        stream: false,
        customEndpoint,
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.groq.com/openai/v1/v1/chat/completions');
      expect(result.isGoogle).toBe(false);
      expect(result.isAnthropic).toBe(false);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('llama-3.1-70b');
      expect(sentBody.stream).toBe(false);
    });

    it('uses custom endpoint with streaming', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const customEndpoint = buildCustomEndpoint('http://localhost:8000');

      await client.forward({
        provider: 'custom:uuid',
        apiKey: '',
        model: 'my-model',
        body,
        stream: true,
        customEndpoint,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream).toBe(true);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('merges extraHeaders with custom endpoint headers', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const customEndpoint = {
        baseUrl: 'http://localhost:8000',
        buildHeaders: (key: string) => ({
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        }),
        buildPath: () => '/v1/chat/completions',
        format: 'openai' as const,
      };

      await client.forward({
        provider: 'custom:uuid',
        apiKey: 'test-key',
        model: 'model',
        body,
        stream: false,
        extraHeaders: { 'X-Custom': 'value' },
        customEndpoint,
      });

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions.headers['Authorization']).toBe('Bearer test-key');
      expect(fetchOptions.headers['X-Custom']).toBe('value');
    });

    // Regression: #1591 — MiniMax endpoint rejects bare model name because the
    // second "/" segment was being eaten before reaching the provider.
    it('preserves multi-segment upstream model ids with a vendor/model shape (#1591)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const customEndpoint = {
        baseUrl: 'https://api.minimax.io/v1',
        buildHeaders: (key: string) => ({
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        }),
        buildPath: () => '/chat/completions',
        format: 'openai' as const,
      };

      await client.forward({
        provider: 'custom:minimax-cp',
        apiKey: 'test-key',
        model: 'MiniMaxAI/MiniMax-2.7',
        body,
        stream: false,
        customEndpoint,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('MiniMaxAI/MiniMax-2.7');
    });

    // Regression: #1615 — Fireworks Fire Pass rejects truncated model name
    // because earlier code stripped the "accounts/" segment off the wire payload.
    it('preserves deeply slashed upstream model ids (#1615)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const customEndpoint = {
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        buildHeaders: (key: string) => ({
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        }),
        buildPath: () => '/chat/completions',
        format: 'openai' as const,
      };

      await client.forward({
        provider: 'custom:fireworks-cp',
        apiKey: 'test-key',
        model: 'accounts/fireworks/routers/kimi-k2p5-turbo',
        body,
        stream: false,
        customEndpoint,
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('accounts/fireworks/routers/kimi-k2p5-turbo');
    });
  });

  describe('Error handling', () => {
    it('throws for unknown provider', async () => {
      await expect(
        client.forward({
          provider: 'unknown-provider',
          apiKey: 'key',
          model: 'model',
          body,
          stream: false,
        }),
      ).rejects.toThrow('No endpoint configured for provider');
    });

    it('propagates fetch errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(
        client.forward({
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'gpt-4o',
          body,
          stream: false,
        }),
      ).rejects.toThrow('Network error');
    });

    it('sanitizes Google API key from fetch error messages', async () => {
      mockFetch.mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com key=AIzaSySecret123'),
      );

      await expect(
        client.forward({
          provider: 'google',
          apiKey: 'AIzaSySecret123',
          model: 'gemini-2.0-flash',
          body,
          stream: false,
        }),
      ).rejects.toThrow('key=***');

      // Verify the secret key is NOT in the error
      try {
        await client.forward({
          provider: 'google',
          apiKey: 'AIzaSySecret123',
          model: 'gemini-2.0-flash',
          body,
          stream: false,
        });
      } catch (err) {
        expect((err as Error).message).not.toContain('AIzaSySecret123');
      }
    });

    it('sanitizes non-Error fetch exceptions', async () => {
      mockFetch.mockRejectedValue('key=LEAKED_SECRET fetch failed');

      await expect(
        client.forward({
          provider: 'google',
          apiKey: 'LEAKED_SECRET',
          model: 'gemini-2.0-flash',
          body,
          stream: false,
        }),
      ).rejects.toThrow('key=***');
    });
  });

  describe('PROVIDER_TIMEOUT_MS env override', () => {
    const originalEnv = process.env.PROVIDER_TIMEOUT_MS;

    afterEach(() => {
      if (originalEnv === undefined) delete process.env.PROVIDER_TIMEOUT_MS;
      else process.env.PROVIDER_TIMEOUT_MS = originalEnv;
    });

    async function captureTimeoutMs(envValue: string | undefined): Promise<number> {
      if (envValue === undefined) delete process.env.PROVIDER_TIMEOUT_MS;
      else process.env.PROVIDER_TIMEOUT_MS = envValue;

      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      timeoutSpy.mockClear();

      let observed = -1;
      await jest.isolateModulesAsync(async () => {
        const { ProviderClient: FreshClient } = await import('../provider-client');
        const fresh = new FreshClient();
        mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await fresh.forward({
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'gpt-4',
          body,
          stream: false,
        });
        observed = timeoutSpy.mock.calls[0]?.[0] ?? -1;
      });

      timeoutSpy.mockRestore();
      return observed;
    }

    it('defaults to 180000 ms when env var is unset', async () => {
      expect(await captureTimeoutMs(undefined)).toBe(180_000);
    });

    it('uses the configured value when env var is a positive integer', async () => {
      expect(await captureTimeoutMs('45000')).toBe(45_000);
    });

    it('falls back to 180000 ms when env var is non-numeric', async () => {
      expect(await captureTimeoutMs('abc')).toBe(180_000);
    });

    it('falls back to 180000 ms when env var is negative', async () => {
      expect(await captureTimeoutMs('-1')).toBe(180_000);
    });

    it('falls back to 180000 ms when env var is zero', async () => {
      expect(await captureTimeoutMs('0')).toBe(180_000);
    });
  });

  describe('Gemini subscription (CodeAssist envelope)', () => {
    it('wraps the request body in the CodeAssist envelope for gemini subscription', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'gemini',
        apiKey: 'access-token',
        model: 'gemini-2.5-pro',
        body,
        stream: false,
        authType: 'subscription',
        providerResource: 'proj-code-assist-999',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.model).toBe('gemini-2.5-pro');
      expect(sentBody.project).toBe('proj-code-assist-999');
      expect(sentBody.request).toBeDefined();
      expect(sentBody.request.contents).toBeDefined();
      expect(result.isGoogle).toBe(true);
      expect(result.isCodeAssist).toBe(true);
    });

    it('sanitizes tool schemas inside the CodeAssist envelope for gemini subscription', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'gemini',
        apiKey: 'access-token',
        model: 'gemini-2.5-pro',
        body: {
          messages: [{ role: 'user', content: 'Set a threshold' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'set_threshold',
                parameters: {
                  type: 'object',
                  properties: {
                    threshold: {
                      type: 'number',
                      minimum: 0,
                      exclusiveMinimum: true,
                      exclusiveMaximum: false,
                    },
                  },
                },
              },
            },
          ],
        },
        stream: false,
        authType: 'subscription',
        providerResource: 'proj-code-assist-999',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const tools = sentBody.request.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const props = tools[0].functionDeclarations[0].parameters.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.threshold).toEqual({ type: 'number', minimum: 0 });
    });

    it('uses the non-stream generateContent path for non-streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'gemini',
        apiKey: 'access-token',
        model: 'gemini-2.5-pro',
        body,
        stream: false,
        authType: 'subscription',
        providerResource: 'proj-123',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/v1internal:generateContent');
      expect(url).not.toContain(':streamGenerateContent');
    });

    it('uses the stream path and appends alt=sse for streaming requests', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'gemini',
        apiKey: 'access-token',
        model: 'gemini-2.5-pro',
        body,
        stream: true,
        authType: 'subscription',
        providerResource: 'proj-123',
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/v1internal:streamGenerateContent');
      expect(url).toContain('alt=sse');
    });

    it('sends Authorization: Bearer header (not x-goog-api-key)', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      await client.forward({
        provider: 'gemini',
        apiKey: 'my-oauth-token',
        model: 'gemini-2.5-pro',
        body,
        stream: false,
        authType: 'subscription',
        providerResource: 'proj-123',
      });

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer my-oauth-token');
      expect(headers['x-goog-api-key']).toBeUndefined();
    });

    it('sets isCodeAssist=false when not using the CodeAssist endpoint', async () => {
      mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

      const result = await client.forward({
        provider: 'google',
        apiKey: 'AIza-key',
        model: 'gemini-2.5-pro',
        body,
        stream: false,
      });

      expect(result.isCodeAssist).toBeFalsy();
      expect(result.isGoogle).toBe(true);
    });
  });
});

describe('ProviderClient provider-specific message fields', () => {
  const previousMode = process.env['MANIFEST_MODE'];

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  const reasoningBody = {
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'upstream thinking',
        tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
      },
    ],
  };

  it('preserves reasoning_content for Zen without consulting model capabilities', async () => {
    const bareClient = new ProviderClient();

    await bareClient.forward({
      provider: 'opencode-zen',
      apiKey: 'zen-token',
      model: 'opencode-zen/big-pickle',
      body: reasoningBody,
      stream: false,
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.messages[0].reasoning_content).toBe('upstream thinking');
  });
});
