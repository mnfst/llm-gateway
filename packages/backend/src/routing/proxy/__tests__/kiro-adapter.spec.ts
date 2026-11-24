import { Buffer } from 'node:buffer';
import { Logger } from '@nestjs/common';
import {
  buildKiroChatRequest,
  buildKiroHeaders,
  createKiroOpenAiStream,
  forwardKiroChat,
  KIRO_BASE_URL,
  KIRO_CHAT_TARGET,
  KIRO_MODELS_TARGET,
  KiroEventStreamParser,
  parseKiroModels,
  toKiroModelId,
} from '../kiro-adapter';

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

function stringHeader(name: string, value: string): Buffer {
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

function typedHeader(name: string, type: number, value: number | bigint | Buffer = 0): Buffer {
  const nameBytes = Buffer.from(name);
  if (type === 0 || type === 1) {
    return Buffer.concat([Buffer.from([nameBytes.length]), nameBytes, Buffer.from([type])]);
  }
  if (type === 2) {
    const valueBytes = Buffer.alloc(1);
    valueBytes.writeInt8(Number(value));
    return Buffer.concat([
      Buffer.from([nameBytes.length]),
      nameBytes,
      Buffer.from([type]),
      valueBytes,
    ]);
  }
  if (type === 3) {
    const valueBytes = Buffer.alloc(2);
    valueBytes.writeInt16BE(Number(value));
    return Buffer.concat([
      Buffer.from([nameBytes.length]),
      nameBytes,
      Buffer.from([type]),
      valueBytes,
    ]);
  }
  if (type === 4) {
    const valueBytes = Buffer.alloc(4);
    valueBytes.writeInt32BE(Number(value));
    return Buffer.concat([
      Buffer.from([nameBytes.length]),
      nameBytes,
      Buffer.from([type]),
      valueBytes,
    ]);
  }
  if (type === 5 || type === 8) {
    const valueBytes = Buffer.alloc(8);
    valueBytes.writeBigInt64BE(BigInt(value as number | bigint));
    return Buffer.concat([
      Buffer.from([nameBytes.length]),
      nameBytes,
      Buffer.from([type]),
      valueBytes,
    ]);
  }
  if (type === 6) {
    const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from([Number(value)]);
    const valueLength = Buffer.alloc(2);
    valueLength.writeUInt16BE(valueBytes.length, 0);
    return Buffer.concat([
      Buffer.from([nameBytes.length]),
      nameBytes,
      Buffer.from([type]),
      valueLength,
      valueBytes,
    ]);
  }
  if (type === 9) {
    const valueBytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    return Buffer.concat([
      Buffer.from([nameBytes.length]),
      nameBytes,
      Buffer.from([type]),
      valueBytes,
    ]);
  }
  return Buffer.concat([Buffer.from([nameBytes.length]), nameBytes, Buffer.from([type])]);
}

function eventFrame(
  eventType: string,
  payload: unknown,
  messageType = 'event',
  extraHeaders: Buffer[] = [],
): Uint8Array {
  const headers = Buffer.concat([
    stringHeader(':message-type', messageType),
    stringHeader(':event-type', eventType),
    ...extraHeaders,
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

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

type BuiltKiroRequest = {
  conversationState: {
    history: Array<Record<string, unknown>>;
    currentMessage: {
      userInputMessage: {
        content: string;
        userInputMessageContext?: {
          tools?: Array<{
            toolSpecification: {
              name: string;
              description: string;
              inputSchema: { json: Record<string, unknown> };
            };
          }>;
          toolResults?: Array<{
            toolUseId: string;
            status: string;
            content: Array<{ text: string }>;
          }>;
        };
      };
    };
  };
};

function buildKiro(body: Record<string, unknown>): BuiltKiroRequest {
  return buildKiroChatRequest(body, 'auto') as unknown as BuiltKiroRequest;
}

function kiroSpecs(request: BuiltKiroRequest) {
  return (
    request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? []
  ).map((tool) => tool.toolSpecification);
}

function kiroToolUses(request: BuiltKiroRequest) {
  const assistant = request.conversationState.history.find(
    (turn) => 'assistantResponseMessage' in turn,
  ) as
    | {
        assistantResponseMessage: {
          content: string;
          toolUses?: Array<{ toolUseId: string; name: string; input: unknown }>;
        };
      }
    | undefined;
  return assistant?.assistantResponseMessage;
}

function sseToolCalls(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .flatMap((line) => {
      const chunk = JSON.parse(line.slice(6)) as {
        choices: Array<{ delta: { tool_calls?: Array<Record<string, unknown>> } }>;
      };
      return chunk.choices[0].delta.tool_calls ?? [];
    });
}

function finalSseUsage(text: string): Record<string, number> | undefined {
  let usage: Record<string, number> | undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    const chunk = JSON.parse(line.slice(6)) as { usage?: Record<string, number> };
    if (chunk.usage) usage = chunk.usage;
  }
  return usage;
}

describe('kiro-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('builds Kiro AWS JSON headers', () => {
    expect(buildKiroHeaders('ksk_test', KIRO_MODELS_TARGET)).toEqual({
      Authorization: 'Bearer ksk_test',
      'Content-Type': 'application/x-amz-json-1.0',
      'x-amz-target': KIRO_MODELS_TARGET,
    });
  });

  it('parses Kiro model list responses into subscription model IDs', () => {
    const result = parseKiroModels({
      models: [
        {
          model_id: 'auto',
          model_name: 'auto',
          context_window_tokens: 1000000,
        },
        {
          modelId: 'claude-sonnet-4.5',
          modelName: 'Claude Sonnet 4.5',
          tokenLimits: { maxInputTokens: 200000 },
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'kiro/auto',
        displayName: 'auto',
        provider: 'kiro',
        contextWindow: 1000000,
        inputPricePerToken: 0,
        outputPricePerToken: 0,
        capabilityCode: true,
      }),
      expect.objectContaining({
        id: 'kiro/claude-sonnet-4.5',
        displayName: 'Claude Sonnet 4.5',
        contextWindow: 200000,
      }),
    ]);
  });

  it('strips only the kiro vendor prefix before forwarding', () => {
    expect(toKiroModelId('kiro/auto')).toBe('auto');
    expect(toKiroModelId('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
  });

  it('converts OpenAI messages into a Kiro conversation request', () => {
    const request = buildKiroChatRequest(
      {
        messages: [
          { role: 'system', content: 'Use concise answers.' },
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          { role: 'tool', tool_call_id: 'tool-1', content: { ok: true } },
          { role: 'user', content: [{ type: 'text', text: 'Second question' }] },
        ],
      },
      'auto',
    );

    expect(request).toMatchObject({
      conversationState: {
        history: [
          { userInputMessage: { content: 'First question', origin: 'KIRO_CLI' } },
          { assistantResponseMessage: { content: 'First answer' } },
        ],
        currentMessage: {
          userInputMessage: {
            content:
              'System instructions:\nUse concise answers.\n\nUser:\nSecond question\n\n[Tool result: {"ok":true}]',
            origin: 'KIRO_CLI',
            modelId: 'auto',
          },
        },
        chatTriggerType: 'MANUAL',
      },
      agentMode: 'SUPERVISED',
    });
  });

  it('maps OpenAI tools, tool calls, and tool results onto Kiro tool fields', () => {
    const request = buildKiroChatRequest(
      {
        messages: [
          { role: 'system', content: 'You can run commands.' },
          { role: 'user', content: 'List the files.' },
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
          { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'bash',
              description: 'Run a shell command.',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
                additionalProperties: false,
              },
            },
          },
        ],
      },
      'auto',
    ) as {
      conversationState: {
        history: Array<Record<string, unknown>>;
        currentMessage: {
          userInputMessage: {
            content: string;
            userInputMessageContext: {
              tools: unknown[];
              toolResults: unknown[];
            };
          };
        };
      };
    };

    expect(request.conversationState.history).toEqual([
      {
        userInputMessage: {
          content: 'System instructions:\nYou can run commands.\n\nUser:\nList the files.',
          origin: 'KIRO_CLI',
        },
      },
      {
        assistantResponseMessage: {
          content: '...',
          toolUses: [{ toolUseId: 'call_1', name: 'bash', input: { command: 'ls' } }],
        },
      },
    ]);

    const current = request.conversationState.currentMessage.userInputMessage;
    // A tool result with no new user text must stay empty: fabricating
    // "continue" (or leaving the system prompt here) makes Kiro read a fresh,
    // context-free instruction and drop the task. The system prompt moves to the
    // first user turn (above) so it still reaches the model.
    expect(current.content).toBe('');
    expect(current.userInputMessageContext.toolResults).toEqual([
      { toolUseId: 'call_1', status: 'success', content: [{ text: 'a.txt\nb.txt' }] },
    ]);
    expect(current.userInputMessageContext.tools).toEqual([
      {
        toolSpecification: {
          name: 'bash',
          description: 'Run a shell command.',
          inputSchema: {
            json: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        },
      },
    ]);
  });

  it('inlines a lone tool result that has no assistant call to pair with', () => {
    const withSystem = buildKiro({
      messages: [
        { role: 'system', content: 'You can run commands.' },
        { role: 'tool', tool_call_id: 'c1', content: 'hi' },
      ],
    });
    expect(withSystem.conversationState.history).toEqual([]);
    expect(withSystem.conversationState.currentMessage.userInputMessage.content).toBe(
      'System instructions:\nYou can run commands.\n\nUser:\n[Tool result: hi]',
    );
    expect(
      withSystem.conversationState.currentMessage.userInputMessage.userInputMessageContext
        ?.toolResults,
    ).toBeUndefined();

    const withoutSystem = buildKiro({
      messages: [{ role: 'tool', tool_call_id: 'c1', content: 'hi' }],
    });
    expect(withoutSystem.conversationState.history).toEqual([]);
    expect(withoutSystem.conversationState.currentMessage.userInputMessage.content).toBe(
      '[Tool result: hi]',
    );
  });

  it('sanitizes invalid Kiro tool names and restores them on the response', async () => {
    const request = buildKiroChatRequest(
      {
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          { type: 'function', function: { name: 'my.tool', parameters: { type: 'object' } } },
          { type: 'function', function: { name: '__a..b__', parameters: { type: 'object' } } },
        ],
      },
      'auto',
    ) as {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            userInputMessageContext: { tools: Array<{ toolSpecification: { name: string } }> };
          };
        };
      };
    };

    expect(
      request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map(
        (tool) => tool.toolSpecification.name,
      ),
    ).toEqual(['my_tool', 'a_b']);

    const source = streamFrom([
      eventFrame('toolUseEvent', { toolUseId: 'c1', name: 'my_tool', input: '{}', stop: true }),
    ]);
    const response = new Response(
      createKiroOpenAiStream(source, 'auto', new Map([['my_tool', 'my.tool']])),
    );
    const text = await response.text();
    expect(text).toContain('"name":"my.tool"');
  });

  it('handles image parts, empty parts, and circular object content defensively', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const request = buildKiroChatRequest(
      {
        messages: [
          { role: 'user', content: [{ type: 'image_url' }, { type: 'unknown' }] },
          { role: 'assistant', content: null },
          { role: 'user', content: circular },
        ],
      },
      'auto',
    ) as {
      conversationState: {
        history: Array<{ userInputMessage?: { content: string } }>;
        currentMessage: { userInputMessage: { content: string } };
      };
    };

    expect(request.conversationState.history).toEqual([
      { userInputMessage: { content: '[image omitted]', origin: 'KIRO_CLI' } },
    ]);
    expect(request.conversationState.currentMessage.userInputMessage.content).toBe(
      '[object Object]',
    );
  });

  it('parses split AWS event-stream frames', () => {
    const frame = eventFrame('assistantResponseEvent', { content: 'hello' });
    const parser = new KiroEventStreamParser();

    expect(parser.push(frame.subarray(0, 8))).toEqual([]);
    expect(parser.push(frame.subarray(8))).toEqual([
      {
        eventType: 'assistantResponseEvent',
        messageType: 'event',
        payload: { content: 'hello' },
      },
    ]);
    expect(() => parser.finish()).not.toThrow();
  });

  it('parses supported AWS event-stream headers and rejects malformed frames', () => {
    const parser = new KiroEventStreamParser();
    expect(
      parser.push(
        eventFrame('assistantResponseEvent', { content: 'hello' }, 'event', [
          typedHeader('bool', 0),
          typedHeader('byte', 2, -1),
          typedHeader('short', 3, 7),
          typedHeader('int', 4, 42),
          typedHeader('long', 5, 42n),
          typedHeader('bytes', 6, Buffer.from([1, 2, 3])),
          typedHeader('timestamp', 8, 1700000000000n),
          typedHeader('uuid', 9),
        ]),
      )[0],
    ).toEqual({
      eventType: 'assistantResponseEvent',
      messageType: 'event',
      payload: { content: 'hello' },
    });

    const invalidLength = Buffer.alloc(12);
    invalidLength.writeUInt32BE(15, 0);
    expect(() => new KiroEventStreamParser().push(invalidLength)).toThrow(
      'Invalid Kiro event stream frame',
    );
  });

  it('keeps parsing the payload when Kiro sends an unknown event-stream header type', () => {
    const parser = new KiroEventStreamParser();

    expect(
      parser.push(
        eventFrame('assistantResponseEvent', { content: 'hello' }, 'event', [
          typedHeader('unsupported', 10),
        ]),
      )[0],
    ).toEqual({
      eventType: 'assistantResponseEvent',
      messageType: 'event',
      payload: { content: 'hello' },
    });
  });

  it('unwraps nested Kiro event payloads', async () => {
    const response = new Response(
      createKiroOpenAiStream(
        streamFrom([
          eventFrame('assistantResponseEvent', {
            assistantResponseEvent: { content: 'wrapped' },
          }),
        ]),
        'auto',
      ),
    );

    await expect(response.text()).resolves.toContain('"content":"wrapped"');
  });

  it('surfaces Kiro exception events from streaming responses', async () => {
    const response = new Response(
      createKiroOpenAiStream(
        streamFrom([eventFrame('accessDeniedException', { message: 'denied' }, 'exception')]),
        'auto',
      ),
    );

    await expect(response.text()).rejects.toThrow('denied');
  });

  it('converts Kiro event-stream output to OpenAI SSE chunks', async () => {
    const source = streamFrom([
      eventFrame('reasoningContentEvent', { text: 'thinking' }),
      eventFrame('assistantResponseEvent', { content: 'hello' }),
      eventFrame('metadataEvent', {
        tokenUsage: {
          uncachedInputTokens: 4,
          cacheReadInputTokens: 1,
          cacheWriteInputTokens: 2,
          outputTokens: 3,
          totalTokens: 10,
        },
      }),
    ]);

    const response = new Response(createKiroOpenAiStream(source, 'auto'));
    const text = await response.text();

    expect(text).toContain('"reasoning_content":"thinking"');
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"prompt_tokens":7');
    expect(text).toContain('data: [DONE]');
  });

  it('keeps the cache breakdown in the normalized usage', async () => {
    const source = streamFrom([
      eventFrame('assistantResponseEvent', { content: 'hello' }),
      eventFrame('metadataEvent', {
        tokenUsage: {
          uncachedInputTokens: 4,
          cacheReadInputTokens: 100,
          cacheWriteInputTokens: 20,
          outputTokens: 3,
          totalTokens: 127,
        },
      }),
    ]);

    const response = new Response(createKiroOpenAiStream(source, 'auto'));
    const text = await response.text();

    expect(text).toContain('"prompt_tokens":124');
    expect(text).toContain('"cache_read_tokens":100');
    expect(text).toContain('"cache_creation_tokens":20');
    expect(text).toContain('"cached_tokens":100');
    expect(text).toContain('"cache_write_tokens":20');
  });

  it('derives the total from prompt and completion when tokenUsage omits it', async () => {
    const source = streamFrom([
      eventFrame('assistantResponseEvent', { content: 'hello' }),
      eventFrame('metadataEvent', {
        tokenUsage: {
          uncachedInputTokens: 10,
          outputTokens: 5,
        },
      }),
    ]);

    const response = new Response(createKiroOpenAiStream(source, 'auto'));

    expect(finalSseUsage(await response.text())).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('ignores contextUsagePercentage and estimates from the text instead', async () => {
    const source = streamFrom([
      eventFrame('assistantResponseEvent', { content: 'hello' }),
      eventFrame('contextUsageEvent', { contextUsagePercentage: 50 }),
    ]);

    const response = new Response(createKiroOpenAiStream(source, 'auto', undefined, 17));

    expect(finalSseUsage(await response.text())).toEqual({
      prompt_tokens: 17,
      completion_tokens: 2,
      total_tokens: 19,
      estimated: true,
    });
  });

  it('estimates usage from the prompt and response for the real Kiro event shape', async () => {
    const source = streamFrom([
      eventFrame('initial-response', { conversationId: 'c1' }),
      eventFrame('assistantResponseEvent', { content: 'x'.repeat(40) }),
      eventFrame('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.01 }),
    ]);

    const response = new Response(
      createKiroOpenAiStream(source, 'claude-sonnet-4.5', undefined, 100),
    );

    expect(finalSseUsage(await response.text())).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      estimated: true,
    });
  });

  it('emits no usage when there is neither a prompt estimate nor output text', async () => {
    const source = streamFrom([eventFrame('messageStopEvent', { stopReason: 'end_turn' })]);

    const response = new Response(createKiroOpenAiStream(source, 'auto'));

    expect(finalSseUsage(await response.text())).toBeUndefined();
  });

  it('estimates usage for a real Kiro stream with no usage event (non-streaming)', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        streamFrom([
          eventFrame('initial-response', { conversationId: 'c1' }),
          eventFrame('assistantResponseEvent', { content: 'Pong' }),
          eventFrame('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.0099 }),
        ]),
        { status: 200 },
      ),
    );

    const response = await forwardKiroChat({
      apiKey: 'ksk_test',
      model: 'claude-sonnet-4.5',
      body: { messages: [{ role: 'user', content: 'Say pong in one word.' }] },
      stream: false,
      timeoutMs: 1000,
    });
    const json = (await response.json()) as {
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        estimated?: boolean;
      };
    };

    expect(json.usage.estimated).toBe(true);
    expect(json.usage.prompt_tokens).toBeGreaterThan(0);
    expect(json.usage.completion_tokens).toBeGreaterThan(0);
    expect(json.usage.total_tokens).toBe(json.usage.prompt_tokens + json.usage.completion_tokens);
  });

  it('includes emitted tool input in the estimated completion tokens', async () => {
    const source = streamFrom([
      eventFrame('assistantResponseEvent', { content: 'x'.repeat(40) }),
      eventFrame('toolUseEvent', { toolUseId: 'call_1', name: 'fn', input: 'abcd', stop: true }),
    ]);

    const response = new Response(
      createKiroOpenAiStream(source, 'claude-sonnet-4.5', undefined, 100),
    );

    expect(finalSseUsage(await response.text())).toEqual({
      prompt_tokens: 100,
      completion_tokens: 12,
      total_tokens: 112,
      estimated: true,
    });
  });

  it('logs an unhandled Kiro event type at debug', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    try {
      const source = streamFrom([
        eventFrame('assistantResponseEvent', { content: 'hello' }),
        eventFrame('someFutureEvent', { detail: 'x' }),
      ]);

      await new Response(createKiroOpenAiStream(source, 'auto')).text();

      expect(debug).toHaveBeenCalledWith('Unhandled Kiro event type: someFutureEvent');
    } finally {
      debug.mockRestore();
    }
  });

  it('converts Kiro toolUseEvent frames into OpenAI tool_calls', async () => {
    const source = streamFrom([
      eventFrame('toolUseEvent', { toolUseId: 'call_1', name: 'bash', input: '{"command":' }),
      eventFrame('toolUseEvent', { toolUseId: 'call_1', name: 'bash', input: '"ls"}', stop: true }),
      eventFrame('messageStopEvent', { stopReason: 'tool_use' }),
    ]);

    const response = new Response(createKiroOpenAiStream(source, 'auto'));
    const text = await response.text();
    const chunks = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            choices: Array<{
              delta: {
                tool_calls?: Array<{
                  index: number;
                  id: string;
                  type: string;
                  function: { name: string; arguments: string };
                }>;
              };
              finish_reason: string | null;
            }>;
          },
      );

    const toolCalls = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []);
    expect(toolCalls).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      },
    ]);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('tool_calls');
    expect(text).toContain('data: [DONE]');
  });

  it('forwards tools and returns Kiro tool calls in the non-streaming completion', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        streamFrom([
          eventFrame('toolUseEvent', {
            toolUseId: 'call_1',
            name: 'read',
            input: '{"path":"a"}',
            stop: true,
          }),
        ]),
        { status: 200 },
      ),
    );

    const response = await forwardKiroChat({
      apiKey: 'ksk_test',
      model: 'auto',
      body: {
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      },
      stream: false,
      timeoutMs: 1000,
    });
    const json = await response.json();

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      conversationState: {
        currentMessage: {
          userInputMessage: { userInputMessageContext: { tools: unknown[] } };
        };
      };
    };
    expect(
      sentBody.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools,
    ).toEqual([
      {
        toolSpecification: {
          name: 'read',
          description: 'Tool: read',
          inputSchema: { json: { type: 'object', properties: {} } },
        },
      },
    ]);

    expect(json.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"a"}' },
          },
        ],
      },
    });
  });

  it('forwards streaming Kiro chat as OpenAI-compatible SSE', async () => {
    mockFetch.mockResolvedValue(
      new Response(streamFrom([eventFrame('assistantResponseEvent', { content: 'hello' })]), {
        status: 200,
      }),
    );

    const response = await forwardKiroChat({
      apiKey: 'ksk_test',
      model: 'auto',
      body: { messages: [{ role: 'user', content: 'Hello' }] },
      stream: true,
      timeoutMs: 1000,
      extraHeaders: { 'x-extra': '1' },
    });

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(mockFetch.mock.calls[0][1].headers['x-extra']).toBe('1');
    expect(await response.text()).toContain('"content":"hello"');
  });

  it('forwards non-streaming Kiro chat and returns OpenAI-compatible JSON', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        streamFrom([
          eventFrame('assistantResponseEvent', { content: 'hel' }),
          eventFrame('assistantResponseEvent', { content: 'lo' }),
          eventFrame('metadataEvent', {
            tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          }),
        ]),
        { status: 200 },
      ),
    );

    const response = await forwardKiroChat({
      apiKey: 'ksk_test',
      model: 'auto',
      body: { messages: [{ role: 'user', content: 'Hello' }] },
      stream: false,
      timeoutMs: 1000,
    });
    const json = await response.json();

    expect(mockFetch).toHaveBeenCalledWith(
      KIRO_BASE_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ksk_test',
          'x-amz-target': KIRO_CHAT_TARGET,
          'x-amzn-kiro-agent-mode': 'SUPERVISED',
        }),
      }),
    );
    expect(json).toMatchObject({
      object: 'chat.completion',
      model: 'auto',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });

  it('passes upstream Kiro errors through unchanged', async () => {
    mockFetch.mockResolvedValue(new Response('forbidden', { status: 403 }));

    const response = await forwardKiroChat({
      apiKey: 'ksk_bad',
      model: 'auto',
      body: { messages: [{ role: 'user', content: 'Hello' }] },
      stream: false,
      timeoutMs: 1000,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('forbidden');
  });

  describe('tool mapping edge cases', () => {
    it('normalizes tool names, defaults descriptions, and cleans schemas', () => {
      const request = buildKiro({
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'a.b',
              parameters: {
                type: 'object',
                properties: { x: { type: 'string' } },
                required: ['x', 'missing'],
                additionalProperties: false,
              },
            },
          },
          { type: 'function', function: { name: 'a..b', parameters: { type: 'object' } } },
          { type: 'function', function: { name: '__' } },
          { type: 'function', function: { name: 'a.b' } },
          { type: 'function' },
          null,
          'nope',
          { name: 'top.level', description: 'plain' },
          { function: { name: 'desc', description: 42, parameters: [] } },
        ],
      });

      const specs = kiroSpecs(request);
      expect(specs.map((spec) => spec.name)).toEqual(['a_b', 'a_b_2', 'tool', 'top_level', 'desc']);
      expect(specs[0].inputSchema.json).toEqual({
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x'],
      });
      expect(specs[3].description).toBe('plain');
      expect(specs[4].description).toBe('Tool: desc');
      expect(specs[4].inputSchema.json).toEqual({ type: 'object', properties: {} });
    });

    it('parses arguments from objects and JSON, generating missing ids', () => {
      const request = buildKiro({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', function: { name: 'x', arguments: { a: 1 } } },
              { function: { name: 'y', arguments: '{"b":2}' } },
              { function: { name: 'z', arguments: 'not json' } },
              { function: { name: 'w', arguments: '42' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'r1' },
          { role: 'tool', tool_call_id: 'call_2', content: 'r2' },
          { role: 'tool', tool_call_id: 'call_3', content: 'r3' },
          { role: 'tool', tool_call_id: 'call_4', content: 'r4' },
        ],
        tools: [
          { function: { name: 'x' } },
          { function: { name: 'y' } },
          { function: { name: 'z' } },
          { function: { name: 'w' } },
        ],
      });

      expect(kiroToolUses(request)?.toolUses).toEqual([
        { toolUseId: 'c1', name: 'x', input: { a: 1 } },
        { toolUseId: 'call_2', name: 'y', input: { b: 2 } },
        { toolUseId: 'call_3', name: 'z', input: {} },
        { toolUseId: 'call_4', name: 'w', input: {} },
      ]);
      expect(
        request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.map(
          (result) => result.toolUseId,
        ),
      ).toEqual(['c1', 'call_2', 'call_3', 'call_4']);
    });

    it('de-duplicates repeated tool-use ids and flattens leftover results', () => {
      const request = buildKiro({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'dup', function: { name: 't', arguments: '{}' } },
              { id: 'dup', function: { name: 't', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'dup', content: 'r1' },
          { role: 'tool', tool_call_id: 'dup', content: 'r2' },
          { role: 'tool', tool_call_id: 'dup', content: 'r3' },
        ],
        tools: [{ function: { name: 't' } }],
      });

      expect(kiroToolUses(request)?.toolUses?.map((use) => use.toolUseId)).toEqual([
        'dup',
        'dup_2',
      ]);
      expect(request.conversationState.currentMessage.userInputMessage.content).toContain(
        '[Tool result: r3]',
      );
    });

    it('falls back to a generated id when a tool-use id has no valid characters', () => {
      const request = buildKiro({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: '***', function: { name: 't', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: '***', content: 'r' },
        ],
        tools: [{ function: { name: 't' } }],
      });

      expect(kiroToolUses(request)?.toolUses?.[0].toolUseId).toBe('call_1_0');
    });

    it('merges consecutive assistant messages with their tool calls', () => {
      const request = buildKiro({
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: 'thinking' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'r' },
        ],
        tools: [{ function: { name: 't' } }],
      });

      expect(kiroToolUses(request)).toMatchObject({
        content: 'thinking',
        toolUses: [{ toolUseId: 'c1', name: 't', input: {} }],
      });
    });

    it('flattens calls to undeclared tools and their results to text', () => {
      const request = buildKiro({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'ghost', arguments: '{"a":1}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'r' },
        ],
        tools: [{ function: { name: 'other' } }],
      });

      expect(kiroToolUses(request)?.content).toBe('...');
      const current = request.conversationState.currentMessage.userInputMessage;
      expect(current.content).toContain('[Tool call: ghost({"a":1})]');
      expect(current.content).toContain('[Tool result: r]');
      expect(current.userInputMessageContext?.toolResults).toBeUndefined();
    });

    it('synthesizes a current user turn for empty or assistant-bounded conversations', () => {
      const empty = buildKiro({ messages: [] });
      expect(empty.conversationState.history).toEqual([]);
      expect(empty.conversationState.currentMessage.userInputMessage.content).toBe('continue');

      const startsAssistant = buildKiro({
        messages: [
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'q' },
        ],
      });
      expect(startsAssistant.conversationState.history[0]).toEqual({
        userInputMessage: { content: 'continue', origin: 'KIRO_CLI' },
      });
      expect(startsAssistant.conversationState.currentMessage.userInputMessage.content).toBe('q');

      const endsAssistant = buildKiro({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
        ],
      });
      expect(endsAssistant.conversationState.currentMessage.userInputMessage.content).toBe(
        'continue',
      );
      expect(endsAssistant.conversationState.history).toEqual([
        { userInputMessage: { content: 'q', origin: 'KIRO_CLI' } },
        { assistantResponseMessage: { content: 'a' } },
      ]);
    });

    it('falls back to a Hello turn for an empty user message', () => {
      expect(
        buildKiro({ messages: [{ role: 'user', content: '' }] }).conversationState.currentMessage
          .userInputMessage.content,
      ).toBe('Hello');

      expect(
        buildKiro({
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: '' },
          ],
        }).conversationState.currentMessage.userInputMessage.content,
      ).toBe('System instructions:\nBe terse.\n\nUser:\nHello');
    });

    it('folds developer instructions and string/array content parts', () => {
      const request = buildKiro({
        messages: [
          { role: 'developer', content: 'dev rules' },
          {
            role: 'user',
            content: ['line1', { type: 'text', text: 'line2' }, { type: 'image_url' }],
          },
        ],
      });

      expect(request.conversationState.currentMessage.userInputMessage.content).toBe(
        'System instructions:\ndev rules\n\nUser:\nline1\nline2\n[image omitted]',
      );
    });

    it('collects tool-use events from object input, arrays, and nested payloads', async () => {
      const source = streamFrom([
        eventFrame('toolUseEvent', { name: 'obj', input: { a: 1 } }),
        eventFrame('toolUseEvent', { toolUseId: 'skip', input: '{}' }),
        eventFrame('toolUseEvent', {
          toolUseEvent: { toolUseId: 'n1', name: 'nested', input: '{"n":1}', stop: true },
        }),
        eventFrame('toolUseEvent', [
          { toolUseId: 'a1', name: 'arr1', input: '{"x":1}' },
          { toolUseId: 'a2', name: 'arr2', input: '{"y":2}' },
        ]),
      ]);

      const response = new Response(createKiroOpenAiStream(source, 'auto'));
      expect(sseToolCalls(await response.text())).toEqual([
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'obj', arguments: '{"a":1}' },
        },
        {
          index: 1,
          id: 'n1',
          type: 'function',
          function: { name: 'nested', arguments: '{"n":1}' },
        },
        { index: 2, id: 'a1', type: 'function', function: { name: 'arr1', arguments: '{"x":1}' } },
        { index: 3, id: 'a2', type: 'function', function: { name: 'arr2', arguments: '{"y":2}' } },
      ]);
    });

    it('surfaces Kiro exception payload variants', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ errorMessage: 'via-errorMessage' }, 'via-errorMessage'],
        [{ error: 'via-error' }, 'via-error'],
        [{}, 'Kiro returned an exception event'],
      ];

      for (const [payload, message] of cases) {
        const response = new Response(
          createKiroOpenAiStream(streamFrom([eventFrame('boom', payload, 'exception')]), 'auto'),
        );
        await expect(response.text()).rejects.toThrow(message);
      }
    });
  });
});
