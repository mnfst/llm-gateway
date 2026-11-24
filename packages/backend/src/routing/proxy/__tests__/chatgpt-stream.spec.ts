import { transformResponsesStreamChunk } from '../chatgpt-adapter';

describe('ChatGPT Adapter – transformResponsesStreamChunk', () => {
  it('converts output_text delta to chat completion chunk', () => {
    const chunk = 'event: response.output_text.delta\ndata: {"delta":"Hello"}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('data: ');
    expect(result).toContain('"chat.completion.chunk"');

    const json = JSON.parse(result!.replace('data: ', '').trim());
    expect(json.choices[0].delta.content).toBe('Hello');
    expect(json.choices[0].finish_reason).toBeNull();
    expect(json.model).toBe('gpt-5');
  });

  it('converts response.completed to finish + DONE', () => {
    const chunk = 'event: response.completed\ndata: {}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('"finish_reason":"stop"');
    expect(result).toContain('data: [DONE]');
  });

  it('converts response.failed to a terminal error event', () => {
    const chunk =
      'event: response.failed\ndata: {"response":{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('data: [DONE]');
    const errorLine = result!.split('\n').find((line) => line.startsWith('data: {'));
    const json = JSON.parse(errorLine!.replace('data: ', ''));
    expect(json.error).toEqual({
      message: 'Too many requests',
      type: 'upstream_error',
      status: 429,
      code: 'rate_limit_exceeded',
    });
  });

  it('converts Responses error events to terminal error events', () => {
    const chunk =
      'event: error\ndata: {"error":{"type":"invalid_request_error","message":"Model unavailable"}}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('data: [DONE]');
    const errorLine = result!.split('\n').find((line) => line.startsWith('data: {'));
    const json = JSON.parse(errorLine!.replace('data: ', ''));
    expect(json.error).toEqual({
      message: 'Model unavailable',
      type: 'invalid_request_error',
      status: 400,
    });
  });

  it('converts response.incomplete (max_output_tokens) to a length finish chunk', () => {
    const chunk =
      'event: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('data: [DONE]');
    const finishLine = result!.split('\n').find((line) => line.startsWith('data: {'));
    const json = JSON.parse(finishLine!.replace('data: ', ''));
    expect(json.choices[0].finish_reason).toBe('length');
    expect(json.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it('converts response.incomplete (content_filter) to a content_filter finish chunk', () => {
    const chunk =
      'event: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"content_filter"}}}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('data: [DONE]');
    const finishLine = result!.split('\n').find((line) => line.startsWith('data: {'));
    const json = JSON.parse(finishLine!.replace('data: ', ''));
    expect(json.choices[0].finish_reason).toBe('content_filter');
    expect(json.usage).toBeUndefined();
  });

  it('extracts usage from response.completed event', () => {
    const data = JSON.stringify({
      response: {
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      },
    });
    const chunk = `event: response.completed\ndata: ${data}`;
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    const finishLine = result!.split('\n').find((line) => line.startsWith('data: {'));
    const json = JSON.parse(finishLine!.replace('data: ', ''));
    expect(json.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it('extracts cached_tokens from completed event usage details', () => {
    const data = JSON.stringify({
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 42 },
        },
      },
    });
    const chunk = `event: response.completed\ndata: ${data}`;
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    const finishLine = result!.split('\n').find((line) => line.startsWith('data: {'));
    const json = JSON.parse(finishLine!.replace('data: ', ''));
    expect(json.usage.cache_read_tokens).toBe(42);
  });

  it('extracts cache_write_tokens from completed event usage details', () => {
    const event =
      'event: response.completed\ndata: ' +
      JSON.stringify({
        response: {
          output: [],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cached_tokens: 10, cache_write_tokens: 30 },
          },
        },
      });

    const result = transformResponsesStreamChunk(event, 'gpt-5');
    const json = JSON.parse(result!.match(/data: (.+)/)![1]);

    expect(json.usage.cache_creation_tokens).toBe(30);
  });

  it('extracts cache_creation_input_tokens from completed event usage details', () => {
    const event =
      'event: response.completed\ndata: ' +
      JSON.stringify({
        response: {
          output: [],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cache_creation_input_tokens: 30 },
          },
        },
      });

    const result = transformResponsesStreamChunk(event, 'gpt-5');
    const json = JSON.parse(result!.match(/data: (.+)/)![1]);

    expect(json.usage.cache_creation_tokens).toBe(30);
  });

  it('returns null for irrelevant events', () => {
    const chunk = 'event: response.created\ndata: {"id":"resp_123"}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(transformResponsesStreamChunk('', 'gpt-5')).toBeNull();
  });

  it('returns null for malformed JSON in delta event', () => {
    const chunk = 'event: response.output_text.delta\ndata: not-json';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).toBeNull();
  });

  it('handles delta with non-string delta field', () => {
    const chunk = 'event: response.output_text.delta\ndata: {"delta":42}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    const json = JSON.parse(result!.replace('data: ', '').trim());
    expect(json.choices[0].delta.content).toBe('');
  });

  it('handles pre-processed chunks (data: prefix stripped by the payload parser)', () => {
    const chunk = 'event: response.output_text.delta\n{"delta":"Hi"}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    const json = JSON.parse(result!.replace('data: ', '').trim());
    expect(json.choices[0].delta.content).toBe('Hi');
  });

  it('returns null for empty lines only', () => {
    const result = transformResponsesStreamChunk('   ', 'gpt-5');
    expect(result).toBeNull();
  });

  it('converts function_call_arguments.delta to tool_calls chunk', () => {
    const chunk =
      'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"loc","output_index":0}';
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    const json = JSON.parse(result!.replace('data: ', '').trim());
    expect(json.choices[0].delta.tool_calls[0].function.arguments).toBe('{"loc');
    expect(json.choices[0].delta.tool_calls[0].index).toBe(0);
  });

  it('converts output_item.added for function_call to tool_calls header', () => {
    const data = JSON.stringify({
      output_index: 0,
      item: { type: 'function_call', call_id: 'call_abc', name: 'get_weather' },
    });
    const chunk = `event: response.output_item.added\ndata: ${data}`;
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    const json = JSON.parse(result!.replace('data: ', '').trim());
    expect(json.choices[0].delta.tool_calls[0]).toEqual(
      expect.objectContaining({
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      }),
    );
  });

  it('returns null for output_item.added with non-function_call type', () => {
    const data = JSON.stringify({
      output_index: 0,
      item: { type: 'message', role: 'assistant' },
    });
    const chunk = `event: response.output_item.added\ndata: ${data}`;
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).toBeNull();
  });

  it('sets finish_reason to tool_calls when response has function_call output', () => {
    const data = JSON.stringify({
      response: {
        output: [{ type: 'function_call', call_id: 'call_1', name: 'search' }],
        usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
      },
    });
    const chunk = `event: response.completed\ndata: ${data}`;
    const result = transformResponsesStreamChunk(chunk, 'gpt-5');

    expect(result).not.toBeNull();
    expect(result).toContain('"finish_reason":"tool_calls"');
  });
});
