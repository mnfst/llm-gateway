import { ProviderClient } from '../provider-client';
import { messagesToChatCompletionsRequest } from '../anthropic-messages-adapter';
import { resolveForwardEndpoint } from '../forward-endpoint-resolver';

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

type ApiMode = NonNullable<Parameters<ProviderClient['forward']>[0]['apiMode']>;
type Connection = 'default' | 'regional';

const RUNTIME_CHAT_URL =
  'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions';
const RUNTIME_RESPONSES_URL = 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses';
const KILL_SWITCH = 'BEDROCK_RUNTIME_CHAT_VIA_RESPONSES';

const LUNA = 'us.openai.gpt-6-luna';
const ASTRA = 'us.openai.gpt-6-astra';
const KIMI = 'global.moonshotai.kimi-k3';

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the current weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};
const flatWeatherTool = {
  type: 'function',
  name: 'get_weather',
  description: 'Look up the current weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};
const tools = [weatherTool];

const baseBody = {
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Weather in Paris?' },
  ],
};

describe('ProviderClient: Bedrock Runtime GPT chat with function tools and reasoning', () => {
  const previousMode = process.env['MANIFEST_MODE'];
  const previousSwitch = process.env[KILL_SWITCH];
  let client: ProviderClient;

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    delete process.env[KILL_SWITCH];
    client = new ProviderClient();
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    if (previousSwitch === undefined) delete process.env[KILL_SWITCH];
    else process.env[KILL_SWITCH] = previousSwitch;
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  /**
   * Sends one chat request through the public `forward`. A regional connection
   * reaches it as the `customEndpoint` the resolver builds without a body, as
   * the proxy does in production.
   */
  async function send(
    model: string,
    extra: Record<string, unknown>,
    options: { connection?: Connection; stream?: boolean; apiMode?: ApiMode } = {},
  ) {
    const { connection = 'default', stream = false, apiMode = 'chat_completions' } = options;
    const customEndpoint =
      connection === 'regional'
        ? resolveForwardEndpoint({
            provider: 'bedrock',
            authType: 'api_key',
            model,
            providerRegion: 'us-east-1',
            apiMode,
          }).customEndpoint
        : undefined;
    const result = await client.forward({
      provider: 'bedrock',
      apiKey: 'bedrock-api-key-test',
      model,
      body: { ...baseBody, ...extra },
      stream,
      apiMode,
      customEndpoint,
    });
    const [url, init] = mockFetch.mock.calls[0];
    return { result, url: url as string, sent: JSON.parse(init.body) as Record<string, unknown> };
  }

  describe.each<Connection>(['default', 'regional'])('on the %s connection', (connection) => {
    it.each([false, true])(
      'sends luna with function tools and effort high to Responses (stream %s)',
      async (stream) => {
        const { result, url, sent } = await send(
          LUNA,
          {
            tools,
            reasoning_effort: 'high',
            tool_choice: 'required',
            parallel_tool_calls: false,
            max_tokens: 1024,
            temperature: 0.2,
            top_p: 0.9,
            stop: ['END'],
          },
          { connection, stream },
        );

        expect(url).toBe(RUNTIME_RESPONSES_URL);
        expect(sent.model).toBe(LUNA);
        expect(sent.input).toEqual([
          { role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
        ]);
        expect(sent.instructions).toBe('Be brief.');
        expect(sent.tools).toEqual([flatWeatherTool]);
        expect(sent.tool_choice).toBe('required');
        expect(sent.parallel_tool_calls).toBe(false);
        expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
        expect(sent.store).toBe(false);
        expect(sent.max_output_tokens).toBe(1024);
        expect(sent.stream).toBe(stream);
        for (const dropped of [
          'messages',
          'reasoning_effort',
          'temperature',
          'top_p',
          'stop',
          'max_tokens',
          'max_completion_tokens',
        ]) {
          expect(sent).not.toHaveProperty(dropped);
        }
        expect(result.isChatGpt).toBe(true);
        expect(result.isResponses).toBeFalsy();
        expect(result.wireFormat).toBe('openai_responses');
        expect(result.wireApiMode).toBe('responses');
        expect(result.wireRequestUrl).toBe(RUNTIME_RESPONSES_URL);
      },
    );

    it.each(['low', 'medium', 'high', 'xhigh', 'max'])(
      'maps effort %s onto the Responses reasoning object',
      async (effort) => {
        const { url, sent } = await send(LUNA, { tools, reasoning_effort: effort }, { connection });

        expect(url).toBe(RUNTIME_RESPONSES_URL);
        expect(sent.reasoning).toEqual({ effort, summary: 'auto' });
        expect(sent).not.toHaveProperty('reasoning_effort');
      },
    );

    it('streams a max effort request through Responses', async () => {
      const { url, sent } = await send(
        LUNA,
        { tools, reasoning_effort: 'max' },
        { connection, stream: true },
      );

      expect(url).toBe(RUNTIME_RESPONSES_URL);
      expect(sent.reasoning).toEqual({ effort: 'max', summary: 'auto' });
      expect(sent.stream).toBe(true);
    });

    it.each([
      'us.openai.gpt-6-luna',
      'global.openai.gpt-6-sol',
      'eu.openai.gpt-5.6-luna',
      'global.openai.gpt-5.6-luna',
    ])('reroutes %s with tools and effort high', async (model) => {
      const { url, sent } = await send(model, { tools, reasoning_effort: 'high' }, { connection });

      expect(url).toBe(RUNTIME_RESPONSES_URL);
      expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      expect(sent.tools).toEqual([flatWeatherTool]);
    });

    it('sends astra with tools and no effort to Responses without a reasoning object', async () => {
      const { url, sent, result } = await send(ASTRA, { tools }, { connection });

      expect(url).toBe(RUNTIME_RESPONSES_URL);
      expect(sent.tools).toEqual([flatWeatherTool]);
      expect(sent).not.toHaveProperty('reasoning');
      expect(sent).not.toHaveProperty('reasoning_effort');
      expect(sent).not.toHaveProperty('messages');
      expect(result.wireFormat).toBe('openai_responses');
    });

    it('sends astra with tools and effort high to Responses with the reasoning object', async () => {
      const { url, sent } = await send(ASTRA, { tools, reasoning_effort: 'high' }, { connection });

      expect(url).toBe(RUNTIME_RESPONSES_URL);
      expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      expect(sent).not.toHaveProperty('reasoning_effort');
    });

    it.each([
      ['luna', LUNA],
      ['sol', 'global.openai.gpt-6-sol'],
      ['5.6-luna', 'eu.openai.gpt-5.6-luna'],
    ])(
      'keeps %s with tools and no effort on Chat Completions with effort none',
      async (_name, model) => {
        const { url, sent, result } = await send(model, { tools }, { connection });

        expect(url).toBe(RUNTIME_CHAT_URL);
        expect(sent.reasoning_effort).toBe('none');
        expect(sent.tools).toEqual(tools);
        expect(sent).not.toHaveProperty('input');
        expect(result.isChatGpt).toBe(false);
        expect(result.wireFormat).toBe('openai_chat_completions');
        expect(result.wireApiMode).toBe('chat_completions');
      },
    );

    it('keeps luna with tools and effort none on Chat Completions', async () => {
      const { url, sent } = await send(LUNA, { tools, reasoning_effort: 'none' }, { connection });

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('none');
      expect(sent.tools).toEqual(tools);
    });

    it('keeps luna with effort high and no tools on Chat Completions', async () => {
      const { url, sent } = await send(LUNA, { reasoning_effort: 'high' }, { connection });

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('high');
      expect(sent).not.toHaveProperty('input');
    });

    it('keeps luna with an empty tools array and effort high on Chat Completions', async () => {
      const { url, sent } = await send(
        LUNA,
        { tools: [], reasoning_effort: 'high' },
        { connection },
      );

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('high');
    });

    it('keeps luna with only non-function tools and effort high on Chat Completions', async () => {
      const { url, sent } = await send(
        LUNA,
        { tools: [{ type: 'web_search' }], reasoning_effort: 'high' },
        { connection },
      );

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('high');
      expect(sent.tools).toEqual([{ type: 'web_search' }]);
    });

    it('leaves kimi-k3 with tools and effort high on Chat Completions', async () => {
      const { url, sent, result } = await send(
        KIMI,
        { tools, reasoning_effort: 'high' },
        { connection },
      );

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.tools).toEqual(tools);
      expect(sent).not.toHaveProperty('input');
      expect(sent).not.toHaveProperty('reasoning_effort');
      expect(result.wireFormat).toBe('openai_chat_completions');
    });

    it('keeps an Anthropic Messages request with tools on Chat Completions with effort none', async () => {
      const messagesBody = {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
      };
      const customEndpoint =
        connection === 'regional'
          ? resolveForwardEndpoint({
              provider: 'bedrock',
              authType: 'api_key',
              model: LUNA,
              providerRegion: 'us-east-1',
              apiMode: 'messages',
            }).customEndpoint
          : undefined;

      const result = await client.forward({
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        model: LUNA,
        body: messagesBody,
        resolveChatBody: async () => messagesToChatCompletionsRequest(messagesBody),
        stream: false,
        apiMode: 'messages',
        customEndpoint,
      });

      expect(mockFetch.mock.calls[0][0]).toBe(RUNTIME_CHAT_URL);
      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.tools[0].type).toBe('function');
      expect(sent.reasoning_effort).toBe('none');
      expect(sent).not.toHaveProperty('input');
      expect(result.wireFormat).toBe('openai_chat_completions');
    });

    it('keeps a native Responses request on the native Responses path', async () => {
      const customEndpoint =
        connection === 'regional'
          ? resolveForwardEndpoint({
              provider: 'bedrock',
              authType: 'api_key',
              model: LUNA,
              providerRegion: 'us-east-1',
              apiMode: 'responses',
            }).customEndpoint
          : undefined;

      const result = await client.forward({
        provider: 'bedrock',
        apiKey: 'bedrock-api-key-test',
        model: LUNA,
        body: {
          input: 'Weather in Paris?',
          tools: [flatWeatherTool],
          reasoning: { effort: 'high' },
        },
        stream: false,
        apiMode: 'responses',
        customEndpoint,
      });

      expect(mockFetch.mock.calls[0][0]).toBe(RUNTIME_RESPONSES_URL);
      const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sent.input).toBe('Weather in Paris?');
      expect(sent.reasoning).toEqual({ effort: 'high' });
      expect(result.isResponses).toBe(true);
      expect(result.isChatGpt).toBe(false);
    });
  });

  it('keeps Mantle dropping the effort for a base model id', async () => {
    mockFetch.mockClear();
    await client.forward({
      provider: 'bedrock',
      apiKey: 'bedrock-api-key-test',
      model: 'openai.gpt-6-luna',
      body: { ...baseBody, tools, reasoning_effort: 'high' },
      stream: false,
      apiMode: 'chat_completions',
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses',
    );
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent).not.toHaveProperty('reasoning');
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(sent.tools).toEqual([flatWeatherTool]);
  });

  describe('second turn after a tool result', () => {
    const secondTurn = {
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_weather_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_weather_1', content: '{"temp_c":18}' },
      ],
    };

    it('replays the tool call and its output under one call_id', async () => {
      const { url, sent } = await send(LUNA, { ...secondTurn, tools, reasoning_effort: 'high' });

      expect(url).toBe(RUNTIME_RESPONSES_URL);
      expect(sent.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
        {
          type: 'function_call',
          call_id: 'call_weather_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
        },
        { type: 'function_call_output', call_id: 'call_weather_1', output: '{"temp_c":18}' },
      ]);
    });

    it('resends a healed body to the Responses endpoint', async () => {
      const { result, sent } = await send(LUNA, {
        ...secondTurn,
        tools,
        reasoning_effort: 'high',
      });

      expect(result.retryWireBody).toBeDefined();
      mockFetch.mockClear();
      await result.retryWireBody!({ ...sent, reasoning: { effort: 'low', summary: 'auto' } });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toBe(RUNTIME_RESPONSES_URL);
      const resent = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(resent.reasoning).toEqual({ effort: 'low', summary: 'auto' });
      expect(resent.input).toEqual(sent.input);
    });
  });

  describe(`${KILL_SWITCH}`, () => {
    it('sends luna with tools and effort high to Chat Completions when set to false', async () => {
      process.env[KILL_SWITCH] = 'false';

      const { url, sent, result } = await send(LUNA, { tools, reasoning_effort: 'high' });

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('high');
      expect(sent.tools).toEqual(tools);
      expect(sent).not.toHaveProperty('input');
      expect(result.wireFormat).toBe('openai_chat_completions');
    });

    it('also turns the reroute off on a regional connection', async () => {
      process.env[KILL_SWITCH] = 'false';

      const { url, sent } = await send(
        LUNA,
        { tools, reasoning_effort: 'high' },
        { connection: 'regional' },
      );

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('high');
    });

    it('reads the variable on every call', async () => {
      process.env[KILL_SWITCH] = 'false';
      const off = await send(LUNA, { tools, reasoning_effort: 'high' });
      expect(off.url).toBe(RUNTIME_CHAT_URL);

      mockFetch.mockClear();
      delete process.env[KILL_SWITCH];
      const on = await send(LUNA, { tools, reasoning_effort: 'high' });
      expect(on.url).toBe(RUNTIME_RESPONSES_URL);
    });

    it.each([undefined, 'true', '1', '0', 'FALSE', ''])(
      'keeps the reroute on when the value is %p',
      async (value) => {
        if (value === undefined) delete process.env[KILL_SWITCH];
        else process.env[KILL_SWITCH] = value;

        const { url, sent } = await send(LUNA, { tools, reasoning_effort: 'high' });

        expect(url).toBe(RUNTIME_RESPONSES_URL);
        expect(sent.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      },
    );

    it('does not change the effort none behaviour of the chat route', async () => {
      process.env[KILL_SWITCH] = 'false';

      const { url, sent } = await send(LUNA, { tools });

      expect(url).toBe(RUNTIME_CHAT_URL);
      expect(sent.reasoning_effort).toBe('none');
    });
  });
});
