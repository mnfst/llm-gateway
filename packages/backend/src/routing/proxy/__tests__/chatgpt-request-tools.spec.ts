import { toResponsesRequest } from '../chatgpt-adapter';

describe('ChatGPT Adapter – toResponsesRequest (tool calls)', () => {
  it('converts assistant tool_calls to Responses API function_call items', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Search for cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"cats"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"results":["cat1"]}' },
        { role: 'assistant', content: 'I found some cats!' },
      ],
    };
    const result = toResponsesRequest(body, 'gpt-5');
    const input = result.input as Record<string, unknown>[];

    expect(input).toHaveLength(4);
    expect(input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'search',
      arguments: '{"q":"cats"}',
    });
    expect(input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"results":["cat1"]}',
    });
    expect(input[3]).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I found some cats!' }],
    });
  });

  it('emits text content before function_call items when assistant has both', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: 'Let me search for that.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
      ],
    };
    const result = toResponsesRequest(body, 'gpt-5');
    const input = result.input as Record<string, unknown>[];

    expect(input[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Let me search for that.' }],
    });
    expect(input[1]).toEqual(expect.objectContaining({ type: 'function_call', name: 'search' }));
  });

  it('preserves array-form assistant text before function_call items', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Let me search for that.' }],
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
      ],
    };
    const result = toResponsesRequest(body, 'gpt-5');
    const input = result.input as Record<string, unknown>[];

    expect(input[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Let me search for that.' }],
    });
    expect(input[1]).toEqual(expect.objectContaining({ type: 'function_call', name: 'search' }));
  });

  it('converts tool message to function_call_output', () => {
    const body = {
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result data' }],
    };
    const result = toResponsesRequest(body, 'gpt-5');

    expect(result.input).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'result data' },
    ]);
  });

  it('extracts text from array-form tool message content', () => {
    const body = {
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'result data' }] },
      ],
    };
    const result = toResponsesRequest(body, 'gpt-5');

    expect(result.input).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'result data' },
    ]);
  });

  it('converts function role messages to function_call_output', () => {
    const body = {
      messages: [{ role: 'function', content: '{"temp":72}' }],
    };
    const result = toResponsesRequest(body, 'gpt-5');

    expect(result.input).toHaveLength(1);
    expect((result.input as Record<string, unknown>[])[0]).toEqual(
      expect.objectContaining({ type: 'function_call_output', output: '{"temp":72}' }),
    );
  });

  it('converts Chat Completions tools to Responses API format', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a location',
            parameters: { type: 'object', properties: { location: { type: 'string' } } },
          },
        },
      ],
    };
    const result = toResponsesRequest(body, 'gpt-5');

    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ]);
  });

  it('passes through non-function tool types unchanged', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'code_interpreter' }],
    };
    const result = toResponsesRequest(body, 'gpt-5');

    expect(result.tools).toEqual([{ type: 'code_interpreter' }]);
  });

  describe('duplicate call_id normalization', () => {
    const call = (callId: string, args: string) => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: callId, type: 'function', function: { name: 'terminal', arguments: args } },
      ],
    });
    const output = (callId: string, text: string) => ({
      role: 'tool',
      tool_call_id: callId,
      content: text,
    });

    it('gives repeated call/output pairs unique ids without touching the payloads', () => {
      const result = toResponsesRequest(
        {
          messages: [
            { role: 'user', content: 'run it' },
            call('terminal:0', '{"cmd":"ls"}'),
            output('terminal:0', 'one'),
            call('terminal:0', '{"cmd":"pwd"}'),
            output('terminal:0', 'two'),
            call('terminal:0', '{"cmd":"whoami"}'),
            output('terminal:0', 'three'),
          ],
        },
        'gpt-5',
      );

      expect(result.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        {
          type: 'function_call',
          call_id: 'terminal:0',
          name: 'terminal',
          arguments: '{"cmd":"ls"}',
        },
        { type: 'function_call_output', call_id: 'terminal:0', output: 'one' },
        {
          type: 'function_call',
          call_id: 'terminal:0-mnfst-2',
          name: 'terminal',
          arguments: '{"cmd":"pwd"}',
        },
        { type: 'function_call_output', call_id: 'terminal:0-mnfst-2', output: 'two' },
        {
          type: 'function_call',
          call_id: 'terminal:0-mnfst-3',
          name: 'terminal',
          arguments: '{"cmd":"whoami"}',
        },
        { type: 'function_call_output', call_id: 'terminal:0-mnfst-3', output: 'three' },
      ]);
    });

    it('leaves unique and ambiguous histories untouched', () => {
      const unique = [
        call('terminal:0', '{}'),
        output('terminal:0', 'one'),
        call('terminal:1', '{}'),
        output('terminal:1', 'two'),
      ];
      const uniqueInput = toResponsesRequest({ messages: unique }, 'gpt-5').input as Record<
        string,
        unknown
      >[];
      expect(uniqueInput.map((item) => item.call_id)).toEqual([
        'terminal:0',
        'terminal:0',
        'terminal:1',
        'terminal:1',
      ]);

      // Two calls in a row: which output belongs to which call is a guess.
      const unpaired = [
        call('terminal:0', '{}'),
        call('terminal:0', '{}'),
        output('terminal:0', 'one'),
        output('terminal:0', 'two'),
      ];
      const unpairedInput = toResponsesRequest({ messages: unpaired }, 'gpt-5').input as Record<
        string,
        unknown
      >[];
      expect(unpairedInput.map((item) => item.call_id)).toEqual([
        'terminal:0',
        'terminal:0',
        'terminal:0',
        'terminal:0',
      ]);
    });

    it('extends a replacement id that the history already uses', () => {
      const result = toResponsesRequest(
        {
          messages: [
            call('terminal:0', '{}'),
            output('terminal:0', 'one'),
            call('terminal:0-mnfst-2', '{}'),
            output('terminal:0-mnfst-2', 'other tool'),
            call('terminal:0', '{}'),
            output('terminal:0', 'two'),
          ],
        },
        'gpt-5',
      );

      expect((result.input as Record<string, unknown>[]).map((item) => item.call_id)).toEqual([
        'terminal:0',
        'terminal:0',
        'terminal:0-mnfst-2',
        'terminal:0-mnfst-2',
        'terminal:0-mnfst-2-x',
        'terminal:0-mnfst-2-x',
      ]);
    });
  });
});
