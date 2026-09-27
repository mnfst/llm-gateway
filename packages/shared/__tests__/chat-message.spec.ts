import {
  coerceContentToText,
  extractRecordedConversationMessages,
  extractRequestMessages,
  extractRequestTools,
  extractResponseMessages,
  extractResponseToolCalls,
  normalizeRole,
} from '../src/chat-message';

describe('recorded chat message helpers', () => {
  it('normalizes provider roles without inventing known roles', () => {
    expect(['system', 'user', 'assistant', 'tool'].map(normalizeRole)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(normalizeRole('model')).toBe('assistant');
    expect(normalizeRole('developer')).toBe('unknown');
  });

  it('renders multimodal and provider-specific content as compact text', () => {
    expect(coerceContentToText(null)).toBe('');
    expect(
      coerceContentToText([
        'plain',
        42,
        { text: 'caption' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,secret' } },
        { type: 'input_image' },
        { type: 'image' },
        { type: 'tool_result', content: [{ text: 'tool output' }] },
        { functionResponse: { response: { ok: true } } },
        { type: 'unknown' },
      ]),
    ).toBe('plain\ncaption\n[image]\n[image]\n[image]\ntool output\n{"ok":true}');
    expect(coerceContentToText({ nested: true })).toBe('{"nested":true}');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(coerceContentToText(circular)).toBe('[object Object]');
  });

  it('ignores empty system prompts and malformed message entries', () => {
    expect(extractRequestMessages(null)).toEqual([]);
    expect(extractRequestMessages({ system: '', messages: [null] })).toEqual([]);
  });

  it('reads Anthropic system prompts, tool calls, and tool results', () => {
    expect(
      extractRequestMessages({
        system: 'Be concise.',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'weather', input: { city: 'Paris' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Sunny' }],
          },
        ],
      }),
    ).toEqual([
      { role: 'system', content: 'Be concise.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: { name: 'weather', arguments: { city: 'Paris' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tool-1', content: 'Sunny' },
    ]);
  });

  it('keeps Anthropic text and primitive content blocks', () => {
    expect(
      extractRequestMessages({
        messages: [
          {
            role: 'assistant',
            content: ['preface', { type: 'text', text: 'answer' }],
          },
        ],
      }),
    ).toEqual([
      {
        role: 'assistant',
        content: ['preface', { type: 'text', text: 'answer' }],
      },
    ]);
  });

  it('keeps optional Anthropic tool metadata optional', () => {
    expect(
      extractRequestMessages({
        messages: [
          {
            content: [{ type: 'tool_use' }, { type: 'tool_result', content: 'No id' }],
          },
        ],
      }),
    ).toEqual([
      {
        role: 'unknown',
        content: null,
        tool_calls: [
          {
            id: undefined,
            type: 'function',
            function: { name: undefined, arguments: undefined },
          },
        ],
      },
      { role: 'tool', tool_call_id: undefined, content: 'No id' },
    ]);
  });

  it('reads instructions and Responses API input items', () => {
    expect(
      extractRequestMessages({
        instructions: 'Use short answers.',
        input: [
          'Hello',
          { type: 'function_call', id: 'call-fallback' },
          { type: 'function_call_output' },
          { type: 'message', content: 'Continue' },
          { type: 'function_call' },
          { type: 'function_call_output', call_id: 'call-output', output: 'Done' },
          { type: 'message', role: 'assistant', content: 'Finished' },
          { type: 'computer_call', id: 'ignored' },
        ],
      }),
    ).toEqual([
      { role: 'system', content: 'Use short answers.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-fallback',
            type: 'function',
            function: { name: 'unknown', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: undefined, content: '' },
      { role: 'user', content: 'Continue' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: undefined,
            type: 'function',
            function: { name: 'unknown', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-output', content: 'Done' },
      { role: 'assistant', content: 'Finished' },
    ]);
    expect(extractRequestMessages({ input: 'A plain prompt' })).toEqual([
      { role: 'user', content: 'A plain prompt' },
    ]);
  });

  it('reads Gemini system instructions and normalizes model roles', () => {
    expect(
      extractRequestMessages({
        systemInstruction: {
          parts: [{ text: 'Be concise.' }, { text: 'Use metric units.' }],
        },
        contents: [
          { role: 'model', parts: [{ text: 'Answer' }] },
          { role: 'custom', parts: [{ text: 'Custom' }] },
          { parts: [{ text: 'Prompt' }] },
          'ignored',
        ],
      }),
    ).toEqual([
      { role: 'system', content: 'Be concise.\nUse metric units.' },
      { role: 'assistant', content: [{ text: 'Answer' }] },
      { role: 'custom', content: [{ text: 'Custom' }] },
      { role: 'user', content: [{ text: 'Prompt' }] },
    ]);
  });

  it('unwraps Gemini CodeAssist request envelopes', () => {
    expect(
      extractRequestMessages({
        model: 'gemini-2.5-pro',
        project: 'project-id',
        request: {
          systemInstruction: { parts: [{ text: 'Answer in French.' }] },
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        },
      }),
    ).toEqual([
      { role: 'system', content: 'Answer in French.' },
      { role: 'user', content: [{ text: 'Hello' }] },
    ]);
  });

  it('normalizes Anthropic tool definitions', () => {
    expect(
      extractRequestTools({
        tools: [{ name: 'weather', description: 'Get weather', input_schema: { type: 'object' } }],
      }),
    ).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Get weather',
          parameters: { type: 'object' },
        },
      },
    ]);
  });

  it('normalizes OpenAI tool definitions', () => {
    expect(
      extractRequestTools({
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              description: 'Get weather',
              parameters: { type: 'object' },
            },
          },
          { function: {} },
          { type: 'custom', parameters: { type: 'string' } },
          {},
          null,
        ],
      }),
    ).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Get weather',
          parameters: { type: 'object' },
        },
      },
      {
        type: 'function',
        function: {
          name: undefined,
          description: undefined,
          parameters: undefined,
        },
      },
      {
        type: 'custom',
        function: {
          name: undefined,
          description: undefined,
          parameters: { type: 'string' },
        },
      },
      {
        type: 'function',
        function: {
          name: undefined,
          description: undefined,
          parameters: undefined,
        },
      },
    ]);
    expect(extractRequestTools(null)).toEqual([]);
  });

  it('reads JSON responses from each supported API format', () => {
    expect(
      extractResponseMessages({
        type: 'json',
        body: { choices: [{ message: { role: 'assistant', content: 'OpenAI' } }] },
      }),
    ).toEqual([{ role: 'assistant', content: 'OpenAI' }]);
    expect(
      extractResponseMessages({
        type: 'json',
        body: {
          output: [
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'lookup',
              arguments: '{"city":"Paris"}',
            },
          ],
        },
      }),
    ).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ]);
    expect(
      extractResponseMessages({
        type: 'json',
        body: {
          type: 'message',
          content: [{ type: 'text', text: 'Anthropic' }],
        },
      }),
    ).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Anthropic' }],
      },
    ]);
    expect(
      extractResponseMessages({
        type: 'json',
        body: {
          candidates: [{ content: { parts: [{ text: 'Gemini' }] } }],
        },
      }),
    ).toEqual([{ role: 'assistant', content: [{ text: 'Gemini' }] }]);
  });

  it('returns no response messages for malformed or unsupported JSON', () => {
    expect(extractResponseMessages({ type: 'json', body: { choices: [null] } })).toEqual([]);
    expect(extractResponseMessages({ type: 'json', body: { candidates: [null] } })).toEqual([]);
    expect(extractResponseMessages({ type: 'json', body: { unsupported: true } })).toEqual([]);
    expect(extractResponseMessages({ type: 'json', body: 'not an object' })).toEqual([]);
    expect(extractResponseMessages(null)).toEqual([]);
  });

  it('reconstructs assistant text from a captured SSE response', () => {
    expect(
      extractRecordedConversationMessages(
        { messages: [{ role: 'user', content: 'Hello' }] },
        {
          type: 'stream',
          raw_sse:
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n',
        },
      ),
    ).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('reconstructs Gemini streaming text from candidate parts', () => {
    expect(
      extractResponseMessages({
        type: 'stream',
        raw_sse: [
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello! ","thoughtSignature":"signature"}],"role":"model"},"index":0}]}',
          'data: {"candidates":[{"content":{"parts":[{"text":"How can I help?"}],"role":"model"},"finishReason":"STOP","index":0}]}',
        ].join('\r\n\r\n'),
      }),
    ).toEqual([{ role: 'assistant', content: 'Hello! How can I help?' }]);
  });

  it('reconstructs Responses and Anthropic streaming text and skips bad events', () => {
    expect(
      extractResponseMessages({
        type: 'stream',
        raw_sse: [
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"Hello"}',
          'data: not-json',
          'data: {"type":"content_block_delta","delta":{"text":" world"}}',
          'data: {"type":"content_block_delta","delta":{"other":"ignored"}}',
          'data: [DONE]',
        ].join('\n'),
      }),
    ).toEqual([{ role: 'assistant', content: 'Hello world' }]);
    expect(
      extractResponseMessages({
        type: 'stream',
        raw_sse: 'event: ping\ndata: {"type":"ping"}\n',
      }),
    ).toEqual([]);
  });

  it('extracts only tool calls emitted by JSON responses', () => {
    expect(
      extractResponseToolCalls({
        type: 'json',
        body: {
          type: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'weather',
              input: { city: 'Paris' },
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: 'tool-1',
        type: 'function',
        function: { name: 'weather', arguments: { city: 'Paris' } },
      },
    ]);
    expect(
      extractResponseToolCalls({
        type: 'json',
        body: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'gemini-tool-1',
                      name: 'weather',
                      args: { city: 'Paris' },
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: 'gemini-tool-1',
        type: 'function',
        function: { name: 'weather', arguments: { city: 'Paris' } },
      },
    ]);
    expect(extractResponseToolCalls(null)).toEqual([]);
  });

  it('reconstructs streamed Chat Completions tool calls', () => {
    expect(
      extractResponseToolCalls({
        type: 'stream',
        raw_sse: [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}',
          'data: [DONE]',
        ].join('\n'),
      }),
    ).toEqual([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'weather', arguments: '{"city":"Paris"}' },
      },
    ]);
  });

  it('reconstructs streamed Responses and Anthropic tool calls', () => {
    expect(
      extractResponseToolCalls({
        type: 'stream',
        raw_sse: [
          'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"item-1","type":"function_call","call_id":"call-1","name":"lookup","arguments":""}}',
          'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","output_index":0,"delta":"{\\"id\\":"}',
          'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","output_index":0,"delta":"42}"}',
        ].join('\n'),
      }),
    ).toEqual([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":42}' },
      },
    ]);

    expect(
      extractResponseToolCalls({
        type: 'stream',
        raw_sse: [
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup","input":{}}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"42}"}}',
        ].join('\n'),
      }),
    ).toEqual([
      {
        id: 'tool-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":42}' },
      },
    ]);
  });

  it('keeps malformed optional tool-call metadata safe', () => {
    expect(
      extractResponseToolCalls({
        type: 'json',
        body: {
          candidates: [{ content: {} }],
        },
      }),
    ).toEqual([]);
    expect(
      extractResponseToolCalls({
        type: 'json',
        body: {
          candidates: [{ content: { parts: [{ functionCall: {} }] } }],
        },
      }),
    ).toEqual([
      {
        id: undefined,
        type: 'function',
        function: { name: undefined, arguments: undefined },
      },
    ]);

    expect(
      extractResponseToolCalls({
        type: 'stream',
        raw_sse: [
          'data: {"choices":[{"delta":{"tool_calls":[null,{"function":{"name":"look"}},{"index":0,"function":{"name":"up"}}]}}]}',
          'data: {"type":"response.output_item.done","item":{"id":"item-only","type":"function_call"}}',
          'data: {"type":"response.output_item.done","item":{"call_id":"call-only","type":"function_call"}}',
          'data: {"type":"response.output_item.done","item":{"type":"function_call"}}',
          'data: {"type":"response.function_call_arguments.delta","delta":"{}"}',
          'data: {"type":"content_block_start","content_block":{"type":"tool_use"}}',
          'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}',
        ].join('\n'),
      }),
    ).toEqual([
      {
        type: 'function',
        function: { name: 'lookup' },
      },
      {
        id: 'item-only',
        type: 'function',
        function: {},
      },
      {
        id: 'call-only',
        type: 'function',
        function: {},
      },
      {
        type: 'function',
        function: { arguments: '{}' },
      },
      {
        type: 'function',
        function: { arguments: '{}' },
      },
    ]);

    expect(
      extractResponseToolCalls({
        type: 'json',
        body: { choices: [{ message: { role: 'assistant', content: 'No call' } }] },
      }),
    ).toEqual([]);
  });
});
