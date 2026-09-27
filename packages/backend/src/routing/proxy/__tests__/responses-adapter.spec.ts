import {
  collectResponsesSseResponse,
  createResponsesStreamTransformer,
  fromChatCompletionResponse,
  toChatCompletionsRequest,
  toNativeResponsesRequest,
} from '../responses-adapter';

/** Ordered list of every event payload's `type` in a concatenated SSE string. */
function eventTypes(sse: string): string[] {
  const types: string[] = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (json === '[DONE]') {
      types.push('[DONE]');
      continue;
    }
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed?.type === 'string') types.push(parsed.type);
    } catch {
      /* ignore */
    }
  }
  return types;
}

/** Parses the data payload of the first event with the given `type`. */
function firstEventData(sse: string, type: string): Record<string, any> | null {
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice(6).trim();
    if (json === '[DONE]') continue;
    try {
      const parsed = JSON.parse(json);
      if (parsed?.type === type) return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

describe('Responses adapter', () => {
  describe('toChatCompletionsRequest', () => {
    it('converts string input, instructions, tools, and max_output_tokens', () => {
      const result = toChatCompletionsRequest({
        model: 'gpt-5',
        instructions: 'Be concise.',
        input: 'Hello',
        max_output_tokens: 123,
        temperature: 0.2,
        top_p: 0.9,
        stream: true,
        metadata: { trace: 'abc' },
        store: true,
        user: 'user-1',
        parallel_tool_calls: false,
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: 'Lookup data',
            parameters: { type: 'object' },
            strict: true,
          },
        ],
        tool_choice: { type: 'function', name: 'lookup' },
      });

      expect(result.messages).toEqual([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ]);
      expect(result.max_tokens).toBe(123);
      expect(result.temperature).toBe(0.2);
      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Lookup data',
            parameters: { type: 'object' },
            strict: true,
          },
        },
      ]);
      expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
    });

    it('maps Responses json_schema text format to Chat Completions response_format', () => {
      const result = toChatCompletionsRequest({
        input: 'Return patient data.',
        text: {
          format: {
            type: 'json_schema',
            name: 'patient_summary',
            description: 'Structured patient summary',
            schema: {
              type: 'object',
              properties: { summary: { type: 'string' } },
              required: ['summary'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      });

      expect(result.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'patient_summary',
          description: 'Structured patient summary',
          schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
            additionalProperties: false,
          },
          strict: true,
        },
      });
    });

    it('maps Responses json_object text format to Chat Completions response_format', () => {
      const result = toChatCompletionsRequest({
        input: 'Return JSON.',
        text: { format: { type: 'json_object' } },
      });

      expect(result.response_format).toEqual({ type: 'json_object' });
    });

    it('omits Chat Completions response_format for text or absent Responses formats', () => {
      expect(
        toChatCompletionsRequest({
          input: 'Return text.',
          text: { format: { type: 'text' } },
        }),
      ).not.toHaveProperty('response_format');
      expect(toChatCompletionsRequest({ input: 'Return text.' })).not.toHaveProperty(
        'response_format',
      );
    });

    it('converts item lists, images, function calls, and tool outputs', () => {
      const result = toChatCompletionsRequest({
        input: [
          'first',
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'look' },
              { type: 'input_image', image_url: 'https://example.test/image.png' },
            ],
          },
          { role: 'user', content: [{ type: 'input_text', text: 'single text' }] },
          { role: 'user', content: [{ type: 'input_audio', audio: 'abc' }] },
          { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
          { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
          { type: 'function_call_output', call_id: 'call_1', output: { ok: true } },
        ],
        tools: [{ type: 'web_search_preview' }],
        tool_choice: 'auto',
      });

      expect(result.messages).toEqual([
        { role: 'user', content: 'first' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
          ],
        },
        { role: 'user', content: 'single text' },
        { role: 'user', content: [{ type: 'input_audio', audio: 'abc' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ]);
      expect(result.tools).toEqual([]);
      expect(result.tool_choice).toBe('auto');
    });

    it('folds role:"developer" instruction messages into "system"', () => {
      const result = toChatCompletionsRequest({
        input: [
          { role: 'developer', content: [{ type: 'input_text', text: 'You are concise.' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
        ],
      });

      expect(result.messages).toEqual([
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Hi' },
      ]);
    });

    it('drops hosted tools and keeps only function tools', () => {
      const result = toChatCompletionsRequest({
        input: 'go',
        tools: [
          { type: 'web_search' },
          { type: 'file_search' },
          { type: 'computer_use_preview' },
          { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        ],
      });

      expect(result.tools).toEqual([
        { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
      ]);
    });

    it('drops non-message input items that have no chat-completions equivalent', () => {
      const result = toChatCompletionsRequest({
        instructions: 'You are a helpful assistant.',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'total?' }] },
          {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'gAAAAA',
            summary: [{ type: 'summary_text', text: 'thinking about the totals' }],
          },
          { type: 'item_reference', id: 'msg_1' },
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
        ],
      });

      expect(result.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'total?' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ]);
    });

    it('never emits a message without content for reasoning items', () => {
      const result = toChatCompletionsRequest({
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAA' },
        ],
      });
      const messages = result.messages as Record<string, unknown>[];

      expect(messages).toHaveLength(1);
      for (const message of messages) {
        expect(Object.prototype.hasOwnProperty.call(message, 'content')).toBe(true);
        expect(message.content).not.toBeUndefined();
      }
      expect(JSON.stringify(messages)).not.toContain('{"role":"user"}');
    });

    it('drops message items that carry no content at all', () => {
      const result = toChatCompletionsRequest({
        input: [
          { type: 'message', role: 'user' },
          { role: 'assistant' },
          { role: 'user', content: [{ type: 'input_text', text: 'still here' }] },
        ],
      });

      expect(result.messages).toEqual([{ role: 'user', content: 'still here' }]);
    });

    it('uses safe defaults for malformed input items', () => {
      const result = toChatCompletionsRequest({
        input: [
          42,
          { role: 1, content: 7 },
          { type: 'function_call' },
          { type: 'function_call_output', output: undefined },
        ],
      });
      const messages = result.messages as Record<string, unknown>[];

      expect(messages[0]).toEqual({ role: 'user', content: 7 });
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', function: { name: 'unknown', arguments: '{}' } }],
      });
      expect(messages[2]).toMatchObject({ role: 'tool', content: '' });
    });
  });

  it('builds native Responses requests with resolved model and default flags', () => {
    expect(toNativeResponsesRequest({ input: 'hi' }, 'gpt-4o')).toEqual({
      input: 'hi',
      model: 'gpt-4o',
      stream: false,
      store: false,
    });
    expect(toNativeResponsesRequest({ input: 'hi', stream: true, store: true }, 'gpt-4o')).toEqual({
      input: 'hi',
      model: 'gpt-4o',
      stream: true,
      store: true,
    });
  });

  it('can add default instructions for native Responses backends that require them', () => {
    expect(
      toNativeResponsesRequest({ input: 'hi' }, 'gpt-5.4', { defaultInstructions: true }),
    ).toMatchObject({
      input: 'hi',
      model: 'gpt-5.4',
      instructions: 'You are a helpful assistant.',
    });

    expect(
      toNativeResponsesRequest(
        { input: 'hi', instructions: 'Follow the house style.' },
        'gpt-5.4',
        { defaultInstructions: true },
      ).instructions,
    ).toBe('Follow the house style.');
  });

  it('can normalize SDK Responses input for native backends that require input lists', () => {
    expect(toNativeResponsesRequest({ input: 'hi' }, 'gpt-5.4', { inputList: true }).input).toEqual(
      [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    );

    expect(
      toNativeResponsesRequest(
        {
          input: [
            'first',
            { role: 'user', content: 'second' },
            { role: 'assistant', content: [{ type: 'text', text: 'third' }] },
            { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
            42,
          ],
        },
        'gpt-5.4',
        { inputList: true },
      ).input,
    ).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'third' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ]);
  });

  it('passes typed non-message Responses items through when normalizing native input', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const itemReference = { type: 'item_reference', id: 'fc_1' };
    const result = toNativeResponsesRequest(
      {
        input: [{ type: 'message', role: 'user', content: 'hello' }, reasoning, itemReference],
      },
      'gpt-5.4',
    ).input as unknown[];

    expect(result).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      reasoning,
      itemReference,
    ]);
    expect(result[1]).toBe(reasoning);
    expect(result[2]).toBe(itemReference);
  });

  it('does not add roles to typed non-message Responses items in native input lists', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const itemReference = { type: 'item_reference', id: 'fc_1' };
    const result = toNativeResponsesRequest(
      {
        input: [
          { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          reasoning,
          itemReference,
        ],
      },
      'gpt-5.4',
      { inputList: true },
    ).input as unknown[];

    expect(result).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      reasoning,
      itemReference,
    ]);
    expect(result[1]).toBe(reasoning);
    expect(result[2]).toBe(itemReference);
  });

  it('normalizes legacy image_url content parts in native Responses input lists', () => {
    expect(
      toNativeResponsesRequest(
        {
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'look' },
                {
                  type: 'image_url',
                  image_url: { url: 'https://example.test/image.png', detail: 'low' },
                },
              ],
            },
          ],
        },
        'gpt-5.4',
      ).input,
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          {
            type: 'input_image',
            image_url: 'https://example.test/image.png',
            detail: 'low',
          },
        ],
      },
    ]);
  });

  it('can force streaming for native backends that always return SSE', () => {
    expect(
      toNativeResponsesRequest({ input: 'hi', stream: false }, 'gpt-5.4', {
        forceStream: true,
      }).stream,
    ).toBe(true);
  });

  it('strips Codex-subscription unsupported params and forces store=false', () => {
    const result = toNativeResponsesRequest(
      {
        input: 'hi',
        temperature: 0.3,
        top_p: 0.5,
        max_output_tokens: 50,
        metadata: { x: '1' },
        safety_identifier: 'probe',
        prompt_cache_retention: '24h',
        truncation: 'auto',
        store: true,
      },
      'gpt-5.4-mini',
      { stripCodexUnsupported: true },
    );
    expect(result).not.toHaveProperty('temperature');
    expect(result).not.toHaveProperty('top_p');
    expect(result).not.toHaveProperty('max_output_tokens');
    expect(result).not.toHaveProperty('metadata');
    expect(result).not.toHaveProperty('safety_identifier');
    expect(result).not.toHaveProperty('prompt_cache_retention');
    expect(result).not.toHaveProperty('truncation');
    expect(result.store).toBe(false);
  });

  it('preserves Codex-subscription unsupported params when the strip flag is off', () => {
    const result = toNativeResponsesRequest(
      { input: 'hi', temperature: 0.3, top_p: 0.5 },
      'gpt-5.4-mini',
    );
    expect(result.temperature).toBe(0.3);
    expect(result.top_p).toBe(0.5);
  });

  describe('duplicate call_id normalization', () => {
    const call = (callId: string, name: string, args: string) => ({
      type: 'function_call',
      call_id: callId,
      name,
      arguments: args,
    });
    const output = (callId: string, text: string) => ({
      type: 'function_call_output',
      call_id: callId,
      output: text,
    });

    it('gives repeated call/output pairs unique ids without touching the payloads', () => {
      const result = toNativeResponsesRequest(
        {
          input: [
            { role: 'user', content: 'run it' },
            call('terminal:0', 'terminal', '{"cmd":"ls"}'),
            output('terminal:0', 'one'),
            call('vision_analyze:0', 'vision_analyze', '{"id":1}'),
            output('vision_analyze:0', 'first look'),
            call('terminal:0', 'terminal', '{"cmd":"pwd"}'),
            output('terminal:0', 'two'),
            call('vision_analyze:0', 'vision_analyze', '{"id":2}'),
            output('vision_analyze:0', 'second look'),
            call('terminal:0', 'terminal', '{"cmd":"whoami"}'),
            output('terminal:0', 'three'),
          ],
        },
        'muse-spark-1.3-contributor',
      );

      expect(result.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        call('terminal:0', 'terminal', '{"cmd":"ls"}'),
        output('terminal:0', 'one'),
        call('vision_analyze:0', 'vision_analyze', '{"id":1}'),
        output('vision_analyze:0', 'first look'),
        call('terminal:0-mnfst-2', 'terminal', '{"cmd":"pwd"}'),
        output('terminal:0-mnfst-2', 'two'),
        call('vision_analyze:0-mnfst-2', 'vision_analyze', '{"id":2}'),
        output('vision_analyze:0-mnfst-2', 'second look'),
        call('terminal:0-mnfst-3', 'terminal', '{"cmd":"whoami"}'),
        output('terminal:0-mnfst-3', 'three'),
      ]);
    });

    it('extends a replacement id that the history already uses', () => {
      const result = toNativeResponsesRequest(
        {
          input: [
            call('terminal:0', 'terminal', '{}'),
            output('terminal:0', 'one'),
            call('terminal:0-mnfst-2', 'terminal', '{}'),
            output('terminal:0-mnfst-2', 'other tool'),
            call('terminal:0', 'terminal', '{}'),
            output('terminal:0', 'two'),
          ],
        },
        'muse-spark-1.3-contributor',
      );

      expect(result.input).toEqual([
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'one'),
        call('terminal:0-mnfst-2', 'terminal', '{}'),
        output('terminal:0-mnfst-2', 'other tool'),
        call('terminal:0-mnfst-2-x', 'terminal', '{}'),
        output('terminal:0-mnfst-2-x', 'two'),
      ]);
    });

    it('leaves unique, ambiguous, and id-less histories untouched', () => {
      const unique = [
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'one'),
        call('terminal:1', 'terminal', '{}'),
        output('terminal:1', 'two'),
      ];
      expect(toNativeResponsesRequest({ input: unique }, 'gpt-5.4').input).toEqual(unique);

      // Two calls in a row: which output belongs to which call is a guess.
      const unpaired = [
        call('terminal:0', 'terminal', '{}'),
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'one'),
        output('terminal:0', 'two'),
      ];
      expect(toNativeResponsesRequest({ input: unpaired }, 'gpt-5.4').input).toEqual(unpaired);

      // An output with no matching call leaves an odd number of entries.
      const orphan = [
        output('terminal:0', 'one'),
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'two'),
      ];
      expect(toNativeResponsesRequest({ input: orphan }, 'gpt-5.4').input).toEqual(orphan);

      const idLess = ['plain', { type: 'reasoning', id: 'rs_1' }, { type: 'function_call' }];
      expect(toNativeResponsesRequest({ input: idLess }, 'gpt-5.4').input).toEqual(idLess);
    });

    it('leaves ids alone when the provider holds the earlier turns', () => {
      const input = [
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'one'),
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'two'),
      ];

      expect(
        toNativeResponsesRequest({ input, previous_response_id: 'resp_123' }, 'gpt-5.4').input,
      ).toEqual(input);
      expect(
        toNativeResponsesRequest({ input, previous_response_id: '' }, 'gpt-5.4').input,
      ).toEqual([
        call('terminal:0', 'terminal', '{}'),
        output('terminal:0', 'one'),
        call('terminal:0-mnfst-2', 'terminal', '{}'),
        output('terminal:0-mnfst-2', 'two'),
      ]);
    });

    it('normalizes ids on backends that require input lists', () => {
      const result = toNativeResponsesRequest(
        {
          input: [
            call('terminal:0', 'terminal', '{}'),
            output('terminal:0', 'one'),
            call('terminal:0', 'terminal', '{}'),
            output('terminal:0', 'two'),
          ],
        },
        'gpt-5.4',
        { inputList: true },
      );

      expect((result.input as Record<string, unknown>[]).map((item) => item.call_id)).toEqual([
        'terminal:0',
        'terminal:0',
        'terminal:0-mnfst-2',
        'terminal:0-mnfst-2',
      ]);
    });

    it('keeps a non-list input as it was sent', () => {
      expect(toNativeResponsesRequest({ input: 'hi' }, 'gpt-5.4').input).toBe('hi');
    });
  });

  describe('fromChatCompletionResponse', () => {
    it('converts text, tool calls, and usage to a Response object', () => {
      const result = fromChatCompletionResponse(
        {
          id: 'chatcmpl_1',
          object: 'chat.completion',
          created: 1234,
          model: 'gpt-4o',
          choices: [
            {
              message: {
                content: [{ type: 'text', text: 'Hello' }],
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"id":1}' },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13,
            cache_read_tokens: 4,
            cache_creation_tokens: 2,
          },
        },
        'fallback-model',
      );

      expect(result.object).toBe('response');
      expect(result.created_at).toBe(1234);
      expect(result.model).toBe('gpt-4o');
      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
        }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"id":1}',
        }),
      ]);
      expect(result.usage).toEqual({
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 13,
      });
    });

    it('handles missing choices, non-string content, and missing usage', () => {
      const result = fromChatCompletionResponse({ choices: [{ message: { content: 7 } }] }, 'm');
      expect(result.model).toBe('m');
      expect(result.output).toEqual([]);
      expect(result.usage).toBeNull();
    });

    it('keeps tool calls when the structured-output tool name does not match', () => {
      const result = fromChatCompletionResponse(
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"id":1}' },
                  },
                ],
              },
            },
          ],
        },
        'claude-sonnet-4',
        { structuredOutputToolName: 'patient_summary' },
      );

      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"id":1}',
        }),
      ]);
    });

    it('uses safe defaults for malformed structured-output tool calls', () => {
      const result = fromChatCompletionResponse(
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  null,
                  { id: 'bad_call', type: 'function' },
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'patient_summary' },
                  },
                ],
              },
            },
          ],
        },
        'claude-sonnet-4',
        {
          structuredOutputToolName: 'patient_summary',
          textFormat: { type: 'text' },
        },
      );

      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{}', annotations: [] }],
        }),
      ]);
      expect(result.text).toEqual({ format: { type: 'text' } });
    });

    it('unwraps the configured structured-output tool call into response text', () => {
      const schema = { type: 'object', properties: { title: { type: 'string' } } };
      const result = fromChatCompletionResponse(
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'patient_summary', arguments: '{"title":"ok"}' },
                  },
                ],
              },
            },
          ],
        },
        'claude-sonnet-4',
        {
          structuredOutputToolName: 'patient_summary',
          textFormat: {
            type: 'json_schema',
            name: 'patient_summary',
            description: 'Patient summary',
            schema,
            strict: true,
          },
        },
      );

      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"title":"ok"}', annotations: [] }],
        }),
      ]);
      expect(result.text).toEqual({
        format: {
          type: 'json_schema',
          name: 'patient_summary',
          description: 'Patient summary',
          schema,
          strict: true,
        },
      });
    });
  });

  describe('collectResponsesSseResponse', () => {
    it('returns the completed response object when present', () => {
      const response = {
        id: 'resp_1',
        object: 'response',
        output: [{ type: 'message' }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      };
      const result = collectResponsesSseResponse(
        `event: response.completed\ndata: ${JSON.stringify({ response })}\n\n`,
      );

      expect(result).toEqual(response);
    });

    it('keeps collected text when the completed response omits output', () => {
      const response = {
        id: 'resp_1',
        object: 'response',
        output: [],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      };
      const result = collectResponsesSseResponse(
        [
          'event: response.output_text.delta\ndata: {"delta":"Hi"}',
          `event: response.completed\ndata: ${JSON.stringify({ response })}`,
          '',
        ].join('\n\n'),
      );

      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
        }),
      ]);
    });

    it('falls back to collected output text and ignores malformed events', () => {
      const result = collectResponsesSseResponse(
        [
          'event: response.output_text.delta\ndata: {"delta":"Hi"}',
          'event: response.output_text.delta\ndata: not-json',
          '',
        ].join('\n\n'),
      );

      expect(result.object).toBe('response');
      expect(result.output).toEqual([
        expect.objectContaining({
          type: 'message',
          content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
        }),
      ]);
    });

    it('collects function_call items emitted via output_item.added + arguments.delta', () => {
      // Codex Responses streams the tool call via item.added + delta events
      // and ships `response.completed` with `output: []`. Without the SSE
      // collector picking up these events, the SDK sees an empty output
      // array even though tokens were billed.
      const completed = {
        id: 'resp_1',
        object: 'response',
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      };
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"city\\":"}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"\\"Paris\\"}"}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(
        expect.objectContaining({
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
        }),
      );
    });

    it('preserves text output alongside a function call at a non-zero output_index', () => {
      const completed = {
        id: 'resp_2',
        object: 'response',
        output: [],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      };
      const sse = [
        'event: response.output_text.delta\ndata: {"delta":"Let me check."}',
        'event: response.output_item.added\ndata: {"output_index":1,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"search"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":1,"delta":"{\\"q\\":\\"test\\"}"}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      // Text-then-function order is preserved: text first (added by
      // withCollectedTextOutput), function_call second.
      expect(output).toHaveLength(2);
      expect(output[0]).toEqual(
        expect.objectContaining({
          type: 'message',
          content: [{ type: 'output_text', text: 'Let me check.', annotations: [] }],
        }),
      );
      expect(output[1]).toEqual(
        expect.objectContaining({
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'search',
          arguments: '{"q":"test"}',
        }),
      );
    });

    it('prefers the authoritative item from response.output_item.done', () => {
      const completed = {
        id: 'resp_3',
        object: 'response',
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      };
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_3","call_id":"call_3","name":"get_weather"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"city\\":"}',
        // Truncate the partial deltas — `done` carries the authoritative state.
        'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_3","call_id":"call_3","name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}","status":"completed"}}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(
        expect.objectContaining({
          type: 'function_call',
          id: 'fc_3',
          arguments: '{"city":"Paris"}',
          status: 'completed',
        }),
      );
    });

    it('reads final args from response.function_call_arguments.done with nested item shape', () => {
      // Documented Responses-API variant: { output_index, item: { arguments } }.
      const completed = {
        id: 'resp_done_nested',
        object: 'response',
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      };
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_n","call_id":"call_n","name":"get_weather"}}',
        'event: response.function_call_arguments.done\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_n","call_id":"call_n","name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(
        expect.objectContaining({ id: 'fc_n', arguments: '{"city":"Paris"}' }),
      );
    });

    it('uses response.function_call_arguments.done as the authoritative final arguments', () => {
      // Some streams skip per-character deltas (e.g. no-argument calls) and
      // only ship the final argument string via `.arguments.done`.
      const completed = {
        id: 'resp_done',
        object: 'response',
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      };
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_d","call_id":"call_d","name":"get_weather"}}',
        'event: response.function_call_arguments.done\ndata: {"output_index":0,"item_id":"fc_d","arguments":"{\\"city\\":\\"Paris\\"}"}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(
        expect.objectContaining({
          type: 'function_call',
          id: 'fc_d',
          arguments: '{"city":"Paris"}',
        }),
      );
    });

    it('does not duplicate function_call items already present in completed.output', () => {
      const completed = {
        id: 'resp_4',
        object: 'response',
        output: [
          {
            type: 'function_call',
            id: 'fc_4',
            call_id: 'call_4',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
            status: 'completed',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      };
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","id":"fc_4","call_id":"call_4","name":"get_weather"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"city\\":\\"Paris\\"}"}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(
        expect.objectContaining({ id: 'fc_4', arguments: '{"city":"Paris"}' }),
      );
    });

    it('dedupes by call_id when streamed item omits the output id', () => {
      // Upstream may emit `output_item.added` without `item.id` while still
      // including the call already in `completed.output`. Without call_id
      // dedupe we would append a duplicate and the SDK caller would execute
      // the same tool twice.
      const completed = {
        id: 'resp_5',
        object: 'response',
        output: [
          {
            type: 'function_call',
            id: 'fc_5',
            call_id: 'call_5',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
            status: 'completed',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      };
      const sse = [
        // No `id` on the streamed item — only call_id is reliably present.
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"call_5","name":"get_weather"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"city\\":\\"Paris\\"}"}',
        `event: response.completed\ndata: ${JSON.stringify({ response: completed })}`,
        '',
      ].join('\n\n');

      const result = collectResponsesSseResponse(sse);
      const output = result.output as Array<Record<string, unknown>>;

      expect(output).toHaveLength(1);
      expect(output[0]).toEqual(expect.objectContaining({ id: 'fc_5', call_id: 'call_5' }));
    });
  });

  describe('createResponsesStreamTransformer', () => {
    it('opens the message item and content part before the first text delta', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      const out =
        t.transform('{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}') ?? '';

      // Lifecycle envelope must precede the delta so strict Responses clients
      // (Pi/OpenClaw) accept the text instead of rendering an empty message.
      expect(eventTypes(out)).toEqual([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
      ]);

      const added = firstEventData(out, 'response.output_item.added')!;
      expect(added.item).toMatchObject({
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
      });
      expect(added.item.content).toEqual([]);

      // The delta must reference the same item_id the item was opened with.
      const delta = firstEventData(out, 'response.output_text.delta')!;
      expect(delta.item_id).toBe(added.item.id);
      expect(delta.delta).toBe('Hello');
    });

    it('opens the item exactly once across multiple deltas', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      t.transform('{"choices":[{"delta":{"content":"Hel"}}]}');
      const second = t.transform('{"choices":[{"delta":{"content":"lo"}}]}') ?? '';

      expect(eventTypes(second)).toEqual(['response.output_text.delta']);
      expect(firstEventData(second, 'response.output_text.delta')!.delta).toBe('lo');
    });

    it('closes the part and item and emits a populated completed event with [DONE]', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      const opened = t.transform('{"choices":[{"delta":{"content":"Hello"}}]}') ?? '';
      t.transform('{"choices":[{"delta":{"content":"!"}}]}');
      const tail =
        t.transform(
          '{"model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1576,"completion_tokens":32,"total_tokens":1608}}',
        ) ?? '';
      const end = t.finalize() ?? '';

      expect(eventTypes(end)).toEqual([
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
        '[DONE]',
      ]);

      const itemId = firstEventData(opened, 'response.output_item.added')!.item.id;
      const textDone = firstEventData(end, 'response.output_text.done')!;
      expect(textDone.text).toBe('Hello!');
      expect(textDone.item_id).toBe(itemId);

      const itemDone = firstEventData(end, 'response.output_item.done')!;
      expect(itemDone.item.id).toBe(itemId);
      expect(itemDone.item.status).toBe('completed');
      expect(itemDone.item.content).toEqual([
        { type: 'output_text', text: 'Hello!', annotations: [] },
      ]);

      // The completed event must carry the assembled message in `output`
      // (the bug: it shipped `output: []`), plus usage and a matching id.
      const completed = firstEventData(end, 'response.completed')!;
      expect(completed.response.status).toBe('completed');
      expect(completed.response.output).toEqual([
        expect.objectContaining({
          id: itemId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
        }),
      ]);
      expect(completed.response.usage).toMatchObject({
        input_tokens: 1576,
        output_tokens: 32,
        total_tokens: 1608,
      });
      // `finish_reason` chunk carried no text delta, so the tail before finalize
      // is empty.
      expect(tail).toBe('');
    });

    it('streams configured structured-output tool arguments as response text', () => {
      const t = createResponsesStreamTransformer('claude-sonnet-4', {
        structuredOutputToolName: 'patient_summary',
        textFormat: { type: 'json_object' },
      });
      const first =
        t.transform(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_1","function":{"name":"patient_summary","arguments":"{\\"title\\""}}]}}]}\n\n',
        ) ?? '';
      const second =
        t.transform(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"ok\\"}"}}]}}]}\n\n',
        ) ?? '';
      const end = t.finalize() ?? '';

      expect(firstEventData(first, 'response.output_text.delta')!.delta).toBe('{"title"');
      expect(firstEventData(second, 'response.output_text.delta')!.delta).toBe(':"ok"}');
      const completed = firstEventData(end, 'response.completed')!;
      expect(completed.response.output).toEqual([
        expect.objectContaining({
          type: 'message',
          content: [{ type: 'output_text', text: '{"title":"ok"}', annotations: [] }],
        }),
      ]);
      expect(completed.response.text).toEqual({ format: { type: 'json_object' } });
    });

    it('ignores malformed structured-output stream tool-call entries', () => {
      const t = createResponsesStreamTransformer('claude-sonnet-4', {
        structuredOutputToolName: 'patient_summary',
      });
      const out =
        t.transform(
          'data: {"choices":[{"delta":{"tool_calls":[null,{"index":1},{"function":{"name":"patient_summary","arguments":"{}"}}]}}]}\n\n',
        ) ?? '';

      expect(firstEventData(out, 'response.output_text.delta')!.delta).toBe('{}');
      const completed = firstEventData(t.finalize() ?? '', 'response.completed')!;
      expect(completed.response.output).toEqual([
        expect.objectContaining({
          type: 'message',
          content: [{ type: 'output_text', text: '{}', annotations: [] }],
        }),
      ]);
    });

    it('emits no item events and an empty output for usage-only streams', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      const out =
        t.transform(
          '{"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":0,"total_tokens":5}}',
        ) ?? '';
      const end = t.finalize() ?? '';

      expect(eventTypes(out)).toEqual(['response.created', 'response.in_progress']);
      expect(eventTypes(end)).toEqual(['response.completed', '[DONE]']);
      expect(firstEventData(end, 'response.completed')!.response.output).toEqual([]);
      expect(firstEventData(end, 'response.completed')!.response.usage).toMatchObject({
        input_tokens: 5,
      });
    });

    it('still emits created, completed, and [DONE] when the stream is empty', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      const end = t.finalize() ?? '';

      expect(eventTypes(end)).toEqual([
        'response.created',
        'response.in_progress',
        'response.completed',
        '[DONE]',
      ]);
    });

    it('finalize is idempotent and returns null after the stream is closed', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      expect(t.finalize()).not.toBeNull();
      expect(t.finalize()).toBeNull();
    });

    it('ignores done, empty, malformed, and irrelevant payloads', () => {
      const t = createResponsesStreamTransformer('gpt-4o');
      expect(t.transform('data: [DONE]\n\n')).toBeNull();
      expect(t.transform('')).toBeNull();
      expect(t.transform('data: not-json\n\n')).toBeNull();
    });

    it('keeps created_at stable across created and completed as the clock advances', () => {
      // Advance the wall clock on every Date.now() so a re-derived timestamp
      // would drift between the opening and closing snapshots of the same id.
      let now = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
      try {
        const t = createResponsesStreamTransformer('gpt-4o');
        const opened = t.transform('{"choices":[{"delta":{"content":"Hi"}}]}') ?? '';
        const end = t.finalize() ?? '';

        const created = firstEventData(opened, 'response.created')!;
        const completed = firstEventData(end, 'response.completed')!;
        expect(completed.response.id).toBe(created.response.id);
        expect(completed.response.created_at).toBe(created.response.created_at);
        // completed_at must reflect the actual finalize time, not the
        // stream-start timestamp reused for created_at.
        expect(completed.response.completed_at).toBeGreaterThan(completed.response.created_at);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
