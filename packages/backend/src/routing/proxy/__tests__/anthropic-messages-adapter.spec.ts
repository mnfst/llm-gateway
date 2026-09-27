import {
  chatCompletionsResponseToMessages,
  createMessagesStreamTransformer,
  messagesToChatCompletionsRequest,
} from '../anthropic-messages-adapter';

describe('Anthropic Messages adapter', () => {
  describe('messagesToChatCompletionsRequest', () => {
    it('converts a basic request with string content', () => {
      const result = messagesToChatCompletionsRequest({
        model: 'claude-sonnet-4',
        max_tokens: 256,
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        top_p: 0.9,
        stream: true,
        stop_sequences: ['STOP'],
        metadata: { user_id: 'u1' },
      });

      expect(result).toEqual({
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
        model: 'claude-sonnet-4',
        max_tokens: 256,
        temperature: 0.7,
        top_p: 0.9,
        stream: true,
        stop: ['STOP'],
        metadata: { user_id: 'u1' },
      });
    });

    it('joins array-form system prompts and ignores non-text parts', () => {
      const result = messagesToChatCompletionsRequest({
        system: [
          { type: 'text', text: 'Line one.' },
          { type: 'text', text: 'Line two.' },
          { type: 'unknown' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result.messages).toEqual([
        { role: 'system', content: 'Line one.\n\nLine two.' },
        { role: 'user', content: 'hi' },
      ]);
    });

    it('omits system message when system is empty or absent', () => {
      const noSystem = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(noSystem.messages).toEqual([{ role: 'user', content: 'x' }]);

      const emptyArray = messagesToChatCompletionsRequest({
        system: [],
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(emptyArray.messages).toEqual([{ role: 'user', content: 'x' }]);
    });

    it('keeps text-only multimodal user content as a string', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'just text' }],
          },
        ],
      });
      expect(result.messages).toEqual([{ role: 'user', content: 'just text' }]);
    });

    it('translates base64 and url image blocks into chat-completions image_url parts', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' },
              },
              { type: 'image', source: { type: 'url', url: 'https://x.test/y.png' } },
              { type: 'image', source: { type: 'base64', data: 'no-mime' } },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
            { type: 'image_url', image_url: { url: 'https://x.test/y.png' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,no-mime' } },
          ],
        },
      ]);
    });

    it('translates assistant tool_use blocks into tool_calls', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: "I'll look it up." },
              { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'cats' } },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        {
          role: 'assistant',
          content: "I'll look it up.",
          tool_calls: [
            {
              id: 'tu_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"cats"}' },
            },
          ],
        },
      ]);
    });

    it('keeps assistant tool_use-only messages with content set to null', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_2', name: 'lookup', input: {} }],
          },
        ],
      });
      expect(result.messages).toEqual([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tu_2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
      ]);
    });

    it('converts user tool_result blocks into role=tool messages', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'found 3' },
              { type: 'tool_result', tool_use_id: 'tu_2', content: { rows: 5 } },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        { role: 'tool', tool_call_id: 'tu_1', content: 'found 3' },
        { role: 'tool', tool_call_id: 'tu_2', content: '{"rows":5}' },
      ]);
    });

    it('extracts tool_result images into a follow-up user message instead of stringified base64', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [
                  { type: 'text', text: 'screenshot follows' },
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        {
          role: 'tool',
          tool_call_id: 'tu_1',
          content: JSON.stringify([
            { type: 'text', text: 'screenshot follows' },
            { type: 'text', text: '[image attached below]' },
          ]),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Images from the preceding tool result:' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ]);
    });

    it('keeps parallel tool results contiguous and emits their images once, after the group', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                ],
              },
              {
                type: 'tool_result',
                tool_use_id: 'tu_2',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'BBBB' },
                  },
                ],
              },
              { type: 'text', text: 'both screenshots above' },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        {
          role: 'tool',
          tool_call_id: 'tu_1',
          content: JSON.stringify([{ type: 'text', text: '[image attached below]' }]),
        },
        {
          role: 'tool',
          tool_call_id: 'tu_2',
          content: JSON.stringify([{ type: 'text', text: '[image attached below]' }]),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Images from the preceding tool result:' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
          ],
        },
        { role: 'user', content: 'both screenshots above' },
      ]);
    });

    it('keeps parallel tool results contiguous across consecutive user messages', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'screenshot', input: {} },
              { type: 'tool_use', id: 'tu_2', name: 'screenshot', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                ],
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_2',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'BBBB' },
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tu_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
            { id: 'tu_2', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'tu_1',
          content: JSON.stringify([{ type: 'text', text: '[image attached below]' }]),
        },
        {
          role: 'tool',
          tool_call_id: 'tu_2',
          content: JSON.stringify([{ type: 'text', text: '[image attached below]' }]),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Images from the preceding tool result:' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
          ],
        },
      ]);
    });

    it('keeps url-sourced tool_result images and leaves unconvertible image blocks in place', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [
                  { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
                  { type: 'image', source: { type: 'unknown' } },
                ],
              },
            ],
          },
        ],
      });

      expect(result.messages).toEqual([
        {
          role: 'tool',
          tool_call_id: 'tu_1',
          content: JSON.stringify([
            { type: 'text', text: '[image attached below]' },
            { type: 'image', source: { type: 'unknown' } },
          ]),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Images from the preceding tool result:' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ]);
    });

    it('falls back to "unknown" for missing tool ids and synthesizes assistant ids', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          { role: 'user', content: [{ type: 'tool_result', content: 'r' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', input: {} }],
          },
        ],
      });

      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toEqual({ role: 'tool', tool_call_id: 'unknown', content: 'r' });
      const assistantMsg = messages[1];
      const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect((toolCalls[0].function as Record<string, unknown>).name).toBe('unknown');
    });

    it('translates tools and tool_choice variants', () => {
      const auto = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { name: 'search', description: 'Search', input_schema: { type: 'object' } },
          { name: 'noschema' },
        ],
        tool_choice: { type: 'auto' },
      });
      expect(auto.tools).toEqual([
        {
          type: 'function',
          function: { name: 'search', description: 'Search', parameters: { type: 'object' } },
        },
        { type: 'function', function: { name: 'noschema' } },
      ]);
      expect(auto.tool_choice).toBe('auto');

      const any = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tool_choice: { type: 'any' },
      });
      expect(any.tool_choice).toBe('required');

      const named = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tool_choice: { type: 'tool', name: 'search' },
      });
      expect(named.tool_choice).toEqual({ type: 'function', function: { name: 'search' } });

      const ignoredNamed = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tool_choice: { type: 'tool' },
      });
      expect(ignoredNamed.tool_choice).toBeUndefined();
    });

    it('exposes Anthropic server tools to the scorer by function.name (issue #1886)', () => {
      // chatBody is consumed by the routing/scoring layer in messages mode —
      // the scorer reads tool count + function.name. When the resolved
      // provider is Anthropic, the wire body goes through
      // applyAnthropicMessagesMutations direct from the inbound body instead
      // of this translation, so server-tool `type` tags are preserved there.
      const result = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { type: 'bash_20250124', name: 'bash' },
          { type: 'mcp_toolset', name: 'mcp' },
          { name: 'my_custom', description: 'c', input_schema: { type: 'object' } },
          { type: 'custom', name: 'explicit_custom', input_schema: { type: 'object' } },
        ],
      });

      // chatBody.tools keeps all five — the scorer reads tool count and
      // function.name and must keep seeing server tools for tier / specificity.
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(5);
      expect(tools.map((t) => (t.function as Record<string, unknown>).name)).toEqual([
        'web_search',
        'bash',
        'mcp',
        'my_custom',
        'explicit_custom',
      ]);
    });

    it('gives Anthropic server tools a safe empty schema so strict chat-completions providers accept them (issue #2754)', () => {
      // chatBody.tools is also the literal wire payload forwarded to
      // non-Anthropic providers reached via the chat-completions wire format
      // (ProviderClient.forward's needsChatBody path). Anthropic server
      // tools (web_search, bash, computer, etc.) carry no `input_schema`;
      // some strict providers (e.g. MiniMax) reject any function tool with
      // no `parameters` field at all, so omitting it 400s the request even
      // though Manifest itself never executes the tool.
      const result = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { type: 'bash_20250124', name: 'bash' },
          { type: 'mcp_toolset', name: 'mcp' },
        ],
      });

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'web_search',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
        {
          type: 'function',
          function: {
            name: 'bash',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mcp',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ]);
    });

    it('treats unknown non-custom tool types as custom tools with a safe empty schema (issue #1897)', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'advisor_20260301', name: 'advisor', description: 'Plan the task' }],
      });

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'advisor',
            description: 'Plan the task',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ]);
    });

    it('adds missing array items in Anthropic tool schemas before OpenAI forwarding', () => {
      const inputSchema = {
        type: 'object',
        properties: {
          codebase_context: {
            anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
          },
          existing_items: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      };
      const result = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          {
            name: 'mcp__revenuecat__create-paywall-ai',
            description: 'Create a paywall',
            input_schema: inputSchema,
          },
        ],
      });

      const tools = result.tools as Array<Record<string, Record<string, unknown>>>;
      expect(tools[0].function.parameters).toEqual({
        type: 'object',
        properties: {
          codebase_context: {
            anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array', items: {} }],
          },
          existing_items: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      });
      expect(inputSchema.properties.codebase_context.anyOf[2]).toEqual({ type: 'array' });
    });

    it('forwards Anthropic-native thinking and top_k onto chatBody', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [{ role: 'user', content: 'x' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        top_k: 40,
      });
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
      expect(result.top_k).toBe(40);
    });

    it('drops malformed image blocks (unsupported source type) without crashing', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: { type: 'unknown' } },
            ],
          },
        ],
      });
      expect(result.messages).toEqual([{ role: 'user', content: 'look' }]);
    });

    it('handles assistant turn with plain string content', () => {
      const result = messagesToChatCompletionsRequest({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello back' },
        ],
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello back' },
      ]);
    });

    it('preserves the original block order when text and tool_result interleave in a user turn', () => {
      // Cubic flagged: emitting all tool_result blocks before user text in
      // the same turn changes input order and could alter prompt semantics.
      // Now we walk content in order and split user messages around
      // tool_result boundaries.
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'before' },
              { type: 'tool_result', tool_use_id: 'tu_a', content: 'A' },
              { type: 'text', text: 'middle' },
              { type: 'tool_result', tool_use_id: 'tu_b', content: 'B' },
              { type: 'text', text: 'after' },
            ],
          },
        ],
      });
      expect(result.messages).toEqual([
        { role: 'user', content: 'before' },
        { role: 'tool', tool_call_id: 'tu_a', content: 'A' },
        { role: 'user', content: 'middle' },
        { role: 'tool', tool_call_id: 'tu_b', content: 'B' },
        { role: 'user', content: 'after' },
      ]);
    });

    it('echoes Anthropic thinking blocks back as reasoning_content on assistant turns', () => {
      // DeepSeek requires the reasoning trace echoed on follow-up assistant
      // turns. The Anthropic SDK exposes it as a `thinking` block on the
      // assistant message — this verifies the round-trip.
      const result = messagesToChatCompletionsRequest({
        messages: [
          { role: 'user', content: 'use the tool' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I should call get_weather.' },
              { type: 'text', text: 'Looking up.' },
              { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Tokyo' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '18C' }],
          },
        ],
      });
      const messages = result.messages as Array<Record<string, unknown>>;
      const assistant = messages.find((m) => m.role === 'assistant')!;
      expect(assistant.reasoning_content).toBe('I should call get_weather.');
      expect(assistant.content).toBe('Looking up.');
      expect(assistant.tool_calls).toBeDefined();
    });

    it('skips malformed message entries', () => {
      const result = messagesToChatCompletionsRequest({
        messages: ['nope', null, { role: 'user', content: 'ok' }],
      } as Record<string, unknown>);
      expect(result.messages).toEqual([{ role: 'user', content: 'ok' }]);
    });
  });

  describe('chatCompletionsResponseToMessages', () => {
    it('converts a text-only chat completion into an Anthropic message', () => {
      const result = chatCompletionsResponseToMessages(
        {
          id: 'cc_1',
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            cache_read_tokens: 1,
            cache_creation_tokens: 2,
          },
        },
        'gpt-4o-mini',
      );

      expect(result).toEqual({
        id: 'cc_1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-4o-mini',
        content: [{ type: 'text', text: 'hello there' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          // Anthropic's input_tokens excludes cache (= 4 - 1 - 2).
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1,
        },
      });
    });

    it('extracts text from array-shaped content and emits tool_use blocks', () => {
      const result = chatCompletionsResponseToMessages(
        {
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: 'part1 ' },
                  { type: 'text', text: 'part2' },
                  { not: 'a record' },
                ],
                tool_calls: [
                  {
                    id: 'tc_1',
                    function: { name: 'search', arguments: '{"q":"a"}' },
                  },
                  {
                    function: { name: 'lookup', arguments: 'not-json' },
                  },
                  { not: 'a function' },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'fallback',
      );

      expect(result.content).toEqual([
        { type: 'text', text: 'part1 part2' },
        { type: 'tool_use', id: 'tc_1', name: 'search', input: { q: 'a' } },
        expect.objectContaining({ type: 'tool_use', name: 'lookup', input: {} }),
      ]);
      expect(result.stop_reason).toBe('tool_use');
    });

    it('maps stop reasons and falls back to end_turn for unknown values', () => {
      const length = chatCompletionsResponseToMessages(
        { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] },
        'm',
      );
      expect(length.stop_reason).toBe('max_tokens');

      const unknown = chatCompletionsResponseToMessages(
        { choices: [{ message: { content: 'x' }, finish_reason: 'mystery' }] },
        'm',
      );
      expect(unknown.stop_reason).toBe('end_turn');

      const noChoices = chatCompletionsResponseToMessages({ choices: 'bad' as unknown }, 'm');
      expect(noChoices.content).toEqual([]);
      expect(noChoices.stop_reason).toBe('end_turn');
      expect(noChoices.id).toMatch(/^msg_[0-9a-f]{32}$/);
      expect(noChoices.model).toBe('m');
    });

    it('surfaces reasoning_content as a leading thinking block', () => {
      const result = chatCompletionsResponseToMessages(
        {
          choices: [
            {
              message: {
                content: 'The answer is 42.',
                reasoning_content: 'Let me think... yes, 42.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        'deepseek',
      );
      expect(result.content).toEqual([
        { type: 'thinking', thinking: 'Let me think... yes, 42.' },
        { type: 'text', text: 'The answer is 42.' },
      ]);
    });

    it('handles missing content and missing usage gracefully', () => {
      const result = chatCompletionsResponseToMessages(
        { choices: [{ message: {}, finish_reason: 'stop' }] },
        'm',
      );
      expect(result.content).toEqual([]);
      expect(result.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });

    it('skips nullish text/tool blocks without dropping valid sibling blocks', () => {
      // Defensive: an upstream provider could send a content array where some
      // blocks have `text: null` or a tool_call where `id`/`function.arguments`
      // are null. These must not cause valid sibling blocks to be lost or the
      // converter to crash.
      const result = chatCompletionsResponseToMessages(
        {
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: null },
                  { type: 'text', text: 'real text' },
                ],
                tool_calls: [
                  { id: null, function: { name: 'tn', arguments: null } },
                  { id: 'tc_ok', function: { name: 'ok', arguments: '{"a":1}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'fallback',
      );

      // text block: null text contributes nothing; "real text" survives.
      expect(result.content).toEqual([
        { type: 'text', text: 'real text' },
        // tool_call with null id gets a synthesized toolu_* id; null arguments
        // resolve via safeParseJson(undefined) → {} (no crash).
        expect.objectContaining({ type: 'tool_use', name: 'tn', input: {} }),
        { type: 'tool_use', id: 'tc_ok', name: 'ok', input: { a: 1 } },
      ]);
      const synthesized = (result.content as Array<Record<string, unknown>>)[1];
      expect(synthesized.id).toMatch(/^toolu_[0-9a-f]{32}$/);
    });
  });

  describe('createMessagesStreamTransformer', () => {
    function flushChunks(
      transformer: { transform: (c: string) => string | null; finalize: () => string | null },
      chunks: string[],
    ): string {
      const out = chunks.map((c) => transformer.transform(c) ?? '').join('');
      const tail = transformer.finalize() ?? '';
      return out + tail;
    }

    it('emits message_start, content_block events, message_delta, and message_stop for plain text', () => {
      const t = createMessagesStreamTransformer('claude-sonnet-4');
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      ];
      const sse = flushChunks(t, chunks);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const eventLine = block.split('\n')[0]!;
          const dataLine = block.split('\n')[1]!;
          return {
            event: eventLine.replace('event: ', ''),
            data: JSON.parse(dataLine.replace('data: ', '')),
          };
        });

      expect(events.map((e) => e.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);

      expect(events[0].data.message.id).toMatch(/^msg_/);
      expect(events[0].data.message.model).toBe('claude-sonnet-4');
      expect(events[1].data.content_block).toEqual({ type: 'text', text: '' });
      expect(events[2].data.delta).toEqual({ type: 'text_delta', text: 'Hel' });
      expect(events[3].data.delta).toEqual({ type: 'text_delta', text: 'lo' });
      expect(events[5].data.delta).toEqual({ stop_reason: 'end_turn', stop_sequence: null });
      expect(events[5].data.usage).toEqual({
        input_tokens: 3,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });

    it('surfaces upstream error chunks as a terminal Anthropic error event (issue #2212)', () => {
      const t = createMessagesStreamTransformer('gpt-5');
      const sse = flushChunks(t, [
        'data: {"error":{"message":"Too many requests","type":"upstream_error","status":429,"code":"rate_limit_exceeded"}}\n\ndata: [DONE]\n\n',
      ]);

      expect(sse).toBe(
        'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}\n\n',
      );
      // No fabricated message_start / message_delta / message_stop around the error.
      expect(sse).not.toContain('message_start');
      expect(sse).not.toContain('message_stop');
    });

    it('ignores later stream payloads after a terminal error event', () => {
      const t = createMessagesStreamTransformer('gpt-5');
      const sse = flushChunks(t, [
        'data: {"error":{"message":"Too many requests","status":429}}\n\ndata: {"choices":[{"delta":{"content":"same chunk"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"later chunk"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);

      expect(sse).toBe(
        'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}\n\n',
      );
    });

    it('emits an error event mid-stream and suppresses the fabricated end_turn close', () => {
      const t = createMessagesStreamTransformer('gpt-5');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"error":{}}\n\ndata: [DONE]\n\n',
      ]);

      expect(sse).toContain('event: message_start');
      expect(sse).toContain(
        'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Upstream provider stream failed"}}',
      );
      expect(sse).not.toContain('"stop_reason":"end_turn"');
      expect(sse).not.toContain('message_stop');
    });

    it('emits tool_use content_block_start and input_json_delta for tool calls', () => {
      const t = createMessagesStreamTransformer('claude-sonnet-4');
      const sse = flushChunks(t, [
        'data: {"model":"claude","choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_a","function":{"name":"search","arguments":"{\\"q"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":\\"x\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]);

      expect(sse).toContain(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tc_a","name":"search","input":{}}}',
      );
      expect(sse).toContain(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q"}}',
      );
      expect(sse).toContain('"stop_reason":"tool_use"');
    });

    it('translates DeepSeek-style delta.reasoning_content into a leading thinking block', () => {
      // Without this, Claude clients lose the reasoning trace and the next turn
      // gets rejected by DeepSeek: "The `reasoning_content` in the thinking
      // mode must be passed back to the API."
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"step by step."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"42"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      expect(events.map((e) => e.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(events[1].data).toEqual({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      });
      expect(events[2].data.delta).toEqual({ type: 'thinking_delta', thinking: 'Let me think ' });
      expect(events[3].data.delta).toEqual({ type: 'thinking_delta', thinking: 'step by step.' });
      expect(events[4].data).toEqual({ type: 'content_block_stop', index: 0 });
      expect(events[5].data).toEqual({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      });
      expect(events[6].data.delta).toEqual({ type: 'text_delta', text: '42' });
    });

    it('closes the thinking block on finalize when the stream emits only reasoning_content', () => {
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);
      expect(sse).toContain(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      );
      expect(sse).toContain('"delta":{"type":"thinking_delta","thinking":"hmm"}');
      expect(sse).toContain(
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      );
    });

    it('closes the thinking block before opening a tool_use block', () => {
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"search","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]);
      const order = sse.match(/event: (\w+)/g)!.map((s) => s.replace('event: ', ''));
      // thinking block must be stopped before the tool_use block starts
      const thinkingStopAt = order.findIndex(
        (_, i) =>
          order[i] === 'content_block_stop' &&
          // first stop in the stream corresponds to the thinking block
          order.slice(0, i).filter((e) => e === 'content_block_stop').length === 0,
      );
      const toolStartAt = order.findIndex(
        (e, i) =>
          e === 'content_block_start' &&
          order.slice(0, i).filter((x) => x === 'content_block_start').length === 1,
      );
      expect(thinkingStopAt).toBeGreaterThan(-1);
      expect(toolStartAt).toBeGreaterThan(thinkingStopAt);
      expect(sse).toContain('"content_block":{"type":"tool_use"');
      expect(sse).toContain('"index":1'); // tool_use gets index 1, after thinking@0
    });

    it('reopens a fresh thinking block when reasoning_content arrives after text content', () => {
      // Real providers don't always flush reasoning_content before content —
      // a late reasoning chunk after text would previously emit a thinking_delta
      // against an already-stopped block (Anthropic SSE spec violation).
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":"first thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"afterthought"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      expect(events.map((e) => e.event)).toEqual([
        'message_start',
        'content_block_start', // thinking@0
        'content_block_delta', // thinking_delta "first thought"
        'content_block_stop', // thinking@0 closed by content
        'content_block_start', // text@1
        'content_block_delta', // text_delta "answer"
        'content_block_stop', // text@1 closed by late reasoning
        'content_block_start', // thinking@2 (reopen at fresh index)
        'content_block_delta', // thinking_delta "afterthought"
        'content_block_stop', // thinking@2 closed on finalize
        'message_delta',
        'message_stop',
      ]);
      // First thinking block is at index 0
      expect(events[1].data).toMatchObject({ index: 0, content_block: { type: 'thinking' } });
      expect(events[2].data).toMatchObject({
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'first thought' },
      });
      expect(events[3].data).toEqual({ type: 'content_block_stop', index: 0 });
      // Text takes index 1
      expect(events[4].data).toMatchObject({ index: 1, content_block: { type: 'text' } });
      expect(events[6].data).toEqual({ type: 'content_block_stop', index: 1 });
      // Reopened thinking block must use a fresh index (2), not collide with 0
      expect(events[7].data).toMatchObject({ index: 2, content_block: { type: 'thinking' } });
      expect(events[8].data).toMatchObject({
        index: 2,
        delta: { type: 'thinking_delta', thinking: 'afterthought' },
      });
      expect(events[9].data).toEqual({ type: 'content_block_stop', index: 2 });
    });

    it('reopens a fresh text block when content arrives after late reasoning_content', () => {
      // Symmetric case: content first, then a reasoning interlude, then more
      // content. The second content chunk must open a new text block at a
      // fresh index rather than emit deltas against the closed text@0.
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"second-guess"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      // text@0, thinking@1, text@2
      expect(events[1].data).toMatchObject({ index: 0, content_block: { type: 'text' } });
      expect(events[2].data).toMatchObject({
        index: 0,
        delta: { type: 'text_delta', text: 'hello ' },
      });
      expect(events[3].data).toEqual({ type: 'content_block_stop', index: 0 });
      expect(events[4].data).toMatchObject({ index: 1, content_block: { type: 'thinking' } });
      expect(events[5].data).toMatchObject({
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'second-guess' },
      });
      expect(events[6].data).toEqual({ type: 'content_block_stop', index: 1 });
      expect(events[7].data).toMatchObject({ index: 2, content_block: { type: 'text' } });
      expect(events[8].data).toMatchObject({
        index: 2,
        delta: { type: 'text_delta', text: 'world' },
      });
      expect(events[9].data).toEqual({ type: 'content_block_stop', index: 2 });
    });

    it('drops reasoning_content arriving during an open tool_use to keep the tool_use block contiguous', () => {
      // Manifest's Anthropic-compat layer assumes thinking blocks precede
      // tool_use and replays them in that shape on the next turn. Emitting a
      // post-tool thinking block would give clients a transcript shape
      // (`thinking → tool_use → thinking`) we cannot safely replay, so late
      // reasoning_content arriving while a tool_use is in-progress is dropped
      // silently. The pre-tool thinking block and the tool_use itself stay
      // intact.
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":"plan A"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"search","arguments":"{\\"q\\":1}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"plan B"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":" continued"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      expect(events.map((e) => e.event)).toEqual([
        'message_start',
        'content_block_start', // thinking@0
        'content_block_delta', // thinking_delta "plan A"
        'content_block_stop', // thinking@0 closed by tool_use
        'content_block_start', // tool_use@1
        'content_block_delta', // input_json_delta — "plan B" / " continued" dropped while open
        'content_block_stop', // tool_use@1 closed on finalize
        'message_delta',
        'message_stop',
      ]);
      expect(events[4].data).toMatchObject({ index: 1, content_block: { type: 'tool_use' } });
      expect(events[6].data).toEqual({ type: 'content_block_stop', index: 1 });
      // No thinking block ever opens after tool_use@1.
      const postToolThinking = events.find(
        (e, i) =>
          e.event === 'content_block_start' &&
          i > 6 &&
          (e.data.content_block as { type?: string })?.type === 'thinking',
      );
      expect(postToolThinking).toBeUndefined();
    });

    it('keeps a fragmented tool_call on a single tool_use block while dropping interleaved reasoning_content', () => {
      // Regression for the #1907 review: late reasoning_content used to close
      // the in-progress tool_use, then the next arg chunk for the same `index`
      // re-emitted `content_block_start` against the already-stopped index,
      // breaking monotonicity. Per the reviewer's follow-up, we now keep the
      // tool_use contiguous AND drop the interleaved reasoning entirely
      // rather than flushing a post-tool thinking block — emitting
      // `thinking → tool_use → thinking` would produce an Anthropic-shaped
      // transcript we cannot safely replay on the next turn.
      const t = createMessagesStreamTransformer('deepseek-v4-flash');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"late"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      expect(events.map((e) => e.event)).toEqual([
        'message_start',
        'content_block_start', // thinking@0
        'content_block_delta', // thinking_delta "plan"
        'content_block_stop', // thinking@0 stopped before tool_use opens
        'content_block_start', // tool_use@1
        'content_block_delta', // input_json_delta "{\"q\":"
        'content_block_delta', // input_json_delta "1}" — same block, no reopen at @1
        'content_block_stop', // tool_use@1 stopped on finalize
        'message_delta',
        'message_stop',
      ]);

      // tool_use stays at index 1 across both arg chunks.
      expect(events[4].data).toMatchObject({
        index: 1,
        content_block: { type: 'tool_use', id: 'tc_1', name: 'search' },
      });
      expect(events[5].data).toMatchObject({
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      });
      expect(events[6].data).toMatchObject({
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '1}' },
      });
      expect(events[7].data).toEqual({ type: 'content_block_stop', index: 1 });

      // Indices are strictly monotonic — no reuse of a stopped block index —
      // and "late" reasoning never produces a third thinking block.
      const blockIndices = events
        .filter((e) => e.event === 'content_block_start')
        .map((e) => e.data.index);
      expect(blockIndices).toEqual([0, 1]);

      // The dropped "late" reasoning is not surfaced as any thinking_delta.
      const lateLeak = events.find(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type?: string; thinking?: string })?.type === 'thinking_delta' &&
          (e.data.delta as { thinking?: string })?.thinking?.includes('late'),
      );
      expect(lateLeak).toBeUndefined();

      // stop_reason still propagates from the upstream finish_reason.
      const messageDelta = events.find((e) => e.event === 'message_delta');
      expect(messageDelta?.data.delta.stop_reason).toBe('tool_use');
    });

    it('finalize is idempotent — second call returns null', () => {
      const t = createMessagesStreamTransformer('m');
      t.transform('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n');
      const first = t.finalize();
      expect(first).toContain('event: message_stop');
      expect(t.finalize()).toBeNull();
    });

    it('starts the message even when only an empty payload is seen (initial chunk)', () => {
      const t = createMessagesStreamTransformer('m');
      const chunk = 'data: {"choices":[{"delta":{}}]}\n\n';
      const out = t.transform(chunk);
      expect(out).toContain('event: message_start');
    });

    it('ignores unparseable payloads without breaking the stream', () => {
      const t = createMessagesStreamTransformer('m');
      expect(t.transform('data: not-json\n\n')).toBeNull();
      expect(t.transform('data: "scalar"\n\n')).toBeNull();
      expect(t.transform('data: [DONE]\n\n')).toBeNull();

      const real = t.transform('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      expect(real).toContain('event: message_start');
      expect(real).toContain('"text":"a"');
    });

    it('captures usage from a finish_reason chunk that also carries usage', () => {
      const t = createMessagesStreamTransformer('m');
      const sse = [
        t.transform('data: {"choices":[{"delta":{"content":"x"}}]}\n\n') ?? '',
        t.transform(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        ) ?? '',
        t.finalize() ?? '',
      ].join('');
      expect(sse).toContain('"input_tokens":1');
      expect(sse).toContain('"output_tokens":1');
    });

    it('falls back to safe stringification when assistant tool input contains circular refs', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = messagesToChatCompletionsRequest({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_c', name: 'cycle', input: circular }],
          },
        ],
      });
      const messages = result.messages as Array<Record<string, unknown>>;
      const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;
      expect((toolCalls[0].function as Record<string, unknown>).arguments).toBe('');
    });

    it('handles raw payloads without a `data:` prefix', () => {
      const t = createMessagesStreamTransformer('m');
      const out = t.transform('{"choices":[{"delta":{"content":"raw"}}]}');
      expect(out).toContain('event: message_start');
      expect(out).toContain('"text":"raw"');
    });

    it('treats sequential zero-length deltas as no-ops and only opens a block on the first real content', () => {
      // Realistic heartbeat / status pattern: providers can send several deltas
      // with empty `reasoning_content`/`content` strings before any real text
      // arrives. Empty deltas must not open blocks, consume block indices, or
      // otherwise mutate state — so when "hello" finally lands, it opens
      // text@0 (not text@2 or higher) and the stream stays valid.
      const t = createMessagesStreamTransformer('m');
      const sse = flushChunks(t, [
        'data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]);

      const events = sse
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      // No thinking block was ever opened (all reasoning_content was empty),
      // and exactly one text block opens at the first non-empty content.
      expect(events.map((e) => e.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(events[1].data).toEqual({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      expect(events[2].data).toEqual({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      });
    });

    it('finalize closes an incomplete tool_use block opened mid-stream', () => {
      // The stream opens a tool_use and emits a partial input_json_delta, then
      // the upstream cuts off (no finish_reason, no second arg chunk, no usage).
      // finalize() must emit the matching content_block_stop for the open
      // tool_use plus the terminal message_delta / message_stop so clients
      // don't hang on an orphan content_block_start.
      const t = createMessagesStreamTransformer('m');
      const opened = t.transform(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_partial","function":{"name":"search","arguments":"{\\"arg\\""}}]}}]}\n\n',
      );
      expect(opened).toContain('"content_block":{"type":"tool_use"');
      expect(opened).toContain('"partial_json":"{\\"arg\\""');

      const tail = t.finalize();
      expect(tail).not.toBeNull();
      const events = tail!
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')),
          };
        });

      expect(events.map((e) => e.event)).toEqual([
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      // Stop must reference the tool_use's index (0, the first/only block).
      expect(events[0].data).toEqual({ type: 'content_block_stop', index: 0 });
      // No finish_reason was ever seen, so stop_reason defaults to end_turn.
      expect(events[1].data.delta.stop_reason).toBe('end_turn');
    });
  });
});

describe('tool-call id sanitation on /v1/messages responses', () => {
  it('chatCompletionsResponseToMessages sanitizes upstream tool_call ids', () => {
    const result = chatCompletionsResponseToMessages(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'Edit:0', type: 'function', function: { name: 'Edit', arguments: '{}' } },
                {
                  id: 'call_ok-1',
                  type: 'function',
                  function: { name: 'Read', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'kimi-k3',
    );
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks[0].id).toBe('Edit_0');
    expect(blocks[1].id).toBe('call_ok-1');
  });

  it('createMessagesStreamTransformer sanitizes the streamed tool_use id', () => {
    const t = createMessagesStreamTransformer('kimi-k3');
    const out =
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"Edit:0","function":{"name":"Edit","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]
        .map((c) => t.transform(c) ?? '')
        .join('') + (t.finalize() ?? '');
    const start = out
      .split('\n\n')
      .find((b) => b.startsWith('event: content_block_start') && b.includes('tool_use'))!;
    const data = JSON.parse(start.split('\n')[1].replace('data: ', ''));
    expect(data.content_block.id).toBe('Edit_0');
  });
});

describe('empty upstream tool_call ids', () => {
  it('mints a toolu_ id instead of emitting an empty one', () => {
    const result = chatCompletionsResponseToMessages(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: '', type: 'function', function: { name: 'Read', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'kimi-k3',
    );
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks[0].id).toMatch(/^toolu_[0-9a-f]{32}$/);
  });

  it('mints a toolu_ id in the stream transformer as well', () => {
    const t = createMessagesStreamTransformer('kimi-k3');
    const out =
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"Read","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]
        .map((c) => t.transform(c) ?? '')
        .join('') + (t.finalize() ?? '');
    const start = out
      .split('\n\n')
      .find((b) => b.startsWith('event: content_block_start') && b.includes('tool_use'))!;
    const data = JSON.parse(start.split('\n')[1].replace('data: ', ''));
    expect(data.content_block.id).toMatch(/^toolu_[0-9a-f]{32}$/);
  });
});
