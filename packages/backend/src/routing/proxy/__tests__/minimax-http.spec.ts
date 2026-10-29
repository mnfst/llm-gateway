import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderClient } from '../provider-client';
import { PROVIDER_ENDPOINTS } from '../provider-endpoints';

/** Exercise the real serializer and fetch transport against a credential-free HTTP server. */
describe('MiniMax HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  let received: { path: string; body: Record<string, any> }[];
  const previousMode = process.env.MANIFEST_MODE;
  const client = new ProviderClient();
  const endpoints = ['minimax', 'minimax-subscription', 'openrouter'];
  const originals = new Map(endpoints.map((key) => [key, PROVIDER_ENDPOINTS[key]]));

  beforeAll(async () => {
    process.env.MANIFEST_MODE = 'selfhosted';
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ path: req.url!, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.url!.endsWith('/messages')
            ? {
                id: 'msg-test',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                id: 'chat-test',
                object: 'chat.completion',
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const key of endpoints) {
      PROVIDER_ENDPOINTS[key] = {
        ...originals.get(key)!,
        baseUrl: key === 'minimax-subscription' ? `${baseUrl}/anthropic/v1` : baseUrl,
      };
    }
  });
  beforeEach(() => {
    received = [];
  });
  afterAll(async () => {
    for (const key of endpoints) PROVIDER_ENDPOINTS[key] = originals.get(key)!;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (previousMode === undefined) delete process.env.MANIFEST_MODE;
    else process.env.MANIFEST_MODE = previousMode;
  });

  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Inspect it' }, image] },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Inspect with a tool',
      tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'result' },
  ];

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])(
    'preserves %s effort, thinking, images and tool continuation on direct HTTP',
    async (effort) => {
      const body = { messages, thinking: { type: 'adaptive' }, reasoning_effort: effort };
      const snapshot = structuredClone(body);
      const response = await client.forward({
        provider: 'minimax',
        apiKey: 'test-not-a-secret',
        model: 'MiniMax-M3.1-Flash',
        body,
        stream: false,
      });
      expect(response.response.ok).toBe(true);
      expect(received[0].path).toBe('/v1/chat/completions');
      expect(received[0].body).toMatchObject({
        model: 'MiniMax-M3.1-Flash',
        thinking: { type: 'adaptive' },
        reasoning_effort: effort,
        messages,
      });
      expect(body).toEqual(snapshot);
    },
  );

  it.each(['MiniMax-M3', 'MiniMax-M2.7'])(
    'does not rewrite the explicitly selected %s',
    async (model) => {
      await client.forward({
        provider: 'minimax',
        apiKey: 'test-not-a-secret',
        model,
        body: { messages: [{ role: 'user', content: 'hello' }], thinking: { type: 'disabled' } },
        stream: false,
      });
      expect(received[0].body.model).toBe(model);
      expect(received[0].body.thinking).toEqual({ type: 'disabled' });
    },
  );

  it('preserves native Anthropic thinking, effort, images and signed tool history', async () => {
    const nativeMessages = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect', signature: 'opaque-signature' },
          { type: 'tool_use', id: 'tool-1', name: 'inspect', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
      },
    ];
    await client.forward({
      provider: 'minimax',
      authType: 'subscription',
      apiKey: 'test-not-a-secret',
      model: 'MiniMax-M3.1-Flash',
      apiMode: 'messages',
      stream: false,
      body: {
        messages: nativeMessages,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      },
    });
    expect(received[0].path).toBe('/anthropic/v1/messages');
    expect(received[0].body).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: nativeMessages,
    });
  });

  it.each([undefined, { effort: 'high' }])(
    'maps chat effort to subscription output_config without overriding native effort (%j)',
    async (outputConfig) => {
      await client.forward({
        provider: 'minimax',
        authType: 'subscription',
        apiKey: 'test-not-a-secret',
        model: 'MiniMax-M3.1-Flash',
        stream: false,
        body: { messages: [messages[0]], reasoning_effort: 'medium', output_config: outputConfig },
      });
      expect(received[0].body.output_config.effort).toBe(outputConfig?.effort ?? 'medium');
      expect(received[0].body.messages[0].content).toContainEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      });
    },
  );

  it('preserves the verified OpenRouter route and reasoning-details continuation', async () => {
    const details = [{ type: 'reasoning.text', text: 'inspect' }];
    await client.forward({
      provider: 'openrouter',
      apiKey: 'test-not-a-secret',
      model: 'minimax/minimax-m3.1-flash:free',
      stream: false,
      body: {
        messages: [{ ...messages[1], reasoning_details: details }, messages[2]],
        reasoning: { effort: 'high' },
      },
    });
    expect(received[0].body.model).toBe('minimax/minimax-m3.1-flash:free');
    expect(received[0].body.reasoning).toEqual({ effort: 'high' });
    expect(received[0].body.messages[0].reasoning_details).toEqual(details);
    expect(received[0].body.messages[1].tool_call_id).toBe('call-1');
  });
});
