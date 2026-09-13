import {
  createReasoningContentStreamTransformer,
  sanitizeOpenAiBody,
} from '../provider-client-converters';

describe('provider-client-converters', () => {
  describe('sanitizeOpenAiBody', () => {
    /* ── Top-level field preservation ── */

    it('should pass through all fields for openai provider', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'gpt-4o',
        store: true,
        metadata: { key: 'value' },
        stream_options: { include_usage: true },
      };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-4o');

      expect(result).toHaveProperty('store');
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('stream_options');
    });

    it('should strip OpenAI-only fields for non-passthrough providers', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'mistral-large',
        store: true,
        metadata: {},
        service_tier: 'auto',
        stream_options: {},
        modalities: ['text'],
        audio: {},
        prediction: {},
        reasoning_effort: 'medium',
        temperature: 0.5,
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');

      expect(result).not.toHaveProperty('store');
      expect(result).not.toHaveProperty('metadata');
      expect(result).not.toHaveProperty('service_tier');
      expect(result).not.toHaveProperty('stream_options');
      expect(result).not.toHaveProperty('modalities');
      expect(result).not.toHaveProperty('audio');
      expect(result).not.toHaveProperty('prediction');
      expect(result).not.toHaveProperty('reasoning_effort');
      expect(result).toHaveProperty('temperature', 0.5);
    });

    it('should preserve reasoning_effort for xAI', () => {
      const result = sanitizeOpenAiBody(
        {
          messages: [{ role: 'user', content: 'Hi' }],
          reasoning_effort: 'high',
        },
        'xai',
        'grok-4.5',
      );

      expect(result).toHaveProperty('reasoning_effort', 'high');
    });

    it('should preserve reasoning_effort for DeepSeek', () => {
      const result = sanitizeOpenAiBody(
        {
          messages: [{ role: 'user', content: 'Hi' }],
          thinking: { type: 'enabled' },
          reasoning_effort: 'max',
        },
        'deepseek',
        'deepseek-v4-pro',
      );

      expect(result).toHaveProperty('thinking', { type: 'enabled' });
      expect(result).toHaveProperty('reasoning_effort', 'max');
    });

    it('should preserve response_format for OpenAI-wire providers', () => {
      const responseFormat = {
        type: 'json_schema',
        json_schema: {
          name: 'summary',
          schema: { type: 'object', properties: { text: { type: 'string' } } },
          strict: true,
        },
      };
      const result = sanitizeOpenAiBody(
        {
          messages: [{ role: 'user', content: 'Hi' }],
          response_format: responseFormat,
        },
        'mistral',
        'mistral-large',
      );

      expect(result.response_format).toBe(responseFormat);
    });

    it('should convert max_completion_tokens to max_tokens for non-passthrough providers', () => {
      const body = {
        messages: [],
        max_completion_tokens: 1000,
      };

      const result = sanitizeOpenAiBody(body, 'anthropic', 'claude-3');

      expect(result).toHaveProperty('max_tokens', 1000);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should not overwrite existing max_tokens with max_completion_tokens', () => {
      const body = {
        messages: [],
        max_tokens: 500,
        max_completion_tokens: 1000,
      };

      const result = sanitizeOpenAiBody(body, 'anthropic', 'claude-3');

      expect(result.max_tokens).toBe(500);
    });

    it('should pass through openrouter as passthrough provider', () => {
      const body = {
        messages: [],
        store: true,
        metadata: { test: 1 },
      };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'openai/gpt-4o');

      expect(result).toHaveProperty('store');
      expect(result).toHaveProperty('metadata');
    });

    it('strips thinking for OpenRouter NVIDIA Nemotron models (fix for #2464)', () => {
      // OpenRouter forwards most models as a total passthrough, but NVIDIA
      // Nemotron hosts validate strictly and reject Anthropic's top-level
      // `thinking` param with a 400. The fix drops that field only for the
      // Nemotron family instead of guessing NeMo's `chat_template_kwargs`
      // reasoning shape.
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'enabled' },
      };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'nvidia/nemotron-3-ultra-550b-a55b');

      expect(result).not.toHaveProperty('thinking');
    });

    it('keeps thinking passthrough for non-Nemotron OpenRouter models', () => {
      // Other OpenRouter-served families (Gemma, DeepSeek, Kimi, etc.) do not
      // reject the param, so the general passthrough must stay intact.
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'enabled' },
      };

      for (const model of [
        'google/gemma-4-31b-it',
        'deepseek/deepseek-v4-pro',
        'moonshotai/kimi-k2.6',
        'nvidia/llama-3.3-70b-instruct', // llama, not nemotron — keep passthrough
      ]) {
        const result = sanitizeOpenAiBody(body, 'openrouter', model);
        expect(result).toHaveProperty('thinking', { type: 'enabled' });
      }
    });

    it('should strip Anthropic-style thinking params for Ollama endpoints', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'enabled' },
        max_tokens: 4096,
        temperature: 0.5,
      };

      for (const endpointKey of ['ollama', 'ollama-cloud', 'Ollama']) {
        const result = sanitizeOpenAiBody(body, endpointKey, 'qwen3.5:9b-q4_K_M');

        expect(result).not.toHaveProperty('thinking');
        expect(result).toHaveProperty('max_tokens', 4096);
        expect(result).toHaveProperty('temperature', 0.5);
      }
    });

    it('should keep thinking params for compatible OpenAI-format providers', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        thinking: { type: 'enabled' },
      };

      const result = sanitizeOpenAiBody(body, 'deepseek', 'deepseek-v4-flash');

      expect(result).toHaveProperty('thinking', { type: 'enabled' });
    });

    it('should preserve DeepSeek max_tokens for an evidence-based clamp', () => {
      for (const maxTokens of [16000, 5000.7, 0, -100, '4096', 'not-a-number']) {
        const result = sanitizeOpenAiBody(
          { messages: [], max_tokens: maxTokens },
          'deepseek',
          'deepseek-chat',
        );

        expect(result.max_tokens).toBe(maxTokens);
      }
    });

    /* ── Message field preservation ── */

    it('should preserve reasoning_content for provider-specific Autofix', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'I thought...' }],
      };

      const result = sanitizeOpenAiBody(body, 'anthropic', 'claude-3');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'I thought...');
    });

    it('should preserve reasoning_content for deepseek provider', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'deepseek', 'deepseek-chat');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('normalizes provider casing when preserving reasoning_content', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'DeepSeek', 'deepseek-chat');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for native moonshot provider', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'moonshot', 'kimi-k2');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for openrouter deepseek models', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'deepseek/deepseek-r1');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for openrouter moonshot models', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'moonshotai/kimi-k2');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for non-deepseek openrouter models', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'openai/gpt-4o');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for opencode-go deepseek models (issue #1862)', () => {
      // OpenCode Go's subscription proxies forward DeepSeek requests to the
      // upstream DeepSeek API, which enforces "reasoning_content must be
      // passed back" on every thinking-mode follow-up turn.
      const body = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi', reasoning_content: 'I considered...' },
          { role: 'user', content: 'continue' },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'opencode-go', 'opencode-go/deepseek-v4-pro');
      const messages = result.messages as any[];

      expect(messages[1]).toHaveProperty('reasoning_content', 'I considered...');
    });

    it('should preserve reasoning_content for opencode-go reasoning model families', () => {
      const body = {
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: '',
            reasoning_content: 'thinking',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'foo', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{}' },
        ],
      };

      for (const model of [
        'opencode-go/kimi-k2.6',
        'opencode-go/glm-5.1',
        'opencode-go/qwen3.6-plus',
        'opencode-go/minimax-m2.7',
        'opencode-go/mimo-v2.5',
      ]) {
        const result = sanitizeOpenAiBody(body, 'opencode-go', model);
        const messages = result.messages as any[];

        expect(messages[1]).toHaveProperty('reasoning_content', 'thinking');
      }
    });

    it('should preserve reasoning_content for unknown opencode-go model families', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'opencode-go', 'opencode-go/claude-sonnet-4');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for custom providers proxying DeepSeek', () => {
      // proxy-fallback.service strips the "custom:<uuid>/" prefix before
      // calling ProviderClient.forward, so in production sanitizeOpenAiBody
      // sees the already-bare model id.
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'custom', 'deepseek-reasoner');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should match deepseek family models case-insensitively', () => {
      const body = {
        messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
      };

      const result = sanitizeOpenAiBody(body, 'opencode-go', 'opencode-go/DeepSeek-V4-Pro');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
    });

    it('should preserve reasoning_content for deepseek-derived slugs on strict endpoints', () => {
      for (const endpointKey of ['mistral', 'anthropic', 'openai']) {
        const body = {
          messages: [{ role: 'assistant', content: 'Hi', reasoning_content: 'thought' }],
        };
        const result = sanitizeOpenAiBody(body, endpointKey, 'deepseek-r1-distill-llama-70b');
        const messages = result.messages as any[];
        expect(messages[0]).toHaveProperty('reasoning_content', 'thought');
      }
    });

    it('preserves prepared reasoning_content for compatible assistant tool-call messages', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoning_content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'deepseek', 'deepseek-chat');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', '');
    });

    it('does not map reasoning aliases to reasoning_content during sanitization', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoning: 'plain provider reasoning',
            reasoning_text: 'provider reasoning',
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'deepseek', 'deepseek-v4-flash');
      const messages = result.messages as any[];

      expect(messages[0]).not.toHaveProperty('reasoning_content');
      expect(messages[0]).not.toHaveProperty('reasoning');
      expect(messages[0]).not.toHaveProperty('reasoning_text');
    });

    it('does not flatten reasoning_details to reasoning_content for compatible tool-call messages', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoning_details: [
              {
                type: 'reasoning.text',
                text: 'provider-specific reasoning',
                signature: 'sig-abc',
                format: 'anthropic-claude-v1',
              },
            ],
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'deepseek', 'deepseek-v4-flash');
      const messages = result.messages as any[];

      expect(messages[0]).not.toHaveProperty('reasoning_content');
      expect(messages[0]).not.toHaveProperty('reasoning_details');
    });

    it('does not add reasoning_content to strict providers', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      expect(messages[0]).not.toHaveProperty('reasoning_content');
    });

    it('strips reasoning aliases for strict providers', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoning: 'plain provider reasoning',
            reasoning_text: 'provider reasoning',
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      expect(messages[0]).not.toHaveProperty('reasoning_text');
      expect(messages[0]).not.toHaveProperty('reasoning');
      expect(messages[0]).not.toHaveProperty('reasoning_content');
    });

    it('does not replace existing reasoning_content during sanitization', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoning_content: 'client reasoning',
            tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'deepseek', 'deepseek-chat');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_content', 'client reasoning');
    });

    /* ── Message shape edge cases ── */

    it('should strip reasoning_details for non-openrouter providers', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '4',
            reasoning_details: [{ type: 'thinking', thinking: '2+2', signature: 'sig' }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'ministral-3b-2512');
      const messages = result.messages as any[];

      expect(messages[0]).not.toHaveProperty('reasoning_details');
    });

    it('should strip reasoning_details for native openai targets', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: '4',
            reasoning_details: [{ type: 'thinking', thinking: 't', signature: 's' }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-4o');
      const messages = result.messages as any[];

      expect(messages[0]).not.toHaveProperty('reasoning_details');
    });

    it('should preserve reasoning_details for openrouter targets', () => {
      const details = [{ type: 'thinking', thinking: 't', signature: 's' }];
      const body = {
        messages: [{ role: 'assistant', content: '4', reasoning_details: details }],
      };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'minimax/minimax-m2.7');
      const messages = result.messages as any[];

      expect(messages[0]).toHaveProperty('reasoning_details', details);
    });

    it('should handle non-array messages gracefully', () => {
      const body = { messages: 'not-an-array' };

      const result = sanitizeOpenAiBody(body as any, 'anthropic', 'claude-3');

      expect(result.messages).toBe('not-an-array');
    });

    it('should pass through non-object messages in array', () => {
      const body = { messages: [null, undefined, 42, 'string', [1, 2]] };

      const result = sanitizeOpenAiBody(body as any, 'anthropic', 'claude-3');
      const messages = result.messages as any[];

      expect(messages).toEqual([null, undefined, 42, 'string', [1, 2]]);
    });

    /* ── Mistral tool_call_id normalization ── */

    it('should rewrite non-conforming tool_call IDs for Mistral', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            tool_calls: [{ id: 'call_abcdefghijklmnop', type: 'function', function: {} }],
          },
          { role: 'tool', tool_call_id: 'call_abcdefghijklmnop', content: 'result' },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      // The original ID doesn't match ^[A-Za-z0-9]{9}$, so it gets rewritten
      const newTcId = messages[0].tool_calls[0].id;
      expect(newTcId).toMatch(/^tc[a-z0-9]{7}$/);
      // The tool response's tool_call_id should match
      expect(messages[1].tool_call_id).toBe(newTcId);
    });

    it('should preserve conforming 9-char alphanumeric IDs for Mistral', () => {
      const validId = 'Abc123XYZ'; // 9 chars alphanumeric
      const body = {
        messages: [
          { role: 'assistant', tool_calls: [{ id: validId }] },
          { role: 'tool', tool_call_id: validId, content: 'ok' },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      expect(messages[0].tool_calls[0].id).toBe(validId);
      expect(messages[1].tool_call_id).toBe(validId);
    });

    it('should not rewrite tool_call IDs for non-Mistral providers', () => {
      const body = {
        messages: [{ role: 'assistant', tool_calls: [{ id: 'call_long_id_here_123' }] }],
      };

      const result = sanitizeOpenAiBody(body, 'anthropic', 'claude-3');
      const messages = result.messages as any[];

      expect(messages[0].tool_calls[0].id).toBe('call_long_id_here_123');
    });

    it('should handle invalid tool_call entries in reservation phase for Mistral', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            tool_calls: [null, 42, [1, 2], { id: 'Abc123XYZ' }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      // Non-object toolCalls should be skipped in reservation, valid one preserved
      expect(messages[0].tool_calls[3].id).toBe('Abc123XYZ');
    });

    it('should handle invalid tool_call entries in mapping phase for Mistral', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            tool_calls: [null, 'string', { id: 'longNonConformingId' }],
          },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      // Non-object entries should pass through
      expect(messages[0].tool_calls[0]).toBeNull();
      expect(messages[0].tool_calls[1]).toBe('string');
      // Object entry should have rewritten id
      expect(messages[0].tool_calls[2].id).toMatch(/^tc/);
    });

    it('should handle non-string tool_call_id in reservation for Mistral', () => {
      const body = {
        messages: [{ role: 'tool', tool_call_id: 12345, content: 'result' }],
      };

      // Should not throw
      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      expect(messages[0].tool_call_id).toBe(12345);
    });

    it('should handle non-object message entries in reservation phase for Mistral', () => {
      const body = {
        messages: [null, 42, 'string', { role: 'user', content: 'Hi' }],
      };

      // Should not throw
      const result = sanitizeOpenAiBody(body as any, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      expect(messages[0]).toBeNull();
      expect(messages[1]).toBe(42);
      expect(messages[2]).toBe('string');
    });

    it('should handle array-type tool_call in reservation phase for Mistral', () => {
      const body = {
        messages: [{ role: 'assistant', tool_calls: [[1, 2], { id: 'Abc123XYZ' }] }],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      // Array toolCalls should be skipped in reservation
      expect(messages[0].tool_calls[1].id).toBe('Abc123XYZ');
    });

    it('should generate unique IDs that avoid collisions with reserved IDs', () => {
      // Create a scenario where the first generated candidate would collide
      // This is hard to directly test, but we can verify uniqueness with multiple rewrites
      const body = {
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'very-long-call-id-1' },
              { id: 'very-long-call-id-2' },
              { id: 'very-long-call-id-3' },
            ],
          },
          { role: 'tool', tool_call_id: 'very-long-call-id-1', content: 'r1' },
          { role: 'tool', tool_call_id: 'very-long-call-id-2', content: 'r2' },
          { role: 'tool', tool_call_id: 'very-long-call-id-3', content: 'r3' },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      const ids = messages[0].tool_calls.map((tc: any) => tc.id);
      // All IDs should be unique
      expect(new Set(ids).size).toBe(3);
      // Tool call IDs should match
      expect(messages[1].tool_call_id).toBe(ids[0]);
      expect(messages[2].tool_call_id).toBe(ids[1]);
      expect(messages[3].tool_call_id).toBe(ids[2]);
    });

    it('should reuse rewritten ID when same tool_call_id appears again', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            tool_calls: [{ id: 'long-call-id' }],
          },
          { role: 'tool', tool_call_id: 'long-call-id', content: 'r1' },
          // Same ID appears again (e.g., retried tool call)
          { role: 'tool', tool_call_id: 'long-call-id', content: 'r2' },
        ],
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');
      const messages = result.messages as any[];

      // Both tool responses should get the same rewritten ID
      expect(messages[1].tool_call_id).toBe(messages[2].tool_call_id);
      expect(messages[1].tool_call_id).toBe(messages[0].tool_calls[0].id);
    });

    /* ── max_tokens → max_completion_tokens for newer OpenAI models ── */

    it('should convert max_tokens to max_completion_tokens for GPT-5 models', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-5',
        max_tokens: 4096,
      };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-5');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens for o-series models', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'o3',
        max_tokens: 2048,
      };

      const result = sanitizeOpenAiBody(body, 'openai', 'o3');

      expect(result).toHaveProperty('max_completion_tokens', 2048);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should keep max_tokens for older OpenAI models (GPT-4)', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-4o',
        max_tokens: 4096,
      };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-4o');

      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should not convert when max_completion_tokens already present', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'gpt-5.2',
        max_tokens: 1000,
        max_completion_tokens: 2000,
      };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-5.2');

      expect(result).toHaveProperty('max_completion_tokens', 2000);
      expect(result).toHaveProperty('max_tokens', 1000);
    });

    it('should not convert max_tokens for non-OpenAI providers', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        model: 'mistral-large',
        max_tokens: 4096,
      };

      const result = sanitizeOpenAiBody(body, 'mistral', 'mistral-large');

      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    /* ── max_tokens → max_completion_tokens: extended edge cases ── */

    it('should convert max_tokens for o1 model', () => {
      const body = { messages: [], max_tokens: 2048 };

      const result = sanitizeOpenAiBody(body, 'openai', 'o1');

      expect(result).toHaveProperty('max_completion_tokens', 2048);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens for o1-mini model', () => {
      const body = { messages: [], max_tokens: 1024 };

      const result = sanitizeOpenAiBody(body, 'openai', 'o1-mini');

      expect(result).toHaveProperty('max_completion_tokens', 1024);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens for o3-mini model', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openai', 'o3-mini');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens for o4-mini model', () => {
      const body = { messages: [], max_tokens: 8192 };

      const result = sanitizeOpenAiBody(body, 'openai', 'o4-mini');

      expect(result).toHaveProperty('max_completion_tokens', 8192);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens for gpt-5.4 model', () => {
      const body = { messages: [], max_tokens: 16384 };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-5.4');

      expect(result).toHaveProperty('max_completion_tokens', 16384);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens for gpt-5-chat-latest model', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-5-chat-latest');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should NOT convert max_tokens for gpt-4.1 model', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-4.1');

      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should NOT convert max_tokens for gpt-4o-mini model', () => {
      const body = { messages: [], max_tokens: 2048 };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-4o-mini');

      expect(result).toHaveProperty('max_tokens', 2048);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should NOT convert for OpenRouter even when model is o3', () => {
      // OpenRouter is a passthrough provider, but it handles max_tokens itself
      // The conversion should only happen for endpointKey=openai
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openrouter', 'o3');

      // OpenRouter is passthrough, so max_tokens stays as-is (no conversion)
      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should handle case insensitivity for o-series regex', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openai', 'O3');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should handle case insensitivity for GPT-5 regex', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openai', 'GPT-5');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should NOT convert when body has no max_tokens', () => {
      const body = { messages: [], model: 'gpt-5' };

      const result = sanitizeOpenAiBody(body, 'openai', 'gpt-5');

      expect(result).not.toHaveProperty('max_tokens');
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should NOT match model names like "operative" that start with "o"', () => {
      const body = { messages: [], max_tokens: 4096 };

      // "operative" starts with "o" but the regex is /^(o[134]|gpt-5)/i
      // So "operative" won't match since it's o + non-[134] char
      const result = sanitizeOpenAiBody(body, 'openai', 'operative');

      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should match o1-preview model', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'openai', 'o1-preview');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    /* ── Non-passthrough provider: max_completion_tokens conversion ── */

    it('should convert max_completion_tokens to max_tokens for anthropic', () => {
      const body = {
        messages: [],
        max_completion_tokens: 4096,
      };

      const result = sanitizeOpenAiBody(body, 'anthropic', 'claude-opus-4-6');

      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should convert max_completion_tokens to max_tokens for gemini', () => {
      const body = {
        messages: [],
        max_completion_tokens: 8192,
      };

      const result = sanitizeOpenAiBody(body, 'gemini', 'gemini-2.5-pro');

      expect(result).toHaveProperty('max_tokens', 8192);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should not convert max_completion_tokens when max_tokens already exists for non-passthrough', () => {
      const body = {
        messages: [],
        max_tokens: 2048,
        max_completion_tokens: 4096,
      };

      const result = sanitizeOpenAiBody(body, 'anthropic', 'claude-opus-4-6');

      expect(result).toHaveProperty('max_tokens', 2048);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    /* ── Copilot: max_tokens → max_completion_tokens (mnfst/manifest#1849) ── */

    it('should convert max_tokens to max_completion_tokens for Copilot GPT-5', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'copilot', 'gpt-5');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should convert max_tokens to max_completion_tokens for Copilot o-series', () => {
      const body = { messages: [], max_tokens: 2048 };

      const result = sanitizeOpenAiBody(body, 'copilot', 'o3-mini');

      expect(result).toHaveProperty('max_completion_tokens', 2048);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should preserve max_completion_tokens unchanged for Copilot GPT-5 family', () => {
      const body = { messages: [], max_completion_tokens: 1024 };

      const result = sanitizeOpenAiBody(body, 'copilot', 'gpt-5.2');

      expect(result).toHaveProperty('max_completion_tokens', 1024);
      expect(result).not.toHaveProperty('max_tokens');
    });

    it('should NOT convert max_tokens for Copilot GPT-4 family (legacy field still accepted)', () => {
      const body = { messages: [], max_tokens: 4096 };

      const result = sanitizeOpenAiBody(body, 'copilot', 'gpt-4o');

      expect(result).toHaveProperty('max_tokens', 4096);
      expect(result).not.toHaveProperty('max_completion_tokens');
    });

    it('should still strip OPENAI_ONLY_FIELDS for Copilot GPT-5', () => {
      const body = {
        messages: [],
        max_tokens: 4096,
        store: true,
        service_tier: 'auto',
      };

      const result = sanitizeOpenAiBody(body, 'copilot', 'gpt-5');

      expect(result).toHaveProperty('max_completion_tokens', 4096);
      expect(result).not.toHaveProperty('store');
      expect(result).not.toHaveProperty('service_tier');
    });
  });

  describe('createReasoningContentStreamTransformer', () => {
    it('normalizes Copilot reasoning_text to reasoning_content for clients', () => {
      const transform = createReasoningContentStreamTransformer(undefined, {
        outputStreamDeltaPaths: ['reasoning_content', 'reasoning_text'],
        clientStreamDeltaPath: 'reasoning_content',
      });

      const out = transform(
        JSON.stringify({
          choices: [
            {
              delta: {
                role: 'assistant',
                content: '',
                reasoning_text: 'Let me think.',
              },
              finish_reason: null,
            },
          ],
          model: 'claude-sonnet-4.6',
        }),
      );
      const data = JSON.parse(out!.replace('data: ', '').trim());

      expect(data.choices[0].delta.reasoning_text).toBe('Let me think.');
      expect(data.choices[0].delta.reasoning_content).toBe('Let me think.');
    });

    it('keeps existing reasoning_content when a provider sends multiple reasoning aliases', () => {
      const transform = createReasoningContentStreamTransformer(undefined, {
        outputStreamDeltaPaths: ['reasoning_content', 'reasoning_text'],
        clientStreamDeltaPath: 'reasoning_content',
      });

      const input = JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: 'standard',
              reasoning_text: 'provider alias',
            },
            finish_reason: null,
          },
        ],
      });

      expect(transform(input)).toBe(`data: ${input}\n\n`);
    });

    it('does not assign unsafe reasoning client paths', () => {
      const transform = createReasoningContentStreamTransformer(undefined, {
        outputStreamDeltaPaths: ['reasoning_text'],
        clientStreamDeltaPath: '__proto__.polluted' as 'reasoning_content',
      });
      const input = JSON.stringify({
        choices: [{ delta: { reasoning_text: 'unsafe' }, finish_reason: null }],
      });

      expect(transform(input)).toBe(`data: ${input}\n\n`);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('accumulates reasoning_content and fires callback on tool-call finish', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback);

      expect(
        transform(
          JSON.stringify({
            choices: [{ delta: { reasoning_content: 'I should ' }, finish_reason: null }],
          }),
        ),
      ).toContain('reasoning_content');
      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_content: 'use a tool.' }, finish_reason: null }],
        }),
      );
      transform(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup' } }],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      transform(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('call_1', 'I should use a tool.');
    });

    it('stores reasoning_content once a tool call id appears even without a tool-call finish marker', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback);

      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_content: 'I should use a tool.' }, finish_reason: null }],
        }),
      );
      transform(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup' } }],
              },
              finish_reason: null,
            },
          ],
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('call_1', 'I should use a tool.');
    });

    it('does not store reasoning_content for completed assistant messages without tool calls', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback);

      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_content: 'I should calculate. ' }, finish_reason: null }],
        }),
      );
      transform(
        JSON.stringify({
          choices: [{ delta: { content: 'The answer is 42.' }, finish_reason: null }],
        }),
      );
      transform(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));

      expect(callback).not.toHaveBeenCalled();
    });

    it('updates cached reasoning_content if more reasoning arrives after the tool call id', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback);

      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_content: 'plan A' }, finish_reason: null }],
        }),
      );
      transform(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup' } }],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_content: ' then plan B' }, finish_reason: null }],
        }),
      );

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith('call_1', 'plan A then plan B');
    });

    it('does not fire without a tool call id', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback);

      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }],
        }),
      );
      transform(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));

      expect(callback).not.toHaveBeenCalled();
    });

    it('passes malformed chunks through unchanged as SSE data', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback);

      expect(transform('not json')).toBe('data: not json\n\n');
      expect(callback).not.toHaveBeenCalled();
    });

    it('accumulates normalized reasoning aliases for tool-call replay cache', () => {
      const callback = jest.fn();
      const transform = createReasoningContentStreamTransformer(callback, {
        outputStreamDeltaPaths: ['reasoning_content', 'reasoning_text'],
        clientStreamDeltaPath: 'reasoning_content',
      });

      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_text: 'use ' }, finish_reason: null }],
        }),
      );
      transform(
        JSON.stringify({
          choices: [{ delta: { reasoning_text: 'a tool' }, finish_reason: null }],
        }),
      );
      transform(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup' } }],
              },
              finish_reason: null,
            },
          ],
        }),
      );

      expect(callback).toHaveBeenCalledWith('call_1', 'use a tool');
    });
  });
});

describe('sanitizeOpenAiBody provider-specific fields', () => {
  const bodyWithReasoning = () => ({
    messages: [
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'upstream thinking',
        tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
      },
    ],
  });

  it('keeps reasoning_content without model capability checks', () => {
    const result = sanitizeOpenAiBody(
      bodyWithReasoning(),
      'opencode-zen',
      'opencode-zen/big-pickle',
    );

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBe('upstream thinking');
  });
});
