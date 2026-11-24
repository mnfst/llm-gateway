// Strict header contract tests for ProviderClient's auth-critical paths.
//
// Existing tests in provider-client.spec.ts often assert headers with
// `expect.any(Object)` or only check one or two fields. That leaves room
// for regressions in the auth header *shape* — e.g. Anthropic silently
// switching from `x-api-key` to `Authorization: Bearer`, or the
// ChatGPT subscription path losing the Codex-CLI spoof. This file pins
// the *exact* header set on every auth-critical path so any drift
// fails loudly.

import { ProviderClient } from '../provider-client';
import { CodexSessionAffinity } from '../codex-session-affinity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

const body = {
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0.7,
};

describe('ProviderClient — strict header contract on auth-critical paths', () => {
  let client: ProviderClient;

  beforeEach(() => {
    client = new ProviderClient();
    mockFetch.mockReset();
  });

  it('Anthropic api_key path sends exactly x-api-key (no Authorization Bearer leak)', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    // Pin every header on this path so we'd notice a Bearer/x-api-key swap.
    expect(sentHeaders).toEqual({
      'x-api-key': 'sk-ant-key',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
    expect(sentHeaders).not.toHaveProperty('Authorization');
    expect(sentHeaders).not.toHaveProperty('anthropic-beta');
  });

  it('Anthropic subscription path sends Claude Code-shaped Bearer headers (and NO x-api-key)', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      authType: 'subscription',
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).toEqual({
      Authorization: 'Bearer sk-ant-oat-token',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': expect.stringContaining('claude-code-20250219'),
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': expect.stringContaining('claude-cli/'),
      'x-app': 'cli',
      'x-stainless-arch': expect.any(String),
      'x-stainless-helper-method': 'stream',
      'x-stainless-lang': 'js',
      'x-stainless-os': expect.any(String),
      'x-stainless-package-version': expect.any(String),
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': expect.any(String),
      'x-stainless-timeout': '600',
    });
    expect(sentHeaders['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(sentHeaders['anthropic-beta']).toContain('context-management-2025-06-27');
    expect(sentHeaders['anthropic-beta']).toContain('effort-2025-11-24');
    expect(sentHeaders['anthropic-beta']).not.toContain('prompt-caching-scope-2026-01-05');
    expect(sentHeaders).not.toHaveProperty('x-api-key');
  });

  it('OpenAI api_key path sends exactly Authorization Bearer (and never x-api-key)', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      body,
      stream: false,
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).toEqual({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
    expect(sentHeaders).not.toHaveProperty('x-api-key');
    expect(sentHeaders).not.toHaveProperty('originator');
  });

  it('xAI api_key path sends exactly Authorization Bearer (no leaked Anthropic-style headers)', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'xai',
      apiKey: 'sk-xai-key',
      model: 'grok-3',
      body,
      stream: false,
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).toEqual({
      Authorization: 'Bearer sk-xai-key',
      'Content-Type': 'application/json',
    });
    expect(sentHeaders).not.toHaveProperty('x-api-key');
    expect(sentHeaders).not.toHaveProperty('anthropic-version');
  });

  it('Kimi (moonshot subscription) Anthropic-compatible path sends x-api-key (NOT Bearer)', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'moonshot',
      apiKey: 'kimi-code-key',
      model: 'kimi-for-coding',
      body,
      stream: false,
      authType: 'subscription',
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).toEqual({
      'x-api-key': 'kimi-code-key',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
    expect(sentHeaders).not.toHaveProperty('Authorization');
  });

  it('Google api_key path sends exactly x-goog-api-key (NOT Authorization Bearer)', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'google',
      apiKey: 'AIza-secret',
      model: 'gemini-2.0-flash',
      body,
      stream: false,
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'AIza-secret',
    });
    expect(sentHeaders).not.toHaveProperty('Authorization');
    // Key must not appear in URL either.
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('AIza-secret');
  });

  it('OpenRouter sends Bearer + HTTP-Referer + X-Title attribution headers', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'openrouter',
      apiKey: 'sk-or-key',
      model: 'openrouter/auto',
      body,
      stream: false,
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).toEqual({
      Authorization: 'Bearer sk-or-key',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://manifest.build',
      'X-Title': 'Manifest',
    });
    expect(sentHeaders).not.toHaveProperty('x-api-key');
  });

  it('ChatGPT subscription path pins Codex-CLI spoof headers exactly', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'openai',
      apiKey: 'oauth-token',
      model: 'gpt-5',
      body,
      stream: false,
      authType: 'subscription',
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders.Authorization).toBe('Bearer oauth-token');
    expect(sentHeaders['Content-Type']).toBe('application/json');
    expect(sentHeaders.originator).toBe('codex_cli_rs');
    // user-agent is the spoofed Codex CLI agent — must be present (any
    // missing field would change upstream behavior since chatgpt.com
    // rejects non-Codex shaped requests).
    expect(typeof sentHeaders['user-agent']).toBe('string');
    expect(sentHeaders['user-agent'].length).toBeGreaterThan(0);
    // Prompt-cache affinity headers the Codex backend needs for cache hits.
    expect(sentHeaders['session-id']).toMatch(UUID_RE);
    expect(sentHeaders['thread-id']).toMatch(UUID_RE);
    expect(sentHeaders).not.toHaveProperty('x-api-key');
    expect(sentHeaders).not.toHaveProperty('anthropic-version');
  });
});

describe('ProviderClient — Codex prompt-cache affinity (openai-subscription)', () => {
  let client: ProviderClient;

  beforeEach(() => {
    client = new ProviderClient();
    mockFetch.mockReset();
  });

  const subscriptionOpts = {
    provider: 'openai',
    apiKey: 'oauth-token',
    model: 'gpt-5',
    body,
    stream: false,
    authType: 'subscription',
  } as const;

  it('sends deterministic session-id/thread-id headers across requests', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    const scoped = { ...subscriptionOpts, body: { ...body, prompt_cache_key: 'conversation-1' } };
    await client.forward(scoped);
    await client.forward(scoped);

    const first = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    const second = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(first['session-id']).toMatch(UUID_RE);
    expect(first['session-id']).toBe(second['session-id']);
    expect(first['thread-id']).toBe(second['thread-id']);
  });

  it('injects request-local prompt cache affinity without a caller key', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({ ...subscriptionOpts });
    await client.forward({ ...subscriptionOpts });

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    const firstHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    const secondHeaders = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(firstBody.prompt_cache_key).toMatch(UUID_RE);
    expect(secondBody.prompt_cache_key).not.toBe(firstBody.prompt_cache_key);
    expect(secondHeaders['session-id']).not.toBe(firstHeaders['session-id']);
  });

  it('keeps the caller-supplied prompt_cache_key on the Chat Completions path', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      ...subscriptionOpts,
      body: { ...body, prompt_cache_key: 'caller-conv-1' },
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.prompt_cache_key).toBe('caller-conv-1');
  });

  it('forwards the caller prompt_cache_key on the api-key /responses conversion path', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o1-pro',
      body: { ...body, prompt_cache_key: 'caller-conv-1' },
      stream: false,
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.prompt_cache_key).toBe('caller-conv-1');
    // Affinity headers stay subscription-only; the API-key path needs none.
    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders).not.toHaveProperty('session-id');
  });

  it('adds scoped prompt cache affinity on the api-key /responses path', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'o1-pro',
      body,
      providerCacheKey: 'v1:tenant-agent-session-digest',
      stream: false,
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.prompt_cache_key).toMatch(/^manifest-[a-f0-9]{32}$/);
    expect(sentBody.prompt_cache_key).not.toContain('tenant-agent-session');
  });

  it('replays the x-codex-turn-state token captured from the previous response', async () => {
    const completed =
      'event: response.completed\ndata: {"response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\n';
    mockFetch.mockResolvedValueOnce(
      new Response(completed, {
        status: 200,
        headers: { 'x-codex-turn-state': 'turn-abc' },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response(completed, { status: 200 }));

    const scoped = { ...subscriptionOpts, body: { ...body, prompt_cache_key: 'conversation-1' } };
    await client.forward(scoped);
    await client.forward(scoped);

    const first = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    const second = mockFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(first).not.toHaveProperty('x-codex-turn-state');
    expect(second['x-codex-turn-state']).toBe('turn-abc');
  });

  it('applies affinity on the native Responses API path too', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      ...subscriptionOpts,
      apiMode: 'responses',
      body: { input: 'Hello', instructions: 'You are helpful.' },
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentHeaders['session-id']).toMatch(UUID_RE);
    expect(sentBody.prompt_cache_key).toMatch(UUID_RE);
  });

  it('keeps affinity headers authoritative over caller-supplied extraHeaders', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await client.forward({
      ...subscriptionOpts,
      extraHeaders: { 'session-id': 'attacker-override', 'x-observability': 'keep-me' },
    });

    const sentHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    // Routing-critical affinity header wins…
    expect(sentHeaders['session-id']).toMatch(UUID_RE);
    expect(sentHeaders['session-id']).not.toBe('attacker-override');
    // …while non-conflicting extraHeaders still pass through.
    expect(sentHeaders['x-observability']).toBe('keep-me');
  });

  it('uses an injected CodexSessionAffinity instance when provided', async () => {
    const affinity = new CodexSessionAffinity();
    const prepareSpy = jest.spyOn(affinity, 'prepare');
    const injected = new ProviderClient(undefined, undefined, affinity);
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await injected.forward({ ...subscriptionOpts });

    expect(prepareSpy).toHaveBeenCalledWith('oauth-token', expect.any(Object));
  });
});

describe('ProviderClient — anthropic-beta merge', () => {
  let client: ProviderClient;

  beforeEach(() => {
    client = new ProviderClient();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  const sentBeta = () =>
    (mockFetch.mock.calls[0][1].headers as Record<string, string>)['anthropic-beta'];

  it("appends the caller's beta flags after Manifest's on the subscription path", async () => {
    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      authType: 'subscription',
      apiMode: 'messages',
      clientAnthropicBeta: 'structured-outputs-2025-11-13',
    });

    // Manifest's OAuth flags are load-bearing for this route, so they survive…
    expect(sentBeta()).toContain('oauth-2025-04-20');
    // …and the flag that makes the caller's `output_config` legal rides along.
    expect(sentBeta()).toContain('structured-outputs-2025-11-13');
  });

  it("forwards the caller's beta flags on the api_key path, which sends none of its own", async () => {
    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      apiMode: 'messages',
      clientAnthropicBeta: 'context-management-2025-06-27',
    });

    expect(sentBeta()).toBe('context-management-2025-06-27');
  });

  it('never repeats a flag Manifest already sends', async () => {
    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-token',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      authType: 'subscription',
      apiMode: 'messages',
      clientAnthropicBeta: 'oauth-2025-04-20',
    });

    expect(
      sentBeta()
        .split(',')
        .filter((f) => f === 'oauth-2025-04-20'),
    ).toHaveLength(1);
  });

  it('drops a malformed flag rather than letting it reach the provider', async () => {
    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      apiMode: 'messages',
      clientAnthropicBeta: 'bad\r\nx-injected: 1',
    });

    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('anthropic-beta');
  });

  it('forwards through a custom endpoint that points at Anthropic', async () => {
    // A tenant can reach Anthropic through a custom provider row, which
    // resolves to the `custom` endpoint key. The flags are as necessary there.
    await client.forward({
      provider: 'my-anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      apiMode: 'messages',
      clientAnthropicBeta: 'structured-outputs-2025-11-13',
      customEndpoint: {
        baseUrl: 'https://api.anthropic.com',
        buildHeaders: (apiKey: string) => ({
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        }),
        buildPath: () => '/v1/messages',
        format: 'anthropic',
      },
    });

    expect(sentBeta()).toBe('structured-outputs-2025-11-13');
  });

  it('does not forward beta flags on a translated (non-Messages) request', async () => {
    // A chat-completions body reaches Anthropic through the OpenAI->Anthropic
    // converters, which only understand the content blocks they were written
    // for. A beta that adds a new block type would be silently dropped from the
    // response, so the flags stay behind until translation supports them.
    await client.forward({
      provider: 'anthropic',
      apiKey: 'sk-ant-key',
      model: 'claude-sonnet-4-20250514',
      body,
      stream: false,
      apiMode: 'chat_completions',
      clientAnthropicBeta: 'structured-outputs-2025-11-13',
    });

    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('anthropic-beta');
  });

  it('does not send the header to an Anthropic-compatible third party', async () => {
    // Kimi, Bedrock, BytePlus and friends only speak the Messages *shape* —
    // they have never received an `anthropic-beta` header and a flag naming an
    // Anthropic-only feature means nothing to them.
    await client.forward({
      provider: 'moonshot',
      apiKey: 'kimi-code-key',
      model: 'kimi-for-coding',
      body,
      stream: false,
      authType: 'subscription',
      apiMode: 'messages',
      clientAnthropicBeta: 'structured-outputs-2025-11-13',
    });

    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('anthropic-beta');
  });

  it('leaves a non-Anthropic provider untouched', async () => {
    await client.forward({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      body,
      stream: false,
      apiMode: 'messages',
      clientAnthropicBeta: 'structured-outputs-2025-11-13',
    });

    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('anthropic-beta');
  });
});
