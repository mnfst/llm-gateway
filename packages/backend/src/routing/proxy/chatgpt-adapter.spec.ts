import {
  collectChatGptSseResponse,
  createChatGptStreamTransformer,
  fromResponsesResponse,
  ResponsesSseError,
  toResponsesRequest,
  transformResponsesStreamChunk,
} from './chatgpt-adapter';

describe('chatgpt-adapter', () => {
  describe('toResponsesRequest', () => {
    it('drops system/developer messages from input but lifts them into instructions', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are careful.' },
          { role: 'developer', content: 'Use markdown.' },
          { role: 'user', content: 'hi' },
        ],
      };
      const req = toResponsesRequest(body, 'gpt-5.2-codex');
      expect(req.model).toBe('gpt-5.2-codex');
      expect(req.instructions).toBe('You are careful.\n\nUse markdown.');
      expect(req.store).toBe(false);
      expect(req.stream).toBe(true);
      const input = req.input as Array<Record<string, unknown>>;
      expect(input).toHaveLength(1);
      expect(input[0].role).toBe('user');
    });

    it('honours explicit stream: false from the caller', () => {
      const body = {
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      };
      const req = toResponsesRequest(body, 'gpt-5');
      expect(req.stream).toBe(false);
    });

    it('converts assistant tool_calls to function_call items and keeps any preceding text', () => {
      const body = {
        messages: [
          { role: 'user', content: 'run foo' },
          {
            role: 'assistant',
            content: 'thinking…',
            tool_calls: [{ id: 'call-1', function: { name: 'foo', arguments: '{"a":1}' } }],
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
        ],
      };
      const req = toResponsesRequest(body, 'gpt-5');
      const input = req.input as Array<Record<string, unknown>>;
      // user, assistant text, function_call, function_call_output
      expect(input).toHaveLength(4);
      expect(input[0].role).toBe('user');
      expect(input[1]).toMatchObject({ role: 'assistant' });
      expect(input[2]).toMatchObject({
        type: 'function_call',
        call_id: 'call-1',
        name: 'foo',
        arguments: '{"a":1}',
      });
      expect(input[3]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'ok',
      });
    });

    it('falls back to a UUID call_id when a tool message omits tool_call_id', () => {
      const body = {
        messages: [{ role: 'tool', content: 'result' }],
      };
      const req = toResponsesRequest(body, 'gpt-5');
      const input = req.input as Array<Record<string, unknown>>;
      expect(input[0].type).toBe('function_call_output');
      expect(typeof input[0].call_id).toBe('string');
      expect((input[0].call_id as string).length).toBeGreaterThan(0);
    });

    it('serialises tools through convertTools when provided', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            type: 'function',
            function: { name: 'add', parameters: { type: 'object' } },
          },
        ],
      };
      const req = toResponsesRequest(body, 'gpt-5');
      expect(req.tools).toEqual([
        { type: 'function', name: 'add', parameters: { type: 'object' } },
      ]);
    });

    it('forwards an explicit Responses-style reasoning object verbatim', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'xhigh', summary: 'detailed' },
      };
      const req = toResponsesRequest(body, 'gpt-5.6-sol');
      expect(req.reasoning).toEqual({ effort: 'xhigh', summary: 'detailed' });
    });

    it('maps the Chat Completions reasoning_effort param when opted in', () => {
      // OpenWebUI and other CC-mode clients send `reasoning_effort`, not the
      // nested Responses object. Dropping it means models like GPT-5.6 never
      // reason, so no summary exists to surface (issue #2531). `summary: auto`
      // is requested alongside so the effort yields visible reasoning_content.
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      };
      const req = toResponsesRequest(body, 'gpt-5.6-sol', { mapReasoningEffort: true });
      expect(req.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });
    });

    it('prefers an explicit reasoning object over reasoning_effort', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'low' },
        reasoning_effort: 'xhigh',
      };
      const req = toResponsesRequest(body, 'gpt-5.6-sol', { mapReasoningEffort: true });
      expect(req.reasoning).toEqual({ effort: 'low' });
    });

    it('drops reasoning_effort for endpoints that did not opt in', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      };
      const req = toResponsesRequest(body, 'gpt-5.6-sol');
      expect(req.reasoning).toBeUndefined();
    });

    // Integration-style check for the api.openai.com/v1/responses branch:
    // Codex-family models (e.g. gpt-5.3-codex) route through this adapter
    // when hit with an API key. The output must be a valid Responses API
    // request body, not leak any Chat Completions-only fields.
    it('produces a valid Responses API body for a Codex model with tools', () => {
      const chatCompletionsBody = {
        model: 'gpt-4o', // Should be overridden by the argument
        messages: [{ role: 'user', content: 'Write a hello world in Python.' }],
        stream: false,
        max_tokens: 1024,
        temperature: 0.5,
        tools: [
          {
            type: 'function',
            function: {
              name: 'run_code',
              description: 'Execute code in a sandbox',
              parameters: {
                type: 'object',
                properties: { code: { type: 'string' } },
                required: ['code'],
              },
            },
          },
        ],
      };

      const req = toResponsesRequest(chatCompletionsBody, 'gpt-5.3-codex');

      // Required Responses API fields.
      expect(req.model).toBe('gpt-5.3-codex');
      expect(req.store).toBe(false);
      expect(req.stream).toBe(false);
      expect(req).toHaveProperty('instructions');
      expect(typeof req.instructions).toBe('string');

      // input is an array of { role, content } items, NOT a `messages` array.
      expect(Array.isArray(req.input)).toBe(true);
      const input = req.input as Array<Record<string, unknown>>;
      expect(input).toHaveLength(1);
      expect(input[0].role).toBe('user');
      expect(Array.isArray(input[0].content)).toBe(true);
      const content = input[0].content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({
        type: 'input_text',
        text: 'Write a hello world in Python.',
      });

      // Tools are flattened — no nested `function` wrapper.
      expect(req.tools).toEqual([
        {
          type: 'function',
          name: 'run_code',
          description: 'Execute code in a sandbox',
          parameters: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
          },
        },
      ]);

      // None of the Chat Completions-only fields must leak into the body
      // — OpenAI's /v1/responses endpoint rejects or ignores them.
      expect(req).not.toHaveProperty('messages');
      expect(req).not.toHaveProperty('max_tokens');
      // Default: max_output_tokens is NOT mapped (ChatGPT subscription rejects it).
      expect(req).not.toHaveProperty('max_output_tokens');
    });

    it('does not map max_tokens to max_output_tokens by default (subscription safe)', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      };

      const req = toResponsesRequest(body, 'gpt-5-codex');

      expect(req).not.toHaveProperty('max_output_tokens');
      expect(req).not.toHaveProperty('max_tokens');
    });

    it('maps max_tokens to max_output_tokens when mapMaxOutputTokens is true', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      };

      const req = toResponsesRequest(body, 'gpt-5-codex', { mapMaxOutputTokens: true });

      expect(req.max_output_tokens).toBe(4096);
      expect(req).not.toHaveProperty('max_tokens');
    });

    it('maps max_completion_tokens to max_output_tokens when mapMaxOutputTokens is true', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 2048,
      };

      const req = toResponsesRequest(body, 'gpt-5-codex', { mapMaxOutputTokens: true });

      expect(req.max_output_tokens).toBe(2048);
      expect(req).not.toHaveProperty('max_completion_tokens');
    });

    it('prefers max_completion_tokens over max_tokens when both present', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
        max_completion_tokens: 2048,
      };

      const req = toResponsesRequest(body, 'gpt-5-codex', { mapMaxOutputTokens: true });

      expect(req.max_output_tokens).toBe(2048);
    });

    it('omits max_output_tokens when caller did not specify a cap', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }] };

      const req = toResponsesRequest(body, 'gpt-5-codex', { mapMaxOutputTokens: true });

      expect(req).not.toHaveProperty('max_output_tokens');
    });
  });

  describe('fromResponsesResponse', () => {
    it('assembles a Chat Completion envelope with text output', () => {
      const out = fromResponsesResponse(
        {
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello ' },
                { type: 'output_text', text: 'world' },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
          },
        },
        'gpt-5',
      );
      expect(out.object).toBe('chat.completion');
      expect(out.model).toBe('gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      expect(choices[0].finish_reason).toBe('stop');
      expect((choices[0].message as Record<string, unknown>).content).toBe('Hello world');
      expect(out.usage).toMatchObject({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cache_read_tokens: 3,
        cache_creation_tokens: 2,
      });
    });

    it('accepts cache_creation_input_tokens in Responses usage details', () => {
      const out = fromResponsesResponse(
        {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cache_creation_input_tokens: 4 },
          },
        },
        'gpt-5',
      );

      expect(out.usage).toMatchObject({ cache_creation_tokens: 4 });
    });

    it('assembles a tool_calls envelope and sets finish_reason accordingly', () => {
      const out = fromResponsesResponse(
        {
          output: [{ type: 'function_call', call_id: 'c1', name: 'foo', arguments: '{"x":1}' }],
        },
        'gpt-5',
      );
      const choices = out.choices as Array<Record<string, unknown>>;
      expect(choices[0].finish_reason).toBe('tool_calls');
      const message = choices[0].message as Record<string, unknown>;
      expect(message.content).toBeNull();
      expect(message.tool_calls).toEqual([
        {
          id: 'c1',
          type: 'function',
          function: { name: 'foo', arguments: '{"x":1}' },
        },
      ]);
    });

    it('surfaces reasoning summary output as Chat Completions reasoning_content', () => {
      const out = fromResponsesResponse(
        {
          output: [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Checked the constraints.' }],
            },
            { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
          ],
        },
        'gpt-5.5',
      );
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.content).toBe('Done.');
      expect(message.reasoning_content).toBe('Checked the constraints.');
    });

    it('joins reasoning summary and content text while ignoring malformed parts', () => {
      const out = fromResponsesResponse(
        {
          output: [
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'Summary text.' },
                { type: 'summary_text' },
                'invalid',
              ],
              content: [{ type: 'reasoning_text', text: 'Reasoning text.' }],
            },
            { type: 'reasoning', summary: 'invalid' },
            { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
          ],
        },
        'gpt-5.5',
      );
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.content).toBe('Done.');
      expect(message.reasoning_content).toBe('Summary text.\n\nReasoning text.');
    });

    it('defaults missing usage fields to zero', () => {
      const out = fromResponsesResponse({ output: [] }, 'gpt-5');
      expect(out.usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      });
    });

    it('tolerates message output items with no content field', () => {
      const out = fromResponsesResponse({ output: [{ type: 'message' }] }, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      expect((choices[0].message as Record<string, unknown>).content).toBeNull();
    });
  });

  describe('transformResponsesStreamChunk', () => {
    function parseFrame(frame: string | null) {
      if (!frame) return null;
      const first = frame.split('\n\n')[0];
      return JSON.parse(first.replace(/^data: /, ''));
    }

    it('returns null for irrelevant events', () => {
      expect(
        transformResponsesStreamChunk('event: response.created\ndata: {}', 'gpt-5'),
      ).toBeNull();
      expect(transformResponsesStreamChunk('', 'gpt-5')).toBeNull();
    });

    it('converts output_text.delta events into a Chat Completion content delta', () => {
      const chunk = 'event: response.output_text.delta\ndata: {"delta":"hi"}';
      const parsed = parseFrame(transformResponsesStreamChunk(chunk, 'gpt-5'));
      expect(parsed.choices[0]).toEqual({
        index: 0,
        delta: { content: 'hi' },
        finish_reason: null,
      });
    });

    it('converts reasoning summary deltas into a Chat Completion reasoning_content delta', () => {
      const chunk =
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"Checked constraints."}';
      const parsed = parseFrame(transformResponsesStreamChunk(chunk, 'gpt-5.5'));
      expect(parsed.choices[0]).toEqual({
        index: 0,
        delta: { reasoning_content: 'Checked constraints.' },
        finish_reason: null,
      });
    });

    it('converts alternate reasoning delta event names', () => {
      const summaryChunk = 'event: response.reasoning_summary.delta\ndata: {"delta":"Summary."}';
      const emptyChunk = 'event: response.reasoning_summary.delta\ndata: {"delta":{}}';
      const summary = parseFrame(transformResponsesStreamChunk(summaryChunk, 'gpt-5.5'));
      const empty = parseFrame(transformResponsesStreamChunk(emptyChunk, 'gpt-5.5'));

      expect(summary.choices[0].delta).toEqual({ reasoning_content: 'Summary.' });
      expect(empty.choices[0].delta).toEqual({ reasoning_content: '' });
    });

    it('streams reasoning summary delta events with names it has never seen', () => {
      // New model generations rename summary delta events; anything shaped
      // `response.reasoning_summary*.delta` must keep streaming (issue #2531).
      const chunk = 'event: response.reasoning_summary_part.delta\ndata: {"delta":"New shape."}';
      const parsed = parseFrame(transformResponsesStreamChunk(chunk, 'gpt-5.6-sol'));

      expect(parsed.choices[0].delta).toEqual({ reasoning_content: 'New shape.' });
    });

    it('extracts reasoning text from object-shaped deltas', () => {
      const chunk =
        'event: response.reasoning_summary_text.delta\ndata: {"delta":{"text":"Nested."}}';
      const parsed = parseFrame(transformResponsesStreamChunk(chunk, 'gpt-5.6-sol'));

      expect(parsed.choices[0].delta).toEqual({ reasoning_content: 'Nested.' });
    });

    it('does not expose raw reasoning text deltas as summaries', () => {
      const chunk = 'event: response.reasoning_text.delta\ndata: {"delta":"Private chain."}';

      expect(transformResponsesStreamChunk(chunk, 'gpt-5.5')).toBeNull();

      const renamed = 'event: response.reasoning_text_part.delta\ndata: {"delta":"Private."}';
      expect(transformResponsesStreamChunk(renamed, 'gpt-5.6-sol')).toBeNull();
    });

    it('returns null for malformed reasoning delta payloads', () => {
      const chunk = 'event: response.reasoning_summary.delta\ndata: {';

      expect(transformResponsesStreamChunk(chunk, 'gpt-5.5')).toBeNull();
    });

    it('converts function_call_arguments.delta into a tool_calls.arguments delta', () => {
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"delta":"foo","output_index":1}';
      const parsed = parseFrame(transformResponsesStreamChunk(chunk, 'gpt-5'));
      expect(parsed.choices[0].delta.tool_calls).toEqual([
        { index: 1, function: { arguments: 'foo' } },
      ]);
    });

    it('converts output_item.added (function_call) into a tool_calls announcement', () => {
      const chunk =
        'event: response.output_item.added\ndata: {"output_index":2,"item":{"type":"function_call","call_id":"c1","name":"foo"}}';
      const parsed = parseFrame(transformResponsesStreamChunk(chunk, 'gpt-5'));
      expect(parsed.choices[0].delta.tool_calls).toEqual([
        {
          index: 2,
          id: 'c1',
          type: 'function',
          function: { name: 'foo', arguments: '' },
        },
      ]);
    });

    it('ignores output_item.added events for non-function items', () => {
      const chunk =
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"message"}}';
      expect(transformResponsesStreamChunk(chunk, 'gpt-5')).toBeNull();
    });

    it('emits a finish frame + [DONE] on response.completed with usage', () => {
      const chunk =
        'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"input_tokens_details":{"cached_tokens":1}},"output":[]}}';
      const raw = transformResponsesStreamChunk(chunk, 'gpt-5');
      expect(raw).not.toBeNull();
      expect(raw!.trim().endsWith('data: [DONE]')).toBe(true);
      const first = raw!.split('\n\n')[0];
      const parsed = JSON.parse(first.replace(/^data: /, ''));
      expect(parsed.choices[0].finish_reason).toBe('stop');
      expect(parsed.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2 });
    });

    it('marks finish_reason=tool_calls when the completed response had function_call items', () => {
      const chunk =
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}';
      const raw = transformResponsesStreamChunk(chunk, 'gpt-5');
      const first = raw!.split('\n\n')[0];
      const parsed = JSON.parse(first.replace(/^data: /, ''));
      expect(parsed.choices[0].finish_reason).toBe('tool_calls');
      // No usage attached.
      expect(parsed.usage).toBeUndefined();
    });
  });

  describe('createChatGptStreamTransformer', () => {
    const completedWithReasoning =
      'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Checked the constraints."}]},{"type":"message"}]}}';

    function frames(raw: string | null): Array<Record<string, unknown>> {
      return (raw ?? '')
        .split('\n\n')
        .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
        .map((f) => JSON.parse(f.replace(/^data: /, '')) as Record<string, unknown>);
    }

    function delta(frame: Record<string, unknown>): Record<string, unknown> {
      const choices = frame.choices as Array<Record<string, unknown>>;
      return choices[0].delta as Record<string, unknown>;
    }

    it('backfills reasoning_content from the completed output when no summary deltas streamed', () => {
      // The terminal event always carries the full reasoning output, whatever
      // the upstream named its delta events — so an unrecognized delta shape
      // degrades to a single terminal reasoning frame instead of losing the
      // summary entirely (issue #2531).
      const transform = createChatGptStreamTransformer('gpt-5.6-sol');
      const out = frames(transform(completedWithReasoning));

      expect(out).toHaveLength(2);
      expect(delta(out[0])).toEqual({ reasoning_content: 'Checked the constraints.' });
      expect((out[1].choices as Array<Record<string, unknown>>)[0].finish_reason).toBe('stop');
    });

    it('does not backfill when summary deltas already streamed', () => {
      const transform = createChatGptStreamTransformer('gpt-5.6-sol');
      transform('event: response.reasoning_summary_text.delta\ndata: {"delta":"Checked "}');
      const out = frames(transform(completedWithReasoning));

      expect(out).toHaveLength(1);
      expect(delta(out[0])).toEqual({});
    });

    it('backfills reasoning_content on response.incomplete', () => {
      const transform = createChatGptStreamTransformer('gpt-5.6-sol');
      const out = frames(
        transform(
          'event: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Partial reasoning."}]}]}}',
        ),
      );

      expect(out).toHaveLength(2);
      expect(delta(out[0])).toEqual({ reasoning_content: 'Partial reasoning.' });
      expect((out[1].choices as Array<Record<string, unknown>>)[0].finish_reason).toBe('length');
    });

    it('emits only the finish frame when the completed output has no reasoning', () => {
      const transform = createChatGptStreamTransformer('gpt-5.6-sol');
      const out = frames(
        transform('event: response.completed\ndata: {"response":{"output":[{"type":"message"}]}}'),
      );

      expect(out).toHaveLength(1);
    });

    it('keeps reasoning state per transformer instance', () => {
      const streamed = createChatGptStreamTransformer('gpt-5.6-sol');
      streamed('event: response.reasoning_summary_text.delta\ndata: {"delta":"Checked "}');
      const fresh = createChatGptStreamTransformer('gpt-5.6-sol');

      expect(frames(streamed(completedWithReasoning))).toHaveLength(1);
      expect(frames(fresh(completedWithReasoning))).toHaveLength(2);
    });
  });

  describe('collectChatGptSseResponse', () => {
    it('maps a context error event to HTTP 400 without losing provider details', () => {
      const sse =
        'event: error\ndata: {"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}';

      try {
        collectChatGptSseResponse(sse, 'gpt-5.6-sol');
        fail('Expected ResponsesSseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ResponsesSseError);
        expect((err as ResponsesSseError).status).toBe(400);
        expect(JSON.parse((err as ResponsesSseError).body)).toEqual({
          error: {
            message: 'Your input exceeds the context window of this model.',
            code: 'context_length_exceeded',
            type: 'invalid_request_error',
          },
        });
      }
    });

    it('maps a nested response.failed context error to HTTP 400', () => {
      const sse =
        'event: response.failed\ndata: {"response":{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Prompt is too large"}}}';

      try {
        collectChatGptSseResponse(sse, 'gpt-5.6-terra');
        fail('Expected ResponsesSseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ResponsesSseError);
        expect((err as ResponsesSseError).status).toBe(400);
      }
    });

    it('uses a useful error type when an unfamiliar code is present', () => {
      const sse =
        'event: error\ndata: {"type":"invalid_request_error","code":"request_rejected","message":"Invalid request"}';

      try {
        collectChatGptSseResponse(sse, 'gpt-5.6-sol');
        fail('Expected ResponsesSseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ResponsesSseError);
        expect((err as ResponsesSseError).status).toBe(400);
      }
    });

    it.each([
      [{ code: 'resource_not_found' }, 404],
      [{ code: 'unauthorized' }, 401],
      [{ code: 'opaque', type: 'authentication_error' }, 401],
      [{ code: 'forbidden' }, 403],
      [{ code: 'opaque', type: 'permission_denied' }, 403],
      [{ code: 'server_error' }, 500],
      [{ code: 'rate_limit_exceeded' }, 429],
      [{ code: 'bad_request' }, 400],
      [{ type: 'invalid_request_error' }, 400],
      [{}, 502],
    ])('preserves Responses error status precedence for %j', (details, expectedStatus) => {
      const sse = `event: error\ndata: ${JSON.stringify({ ...details, message: 'failed' })}`;

      try {
        collectChatGptSseResponse(sse, 'gpt-5.6-sol');
        fail('Expected ResponsesSseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ResponsesSseError);
        expect((err as ResponsesSseError).status).toBe(expectedStatus);
      }
    });

    it('collects text deltas and completed usage into a non-streaming envelope', () => {
      const sse = [
        'event: response.output_text.delta\ndata: {"delta":"Hello "}',
        'event: response.output_text.delta\ndata: {"delta":"world"}',
        'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      expect((choices[0].message as Record<string, unknown>).content).toBe('Hello world');
      expect(choices[0].finish_reason).toBe('stop');
      expect(out.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2 });
    });

    it('collects renamed and object-shaped reasoning summary deltas', () => {
      const sse = [
        'event: response.reasoning_summary_part.delta\ndata: {"delta":{"text":"Renamed."}}',
        'event: response.completed\ndata: {"response":{}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.6-sol');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      expect(message.reasoning_content).toBe('Renamed.');
    });

    it('collects reasoning summary deltas into non-streaming reasoning_content', () => {
      const sse = [
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"I checked "}',
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"the constraints."}',
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.content).toBe('Done.');
      expect(message.reasoning_content).toBe('I checked the constraints.');
    });

    it('uses completed reasoning output as the authoritative non-streaming summary', () => {
      const sse = [
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"Partial"}',
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Complete summary."}]},{"type":"message"}]}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.reasoning_content).toBe('Complete summary.');
    });

    it('clears partial reasoning when completed output has no reasoning item', () => {
      const sse = [
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"Partial"}',
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"message"}]}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.reasoning_content).toBeUndefined();
    });

    it('uses incomplete reasoning output as the authoritative non-streaming summary', () => {
      const sse = [
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"Partial"}',
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Incomplete summary."}]}]}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.reasoning_content).toBe('Incomplete summary.');
      expect(choices[0].finish_reason).toBe('length');
    });

    it('clears partial reasoning when incomplete output has no reasoning item', () => {
      const sse = [
        'event: response.reasoning_summary_text.delta\ndata: {"delta":"Partial"}',
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message"}]}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;

      expect(message.reasoning_content).toBeUndefined();
      expect(choices[0].finish_reason).toBe('length');
    });

    it('tolerates a completed terminal event without a response object', () => {
      const sse = [
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.completed\ndata: {"response":null}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;

      expect((choices[0].message as Record<string, unknown>).content).toBe('Done.');
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('tolerates an incomplete terminal event without a response object', () => {
      const sse = [
        'event: response.output_text.delta\ndata: {"delta":"Done."}',
        'event: response.incomplete\ndata: {"response":null}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5.5');
      const choices = out.choices as Array<Record<string, unknown>>;

      expect((choices[0].message as Record<string, unknown>).content).toBe('Done.');
      expect(choices[0].finish_reason).toBe('length');
    });

    it('reconstructs tool calls across multiple deltas and reports finish_reason=tool_calls', () => {
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c1","name":"foo"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"x"}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"\\":1}"}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      expect(choices[0].finish_reason).toBe('tool_calls');
      expect(message.tool_calls).toEqual([
        {
          id: 'c1',
          type: 'function',
          function: { name: 'foo', arguments: '{"x":1}' },
        },
      ]);
    });

    it('ignores malformed SSE events and falls back to zero usage', () => {
      const sse = 'event: response.output_text.delta\ndata: not-json';
      const out = collectChatGptSseResponse(sse, 'gpt-5');
      expect(out.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      const choices = out.choices as Array<Record<string, unknown>>;
      expect((choices[0].message as Record<string, unknown>).content).toBeNull();
    });

    it('throws an upstream error when the Responses stream emits an error event', () => {
      const sse =
        'event: error\ndata: {"type":"invalid_request_error","code":"model_not_found","message":"Model unavailable"}';

      expect(() => collectChatGptSseResponse(sse, 'gpt-5')).toThrow(ResponsesSseError);

      try {
        collectChatGptSseResponse(sse, 'gpt-5');
      } catch (err) {
        expect(err).toBeInstanceOf(ResponsesSseError);
        expect((err as ResponsesSseError).status).toBe(404);
        expect((err as ResponsesSseError).body).toContain('Model unavailable');
      }
    });

    it('throws an upstream error when the Responses stream emits response.failed', () => {
      const sse =
        'event: response.failed\ndata: {"response":{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}}';

      try {
        collectChatGptSseResponse(sse, 'gpt-5');
        fail('Expected ResponsesSseError');
      } catch (err) {
        expect(err).toBeInstanceOf(ResponsesSseError);
        expect((err as ResponsesSseError).status).toBe(429);
        expect((err as ResponsesSseError).body).toContain('Too many requests');
      }
    });

    it('drops function_call_arguments deltas that arrive for an unknown output_index', () => {
      // No output_item.added ever arrives, so the arguments delta should be ignored.
      const sse = [
        'event: response.function_call_arguments.delta\ndata: {"output_index":7,"delta":"lost"}',
        'event: response.completed\ndata: {"response":{"output":[]}}',
      ].join('\n\n');
      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      expect((choices[0].message as Record<string, unknown>).tool_calls).toBeUndefined();
      expect(choices[0].finish_reason).toBe('stop');
    });
  });
});
