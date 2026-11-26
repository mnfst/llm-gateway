import { ProviderClient } from '../provider-client';
import {
  AnthropicThinkingBindingSessionStore,
  MAX_BINDING_SESSION_ENTRIES,
  THINKING_BINDING_CONTROLS_BETA,
  applyThinkingDropBlock,
  buildThinkingBindingRecovery,
  isAnthropicThinkingBindingError,
} from '../anthropic-thinking-binding';

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

const BOUND_ERROR_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. The `tools` list differs from the one this block was created with.',
  },
});

describe('anthropic-thinking-binding helpers', () => {
  it('matches Anthropic prefix-binding errors and ignores unrelated 400s', () => {
    expect(isAnthropicThinkingBindingError(BOUND_ERROR_BODY)).toBe(true);
    expect(
      isAnthropicThinkingBindingError(
        JSON.stringify({ type: 'error', error: { message: 'messages: max_tokens required' } }),
      ),
    ).toBe(false);
  });

  it('expires remembered sessions after TTL, sweeps periodically, caps entries, and preserves explicit drop_block opt-in', () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const store = new AnthropicThinkingBindingSessionStore();
      const key = store.buildKey('https://api.anthropic.com', 'claude-opus-5-5', 'v1:sess-1');
      store.remember(key);
      expect(store.has(key)).toBe(true);

      Date.now = () => 1_000_000 + 31 * 60 * 1000;
      // Trigger periodic sweep when another session is remembered past CLEANUP_INTERVAL_MS.
      store.remember(store.buildKey('https://api.anthropic.com', 'claude-opus-5-5', 'v1:sess-2'));
      expect(store.has(key)).toBe(false);

      for (let i = 0; i <= MAX_BINDING_SESSION_ENTRIES; i++) {
        store.remember(
          store.buildKey('https://api.anthropic.com', 'claude-opus-5-5', `v1:cap-${i}`),
        );
      }
      expect(
        store.has(store.buildKey('https://api.anthropic.com', 'claude-opus-5-5', 'v1:cap-0')),
      ).toBe(false);
      expect(
        store.has(
          store.buildKey(
            'https://api.anthropic.com',
            'claude-opus-5-5',
            `v1:cap-${MAX_BINDING_SESSION_ENTRIES}`,
          ),
        ),
      ).toBe(true);
    } finally {
      Date.now = realNow;
    }

    const preserved = applyThinkingDropBlock(
      {
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'error' },
        },
      },
      { preserveExplicitBehavior: true },
    );
    expect((preserved.thinking as Record<string, unknown>).block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    });
  });

  it('stops retrying when drop_block and beta header are already present', () => {
    expect(
      buildThinkingBindingRecovery(
        {
          thinking: {
            type: 'adaptive',
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
          },
        },
        { 'anthropic-beta': `oauth-2025-04-20,${THINKING_BINDING_CONTROLS_BETA}` },
      ),
    ).toBeNull();
  });
});

describe('ProviderClient — Anthropic thinking block binding', () => {
  let client: ProviderClient;

  beforeEach(() => {
    client = new ProviderClient();
    mockFetch.mockReset();
  });

  it('sends thinking-binding-controls beta when chat_completions caller supplies thinking.block_binding', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions',
      clientAnthropicBeta: 'structured-outputs-2025-11-13',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
      },
      stream: false,
    });

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBe(THINKING_BINDING_CONTROLS_BETA);
    // Still refuses to blindly pass arbitrary client beta flags on chat_completions.
    expect(headers['anthropic-beta']).not.toContain('structured-outputs-2025-11-13');
  });

  it('never sends thinking-binding-controls beta to Anthropic-compatible third parties', async () => {
    mockFetch.mockResolvedValue(new Response(BOUND_ERROR_BODY, { status: 400 }));

    const result = await client.forward({
      provider: 'moonshot',
      apiKey: 'kimi-code-key',
      model: 'kimi-for-coding',
      apiMode: 'chat_completions',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
      },
      stream: false,
      authType: 'subscription',
    });

    expect(result.response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('anthropic-beta');
  });

  it('retries once with drop_block + beta header on 400 and remembers the session for later turns', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(BOUND_ERROR_BODY, { status: 400 }))
      .mockResolvedValueOnce(
        new Response('{"content":[{"type":"text","text":"ok"}]}', { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response('{"content":[{"type":"text","text":"ok2"}]}', { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response('{"content":[{"type":"text","text":"ok-other"}]}', { status: 200 }),
      );

    const baseRequest = {
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions' as const,
      sessionKey: 'default',
      sessionCacheKey: 'v1:tenant-a-agent-1-default',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      },
      stream: false,
    };

    const first = await client.forward(baseRequest);
    expect(first.response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const retryHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(retryHeaders['anthropic-beta']).toBe(THINKING_BINDING_CONTROLS_BETA);
    expect(retryBody.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(first.wireRequestBody).toEqual(retryBody);

    // Subsequent turn in the same session includes drop_block + beta upfront (1 fetch).
    const second = await client.forward(baseRequest);
    expect(second.response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const secondHeaders = mockFetch.mock.calls[2][1].headers as Record<string, string>;
    const secondBody = JSON.parse(mockFetch.mock.calls[2][1].body as string);
    expect(secondHeaders['anthropic-beta']).toBe(THINKING_BINDING_CONTROLS_BETA);
    expect(secondBody.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    });

    // Different tenant/agent session does NOT inherit the setting.
    await client.forward({
      ...baseRequest,
      sessionCacheKey: 'v1:tenant-b-agent-1-default',
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[3][1].headers).not.toHaveProperty('anthropic-beta');
  });

  it('merges thinking-binding-controls onto subscription anthropic-beta flags during recovery', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(BOUND_ERROR_BODY, { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions',
      authType: 'subscription',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      },
      stream: false,
    });

    expect(result.response.status).toBe(200);
    const retryHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(retryHeaders['anthropic-beta']).toContain(THINKING_BINDING_CONTROLS_BETA);
  });

  it('strips stale thinking blocks on retry when thinking is absent or disabled', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(BOUND_ERROR_BODY, { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-5-5',
      apiMode: 'messages',
      body: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'earlier reply without thinking' }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'old', signature: 'sig_old' },
              { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
          },
        ],
      },
      stream: false,
    });

    expect(result.response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(retryBody.thinking).toBeUndefined();
    expect(retryBody.messages[1].content).toEqual([
      { type: 'text', text: 'earlier reply without thinking' },
    ]);
    expect(retryBody.messages[2].content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
    ]);
  });

  it('recovers streaming chat_completions requests on 400 too', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(BOUND_ERROR_BODY, { status: 400 }))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));

    const result = await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions',
      sessionCacheKey: 'v1:stream-sess',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      },
      stream: true,
    });

    expect(result.response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(retryBody.stream).toBe(true);
    expect(retryBody.thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
  });

  it('returns the 400 without infinite retry if drop_block + beta already failed', async () => {
    mockFetch.mockResolvedValue(new Response(BOUND_ERROR_BODY, { status: 400 }));

    const result = await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
      },
      stream: false,
    });

    expect(result.response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not intercept unrelated 400 errors', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ type: 'error', error: { message: 'invalid model' } }), {
        status: 400,
      }),
    );

    const result = await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions',
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      },
      stream: false,
    });

    expect(result.response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
