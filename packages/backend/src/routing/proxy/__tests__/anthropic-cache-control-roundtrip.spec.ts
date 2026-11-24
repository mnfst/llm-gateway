/**
 * Regression for issue #1871: end-to-end cache_control round-trip through the
 * /v1/messages proxy path.
 *
 * The bug: when apiMode='messages', the response double-converts
 * Anthropic → chat-completions → Anthropic Messages. The second conversion
 * (`toAnthropicUsage`) was hardcoding `cache_creation_input_tokens: 0`, and the
 * recorder's `parseUsageObject` Anthropic branch was reading cache reads from
 * the OpenAI-style `input_tokens_details.cached_tokens` instead of Anthropic's
 * top-level `cache_read_input_tokens`. Net effect: client responses lost cache
 * creation, and `agent_messages` rows recorded `cache_creation_tokens: 0` AND
 * `cache_read_tokens: 0` even when Anthropic actually created/served the cache.
 */
import { fromAnthropicResponse, toAnthropicRequest } from '../anthropic-adapter';
import {
  chatCompletionsResponseToMessages,
  messagesToChatCompletionsRequest,
} from '../anthropic-messages-adapter';
import { parseUsageObject } from '../stream-writer';

describe('issue #1871: cache_control round-trip through /v1/messages', () => {
  describe('request path', () => {
    it('re-injects ephemeral cache_control on the last system block when an Anthropic Messages body round-trips through the chat-completions adapter', () => {
      const padding = 'background context follows '.repeat(1000);
      const inbound = {
        model: 'claude-haiku-4-5',
        max_tokens: 32,
        system: [{ type: 'text', text: padding, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Say pong.' }],
      };

      const chatBody = messagesToChatCompletionsRequest(inbound);
      const wireBody = toAnthropicRequest(chatBody, 'claude-haiku-4-5');

      const system = wireBody.system as Array<{ cache_control?: unknown }>;
      expect(system).toHaveLength(1);
      expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('re-injects cache_control on the last tool definition as well', () => {
      const padding = 'background context follows '.repeat(1000);
      const inbound = {
        model: 'claude-haiku-4-5',
        max_tokens: 32,
        system: [{ type: 'text', text: padding }],
        messages: [{ role: 'user', content: 'Say pong.' }],
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      };

      const chatBody = messagesToChatCompletionsRequest(inbound);
      const wireBody = toAnthropicRequest(chatBody, 'claude-haiku-4-5');

      const tools = wireBody.tools as Array<{ cache_control?: unknown }>;
      expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('response path', () => {
    const cacheCreatingAnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_creation_input_tokens: 3006,
        cache_read_input_tokens: 0,
      },
    };

    const cacheHitAnthropicResponse = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3006,
      },
    };

    it('preserves cache_creation_input_tokens through the chat → messages conversion (client-visible response)', () => {
      const chatResponse = fromAnthropicResponse(
        cacheCreatingAnthropicResponse,
        'claude-haiku-4-5-20251001',
      );
      const clientResponse = chatCompletionsResponseToMessages(
        chatResponse,
        'claude-haiku-4-5-20251001',
      );
      expect(clientResponse.usage).toEqual({
        // 7 uncached + 3006 cache creation = 3013 chat-shape total;
        // Anthropic shape splits them back out, so input_tokens stays 7.
        input_tokens: 7,
        output_tokens: 2,
        cache_creation_input_tokens: 3006,
        cache_read_input_tokens: 0,
      });
    });

    it('preserves cache_read_input_tokens through the chat → messages conversion (client-visible response)', () => {
      const chatResponse = fromAnthropicResponse(
        cacheHitAnthropicResponse,
        'claude-haiku-4-5-20251001',
      );
      const clientResponse = chatCompletionsResponseToMessages(
        chatResponse,
        'claude-haiku-4-5-20251001',
      );
      expect(clientResponse.usage).toEqual({
        input_tokens: 7,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3006,
      });
    });

    it('recovers cache_creation_tokens for DB recording after the Messages-shape conversion', () => {
      const chatResponse = fromAnthropicResponse(
        cacheCreatingAnthropicResponse,
        'claude-haiku-4-5-20251001',
      );
      const messagesResponse = chatCompletionsResponseToMessages(
        chatResponse,
        'claude-haiku-4-5-20251001',
      );
      const streamUsage = parseUsageObject(messagesResponse.usage);
      expect(streamUsage).toEqual({
        prompt_tokens: 3013, // uncached + cache creation, recovered by parser
        completion_tokens: 2,
        cache_read_tokens: 0,
        cache_creation_tokens: 3006,
      });
    });

    it('recovers cache_read_tokens for DB recording after the Messages-shape conversion', () => {
      const chatResponse = fromAnthropicResponse(
        cacheHitAnthropicResponse,
        'claude-haiku-4-5-20251001',
      );
      const messagesResponse = chatCompletionsResponseToMessages(
        chatResponse,
        'claude-haiku-4-5-20251001',
      );
      const streamUsage = parseUsageObject(messagesResponse.usage);
      expect(streamUsage).toEqual({
        prompt_tokens: 3013,
        completion_tokens: 2,
        cache_read_tokens: 3006,
        cache_creation_tokens: 0,
      });
    });

    it('carries OpenAI-compat nested cached_tokens through the messages conversion', () => {
      // OpenAI / DeepSeek / Z.AI / MiniMax / Mistral report cached input via
      // nested prompt_tokens_details.cached_tokens, not the top-level Anthropic
      // key. When /v1/messages routes to such a provider, the conversion must
      // still surface the cache count.
      const openAiChatResponse = {
        id: 'cc_2',
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      };
      const messagesResponse = chatCompletionsResponseToMessages(openAiChatResponse, 'gpt-4o-mini');
      expect(messagesResponse.usage).toEqual({
        input_tokens: 60, // 100 total - 40 cached
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 40,
      });

      const streamUsage = parseUsageObject(messagesResponse.usage);
      expect(streamUsage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 5,
        cache_read_tokens: 40,
        cache_creation_tokens: 0,
      });
    });

    it('carries nested cache writes through the messages conversion', () => {
      const openAiChatResponse = {
        id: 'cc_write',
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
        },
      };

      const messagesResponse = chatCompletionsResponseToMessages(openAiChatResponse, 'gpt-4o-mini');

      expect(messagesResponse.usage).toEqual({
        input_tokens: 50,
        output_tokens: 5,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 20,
      });
      expect(parseUsageObject(messagesResponse.usage)).toEqual({
        prompt_tokens: 100,
        completion_tokens: 5,
        cache_read_tokens: 20,
        cache_creation_tokens: 30,
      });
    });

    it.each([
      ['top-level cache creation', { cache_creation_input_tokens: 30 }],
      ['nested cache creation', { prompt_tokens_details: { cache_creation_input_tokens: 30 } }],
    ])('carries %s through the messages conversion', (_label, cacheUsage) => {
      const messagesResponse = chatCompletionsResponseToMessages(
        {
          id: 'cc_cache_creation',
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            ...cacheUsage,
          },
        },
        'gpt-4o-mini',
      );

      expect(messagesResponse.usage).toEqual({
        input_tokens: 70,
        output_tokens: 5,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 0,
      });
    });

    it('carries Moonshot top-level cached_tokens through the messages conversion', () => {
      const moonshotChatResponse = {
        id: 'cc_kimi',
        model: 'kimi-k2-latest',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          cached_tokens: 40,
        },
      };
      const messagesResponse = chatCompletionsResponseToMessages(
        moonshotChatResponse,
        'kimi-k2-latest',
      );
      expect(messagesResponse.usage).toEqual({
        input_tokens: 60,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 40,
      });
    });

    it('carries DeepSeek prompt_cache_hit_tokens through the messages conversion', () => {
      const deepSeekChatResponse = {
        id: 'cc_deepseek',
        model: 'deepseek-chat',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
        },
      };
      const messagesResponse = chatCompletionsResponseToMessages(
        deepSeekChatResponse,
        'deepseek-chat',
      );
      expect(messagesResponse.usage).toEqual({
        input_tokens: 60,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 40,
      });

      const streamUsage = parseUsageObject(messagesResponse.usage);
      expect(streamUsage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 5,
        cache_read_tokens: 40,
        cache_creation_tokens: 0,
      });
    });
  });
});
