/**
 * Translates between the public Anthropic Messages API format
 * (POST /v1/messages) and the internal chat-completions request/response
 * format used by Manifest's routing pipeline. Mirrors `responses-adapter.ts`
 * for the OpenAI Responses API.
 */
import { randomUUID } from 'crypto';

import { OpenAIMessage } from './proxy-types';

// Anthropic rejects tool_use ids outside ^[a-zA-Z0-9_-]+$, but non-Anthropic
// upstreams mint ids like `Edit:0`; passing one through poisons the client's
// history and 400s every later turn routed to a real Anthropic upstream.
const sanitizeToolUseId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

type JsonRecord = Record<string, unknown>;

const DEFAULT_CUSTOM_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOpenAiFunctionSchema(schema: unknown): unknown {
  if (schema === null || schema === undefined || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeOpenAiFunctionSchema(item));
  }

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = normalizeOpenAiFunctionSchema(value);
  }

  const type = result.type;
  const isArraySchema =
    type === 'array' || (Array.isArray(type) && type.some((item) => item === 'array'));
  if (isArraySchema && result.items === undefined) {
    result.items = {};
  }

  return result;
}

function safeJsonStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

function systemToString(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

function imageBlockToImagePart(block: JsonRecord): JsonRecord | null {
  if (!isRecord(block.source)) return null;
  const source = block.source;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function buildAssistantMessage(content: unknown): OpenAIMessage[] {
  // Assistant turns flatten cleanly because chat_completions splits text and
  // tool_calls into separate fields (no array-content interleaving anyway).
  let text = '';
  let reasoning = '';
  const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];

  const collect = (block: JsonRecord) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoning += block.thinking;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : randomUUID(),
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : 'unknown',
          arguments: safeJsonStringify(block.input ?? {}),
        },
      });
    }
  };

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block)) collect(block);
    }
  }

  if (!text && toolCalls.length === 0 && !reasoning) return [];
  const message: OpenAIMessage = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  return [message];
}

function splitToolResultContent(content: unknown): {
  toolContent: string;
  imageParts: JsonRecord[];
} {
  // Tool messages are text-only in chat_completions, so a nested image block
  // would otherwise ride inside the stringified tool output as raw base64 —
  // which downstream providers tokenize as TEXT at roughly 1.5 chars/token
  // (a single screenshot becomes 100K+ input tokens). Pull images out for a
  // follow-up user message and leave a short placeholder in the tool output.
  if (!Array.isArray(content)) {
    return { toolContent: safeJsonStringify(content), imageParts: [] };
  }
  const imageParts: JsonRecord[] = [];
  const sanitized = content.map((block) => {
    if (!isRecord(block) || block.type !== 'image') return block;
    const part = imageBlockToImagePart(block);
    if (!part) return block;
    imageParts.push(part);
    return { type: 'text', text: '[image attached below]' };
  });
  return { toolContent: safeJsonStringify(sanitized), imageParts };
}

function flushToolImages(messages: OpenAIMessage[], pendingToolImages: JsonRecord[]): void {
  if (pendingToolImages.length === 0) return;
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: 'Images from the preceding tool result:' },
      ...pendingToolImages,
    ],
  });
  pendingToolImages.length = 0;
}

function buildUserMessages(content: unknown, pendingToolImages: JsonRecord[]): OpenAIMessage[] {
  // Walk Anthropic content blocks in input order and emit chat_completions
  // messages without reshuffling. Each `tool_result` becomes a standalone
  // `role: tool` message; intermediate text/image blocks accumulate into a
  // user message that flushes either before the next `tool_result` or at
  // the end of the turn. Preserves the relative order of tool_result blocks
  // vs. surrounding text in mixed-content user turns.
  if (typeof content === 'string') {
    const messages: OpenAIMessage[] = [];
    flushToolImages(messages, pendingToolImages);
    if (content) messages.push({ role: 'user', content });
    return messages;
  }
  if (!Array.isArray(content)) return [];

  const messages: OpenAIMessage[] = [];
  let pendingParts: JsonRecord[] = [];

  const flushPendingUser = () => {
    if (pendingParts.length === 0) return;
    const hasNonText = pendingParts.some((p) => p.type !== 'text');
    if (hasNonText) {
      messages.push({ role: 'user', content: pendingParts });
    } else {
      const text = pendingParts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
      if (text) messages.push({ role: 'user', content: text });
    }
    pendingParts = [];
  };

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_result') {
      flushPendingUser();
      const { toolContent, imageParts } = splitToolResultContent(block.content);
      messages.push({
        role: 'tool',
        tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown',
        content: toolContent,
      });
      pendingToolImages.push(...imageParts);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      flushToolImages(messages, pendingToolImages);
      pendingParts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      flushToolImages(messages, pendingToolImages);
      const part = imageBlockToImagePart(block);
      if (part) pendingParts.push(part);
    }
  }
  flushPendingUser();
  return messages;
}

// chatBody is fed to the routing/scoring layer when the inbound is Anthropic
// Messages — `toolCount` and the specificity detector read `function.name`
// and array length, nothing else. The Anthropic wire body is emitted by
// `applyAnthropicMessagesMutations` directly from the inbound body, so this
// translation can lose Anthropic-only tool fields (e.g. server-tool `type`
// tags, omitted input_schema) without affecting upstream behavior *when the
// resolved provider is Anthropic*.
//
// But `chatBody.tools` is also the literal wire payload forwarded to
// non-Anthropic providers reached via the chat-completions wire format (see
// `ProviderClient.forward`'s `needsChatBody` path) — those providers never
// see the native Anthropic body. Anthropic server tools (`web_search_*`,
// `bash_*`, `computer_*`, etc.) have no `input_schema`, and some strict
// chat-completions providers (e.g. MiniMax) reject any function tool whose
// `parameters` field is missing entirely — even though the tool itself can't
// run there regardless. Emitting the same safe empty-object schema used for
// unrecognized tool types (issue #1897) keeps the request well-formed
// without pretending the schema is meaningful (fixes #2754).
function toChatTools(tools: unknown[]): JsonRecord[] {
  return tools.filter(isRecord).map((tool) => ({
    type: 'function',
    function: {
      name: typeof tool.name === 'string' ? tool.name : 'unknown',
      ...(typeof tool.description === 'string' && { description: tool.description }),
      ...(tool.input_schema !== undefined
        ? { parameters: normalizeOpenAiFunctionSchema(tool.input_schema) }
        : typeof tool.type === 'string' && tool.type !== 'custom'
          ? { parameters: DEFAULT_CUSTOM_TOOL_INPUT_SCHEMA }
          : {}),
    },
  }));
}

function toChatToolChoice(choice: unknown): unknown {
  if (!isRecord(choice)) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/** Anthropic Messages request → chat_completions request (used for routing/forwarding). */
export function messagesToChatCompletionsRequest(body: JsonRecord): JsonRecord {
  const messages: OpenAIMessage[] = [];
  const pendingToolImages: JsonRecord[] = [];

  const systemText = systemToString(body.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  const inputMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const item of inputMessages) {
    if (!isRecord(item)) continue;
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'assistant') {
      flushToolImages(messages, pendingToolImages);
      messages.push(...buildAssistantMessage(item.content));
    } else {
      messages.push(...buildUserMessages(item.content, pendingToolImages));
    }
  }
  // Anthropic combines consecutive user messages into one logical turn.
  // Keep extracted images buffered across those message boundaries so all
  // sibling tool results stay contiguous in the OpenAI-compatible request.
  flushToolImages(messages, pendingToolImages);

  const chatBody: JsonRecord = { messages };

  if (typeof body.model === 'string') chatBody.model = body.model;
  if (body.max_tokens !== undefined) chatBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.stream !== undefined) chatBody.stream = body.stream;
  if (body.metadata !== undefined) chatBody.metadata = body.metadata;
  if (body.stop_sequences !== undefined) chatBody.stop = body.stop_sequences;
  // Anthropic-native fields with no chat_completions analogue. Carried on
  // chatBody so toAnthropicRequest can forward them when the resolved
  // provider is Anthropic. Native OpenAI rejects `thinking` as an unknown
  // parameter, so the forwarding boundary only preserves the lossless case:
  // `thinking: {type: disabled}` becomes reasoning_effort `none` (and only on a
  // model that reasons); every other thinking config is dropped and falls back
  // to the provider's default reasoning (see applyAnthropicThinkingForOpenAi
  // in provider-client).
  if (body.thinking !== undefined) chatBody.thinking = body.thinking;
  if (body.top_k !== undefined) chatBody.top_k = body.top_k;

  if (Array.isArray(body.tools)) chatBody.tools = toChatTools(body.tools);
  const toolChoice = toChatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;

  return chatBody;
}

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
};

function toAnthropicStopReason(finishReason: unknown): string {
  if (typeof finishReason !== 'string') return 'end_turn';
  return STOP_REASON_MAP[finishReason] ?? 'end_turn';
}

function toAnthropicUsage(usage: unknown): JsonRecord {
  const u = isRecord(usage) ? usage : {};
  const promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
  const outputTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
  const promptDetails = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
  // OpenAI-compat providers (OpenAI chat-completions, DeepSeek, Z.AI, MiniMax, etc.)
  // report cached input under nested `prompt_tokens_details.cached_tokens` instead
  // of the top-level Anthropic-converted key — fall back to it.
  const cacheRead =
    typeof u.cache_read_tokens === 'number'
      ? u.cache_read_tokens
      : typeof u.prompt_cache_hit_tokens === 'number'
        ? u.prompt_cache_hit_tokens
        : typeof u.cached_tokens === 'number'
          ? u.cached_tokens
          : typeof promptDetails?.cached_tokens === 'number'
            ? promptDetails.cached_tokens
            : 0;
  const cacheCreation =
    typeof u.cache_creation_tokens === 'number'
      ? u.cache_creation_tokens
      : typeof u.cache_creation_input_tokens === 'number'
        ? u.cache_creation_input_tokens
        : typeof promptDetails?.cache_write_tokens === 'number'
          ? promptDetails.cache_write_tokens
          : typeof promptDetails?.cache_creation_input_tokens === 'number'
            ? promptDetails.cache_creation_input_tokens
            : 0;
  // Chat-shape prompt_tokens is the full input total (uncached + cache reads +
  // cache creation). Anthropic Messages' input_tokens is the uncached portion
  // only, with cache_read_input_tokens / cache_creation_input_tokens reported
  // separately. Subtract so the round-trip matches Anthropic's native shape.
  const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** chat_completions response → Anthropic Messages response. */
export function chatCompletionsResponseToMessages(body: JsonRecord, model: string): JsonRecord {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(firstChoice.message) ? firstChoice.message : {};

  const content: JsonRecord[] = [];

  // DeepSeek-style reasoning_content surfaced as Anthropic `thinking` blocks.
  // Anthropic clients can echo these back on subsequent turns to satisfy
  // providers (DeepSeek, etc.) that require the reasoning trace.
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }

  const text =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? (message.content as Array<JsonRecord>)
            .filter(isRecord)
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('')
        : '';
  if (text) content.push({ type: 'text', text });

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      content.push({
        type: 'tool_use',
        id:
          typeof call.id === 'string' && call.id !== ''
            ? sanitizeToolUseId(call.id)
            : `toolu_${randomUUID().replace(/-/g, '')}`,
        name: typeof call.function.name === 'string' ? call.function.name : '',
        input: safeParseJson(call.function.arguments),
      });
    }
  }

  const stopReason = toAnthropicStopReason(firstChoice.finish_reason);

  return {
    id: typeof body.id === 'string' ? body.id : `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: typeof body.model === 'string' ? body.model : model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: toAnthropicUsage(body.usage),
  };
}

interface StreamState {
  messageId: string;
  model: string;
  startedMessage: boolean;
  // Block-state fields track the *currently open* block of each kind. After a
  // block is stopped, the *Opened flag flips back to false so a subsequent
  // chunk of the same kind allocates a fresh index — supports providers that
  // interleave reasoning_content with content or tool_calls.
  thinkingIndex: number | null;
  thinkingOpened: boolean;
  textIndex: number | null;
  textOpened: boolean;
  toolCalls: Map<number, { id: string; index: number; argBuffer: string; opened: boolean }>;
  // Monotonic counter — block indices must keep increasing across the whole
  // stream, including across reopens of the same kind.
  nextBlockIndexCounter: number;
  finalUsage: JsonRecord | null;
  stopReason: string | null;
  endedMessage: boolean;
}

export interface MessagesStreamTransformer {
  transform: (chunk: string) => string | null;
  finalize: () => string | null;
}

export function createMessagesStreamTransformer(model: string): MessagesStreamTransformer {
  const state: StreamState = {
    messageId: `msg_${randomUUID().replace(/-/g, '')}`,
    model,
    startedMessage: false,
    thinkingIndex: null,
    thinkingOpened: false,
    textIndex: null,
    textOpened: false,
    toolCalls: new Map(),
    nextBlockIndexCounter: 0,
    finalUsage: null,
    stopReason: null,
    endedMessage: false,
  };

  return {
    transform: (chunk: string) => transformStreamChunk(chunk, state),
    finalize: () => {
      const events = closeStream(state);
      return events.length > 0 ? events.join('') : null;
    },
  };
}

function transformStreamChunk(chunk: string, state: StreamState): string | null {
  const events: string[] = [];
  for (const payload of extractDataPayloads(chunk)) {
    if (state.endedMessage) break;
    if (payload === '[DONE]') continue;
    const data = safeParse(payload);
    if (!data) continue;

    // Terminal upstream errors arrive as OpenAI-shape `{"error":{...}}` chunks
    // (e.g. from the ChatGPT Responses adapter). Surface them as a native
    // Anthropic `error` event instead of dropping them — otherwise closeStream
    // would fabricate a successful empty `end_turn` message.
    if (isRecord(data.error)) {
      events.push(buildStreamErrorEvent(state, data.error));
      break;
    }

    if (!state.startedMessage) {
      events.push(buildMessageStartEvent(state, data));
      state.startedMessage = true;
    }

    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (choices.length === 0 && isRecord(data.usage)) {
      state.finalUsage = toAnthropicUsage(data.usage);
      continue;
    }

    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (!choice) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};

    // DeepSeek (and other thinking-mode providers) stream reasoning as
    // `delta.reasoning_content` separately from `delta.content`. Surface it as
    // an Anthropic `thinking` content block so clients can echo it back on the
    // next turn — the upstream rejects follow-ups that don't return the trace.
    // Reasoning can also arrive *after* text or a tool_use has already started
    // (providers don't guarantee reasoning is fully flushed before content).
    // For text we close it and reopen a fresh thinking block — splitting text
    // across blocks is fine because each Anthropic text block is independent.
    // For an in-progress tool_use we DROP the late reasoning: Manifest's
    // Anthropic-compat layer assumes thinking blocks precede tool_use and
    // replays them in that shape on the next turn, so emitting a transcript
    // like `thinking → tool_use → thinking` would produce a stream we can't
    // safely replay. Keeping the tool_use block contiguous is the more
    // defensible tradeoff than surfacing a fragment that breaks replay.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (!hasOpenToolCall(state)) {
        closeTextBlock(state, events);
        if (!state.thinkingOpened) {
          state.thinkingIndex = nextBlockIndex(state);
          events.push(
            formatMessagesEvent('content_block_start', {
              type: 'content_block_start',
              index: state.thinkingIndex,
              content_block: { type: 'thinking', thinking: '' },
            }),
          );
          state.thinkingOpened = true;
        }
        events.push(
          formatMessagesEvent('content_block_delta', {
            type: 'content_block_delta',
            index: state.thinkingIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          }),
        );
      }
      // else: silently drop reasoning_content arriving during an open tool_use.
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      closeThinkingBlock(state, events);
      closeOpenToolCalls(state, events);
      if (!state.textOpened) {
        state.textIndex = nextBlockIndex(state);
        events.push(
          formatMessagesEvent('content_block_start', {
            type: 'content_block_start',
            index: state.textIndex,
            content_block: { type: 'text', text: '' },
          }),
        );
        state.textOpened = true;
      }
      events.push(
        formatMessagesEvent('content_block_delta', {
          type: 'content_block_delta',
          index: state.textIndex,
          delta: { type: 'text_delta', text: delta.content },
        }),
      );
    }

    if (Array.isArray(delta.tool_calls)) {
      closeThinkingBlock(state, events);
      closeTextBlock(state, events);
      for (const call of delta.tool_calls) {
        if (!isRecord(call)) continue;
        const callIndex = typeof call.index === 'number' ? call.index : 0;
        let entry = state.toolCalls.get(callIndex);
        if (!entry) {
          entry = {
            id:
              typeof call.id === 'string' && call.id !== ''
                ? sanitizeToolUseId(call.id)
                : `toolu_${randomUUID().replace(/-/g, '')}`,
            index: nextBlockIndex(state),
            argBuffer: '',
            opened: false,
          };
          state.toolCalls.set(callIndex, entry);
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (!entry.opened) {
          events.push(
            formatMessagesEvent('content_block_start', {
              type: 'content_block_start',
              index: entry.index,
              content_block: {
                type: 'tool_use',
                id: entry.id,
                name: typeof fn.name === 'string' ? fn.name : '',
                input: {},
              },
            }),
          );
          entry.opened = true;
        }
        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          entry.argBuffer += fn.arguments;
          events.push(
            formatMessagesEvent('content_block_delta', {
              type: 'content_block_delta',
              index: entry.index,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            }),
          );
        }
      }
    }

    if (choice.finish_reason) {
      state.stopReason = toAnthropicStopReason(choice.finish_reason);
      if (isRecord(data.usage) && !state.finalUsage) {
        state.finalUsage = toAnthropicUsage(data.usage);
      }
    }
  }

  return events.length > 0 ? events.join('') : null;
}

// Monotonic — every kind of block (thinking/text/tool_use) consumes one slot
// here, even on reopens. Anthropic's content_block_* events index from 0
// upward; the index of a reopened block must keep climbing, not collide with
// an earlier one that has already been stopped.
function nextBlockIndex(state: StreamState): number {
  return state.nextBlockIndexCounter++;
}

function closeThinkingBlock(state: StreamState, events: string[]): void {
  if (!state.thinkingOpened || state.thinkingIndex === null) return;
  events.push(
    formatMessagesEvent('content_block_stop', {
      type: 'content_block_stop',
      index: state.thinkingIndex,
    }),
  );
  state.thinkingOpened = false;
}

function closeTextBlock(state: StreamState, events: string[]): void {
  if (!state.textOpened || state.textIndex === null) return;
  events.push(
    formatMessagesEvent('content_block_stop', {
      type: 'content_block_stop',
      index: state.textIndex,
    }),
  );
  state.textOpened = false;
}

function hasOpenToolCall(state: StreamState): boolean {
  for (const entry of state.toolCalls.values()) {
    if (entry.opened) return true;
  }
  return false;
}

function closeOpenToolCalls(state: StreamState, events: string[]): void {
  for (const entry of state.toolCalls.values()) {
    if (!entry.opened) continue;
    events.push(
      formatMessagesEvent('content_block_stop', {
        type: 'content_block_stop',
        index: entry.index,
      }),
    );
    entry.opened = false;
  }
}

function buildMessageStartEvent(state: StreamState, data: JsonRecord): string {
  const usage = isRecord(data.usage) ? toAnthropicUsage(data.usage) : toAnthropicUsage({});
  return formatMessagesEvent('message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: typeof data.model === 'string' ? data.model : state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
}

const ANTHROPIC_ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
  529: 'overloaded_error',
};

function buildStreamErrorEvent(state: StreamState, error: JsonRecord): string {
  // Marking the message ended makes closeStream a no-op, so the error event is
  // the terminal event the client sees (matching Anthropic's own stream
  // protocol, where `error` can end a stream without `message_stop`).
  state.endedMessage = true;
  const message =
    typeof error.message === 'string' && error.message
      ? error.message
      : 'Upstream provider stream failed';
  const status = typeof error.status === 'number' ? error.status : undefined;
  const errorType = (status && ANTHROPIC_ERROR_TYPE_BY_STATUS[status]) || 'api_error';
  return formatMessagesEvent('error', {
    type: 'error',
    error: { type: errorType, message },
  });
}

function closeStream(state: StreamState): string[] {
  if (state.endedMessage) return [];
  const events: string[] = [];

  closeThinkingBlock(state, events);
  closeTextBlock(state, events);
  closeOpenToolCalls(state, events);

  events.push(
    formatMessagesEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: state.stopReason ?? 'end_turn',
        stop_sequence: null,
      },
      usage: state.finalUsage ?? toAnthropicUsage({}),
    }),
  );
  events.push(formatMessagesEvent('message_stop', { type: 'message_stop' }));
  state.endedMessage = true;
  return events;
}

function extractDataPayloads(chunk: string): string[] {
  const lines = chunk.split('\n').map((line) => line.trim());
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length > 0) return dataLines.map((line) => line.slice(5).trim());
  return [chunk.trim()].filter(Boolean);
}

function safeParse(data: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatMessagesEvent(event: string, data: JsonRecord): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
