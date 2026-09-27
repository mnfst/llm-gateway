import {
  applyAnthropicAutomaticCacheControl,
  applyAnthropicMessagesMutations,
  closeAnthropicObjectSchemas,
  extractThinkingBlocksFromMessagesResponse,
  toAnthropicRequest,
  fromAnthropicResponse,
  transformAnthropicStreamChunk,
  createAnthropicStreamTransformer,
} from '../anthropic-adapter';
import { injectOpenRouterCacheControl } from '../cache-injection';

function countCacheControls(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;

  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  const self = !Array.isArray(value) && 'cache_control' in value ? 1 : 0;
  return self + children.reduce((sum, child) => sum + countCacheControls(child), 0);
}

describe('Anthropic Adapter', () => {
  describe('toAnthropicRequest', () => {
    it('converts basic user message', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<{ role: string; content: unknown }>;

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('extracts system messages into top-level system array', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const system = result.system as Array<{
        type: string;
        text: string;
        cache_control?: unknown;
      }>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toBe('You are helpful.');
      expect(system[0].cache_control).toEqual({ type: 'ephemeral' });

      const messages = result.messages as Array<{ role: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('extracts developer role messages as system blocks', () => {
      const body = {
        messages: [
          { role: 'developer', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const system = result.system as Array<{ type: string; text: string }>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toBe('Be concise.');
    });

    it('injects cache_control on last system block only', () => {
      const body = {
        messages: [
          { role: 'system', content: 'First instruction.' },
          { role: 'system', content: 'Second instruction.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const system = result.system as Array<{ cache_control?: unknown }>;
      expect(system).toHaveLength(2);
      expect(system[0].cache_control).toBeUndefined();
      expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does not include top-level cache_control', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.cache_control).toBeUndefined();
    });

    it('defaults max_tokens to 4096 when absent', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.max_tokens).toBe(4096);
    });

    it('uses provided max_tokens', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1000,
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.max_tokens).toBe(1000);
    });

    it('maps max_completion_tokens to max_tokens', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        max_completion_tokens: 123,
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.max_tokens).toBe(123);
      expect(result.max_completion_tokens).toBeUndefined();
    });

    it('prefers max_tokens when both max-token fields are present', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 256,
        max_completion_tokens: 123,
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.max_tokens).toBe(256);
      expect(result.max_completion_tokens).toBeUndefined();
    });

    it('maps temperature and top_p', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
        top_p: 0.9,
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.temperature).toBe(0.7);
      expect(result.top_p).toBe(0.9);
    });

    it('forwards Anthropic-native top_k, thinking, and stop_sequences when present', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        top_k: 40,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        stop: ['STOP', 'END'],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.top_k).toBe(40);
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
      expect(result.stop_sequences).toEqual(['STOP', 'END']);
    });

    it('preserves adaptive thinking for model-specific Autofix', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'adaptive' },
      };

      expect(toAnthropicRequest(body, 'claude-haiku-4-5-20251001').thinking).toEqual({
        type: 'adaptive',
      });
      expect(toAnthropicRequest(body, 'anthropic/claude-haiku-4.5').thinking).toEqual({
        type: 'adaptive',
      });
      expect(toAnthropicRequest(body, 'claude-haiku-4').thinking).toEqual({ type: 'adaptive' });
    });

    it('preserves extended thinking for Claude Haiku 4.5', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'enabled', budget_tokens: 2048 },
      };

      const result = toAnthropicRequest(body, 'claude-haiku-4-5-20251001');
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    it('preserves adaptive thinking for adaptive-capable Claude models', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'adaptive' },
      };

      expect(toAnthropicRequest(body, 'claude-sonnet-4-6').thinking).toEqual({
        type: 'adaptive',
      });
      expect(toAnthropicRequest(body, 'claude-opus-4-6').thinking).toEqual({
        type: 'adaptive',
      });
    });

    it('preserves the manual budget for adaptive-thinking Autofix', () => {
      const thinking = { type: 'adaptive', budget_tokens: 8192, display: 'omitted' };

      const result = toAnthropicRequest(
        { messages: [{ role: 'user', content: 'Hi' }], thinking },
        'claude-opus-4-8',
      );

      expect(result.thinking).toBe(thinking);
      expect(thinking).toEqual({
        type: 'adaptive',
        budget_tokens: 8192,
        display: 'omitted',
      });
    });

    it('wraps a bare string `stop` value into stop_sequences (chat_completions accepts both shapes)', () => {
      // Cubic flagged: if a chat_completions client sends `stop: "END"`,
      // the previous code dropped it because it only handled arrays.
      const result = toAnthropicRequest(
        { messages: [{ role: 'user', content: 'Hi' }], stop: 'END' },
        'claude-sonnet-4-20250514',
      );
      expect(result.stop_sequences).toEqual(['END']);
    });

    it('ignores empty-string stop and non-string non-array shapes', () => {
      const empty = toAnthropicRequest(
        { messages: [{ role: 'user', content: 'Hi' }], stop: '' },
        'claude-sonnet-4-20250514',
      );
      expect(empty.stop_sequences).toBeUndefined();

      const nonsense = toAnthropicRequest(
        { messages: [{ role: 'user', content: 'Hi' }], stop: 42 },
        'claude-sonnet-4-20250514',
      );
      expect(nonsense.stop_sequences).toBeUndefined();
    });

    it('converts tools with input_schema and injects cache_control on last tool', () => {
      const body = {
        messages: [{ role: 'user', content: 'Search' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const tools = result.tools as Array<{
        name: string;
        input_schema: unknown;
        cache_control?: unknown;
      }>;
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('web_search');
      expect(tools[0].input_schema).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
      });
      expect(tools[0].cache_control).toBeUndefined();
      expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('maps json_schema response_format to native Anthropic output_config', () => {
      const schema = {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      };
      const body = {
        messages: [{ role: 'user', content: 'Summarize the visit.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_patient',
              parameters: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'patient_summary',
            description: 'Patient summary payload',
            schema,
            strict: true,
          },
        },
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      expect(result.tool_choice).toBeUndefined();
      expect(result.output_config).toEqual({
        format: { type: 'json_schema', schema },
      });
      expect(result.tools).toEqual([
        {
          name: 'lookup_patient',
          input_schema: { type: 'object', properties: { id: { type: 'string' } } },
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('uses default schema details when json_schema response_format is incomplete', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return structured data.' }],
          response_format: { type: 'json_schema' },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.tool_choice).toBeUndefined();
      expect(result.tools).toBeUndefined();
      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: { type: 'object', additionalProperties: false },
        },
      });
    });

    it('maps json_object response_format to native Anthropic object output', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return JSON.' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'structured_output',
                parameters: { type: 'object' },
              },
            },
          ],
          response_format: { type: 'json_object' },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.tool_choice).toBeUndefined();
      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: { type: 'object', additionalProperties: false },
        },
      });
      expect(result.tools).toEqual([
        {
          name: 'structured_output',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('does not add output_config for unsupported response_format types', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return text.' }],
          response_format: { type: 'text' },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.tool_choice).toBeUndefined();
      expect(result.tools).toBeUndefined();
      expect(result.output_config).toBeUndefined();
    });

    it('closes object nodes in a structured-output schema recursively', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return structured data.' }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              schema: {
                type: 'object',
                properties: {
                  outer: { type: 'object', properties: { inner: { type: 'string' } } },
                  list: { type: 'array', items: { type: 'object' } },
                  open: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              outer: {
                type: 'object',
                additionalProperties: false,
                properties: { inner: { type: 'string' } },
              },
              list: { type: 'array', items: { type: 'object', additionalProperties: false } },
              open: { type: 'object', additionalProperties: true },
            },
          },
        },
      });
    });

    it('leaves enum/default data values untouched while closing schema nodes', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return structured data.' }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              schema: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['a', { type: 'object' }] },
                  fallback: { type: 'string', default: { type: 'object' } },
                },
              },
            },
          },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['a', { type: 'object' }] },
              fallback: { type: 'string', default: { type: 'object' } },
            },
          },
        },
      });
    });

    it('closes object schemas across every category of schema-valued keyword', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return structured data.' }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              schema: {
                // No `type`, but `properties` still describes an object.
                properties: {
                  a: { type: 'object' },
                  b: { type: ['object', 'null'] },
                },
                // Tuple form of `items`.
                items: [{ type: 'object' }, { type: 'string' }],
                // Combinators are lists of subschemas.
                anyOf: [{ type: 'object' }, { type: 'string' }],
                // Maps of subschemas.
                $defs: { node: { type: 'object' } },
                dependencies: { a: { type: 'object' } },
                patternProperties: { '^x': { type: 'object' } },
                // Single-subschema applicators.
                not: { type: 'object' },
                if: { type: 'object' },
                // `additionalProperties` may itself be a schema.
                additionalProperties: { type: 'object' },
              },
            },
          },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: {
            properties: {
              a: { type: 'object', additionalProperties: false },
              b: { type: ['object', 'null'], additionalProperties: false },
            },
            items: [{ type: 'object', additionalProperties: false }, { type: 'string' }],
            anyOf: [{ type: 'object', additionalProperties: false }, { type: 'string' }],
            $defs: { node: { type: 'object', additionalProperties: false } },
            dependencies: { a: { type: 'object', additionalProperties: false } },
            patternProperties: { '^x': { type: 'object', additionalProperties: false } },
            not: { type: 'object', additionalProperties: false },
            if: { type: 'object', additionalProperties: false },
            additionalProperties: { type: 'object', additionalProperties: false },
          },
        },
      });
    });

    it('preserves a property literally named __proto__ without polluting the prototype', () => {
      const schema = JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"object"}}}',
      ) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(schema.properties, '__proto__')).toBe(true);

      const closed = closeAnthropicObjectSchemas(schema) as Record<string, unknown>;
      const props = closed.properties as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(props, '__proto__')).toBe(true);
      expect((props['__proto__'] as Record<string, unknown>).additionalProperties).toBe(false);
      expect(({} as Record<string, unknown>).additionalProperties).toBeUndefined();
    });

    it('preserves thinking when native structured output is requested', () => {
      const result = toAnthropicRequest(
        {
          messages: [{ role: 'user', content: 'Return JSON.' }],
          thinking: { type: 'enabled', budget_tokens: 1024 },
          response_format: { type: 'json_object' },
        },
        'claude-sonnet-4-20250514',
      );

      expect(result.tool_choice).toBeUndefined();
      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: { type: 'object', additionalProperties: false },
        },
      });
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    });

    it('converts tool_calls in assistant messages to tool_use blocks', () => {
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
                function: { name: 'web_search', arguments: '{"query":"cats"}' },
              },
            ],
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ role: string; content: unknown }>;
      const assistant = messages[1];
      const content = assistant.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'web_search',
        input: { query: 'cats' },
      });
    });

    it('converts tool role messages to user messages with tool_result', () => {
      const body = {
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: '{"results": ["cat1"]}' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ role: string; content: unknown }>;
      expect(messages[0].role).toBe('user');
      const content = messages[0].content as Array<Record<string, unknown>>;
      expect(content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: '{"results": ["cat1"]}',
      });
    });

    it('handles array content blocks in user messages', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'First' },
              { type: 'text', text: 'Second' },
              { type: 'image', source: { data: 'base64' } },
            ],
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ content: unknown }>;
      const content = messages[0].content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'text', text: 'First' });
      expect(content[1]).toEqual({ type: 'text', text: 'Second' });
    });

    it('converts OpenAI image_url content blocks to Anthropic image blocks', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at these.' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.webp' },
              },
            ],
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'Look at these.' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.com/image.webp' },
        },
      ]);
    });

    it('converts Responses input_image content blocks to Anthropic image blocks', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'What is in this image?' },
              { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
            ],
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'What is in this image?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQSkZJRg==' },
        },
      ]);
    });

    it('handles system message with array content', () => {
      const body = {
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'Instruction 1' },
              { type: 'text', text: 'Instruction 2' },
            ],
          },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const system = result.system as Array<{
        type: string;
        text: string;
        cache_control?: unknown;
      }>;
      expect(system).toHaveLength(2);
      expect(system[0].text).toBe('Instruction 1');
      expect(system[1].text).toBe('Instruction 2');
      expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('skips assistant messages with no content and no tool_calls', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant' },
          { role: 'user', content: 'Bye' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<unknown>;
      expect(messages).toHaveLength(2);
    });

    it('filters empty string content on assistant messages with tool_calls', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', type: 'function', function: { name: 'search', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: 'result', tool_call_id: 'tc1' },
          { role: 'user', content: 'Thanks' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ role: string; content: Array<{ type: string }> }>;
      const assistant = messages.find((m) => m.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant!.content).toHaveLength(1);
      expect(assistant!.content[0].type).toBe('tool_use');
    });

    it('omits assistant message with empty string content and no tool_calls', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: '' },
          { role: 'user', content: 'Bye' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');

      const messages = result.messages as Array<{ role: string }>;
      expect(messages).toHaveLength(2);
      expect(messages.every((m) => m.role === 'user')).toBe(true);
    });

    it('omits system key when no system messages exist', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.system).toBeUndefined();
    });

    it('converts tool message with non-string content via JSON.stringify', () => {
      const body = {
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: { result: 'data' } }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<{ role: string; content: unknown }>;
      expect(messages[0].role).toBe('user');
      const content = messages[0].content as Array<Record<string, unknown>>;
      expect(content[0].content).toBe('{"result":"data"}');
    });

    it('converts tool message with null content', () => {
      const body = {
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: null }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<{ role: string; content: unknown }>;
      const content = messages[0].content as Array<Record<string, unknown>>;
      expect(content[0].content).toBe('""');
    });

    it('converts tool message without tool_call_id to unknown', () => {
      const body = {
        messages: [{ role: 'tool', content: 'result text' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<{ role: string; content: unknown }>;
      const content = messages[0].content as Array<Record<string, unknown>>;
      expect(content[0].tool_use_id).toBe('unknown');
    });

    it('returns empty args when tool_call arguments string is invalid JSON', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: 'thinking',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: 'not-valid-json{' },
              },
            ],
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
      const toolBlock = messages[0].content.find((b) => b.type === 'tool_use');
      // safeParseArgs catches and returns {}.
      expect(toolBlock!.input).toEqual({});
    });

    it('handles tool_call with empty arguments string', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: 'Let me call a tool.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: '' },
              },
            ],
          },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<{ role: string; content: unknown }>;
      const content = messages[0].content as Array<Record<string, unknown>>;
      // Last block should be the tool_use with empty parsed args
      const toolBlock = content[content.length - 1];
      expect(toolBlock.type).toBe('tool_use');
      expect(toolBlock.input).toEqual({});
    });

    it('skips user messages with no usable content blocks', () => {
      const body = {
        messages: [
          { role: 'user', content: [{ type: 'image', source: { data: 'base64' } }] },
          { role: 'user', content: 'Hello' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      // The image-only user message should be filtered out (null from convertMessage)
      const messages = result.messages as Array<unknown>;
      expect(messages).toHaveLength(1);
    });

    it('handles body with no messages property', () => {
      const result = toAnthropicRequest({}, 'claude-sonnet-4-20250514');
      const messages = result.messages as Array<unknown>;
      expect(messages).toHaveLength(0);
      expect(result.system).toBeUndefined();
    });

    it('skips tools with no function property', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'retrieval' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.tools).toBeUndefined();
    });

    it('prepends subscription identity block when injectSubscriptionIdentity is true', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-6', {
        injectSubscriptionIdentity: true,
      });
      const system = result.system as Array<{
        type: string;
        text: string;
        cache_control?: unknown;
      }>;
      expect(system).toHaveLength(2);
      expect(system[0].text).toContain('Claude agent');
      expect(system[0].cache_control).toBeUndefined();
      expect(system[1].text).toBe('You are helpful.');
      expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds subscription identity as sole system block when no user system prompt', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-6', {
        injectSubscriptionIdentity: true,
      });
      const system = result.system as Array<{ type: string; text: string }>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toContain('Claude agent');
    });

    it('does not inject subscription identity when option is false', () => {
      const body = {
        messages: [
          { role: 'system', content: 'Custom prompt.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-6', {
        injectSubscriptionIdentity: false,
      });
      const system = result.system as Array<{ type: string; text: string }>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toBe('Custom prompt.');
    });

    it('injects cache_control on system blocks and tools by default', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
        tools: [{ type: 'function', function: { name: 'a', description: 'tool a' } }],
      };
      const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
      expect(result.cache_control).toBeUndefined();
      const system = result.system as Array<{ cache_control?: unknown }>;
      expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
      const tools = result.tools as Array<{ cache_control?: unknown }>;
      expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('fromAnthropicResponse', () => {
    it('converts text response', () => {
      const resp = {
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('claude-sonnet-4-20250514');

      const choices = result.choices as Array<{
        message: Record<string, unknown>;
        finish_reason: string;
      }>;
      expect(choices).toHaveLength(1);
      expect(choices[0].message.role).toBe('assistant');
      expect(choices[0].message.content).toBe('Hello!');
      expect(choices[0].finish_reason).toBe('stop');

      const usage = result.usage as Record<string, unknown>;
      expect(usage.prompt_tokens).toBe(10);
      expect(usage.completion_tokens).toBe(5);
      expect(usage.total_tokens).toBe(15);
    });

    it('maps end_turn to stop', () => {
      const resp = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('maps max_tokens to length', () => {
      const resp = { content: [{ type: 'text', text: 'truncated' }], stop_reason: 'max_tokens' };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('length');
    });

    it('maps tool_use to tool_calls', () => {
      const resp = {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'web_search',
            input: { query: 'cats' },
          },
        ],
        stop_reason: 'tool_use',
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const choices = result.choices as Array<{
        message: Record<string, unknown>;
        finish_reason: string;
      }>;
      expect(choices[0].finish_reason).toBe('tool_calls');

      const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toBe('toolu_1');
      const fn = toolCalls[0].function as { name: string; arguments: string };
      expect(fn.name).toBe('web_search');
      expect(JSON.parse(fn.arguments)).toEqual({ query: 'cats' });
    });

    it('extracts cache token metrics', () => {
      const resp = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const usage = result.usage as Record<string, unknown>;
      expect(usage.cache_read_tokens).toBe(80);
      expect(usage.cache_creation_tokens).toBe(20);
      const details = usage.prompt_tokens_details as { cached_tokens: number };
      expect(details.cached_tokens).toBe(80);
    });

    it('calculates prompt_tokens as input_tokens + cache_read + cache_creation', () => {
      const resp = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const usage = result.usage as Record<string, unknown>;
      // prompt_tokens = input(100) + cache_read(80) + cache_creation(20) = 200
      expect(usage.prompt_tokens).toBe(200);
      expect(usage.completion_tokens).toBe(50);
      expect(usage.total_tokens).toBe(250);
    });

    it('calculates prompt_tokens correctly with zero cache tokens', () => {
      const resp = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 25 },
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const usage = result.usage as Record<string, unknown>;
      // No cache tokens: prompt_tokens = input(50) + 0 + 0 = 50
      expect(usage.prompt_tokens).toBe(50);
      expect(usage.completion_tokens).toBe(25);
      expect(usage.total_tokens).toBe(75);
      expect(usage.cache_read_tokens).toBe(0);
      expect(usage.cache_creation_tokens).toBe(0);
      const details = usage.prompt_tokens_details as { cached_tokens: number };
      expect(details.cached_tokens).toBe(0);
    });

    it('calculates prompt_tokens with only cache_read (no cache_creation)', () => {
      const resp = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 30,
          output_tokens: 10,
          cache_read_input_tokens: 200,
        },
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const usage = result.usage as Record<string, unknown>;
      // prompt_tokens = input(30) + cache_read(200) + 0 = 230
      expect(usage.prompt_tokens).toBe(230);
      expect(usage.cache_read_tokens).toBe(200);
      expect(usage.cache_creation_tokens).toBe(0);
    });

    it('calculates prompt_tokens with only cache_creation (no cache_read)', () => {
      const resp = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_creation_input_tokens: 150,
        },
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const usage = result.usage as Record<string, unknown>;
      // prompt_tokens = input(50) + 0 + cache_creation(150) = 200
      expect(usage.prompt_tokens).toBe(200);
      expect(usage.cache_read_tokens).toBe(0);
      expect(usage.cache_creation_tokens).toBe(150);
    });

    it('handles large cache token counts', () => {
      const resp = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 50000,
          cache_creation_input_tokens: 10000,
        },
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const usage = result.usage as Record<string, unknown>;
      expect(usage.prompt_tokens).toBe(60500);
      expect(usage.total_tokens).toBe(60600);
    });

    it('handles empty content array', () => {
      const resp = { content: [], stop_reason: 'end_turn' };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      expect(choices[0].message.content).toBeNull();
    });

    it('handles mixed text and tool_use content', () => {
      const resp = {
        content: [
          { type: 'text', text: 'Let me search for that.' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
        ],
        stop_reason: 'tool_use',
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');

      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      expect(choices[0].message.content).toBe('Let me search for that.');
      expect(choices[0].message.tool_calls).toBeDefined();
    });

    it('omits usage when not present', () => {
      const resp = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      expect(result.usage).toBeUndefined();
    });

    it('handles missing stop_reason as stop', () => {
      const resp = { content: [{ type: 'text', text: 'ok' }] };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('maps unknown stop_reason to stop', () => {
      const resp = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'unknown_reason' };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('handles tool_use block with null input', () => {
      const resp = {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'test_tool',
            input: null,
          },
        ],
        stop_reason: 'tool_use',
      };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
      const fn = toolCalls[0].function as { arguments: string };
      expect(JSON.parse(fn.arguments)).toEqual({});
    });

    it('handles response with no content array', () => {
      const resp = { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      expect(choices[0].message.content).toBeNull();
    });

    it('maps stop_sequence to stop', () => {
      const resp = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'stop_sequence' };
      const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('stop');
    });
  });

  describe('transformAnthropicStreamChunk', () => {
    it('converts text_delta to OpenAI chunk', () => {
      const chunk =
        'event: content_block_delta\n{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');

      expect(result).toContain('data: ');
      expect(result).toContain('"chat.completion.chunk"');

      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.content).toBe('Hello');
      expect(data.choices[0].finish_reason).toBeNull();
    });

    it('converts message_delta with stop_reason and usage to finish + usage chunks', () => {
      const chunk =
        'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":16}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');

      // Result contains two SSE events: finish chunk + usage chunk
      const parts = result!.split('\n\n').filter(Boolean);
      expect(parts.length).toBe(2);

      const finish = JSON.parse(parts[0].replace('data: ', ''));
      expect(finish.choices[0].finish_reason).toBe('stop');
      expect(finish.choices[0].delta).toEqual({});

      const usage = JSON.parse(parts[1].replace('data: ', ''));
      expect(usage.choices).toEqual([]);
      expect(usage.usage.completion_tokens).toBe(16);
      expect(usage.usage.prompt_tokens).toBe(0); // no message_start in stateless call
    });

    it('returns null for ping event', () => {
      const chunk = 'event: ping\n{"type":"ping"}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).toBeNull();
    });

    it('converts message_start to initial role chunk', () => {
      const chunk =
        'event: message_start\n{"type":"message_start","message":{"id":"msg_01","role":"assistant"}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');

      expect(result).toContain('data: ');
      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.role).toBe('assistant');
      expect(data.choices[0].delta.content).toBe('');
      expect(data.choices[0].finish_reason).toBeNull();
    });

    it('returns null for text-type content_block_start event', () => {
      const chunk =
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).toBeNull();
    });

    it('returns null for content_block_stop event', () => {
      const chunk = 'event: content_block_stop\n{"type":"content_block_stop"}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).toBeNull();
    });

    it('returns null for empty chunks', () => {
      expect(transformAnthropicStreamChunk('', 'claude-sonnet-4-20250514')).toBeNull();
      expect(transformAnthropicStreamChunk('  ', 'claude-sonnet-4-20250514')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const chunk = 'event: content_block_delta\nnot json';
      expect(transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514')).toBeNull();
    });

    it('returns null for input_json_delta without prior block mapping', () => {
      const chunk =
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q"}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).toBeNull();
    });

    it('returns null for event-only chunk with no data payload', () => {
      const chunk = 'event: content_block_start';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).toBeNull();
    });

    it('returns null for content_block_delta without delta property', () => {
      const chunk = 'event: content_block_delta\n{"type":"content_block_delta"}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).toBeNull();
    });

    it('handles message_delta without usage property', () => {
      const chunk =
        'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"end_turn"}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');
      expect(result).not.toBeNull();

      const parts = result!.split('\n\n').filter(Boolean);
      const usage = JSON.parse(parts[1].replace('data: ', ''));
      // outputTokens defaults to 0 when usage is undefined
      expect(usage.usage.completion_tokens).toBe(0);
      expect(usage.usage.prompt_tokens).toBe(0);
      expect(usage.usage.total_tokens).toBe(0);
    });

    it('handles chunk without event prefix (data type fallback)', () => {
      const chunk = '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}';
      const result = transformAnthropicStreamChunk(chunk, 'claude-sonnet-4-20250514');

      expect(result).toContain('data: ');
      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.content).toBe('Hi');
    });
  });

  describe('createAnthropicStreamTransformer (stateful)', () => {
    it('emits tool call delta for tool_use content_block_start', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      );

      const blockStart =
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search"}}';
      const result = transform(blockStart);

      expect(result).not.toBeNull();
      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.tool_calls).toEqual([
        {
          index: 0,
          id: 'toolu_1',
          type: 'function',
          function: { name: 'web_search', arguments: '' },
        },
      ]);
    });

    it('emits tool call argument deltas for input_json_delta', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      );
      transform(
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"search"}}',
      );

      const jsonDelta =
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\""}}';
      const result = transform(jsonDelta);

      expect(result).not.toBeNull();
      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.tool_calls).toEqual([
        { index: 0, function: { arguments: '{"query"' } },
      ]);
    });

    it('streams a full tool call flow end-to-end', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      // message_start
      const start = transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":50}}}',
      );
      expect(start).toContain('"role":"assistant"');

      // tool_use block start
      const blockStart = transform(
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"get_weather"}}',
      );
      const bsData = JSON.parse(blockStart!.replace('data: ', '').trim());
      expect(bsData.choices[0].delta.tool_calls[0].id).toBe('toolu_abc');
      expect(bsData.choices[0].delta.tool_calls[0].function.name).toBe('get_weather');

      // argument deltas
      const arg1 = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}',
      );
      const a1Data = JSON.parse(arg1!.replace('data: ', '').trim());
      expect(a1Data.choices[0].delta.tool_calls[0].function.arguments).toBe('{"loc');

      const arg2 = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ation\\": \\"NYC\\"}"}}',
      );
      const a2Data = JSON.parse(arg2!.replace('data: ', '').trim());
      expect(a2Data.choices[0].delta.tool_calls[0].function.arguments).toBe('ation": "NYC"}');

      // message_delta with tool_use stop reason
      const end = transform(
        'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}',
      );
      const parts = end!.split('\n\n').filter(Boolean);
      const finish = JSON.parse(parts[0].replace('data: ', ''));
      expect(finish.choices[0].finish_reason).toBe('tool_calls');
    });

    it('handles multiple tool calls with correct indices', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      );

      // First tool
      const tc1 = transform(
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"tool_a"}}',
      );
      const tc1Data = JSON.parse(tc1!.replace('data: ', '').trim());
      expect(tc1Data.choices[0].delta.tool_calls[0].index).toBe(0);

      // Second tool
      const tc2 = transform(
        'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"tool_b"}}',
      );
      const tc2Data = JSON.parse(tc2!.replace('data: ', '').trim());
      expect(tc2Data.choices[0].delta.tool_calls[0].index).toBe(1);

      // Delta for second tool uses correct index
      const delta = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      );
      const dData = JSON.parse(delta!.replace('data: ', '').trim());
      expect(dData.choices[0].delta.tool_calls[0].index).toBe(1);
    });

    it('handles text block followed by tool_use block in same stream', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      );

      // Text content_block_start (returns null)
      const textBlock = transform(
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      );
      expect(textBlock).toBeNull();

      // Text delta
      const textDelta = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me search."}}',
      );
      expect(textDelta).toContain('"content":"Let me search."');

      // Tool use content_block_start
      const toolBlock = transform(
        'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_99","name":"search"}}',
      );
      const toolData = JSON.parse(toolBlock!.replace('data: ', '').trim());
      expect(toolData.choices[0].delta.tool_calls[0].index).toBe(0);
      expect(toolData.choices[0].delta.tool_calls[0].id).toBe('toolu_99');

      // Input JSON delta for tool
      const argDelta = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\": \\"cats\\"}"}}',
      );
      const argData = JSON.parse(argDelta!.replace('data: ', '').trim());
      expect(argData.choices[0].delta.tool_calls[0].index).toBe(0);
      expect(argData.choices[0].delta.tool_calls[0].function.arguments).toBe('{"q": "cats"}');
    });

    it('returns null for content_block_start without content_block field', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      );

      const result = transform(
        'event: content_block_start\n{"type":"content_block_start","index":0}',
      );
      expect(result).toBeNull();
    });

    it('handles message_start without message property', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      const result = transform('event: message_start\n{"type":"message_start"}');
      expect(result).not.toBeNull();
      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.role).toBe('assistant');

      // Verify tokens default to 0 in subsequent message_delta
      const end = transform(
        'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      );
      const parts = end!.split('\n\n').filter(Boolean);
      const usage = JSON.parse(parts[1].replace('data: ', ''));
      expect(usage.usage.prompt_tokens).toBe(0);
      expect(usage.usage.cache_read_tokens).toBe(0);
      expect(usage.usage.cache_creation_tokens).toBe(0);
    });

    it('handles interleaved text deltas and input_json_deltas across blocks', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      );

      // Start text block at index 0
      transform(
        'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      );

      // Text delta on block 0
      const t1 = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      );
      expect(t1).toContain('"content":"Hello"');

      // Start tool block at index 1
      const toolStart = transform(
        'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"fn_a"}}',
      );
      expect(toolStart).not.toBeNull();

      // Input JSON delta on block 1
      const j1 = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a"}}',
      );
      const j1Data = JSON.parse(j1!.replace('data: ', '').trim());
      expect(j1Data.choices[0].delta.tool_calls[0].index).toBe(0);

      // Another text delta for block 0 (interleaved -- unlikely but valid)
      const t2 = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
      );
      expect(t2).toContain('"content":" world"');

      // More JSON delta on block 1
      const j2 = transform(
        'event: content_block_delta\n{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\": 1}"}}',
      );
      const j2Data = JSON.parse(j2!.replace('data: ', '').trim());
      expect(j2Data.choices[0].delta.tool_calls[0].function.arguments).toBe('": 1}');
    });

    it('accumulates input tokens from message_start into message_delta usage', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      // message_start carries input token counts
      const start =
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}';
      transform(start);

      // content delta
      const delta =
        'event: content_block_delta\n{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}';
      const textResult = transform(delta);
      expect(textResult).toContain('"content":"Hi"');

      // message_delta carries output tokens — should combine with stored input tokens
      const end =
        'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}';
      const result = transform(end);

      const parts = result!.split('\n\n').filter(Boolean);
      const usage = JSON.parse(parts[1].replace('data: ', ''));
      // prompt_tokens = input(42) + cache_read(10) + cache_creation(5) = 57
      expect(usage.usage.prompt_tokens).toBe(57);
      expect(usage.usage.completion_tokens).toBe(20);
      expect(usage.usage.total_tokens).toBe(77);
      expect(usage.usage.cache_read_tokens).toBe(10);
      expect(usage.usage.cache_creation_tokens).toBe(5);
      expect(usage.usage.prompt_tokens_details.cached_tokens).toBe(10);
    });

    it('prefers cumulative input and cache tokens from message_delta usage when present', () => {
      const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

      transform(
        'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}',
      );

      const result = transform(
        'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":7,"output_tokens":30}}',
      );

      const parts = result!.split('\n\n').filter(Boolean);
      const usage = JSON.parse(parts[1].replace('data: ', ''));
      expect(usage.usage.prompt_tokens).toBe(127);
      expect(usage.usage.completion_tokens).toBe(30);
      expect(usage.usage.total_tokens).toBe(157);
      expect(usage.usage.cache_read_tokens).toBe(20);
      expect(usage.usage.cache_creation_tokens).toBe(7);
      expect(usage.usage.prompt_tokens_details.cached_tokens).toBe(20);
    });
  });

  describe('extended-thinking round-trip (Fix 3)', () => {
    describe('fromAnthropicResponse', () => {
      it('extracts thinking blocks + tool_use via _extractedThinkingBlocks', () => {
        const thinkingBlock = {
          type: 'thinking',
          thinking: 'Let me think about this.',
          signature: 'sig_1',
        };
        const resp = {
          content: [
            thinkingBlock,
            { type: 'text', text: 'Result' },
            { type: 'tool_use', id: 'toolu_first', name: 'search', input: { q: 'cats' } },
          ],
          stop_reason: 'tool_use',
        };
        const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
        const extracted = (result as Record<string, unknown>)._extractedThinkingBlocks as {
          firstToolUseId: string;
          blocks: Array<Record<string, unknown>>;
        };
        expect(extracted).toBeDefined();
        expect(extracted.firstToolUseId).toBe('toolu_first');
        expect(extracted.blocks).toHaveLength(1);
        // The extracted block must be the SAME object reference — Anthropic
        // signs it and we never mutate.
        expect(extracted.blocks[0]).toBe(thinkingBlock);
      });

      it('extracts redacted_thinking blocks the same way', () => {
        const redacted = { type: 'redacted_thinking', data: 'opaque-blob' };
        const resp = {
          content: [redacted, { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} }],
          stop_reason: 'tool_use',
        };
        const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
        const extracted = (result as Record<string, unknown>)._extractedThinkingBlocks as {
          firstToolUseId: string;
          blocks: Array<Record<string, unknown>>;
        };
        expect(extracted).toBeDefined();
        expect(extracted.firstToolUseId).toBe('toolu_1');
        expect(extracted.blocks[0]).toBe(redacted);
      });

      it('does not surface _extractedThinkingBlocks when there is no tool_use', () => {
        const resp = {
          content: [
            { type: 'thinking', thinking: 'quiet reasoning', signature: 's' },
            { type: 'text', text: 'Final answer.' },
          ],
          stop_reason: 'end_turn',
        };
        const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
        expect((result as Record<string, unknown>)._extractedThinkingBlocks).toBeUndefined();
      });

      it('does not surface _extractedThinkingBlocks when there are tool_use but no thinking', () => {
        const resp = {
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'cats' } },
          ],
          stop_reason: 'tool_use',
        };
        const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
        expect((result as Record<string, unknown>)._extractedThinkingBlocks).toBeUndefined();
      });

      it('maps regular content and tool_calls alongside thinking extraction', () => {
        const thinkingBlock = {
          type: 'thinking',
          thinking: 'Thinking...',
          signature: 'sig_xy',
        };
        const resp = {
          content: [
            thinkingBlock,
            { type: 'text', text: 'The answer is:' },
            { type: 'tool_use', id: 'toolu_1', name: 'calc', input: { n: 2 } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
        const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
        const choices = result.choices as Array<{
          message: Record<string, unknown>;
          finish_reason: string;
        }>;
        // Regular mapping still works: text content + tool_calls + finish_reason.
        expect(choices[0].message.content).toBe('The answer is:');
        const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].id).toBe('toolu_1');
        expect(choices[0].finish_reason).toBe('tool_calls');

        // And thinking extraction happened in parallel.
        const extracted = (result as Record<string, unknown>)._extractedThinkingBlocks as {
          firstToolUseId: string;
          blocks: Array<Record<string, unknown>>;
        };
        expect(extracted.firstToolUseId).toBe('toolu_1');
        expect(extracted.blocks[0]).toBe(thinkingBlock);
      });

      it('preserves the order of multiple thinking blocks', () => {
        const b1 = { type: 'thinking', thinking: 'step 1', signature: 's1' };
        const b2 = { type: 'redacted_thinking', data: 'blob' };
        const b3 = { type: 'thinking', thinking: 'step 3', signature: 's3' };
        const resp = {
          content: [b1, b2, b3, { type: 'tool_use', id: 'toolu_1', name: 'calc', input: {} }],
          stop_reason: 'tool_use',
        };
        const result = fromAnthropicResponse(resp, 'claude-sonnet-4-20250514');
        const extracted = (result as Record<string, unknown>)._extractedThinkingBlocks as {
          firstToolUseId: string;
          blocks: Array<Record<string, unknown>>;
        };
        expect(extracted.blocks).toHaveLength(3);
        expect(extracted.blocks[0]).toBe(b1);
        expect(extracted.blocks[1]).toBe(b2);
        expect(extracted.blocks[2]).toBe(b3);
      });
    });

    describe('toAnthropicRequest thinkingLookup', () => {
      it('prepends cached thinking blocks before text and tool_use', () => {
        const thinkingBlock = {
          type: 'thinking',
          thinking: 'cached reasoning',
          signature: 'sig_cached',
        };
        const lookup = jest.fn().mockReturnValue([thinkingBlock]);

        const body = {
          messages: [
            { role: 'user', content: 'Do it' },
            {
              role: 'assistant',
              content: 'Working on it.',
              tool_calls: [
                {
                  id: 'toolu_first',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"cats"}' },
                },
              ],
            },
          ],
        };
        const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514', {
          thinkingLookup: lookup,
        });

        expect(lookup).toHaveBeenCalledWith('toolu_first');

        const messages = result.messages as Array<{ role: string; content: unknown }>;
        const assistant = messages[1];
        const content = assistant.content as Array<Record<string, unknown>>;
        // Order must be: thinking block → text → tool_use.
        expect(content).toHaveLength(3);
        expect(content[0]).toBe(thinkingBlock);
        expect(content[1]).toEqual({ type: 'text', text: 'Working on it.' });
        expect(content[2].type).toBe('tool_use');
        expect(content[2].id).toBe('toolu_first');
      });

      it('passes the route context to thinkingLookup', () => {
        const thinkingBlock = {
          type: 'thinking',
          thinking: 'cached reasoning',
          signature: 'sig_cached',
        };
        const routeContext = {
          provider: 'anthropic',
          authType: 'subscription',
          model: 'claude-sonnet-4-5-20250929',
        };
        const lookup = jest.fn().mockReturnValue([thinkingBlock]);

        toAnthropicRequest(
          {
            messages: [
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'toolu_first',
                    type: 'function',
                    function: { name: 'search', arguments: '{}' },
                  },
                ],
              },
            ],
          },
          'claude-sonnet-4-5-20250929',
          {
            thinkingLookup: lookup,
            thinkingRouteContext: routeContext,
          },
        );

        expect(lookup).toHaveBeenCalledWith('toolu_first', routeContext);
      });

      it('prepends multiple cached blocks in the order they were cached', () => {
        const b1 = { type: 'thinking', thinking: 'one', signature: 's1' };
        const b2 = { type: 'redacted_thinking', data: 'opaque' };
        const lookup = jest.fn().mockReturnValue([b1, b2]);

        const body = {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            },
          ],
        };
        const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514', {
          thinkingLookup: lookup,
        });
        const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
        const content = messages[0].content;
        expect(content).toHaveLength(3);
        expect(content[0]).toBe(b1);
        expect(content[1]).toBe(b2);
        expect(content[2].type).toBe('tool_use');
      });

      it('prepends nothing when thinkingLookup returns null', () => {
        const lookup = jest.fn().mockReturnValue(null);
        const body = {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            },
          ],
        };
        const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514', {
          thinkingLookup: lookup,
        });
        const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
        // Only the tool_use block — no thinking block prepended.
        expect(messages[0].content).toHaveLength(1);
        expect(messages[0].content[0].type).toBe('tool_use');
      });

      it('does not call thinkingLookup when assistant message has no tool_calls', () => {
        const lookup = jest
          .fn()
          .mockReturnValue([{ type: 'thinking', thinking: 'ignored', signature: 'x' }]);
        const body = {
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
          ],
        };
        const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514', {
          thinkingLookup: lookup,
        });
        expect(lookup).not.toHaveBeenCalled();
        const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
        expect(messages[1].content).toHaveLength(1);
        expect(messages[1].content[0]).toEqual({ type: 'text', text: 'Hello!' });
      });

      it('works without a thinkingLookup option (no throw, no prepend)', () => {
        const body = {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            },
          ],
        };
        expect(() => toAnthropicRequest(body, 'claude-sonnet-4-20250514')).not.toThrow();
        const result = toAnthropicRequest(body, 'claude-sonnet-4-20250514');
        const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
        expect(messages[0].content).toHaveLength(1);
        expect(messages[0].content[0].type).toBe('tool_use');
      });

      it('does not call thinkingLookup when the first tool_call has no id', () => {
        const lookup = jest.fn();
        const body = {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                // id missing
                {
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                } as unknown as {
                  id: string;
                  type: string;
                  function: { name: string; arguments: string };
                },
              ],
            },
          ],
        };
        toAnthropicRequest(body, 'claude-sonnet-4-20250514', { thinkingLookup: lookup });
        expect(lookup).not.toHaveBeenCalled();
      });
    });

    describe('createAnthropicStreamTransformer onThinkingBlocks callback', () => {
      it('fires once at message_delta with a single assembled thinking block when a tool_use is present', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );

        // thinking block start at index 0
        expect(
          transform(
            'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
          ),
        ).toBeNull();

        // two thinking_delta events
        expect(
          transform(
            'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}',
          ),
        ).toBeNull();
        expect(
          transform(
            'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason."}}',
          ),
        ).toBeNull();

        // signature_delta
        expect(
          transform(
            'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xyz"}}',
          ),
        ).toBeNull();

        // content_block_stop
        expect(
          transform('event: content_block_stop\n{"type":"content_block_stop","index":0}'),
        ).toBeNull();

        // tool_use block_start at index 1 — records the first tool_use id
        // but does NOT yet fire the callback (we wait for message_delta so
        // late-arriving signature_deltas can't mutate the snapshot).
        const toolStart = transform(
          'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_first","name":"search"}}',
        );
        expect(toolStart).not.toBeNull();
        expect(onThinkingBlocks).not.toHaveBeenCalled();

        // message_delta — flushes the assembled blocks into the callback.
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        expect(onThinkingBlocks).toHaveBeenCalledTimes(1);
        expect(onThinkingBlocks).toHaveBeenCalledWith('toolu_first', [
          { type: 'thinking', thinking: 'Let me reason.', signature: 'sig_xyz' },
        ]);
      });

      it('fires once with a redacted_thinking block intact', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );

        expect(
          transform(
            'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque-blob"}}',
          ),
        ).toBeNull();

        transform(
          'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_a","name":"search"}}',
        );
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        expect(onThinkingBlocks).toHaveBeenCalledTimes(1);
        const [firstId, blocks] = onThinkingBlocks.mock.calls[0];
        expect(firstId).toBe('toolu_a');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({ type: 'redacted_thinking', data: 'opaque-blob' });
      });

      it('keys on the first tool_use id when multiple tool_use blocks arrive', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );

        // thinking block
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}',
        );

        // first tool_use
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"a"}}',
        );
        // second tool_use
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"b"}}',
        );
        // message_delta — flushes the single callback with the first id
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        expect(onThinkingBlocks).toHaveBeenCalledTimes(1);
        expect(onThinkingBlocks).toHaveBeenCalledWith('toolu_1', expect.any(Array));
      });

      it('does not fire at message_delta when tool_use arrives with no thinking blocks', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"a"}}',
        );
        // Drive through message_delta to hit the empty-blocks early return
        // inside flushThinkingBlocks — no callback should fire.
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        expect(onThinkingBlocks).not.toHaveBeenCalled();
      });

      it('does not fire when thinking blocks are seen but no tool_use follows', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"quiet"}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}',
        );
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
        );

        expect(onThinkingBlocks).not.toHaveBeenCalled();
      });

      it('does not plumb the callback when onThinkingBlocks is omitted', () => {
        const transform = createAnthropicStreamTransformer('claude-sonnet-4-20250514');

        // Process a stream with thinking + tool_use without a callback — should not throw.
        expect(() => {
          transform(
            'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          );
          transform(
            'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
          );
          transform(
            'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}',
          );
          transform(
            'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}',
          );
          transform(
            'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"search"}}',
          );
        }).not.toThrow();
      });

      it('captures signature_deltas that arrive after the first tool_use (regression — late signatures)', () => {
        // Anthropic's streaming contract puts thinking deltas before the
        // first tool_use, but we don't rely on that ordering. The flush
        // happens at message_delta so any signature_delta interleaved
        // between tool_use and message_delta is still included.
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}',
        );
        // tool_use arrives BEFORE the signature_delta
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"search"}}',
        );
        // late signature_delta on the thinking block
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"late_sig"}}',
        );
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        expect(onThinkingBlocks).toHaveBeenCalledTimes(1);
        const [, blocks] = onThinkingBlocks.mock.calls[0];
        expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'reason', signature: 'late_sig' });
      });

      it('deep-clones blocks passed to the callback so later mutations do not leak', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoned"}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_1"}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"search"}}',
        );
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        const [, blocks] = onThinkingBlocks.mock.calls[0];
        const snapshot = JSON.stringify(blocks[0]);

        // Mutate the captured block after it's been passed to the callback.
        blocks[0].thinking = 'tampered';
        blocks[0].signature = 'tampered';

        // A second transformer over the same stream data should still emit
        // the original values — confirming the callback received a copy,
        // not a live reference to the transformer's internal map.
        const onThinkingBlocks2 = jest.fn();
        const transform2 = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks2,
        );
        transform2(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );
        transform2(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        );
        transform2(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoned"}}',
        );
        transform2(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_1"}}',
        );
        transform2(
          'event: content_block_start\n{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"search"}}',
        );
        transform2(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );
        const [, blocks2] = onThinkingBlocks2.mock.calls[0];
        expect(JSON.stringify(blocks2[0])).toBe(snapshot);
      });

      it('still emits text_delta content chunks normally with a callback attached', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );
        const textResult = transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        );
        expect(textResult).toContain('"content":"Hello"');
        expect(onThinkingBlocks).not.toHaveBeenCalled();
      });

      it('passes thinking blocks in index order regardless of insertion order', () => {
        const onThinkingBlocks = jest.fn();
        const transform = createAnthropicStreamTransformer(
          'claude-sonnet-4-20250514',
          onThinkingBlocks,
        );

        transform(
          'event: message_start\n{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        );

        // Intentionally seed index 2 before index 0 to verify sorting.
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":2,"content_block":{"type":"redacted_thinking","data":"second"}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first"}}',
        );
        transform(
          'event: content_block_delta\n{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}',
        );
        transform(
          'event: content_block_start\n{"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_z","name":"search"}}',
        );
        transform(
          'event: message_delta\n{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
        );

        expect(onThinkingBlocks).toHaveBeenCalledTimes(1);
        const [firstId, blocks] = onThinkingBlocks.mock.calls[0];
        expect(firstId).toBe('toolu_z');
        expect(blocks).toHaveLength(2);
        // Sorted: index 0 (thinking) before index 2 (redacted_thinking).
        expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'first', signature: 's' });
        expect(blocks[1]).toEqual({ type: 'redacted_thinking', data: 'second' });
      });
    });
  });

  describe('injectOpenRouterCacheControl', () => {
    it('injects cache_control on last system message (string content)', () => {
      const body: Record<string, unknown> = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };

      injectOpenRouterCacheControl(body);

      const messages = body.messages as Array<Record<string, unknown>>;
      const sysMsg = messages[0];
      expect(Array.isArray(sysMsg.content)).toBe(true);
      const blocks = sysMsg.content as Array<Record<string, unknown>>;
      expect(blocks[0]).toEqual({
        type: 'text',
        text: 'You are helpful.',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('injects cache_control on last block of array system content', () => {
      const body: Record<string, unknown> = {
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'First' },
              { type: 'text', text: 'Second' },
            ],
          },
          { role: 'user', content: 'Hi' },
        ],
      };

      injectOpenRouterCacheControl(body);

      const messages = body.messages as Array<Record<string, unknown>>;
      const blocks = messages[0].content as Array<Record<string, unknown>>;
      expect(blocks[0].cache_control).toBeUndefined();
      expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('injects cache_control on last tool definition', () => {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [
          { type: 'function', function: { name: 'a' } },
          { type: 'function', function: { name: 'b' } },
        ],
      };

      injectOpenRouterCacheControl(body);

      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools[0].cache_control).toBeUndefined();
      expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does nothing when no messages', () => {
      const body: Record<string, unknown> = {};
      injectOpenRouterCacheControl(body);
      expect(body).toEqual({});
    });

    it('only injects on the last system/developer message', () => {
      const body: Record<string, unknown> = {
        messages: [
          { role: 'system', content: 'First system' },
          { role: 'user', content: 'Hi' },
          { role: 'system', content: 'Second system' },
        ],
      };

      injectOpenRouterCacheControl(body);

      const messages = body.messages as Array<Record<string, unknown>>;
      // Should only modify the last system message (index 2)
      expect(typeof messages[0].content).toBe('string');
      expect(Array.isArray(messages[2].content)).toBe(true);
    });
  });

  describe('applyAnthropicMessagesMutations', () => {
    it('closes object schemas on a native output_config without mutating the inbound body', () => {
      const inbound = {
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
      };

      const result = applyAnthropicMessagesMutations(inbound);

      expect(result.output_config).toEqual({
        format: {
          type: 'json_schema',
          schema: { type: 'object', additionalProperties: false },
        },
      });
      expect(inbound.output_config.format.schema).toEqual({ type: 'object' });
    });

    it('leaves an output_config that carries no format schema unchanged', () => {
      const noFormat = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'high' },
      });
      expect(noFormat.output_config).toEqual({ effort: 'high' });

      const noSchema = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { format: { type: 'json_schema' } },
      });
      expect(noSchema.output_config).toEqual({ format: { type: 'json_schema' } });
    });

    it('preserves the manual budget in native adaptive thinking', () => {
      const inbound = {
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive', budget_tokens: 8192, display: 'omitted' },
      };

      const result = applyAnthropicMessagesMutations(inbound);

      expect(result.thinking).toBe(inbound.thinking);
      expect(inbound.thinking).toEqual({
        type: 'adaptive',
        budget_tokens: 8192,
        display: 'omitted',
      });
    });

    it('preserves the budget for native manual thinking', () => {
      const thinking = { type: 'enabled', budget_tokens: 8192 };

      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
      });

      expect(result.thinking).toBe(thinking);
    });

    it('preserves Anthropic server tools with their type discriminator and skips input_schema (issue #1886)', () => {
      const inbound = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'find cats' }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          { type: 'bash_20250124', name: 'bash' },
          { name: 'my_custom', input_schema: { type: 'object' } },
        ],
      };
      const result = applyAnthropicMessagesMutations(inbound);

      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(3);
      expect(tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
      expect(tools[0].input_schema).toBeUndefined();
      expect(tools[1]).toMatchObject({ type: 'bash_20250124', name: 'bash' });
      expect(tools[1].input_schema).toBeUndefined();
      expect(tools[2]).toMatchObject({
        name: 'my_custom',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral' },
      });
      // Inbound array isn't mutated.
      expect((inbound.tools[2] as Record<string, unknown>).cache_control).toBeUndefined();
    });

    it('places cache_control on the last system block when system is an array', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        system: [
          { type: 'text', text: 'persona' },
          { type: 'text', text: 'task' },
        ],
      });
      const system = result.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(2);
      expect(system[0].cache_control).toBeUndefined();
      expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds no five-minute breakpoints when the caller uses one-hour TTLs', () => {
      // Claude Code shape: one-hour breakpoints on system, none on tools. A
      // five-minute breakpoint on the last tool (processed before system) or
      // on the first uncached system block would make Anthropic reject the
      // request with "a ttl='1h' cache_control block must not come after a
      // ttl='5m' cache_control block".
      const oneHour = { type: 'ephemeral', ttl: '1h' };
      const result = applyAnthropicMessagesMutations(
        {
          messages: [{ role: 'user', content: 'hi' }],
          system: [
            { type: 'text', text: 'billing header' },
            { type: 'text', text: 'identity', cache_control: oneHour },
            { type: 'text', text: 'instructions', cache_control: oneHour },
          ],
          tools: [
            { name: 'Bash', input_schema: { type: 'object' } },
            { name: 'Read', input_schema: { type: 'object' } },
          ],
        },
        { injectSubscriptionIdentity: true },
      );
      const system = result.system as Array<Record<string, unknown>>;
      expect(system.map((b) => b.cache_control)).toEqual([undefined, undefined, oneHour, oneHour]);
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools.every((t) => t.cache_control === undefined)).toBe(true);
    });

    it('wraps a string system in a block array and caches it', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        system: 'Be concise.',
      });
      expect(result.system).toEqual([
        { type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('leaves an empty string system intact', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        system: '',
      });
      expect(result.system).toBe('');
    });

    it('prepends the subscription identity block ahead of an existing system', () => {
      const result = applyAnthropicMessagesMutations(
        {
          messages: [{ role: 'user', content: 'hi' }],
          system: 'You are Manifest.',
        },
        { injectSubscriptionIdentity: true },
      );
      const system = result.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(2);
      expect(system[0].text).toMatch(/Claude agent/);
      expect(system[0].cache_control).toBeUndefined();
      expect(system[1].text).toBe('You are Manifest.');
      expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('creates a system from scratch when subscription identity is requested and no system exists', () => {
      const result = applyAnthropicMessagesMutations(
        { messages: [{ role: 'user', content: 'hi' }] },
        { injectSubscriptionIdentity: true },
      );
      const system = result.system as Array<Record<string, unknown>>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toMatch(/Claude agent/);
      expect(system[0].cache_control).toBeUndefined();
    });

    it('drops system when input has none and no mutations need it', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result).not.toHaveProperty('system');
    });

    it('drops an explicitly-empty system array', () => {
      // Edge case: caller sends `system: []`. The cache_control branch runs
      // (Array.isArray is true) but produces no blocks, so we drop the field
      // rather than echo a useless empty array.
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        system: [],
      });
      expect(result).not.toHaveProperty('system');
    });

    it('injects cache_control on the last system block and last tool', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'text', text: 'persona' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      });
      const system = result.system as Array<Record<string, unknown>>;
      expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('caps Manifest cache_control injection when Claude Code already supplies three breakpoints', () => {
      const cache = { type: 'ephemeral' };
      const inbound = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'uncached' },
              { type: 'text', text: 'cached', cache_control: cache },
            ],
          },
        ],
        system: [
          { type: 'text', text: 'context', cache_control: cache },
          { type: 'text', text: 'instructions', cache_control: cache },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      };

      const result = applyAnthropicMessagesMutations(inbound, {
        injectSubscriptionIdentity: true,
      });

      expect(countCacheControls(result)).toBe(4);
      const system = result.system as Array<Record<string, unknown>>;
      expect(system[0].text).toMatch(/Claude agent/);
      expect(system[0].cache_control).toBeUndefined();
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools[0].cache_control).toEqual(cache);
      expect((inbound.tools[0] as Record<string, unknown>).cache_control).toBeUndefined();
    });

    it('does not add cache_control when the inbound Messages request is already at the Anthropic cap', () => {
      const cache = { type: 'ephemeral' };
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'cached 1', cache_control: cache },
                { type: 'text', text: 'cached 2', cache_control: cache },
              ],
            },
          ],
          system: [
            { type: 'text', text: 'cached 3', cache_control: cache },
            { type: 'text', text: 'cached 4', cache_control: cache },
          ],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        },
        { injectSubscriptionIdentity: true },
      );

      expect(countCacheControls(result)).toBe(4);
      const system = result.system as Array<Record<string, unknown>>;
      expect(system[0].text).toMatch(/Claude agent/);
      expect(system[0].cache_control).toBeUndefined();
      const tools = result.tools as Array<Record<string, unknown>>;
      expect(tools[0].cache_control).toBeUndefined();
    });

    it('adds top-level automatic cache_control when a breakpoint slot is available', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      };

      applyAnthropicAutomaticCacheControl(body);

      expect((body as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral' });
      expect(countCacheControls(body)).toBe(2);
    });

    it('keeps caller-supplied top-level automatic cache_control', () => {
      const existing = { type: 'ephemeral' };
      const body = {
        cache_control: existing,
        messages: [{ role: 'user', content: 'hi' }],
      };

      applyAnthropicAutomaticCacheControl(body);

      expect(body.cache_control).toBe(existing);
      expect(countCacheControls(body)).toBe(1);
    });

    it('does not mix a default automatic breakpoint with a one-hour explicit breakpoint', () => {
      const body = {
        messages: [{ role: 'user', content: 'hi' }],
        system: [
          {
            type: 'text',
            text: 'instructions',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      };

      applyAnthropicAutomaticCacheControl(body);

      expect((body as Record<string, unknown>).cache_control).toBeUndefined();
      expect(countCacheControls(body)).toBe(1);
    });

    it('does not add top-level automatic cache_control when the body is already at the Anthropic cap', () => {
      const cache = { type: 'ephemeral' };
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'cached 1', cache_control: cache },
              { type: 'text', text: 'cached 2', cache_control: cache },
            ],
          },
        ],
        system: [
          { type: 'text', text: 'cached 3', cache_control: cache },
          { type: 'text', text: 'cached 4', cache_control: cache },
        ],
      };

      applyAnthropicAutomaticCacheControl(body);

      expect((body as Record<string, unknown>).cache_control).toBeUndefined();
      expect(countCacheControls(body)).toBe(4);
    });

    it('defaults max_tokens to 4096 when not provided', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(result.max_tokens).toBe(4096);
    });

    it('keeps caller-supplied max_tokens', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 256,
      });
      expect(result.max_tokens).toBe(256);
    });

    it('normalizes max_completion_tokens for an Anthropic Messages body', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 123,
      });
      expect(result.max_tokens).toBe(123);
      expect(result.max_completion_tokens).toBeUndefined();
    });

    it('replays cached thinking blocks ahead of tool_use in assistant turns', () => {
      const cached = [{ type: 'thinking' as const, thinking: 'searching', signature: 'sig' }];
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            { role: 'user', content: 'find cats' },
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } },
              ],
            },
          ],
        },
        { thinkingLookup: (id) => (id === 'call_1' ? cached : null) },
      );
      const messages = result.messages as Array<Record<string, unknown>>;
      const assistant = messages[1];
      const content = assistant.content as Array<Record<string, unknown>>;
      expect(content[0]).toEqual({ type: 'thinking', thinking: 'searching', signature: 'sig' });
      expect(content[1]).toMatchObject({ type: 'tool_use', id: 'call_1' });
    });

    it('passes the route context when replaying cached thinking blocks', () => {
      const cached = [{ type: 'thinking' as const, thinking: 'searching', signature: 'sig' }];
      const routeContext = {
        provider: 'anthropic',
        authType: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      };
      const lookup = jest.fn().mockReturnValue(cached);

      applyAnthropicMessagesMutations(
        {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } },
              ],
            },
          ],
        },
        { thinkingLookup: lookup, thinkingRouteContext: routeContext },
      );

      expect(lookup).toHaveBeenCalledWith('call_1', routeContext);
    });

    it('does not duplicate thinking blocks the client already echoed', () => {
      // Native Messages clients echo signed thinking blocks back to satisfy
      // Anthropic's signature chain. Replaying a cached copy on top would
      // duplicate signed blocks and the upstream would reject the request.
      const cached = [{ type: 'thinking' as const, thinking: 'old', signature: 'sigA' }];
      const echoed = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'echoed', signature: 'sigA' },
          { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } },
        ],
      };
      const result = applyAnthropicMessagesMutations(
        { messages: [{ role: 'user', content: 'find cats' }, echoed] },
        { thinkingLookup: () => cached },
      );
      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages[1].content).toEqual(echoed.content);
    });

    it('drops unsigned thinking blocks before forwarding native Anthropic messages', () => {
      const invalidThinking = { type: 'thinking', thinking: 'foreign reasoning', signature: '' };
      const missingSignature = { type: 'thinking', thinking: 'fallback reasoning' };
      const toolUse = { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } };
      const inbound = {
        messages: [
          {
            role: 'assistant',
            content: [
              invalidThinking,
              missingSignature,
              { type: 'text', text: 'visible answer' },
              toolUse,
            ],
          },
        ],
      };

      const result = applyAnthropicMessagesMutations(inbound);

      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages[0].content).toEqual([{ type: 'text', text: 'visible answer' }, toolUse]);
      expect(inbound.messages[0].content).toEqual([
        invalidThinking,
        missingSignature,
        { type: 'text', text: 'visible answer' },
        toolUse,
      ]);
    });

    it('replays cached thinking after removing an unsigned client echo', () => {
      const cached = [
        { type: 'thinking' as const, thinking: 'signed reasoning', signature: 'sigA' },
      ];
      const toolUse = { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } };
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'foreign reasoning', signature: '' },
                toolUse,
              ],
            },
          ],
        },
        { thinkingLookup: () => cached },
      );

      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages[0].content).toEqual([cached[0], toolUse]);
    });

    it('does not replay cached thinking when a redacted thinking echo remains after stripping', () => {
      const cached = [{ type: 'thinking' as const, thinking: 'cached', signature: 'sigA' }];
      const redacted = { type: 'redacted_thinking', data: 'opaque' };
      const toolUse = { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } };
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'foreign reasoning', signature: '' },
                redacted,
                toolUse,
              ],
            },
          ],
        },
        { thinkingLookup: () => cached },
      );

      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages[0].content).toEqual([redacted, toolUse]);
    });

    it('keeps sanitized tool_use turns when no cached thinking is available', () => {
      const toolUse = { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'cats' } };
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'foreign reasoning', signature: '' },
                toolUse,
              ],
            },
          ],
        },
        { thinkingLookup: () => null },
      );

      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages[0].content).toEqual([toolUse]);
    });

    it('drops assistant turns that only contain unsigned thinking blocks', () => {
      const invalidThinking = { type: 'thinking', thinking: 'foreign reasoning', signature: '' };
      const inbound = {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: [invalidThinking] },
          { role: 'user', content: 'next' },
        ],
      };

      const result = applyAnthropicMessagesMutations(inbound);

      expect(result.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'user', content: 'next' },
      ]);
      expect(inbound.messages[1].content).toEqual([invalidThinking]);
    });

    it('does not touch messages when thinkingLookup returns nothing', () => {
      const inboundMessages = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_x', name: 'foo', input: {} }],
        },
      ];
      const result = applyAnthropicMessagesMutations(
        { messages: inboundMessages },
        { thinkingLookup: () => null },
      );
      expect(result.messages).toEqual(inboundMessages);
    });

    it('skips thinking replay for assistant turns without a tool_use block', () => {
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
          ],
        },
        {
          thinkingLookup: () => [{ type: 'thinking' as const, thinking: 'x', signature: 's' }],
        },
      );
      const messages = result.messages as Array<Record<string, unknown>>;
      const content = messages[1].content as Array<Record<string, unknown>>;
      expect(content).toEqual([{ type: 'text', text: 'reply' }]);
    });

    it('skips tool_use blocks without a string id', () => {
      const result = applyAnthropicMessagesMutations(
        {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', name: 'foo', input: {} }],
            },
          ],
        },
        {
          thinkingLookup: () => [{ type: 'thinking' as const, thinking: 'x', signature: 's' }],
        },
      );
      const messages = result.messages as Array<Record<string, unknown>>;
      const content = messages[0].content as Array<Record<string, unknown>>;
      expect(content).toEqual([{ type: 'tool_use', name: 'foo', input: {} }]);
    });

    it('passes Anthropic-only fields through untouched (top_k, stop_sequences, thinking, metadata, tool_choice)', () => {
      const result = applyAnthropicMessagesMutations({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ['END'],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        metadata: { user_id: 'u' },
        tool_choice: { type: 'auto' },
      });
      expect(result).toMatchObject({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ['END'],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        metadata: { user_id: 'u' },
        tool_choice: { type: 'auto' },
      });
    });

    it('preserves xhigh effort when Manifest resolves the request to Sonnet', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'xhigh', style: 'unchanged' },
      });

      expect(result.output_config).toEqual({ effort: 'xhigh', style: 'unchanged' });
    });

    it('keeps xhigh effort when the resolved Anthropic model supports it', () => {
      const result = applyAnthropicMessagesMutations({
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'xhigh' },
      });

      expect(result.output_config).toEqual({ effort: 'xhigh' });
    });
  });

  describe('extractThinkingBlocksFromMessagesResponse', () => {
    it('returns undefined when there is no content array', () => {
      expect(extractThinkingBlocksFromMessagesResponse({})).toBeUndefined();
      expect(extractThinkingBlocksFromMessagesResponse({ content: 'string' })).toBeUndefined();
    });

    it('returns undefined when there are thinking blocks but no tool_use', () => {
      expect(
        extractThinkingBlocksFromMessagesResponse({
          content: [{ type: 'thinking', thinking: 't', signature: 's' }],
        }),
      ).toBeUndefined();
    });

    it('returns undefined when there is a tool_use but no thinking blocks', () => {
      expect(
        extractThinkingBlocksFromMessagesResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }],
        }),
      ).toBeUndefined();
    });

    it('collects thinking blocks and keys them by the first tool_use id', () => {
      expect(
        extractThinkingBlocksFromMessagesResponse({
          content: [
            { type: 'thinking', thinking: 'reason 1', signature: 'a' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'tool_use', id: 'toolu_first', name: 'x', input: {} },
            { type: 'tool_use', id: 'toolu_second', name: 'y', input: {} },
            { type: 'text', text: 'narration' },
          ],
        }),
      ).toEqual({
        firstToolUseId: 'toolu_first',
        blocks: [
          { type: 'thinking', thinking: 'reason 1', signature: 'a' },
          { type: 'redacted_thinking', data: 'opaque' },
        ],
      });
    });

    it('ignores tool_use blocks without a string id', () => {
      expect(
        extractThinkingBlocksFromMessagesResponse({
          content: [
            { type: 'thinking', thinking: 't', signature: 's' },
            { type: 'tool_use', name: 'no_id' },
            { type: 'tool_use', id: 'toolu_real', name: 'x', input: {} },
          ],
        }),
      ).toEqual({
        firstToolUseId: 'toolu_real',
        blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
      });
    });
  });
});
