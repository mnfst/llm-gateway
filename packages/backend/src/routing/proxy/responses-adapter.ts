import { randomUUID } from 'crypto';

import { DEFAULT_INSTRUCTIONS } from './chatgpt-helpers';
import { OpenAIMessage } from './proxy-types';
import { deduplicateCallIds } from './responses-call-ids';
import { chatToolName, chatTools, responsesToolNames, ResponsesToolNames } from './responses-tools';

type JsonRecord = Record<string, unknown>;

interface ChatCompletionToResponsesOptions {
  toolNames?: ResponsesToolNames;
  structuredOutputToolName?: string;
  textFormat?: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function toChatContent(content: unknown, role: string): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  const converted = content.filter(isRecord).map((part) => {
    if (typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      return { type: 'image_url', image_url: { url: part.image_url } };
    }
    return part;
  });

  if (converted.length === 1 && converted[0]?.type === 'text' && role !== 'assistant') {
    return converted[0].text;
  }
  return converted;
}

function responseInputItemToMessage(item: JsonRecord, names: ResponsesToolNames): OpenAIMessage[] {
  if (item.type === 'function_call') {
    return [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: typeof item.call_id === 'string' ? item.call_id : randomUUID(),
            type: 'function',
            function: {
              name: chatToolName(item, names),
              arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
            },
          },
        ],
      },
    ];
  }

  if (item.type === 'function_call_output') {
    return [
      {
        role: 'tool',
        tool_call_id: typeof item.call_id === 'string' ? item.call_id : randomUUID(),
        content:
          item.output === undefined || item.output === null
            ? ''
            : typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output),
      },
    ];
  }

  // Typed items with no chat-completions equivalent — `reasoning` (whose
  // `encrypted_content` is opaque outside OpenAI), `item_reference`,
  // `web_search_call`, and friends. Dropping them is the only safe mapping:
  // falling through would emit `{ role: 'user' }` with no `content`, which
  // strictly-validating providers reject with 400/422.
  if (!isNativeResponsesMessageItem(item)) return [];

  const rawRole = typeof item.role === 'string' ? item.role : 'user';
  const role = rawRole === 'developer' ? 'system' : rawRole;
  const content = toChatContent(item.content, role);
  // A message item carrying no content at all is the same wire hazard: the
  // key is omitted on serialization and `{ role: 'user' }` goes out again.
  if (content === undefined) return [];

  return [{ role, content }];
}

export function toChatCompletionsRequest(body: JsonRecord): JsonRecord {
  const messages: OpenAIMessage[] = [];
  const names = responsesToolNames(body.tools);
  const instructions = body.instructions;
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (isRecord(item)) {
        const converted = responseInputItemToMessage(item, names);
        const previous = messages[messages.length - 1];
        const next = converted[0];
        // Parallel Responses calls are separate items, but Chat Completions
        // requires one assistant turn followed by all matching tool results.
        if (previous?.tool_calls && next?.tool_calls) {
          previous.tool_calls.push(...next.tool_calls);
        } else {
          messages.push(...converted);
        }
      }
    }
  }

  const chatBody: JsonRecord = { messages };
  for (const key of [
    'model',
    'temperature',
    'top_p',
    'stream',
    'metadata',
    'store',
    'user',
    'parallel_tool_calls',
  ]) {
    if (body[key] !== undefined) chatBody[key] = body[key];
  }

  if (body.max_output_tokens !== undefined) chatBody.max_tokens = body.max_output_tokens;
  const responseFormat = toChatResponseFormat(body.text);
  if (responseFormat) chatBody.response_format = responseFormat;
  if (Array.isArray(body.tools)) chatBody.tools = chatTools(body.tools, names);
  const toolChoice = toChatToolChoice(body.tool_choice, names);
  if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;

  return chatBody;
}

function toChatResponseFormat(text: unknown): JsonRecord | undefined {
  if (!isRecord(text) || !isRecord(text.format)) return undefined;

  const format = text.format;
  if (format.type === 'json_object') {
    return { type: 'json_object' };
  }
  if (format.type !== 'json_schema') return undefined;

  const jsonSchema: JsonRecord = {};
  if (format.name !== undefined) jsonSchema.name = format.name;
  if (format.schema !== undefined) jsonSchema.schema = format.schema;
  if (format.strict !== undefined) jsonSchema.strict = format.strict;
  if (typeof format.description === 'string' && format.description) {
    jsonSchema.description = format.description;
  }
  return { type: 'json_schema', json_schema: jsonSchema };
}

function toChatToolChoice(toolChoice: unknown, names: ResponsesToolNames): unknown {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required')
    return toolChoice;
  // A hosted tool removed from tools cannot remain as a forced tool choice.
  if (!isRecord(toolChoice) || toolChoice.type !== 'function') return undefined;
  return { type: 'function', function: { name: chatToolName(toolChoice, names) } };
}

/**
 * Responses API parameters the ChatGPT subscription backend
 * (chatgpt.com/backend-api/codex/responses) rejects with HTTP 400. Sampling
 * controls (`temperature`, `top_p`) are locked upstream; `max_output_tokens`,
 * `metadata`, `safety_identifier`, `prompt_cache_retention`, `truncation` are
 * not part of its allowlist. Forwarding any of them returns
 * `unsupported_parameter` and breaks OpenAI-SDK clients.
 */
const CODEX_SUBSCRIPTION_UNSUPPORTED_PARAMS = [
  'temperature',
  'top_p',
  'max_output_tokens',
  'metadata',
  'safety_identifier',
  'prompt_cache_retention',
  'truncation',
] as const;

export function toNativeResponsesRequest(
  body: JsonRecord,
  model: string,
  opts?: {
    defaultInstructions?: boolean;
    inputList?: boolean;
    forceStream?: boolean;
    stripCodexUnsupported?: boolean;
  },
): JsonRecord {
  const request: JsonRecord = { ...body, model };
  if (opts?.stripCodexUnsupported) {
    for (const key of CODEX_SUBSCRIPTION_UNSUPPORTED_PARAMS) {
      delete request[key];
    }
    // The backend also rejects `store: true`. Force it off rather than
    // letting the request fail on something the caller cannot influence.
    request.store = false;
  } else if (body.store === undefined) {
    request.store = false;
  }
  if (opts?.forceStream) {
    request.stream = true;
  } else if (body.stream === undefined) {
    request.stream = false;
  }
  if (opts?.inputList) {
    request.input = toNativeResponsesInput(body.input);
  } else if (body.input !== undefined) {
    request.input = normalizeNativeResponsesInput(body.input);
  }
  // `previous_response_id` means the provider holds the earlier turns, so the
  // ids in this request can pair with items we cannot see. Leave them alone.
  if (
    Array.isArray(request.input) &&
    (typeof request.previous_response_id !== 'string' || !request.previous_response_id)
  ) {
    request.input = deduplicateCallIds(request.input);
  }
  if (
    opts?.defaultInstructions &&
    (typeof request.instructions !== 'string' || !request.instructions.trim())
  ) {
    request.instructions = DEFAULT_INSTRUCTIONS;
  }
  return request;
}

function normalizeNativeResponsesInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;

  return input.map((item) => {
    if (!isRecord(item)) return item;
    if (!isNativeResponsesMessageItem(item)) return item;

    const role = typeof item.role === 'string' ? item.role : 'user';
    return { ...item, content: toNativeResponsesContent(item.content, role) };
  });
}

function toNativeResponsesInput(input: unknown): unknown {
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'input_text', text: input }] }];
  }
  if (!Array.isArray(input)) return input;

  return input.flatMap((item) => {
    if (typeof item === 'string') {
      return [{ role: 'user', content: [{ type: 'input_text', text: item }] }];
    }
    if (!isRecord(item)) return [];
    if (!isNativeResponsesMessageItem(item)) return [item];

    const role = typeof item.role === 'string' ? item.role : 'user';
    return [{ ...item, role, content: toNativeResponsesContent(item.content, role) }];
  });
}

function isNativeResponsesMessageItem(item: JsonRecord): boolean {
  return item.type === undefined || item.type === 'message';
}

function toNativeResponsesContent(content: unknown, role: string): unknown {
  const partType = role === 'assistant' ? 'output_text' : 'input_text';

  if (typeof content === 'string') return [{ type: partType, text: content }];
  if (!Array.isArray(content)) return content;

  return content.filter(isRecord).map((part) => {
    if (typeof part.text === 'string' && (part.type === 'text' || part.type === undefined)) {
      return { ...part, type: partType };
    }
    if (part.type === 'image_url' && role !== 'assistant') {
      const imageUrl = extractImageUrl(part.image_url);
      if (imageUrl) {
        return { type: 'input_image', image_url: imageUrl, ...extractImageDetail(part) };
      }
    }
    return part;
  });
}

function extractImageUrl(imageUrl: unknown): string | null {
  if (typeof imageUrl === 'string') return imageUrl;
  if (!isRecord(imageUrl) || typeof imageUrl.url !== 'string') return null;
  return imageUrl.url;
}

function extractImageDetail(part: JsonRecord): { detail?: string } {
  const nested = isRecord(part.image_url) ? part.image_url.detail : undefined;
  const detail = typeof part.detail === 'string' ? part.detail : nested;
  return typeof detail === 'string' ? { detail } : {};
}

function findStructuredOutputToolCall(
  toolCalls: unknown,
  toolName: string | undefined,
): JsonRecord | null {
  if (!toolName || !Array.isArray(toolCalls)) return null;
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
    if (toolCall.function.name === toolName) return toolCall;
  }
  return null;
}

function toolCallArguments(toolCall: JsonRecord | null): string | null {
  const fn = isRecord(toolCall?.function) ? toolCall.function : null;
  if (!fn) return null;
  return typeof fn.arguments === 'string' ? fn.arguments : '{}';
}

function responseTextFormat(format: unknown): JsonRecord {
  if (!isRecord(format)) return { type: 'text' };
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type !== 'json_schema') return { type: 'text' };

  const out: JsonRecord = { type: 'json_schema' };
  if (format.name !== undefined) out.name = format.name;
  if (format.schema !== undefined) out.schema = format.schema;
  if (format.strict !== undefined) out.strict = format.strict;
  if (typeof format.description === 'string' && format.description) {
    out.description = format.description;
  }
  return out;
}

export function fromChatCompletionResponse(
  body: JsonRecord,
  model: string,
  options: ChatCompletionToResponsesOptions = {},
): JsonRecord {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(firstChoice.message) ? firstChoice.message : {};
  const output: JsonRecord[] = [];
  const structuredToolCall = findStructuredOutputToolCall(
    message.tool_calls,
    options.structuredOutputToolName,
  );
  const structuredText = toolCallArguments(structuredToolCall);
  const contentText = textFromContent(message.content);
  const outputText = structuredText ?? contentText;

  if (outputText || structuredText !== null) {
    output.push({
      type: 'message',
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText, annotations: [] }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
      if (toolCall === structuredToolCall) continue;
      output.push({
        type: 'function_call',
        id: `fc_${randomUUID().replace(/-/g, '')}`,
        call_id: typeof toolCall.id === 'string' ? toolCall.id : randomUUID(),
        name: typeof toolCall.function.name === 'string' ? toolCall.function.name : '',
        ...options.toolNames?.get(String(toolCall.function.name)),
        arguments:
          typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : '{}',
        status: 'completed',
      });
    }
  }

  const created = typeof body.created === 'number' ? body.created : Math.floor(Date.now() / 1000);
  return {
    id: `resp_${randomUUID().replace(/-/g, '')}`,
    object: 'response',
    created_at: created,
    status: 'completed',
    completed_at: created,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: typeof body.model === 'string' ? body.model : model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: responseTextFormat(options.textFormat) },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: toResponsesUsage(body.usage),
    user: null,
    metadata: {},
  };
}

function toResponsesUsage(usage: unknown): JsonRecord | null {
  if (!isRecord(usage)) return null;
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens =
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens;
  const cachedTokens =
    typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : undefined;
  const cacheWriteTokens =
    typeof usage.cache_creation_tokens === 'number' ? usage.cache_creation_tokens : undefined;

  return {
    input_tokens: promptTokens,
    input_tokens_details: {
      cached_tokens: cachedTokens ?? 0,
      cache_write_tokens: cacheWriteTokens ?? 0,
    },
    output_tokens: completionTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: totalTokens,
  };
}

export function collectResponsesSseResponse(sseText: string): JsonRecord {
  let text = '';
  let completed: JsonRecord | null = null;
  // Track function_call output items emitted incrementally. Keyed by
  // `output_index` so a tool call can sit at any position in a mixed-output
  // stream (e.g. assistant message + function_call). Some Codex Responses
  // streams emit `response.completed` with `output: []` and surface the call
  // only via `response.output_item.added` + `.function_call_arguments.delta`,
  // so dropping these events causes the SDK to see no tool call at all.
  const functionCalls = new Map<number, JsonRecord>();

  for (const event of sseText.split('\n\n')) {
    const parsed = parseSseEvent(event);
    if (!parsed) continue;
    if (parsed.event === 'response.output_text.delta') {
      const data = safeParse(parsed.data);
      if (typeof data?.delta === 'string') text += data.delta;
    } else if (parsed.event === 'response.output_item.added') {
      const data = safeParse(parsed.data);
      const item = isRecord(data?.item) ? (data.item as JsonRecord) : null;
      if (item && item.type === 'function_call') {
        const idx = typeof data?.output_index === 'number' ? data.output_index : functionCalls.size;
        functionCalls.set(idx, {
          type: 'function_call',
          id: typeof item.id === 'string' ? item.id : '',
          call_id: typeof item.call_id === 'string' ? item.call_id : '',
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
          ...(typeof item.status === 'string' ? { status: item.status } : {}),
        });
      }
    } else if (parsed.event === 'response.function_call_arguments.delta') {
      const data = safeParse(parsed.data);
      if (!data) continue;
      const idx = typeof data.output_index === 'number' ? data.output_index : 0;
      const fc = functionCalls.get(idx);
      if (fc && typeof data.delta === 'string') {
        const prev = typeof fc.arguments === 'string' ? fc.arguments : '';
        fc.arguments = prev + data.delta;
      }
    } else if (parsed.event === 'response.function_call_arguments.done') {
      // Some streams (e.g. no-argument calls) skip deltas and only ship the
      // final argument string here. Two shapes are documented: top-level
      // `arguments` and a nested `item.arguments`. Treat either as
      // authoritative.
      const data = safeParse(parsed.data);
      if (!data) continue;
      const idx = typeof data.output_index === 'number' ? data.output_index : 0;
      const fc = functionCalls.get(idx);
      const nestedItem = isRecord(data.item) ? (data.item as JsonRecord) : null;
      const finalArgs =
        typeof data.arguments === 'string'
          ? data.arguments
          : nestedItem && typeof nestedItem.arguments === 'string'
            ? (nestedItem.arguments as string)
            : null;
      if (fc && finalArgs !== null) {
        fc.arguments = finalArgs;
      }
    } else if (parsed.event === 'response.output_item.done') {
      const data = safeParse(parsed.data);
      const item = isRecord(data?.item) ? (data.item as JsonRecord) : null;
      if (item && item.type === 'function_call') {
        const idx = typeof data?.output_index === 'number' ? data.output_index : functionCalls.size;
        // The `done` event carries the authoritative final item — replace any
        // partial state we accumulated from `added` + delta events.
        functionCalls.set(idx, item);
      }
    } else if (parsed.event === 'response.completed') {
      const data = safeParse(parsed.data);
      completed = isRecord(data?.response) ? data.response : null;
    }
  }

  if (completed) {
    let result = withCollectedTextOutput(completed, text);
    if (functionCalls.size > 0) {
      result = withCollectedFunctionCalls(result, functionCalls);
    }
    return result;
  }
  return fromChatCompletionResponse(
    {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    'unknown',
  );
}

function withCollectedFunctionCalls(
  response: JsonRecord,
  collected: Map<number, JsonRecord>,
): JsonRecord {
  if (collected.size === 0) return response;
  const existing = Array.isArray(response.output) ? (response.output as JsonRecord[]) : [];
  const existingIds = new Set<string>();
  const existingCallIds = new Set<string>();
  for (const item of existing) {
    if (!isRecord(item) || item.type !== 'function_call') continue;
    if (typeof item.id === 'string' && item.id) existingIds.add(item.id);
    if (typeof item.call_id === 'string' && item.call_id) existingCallIds.add(item.call_id);
  }
  const ordered = [...collected.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  const toAdd = ordered.filter((fc) => {
    const id = typeof fc.id === 'string' ? fc.id : '';
    const callId = typeof fc.call_id === 'string' ? fc.call_id : '';
    if (id && existingIds.has(id)) return false;
    // Fall back to call_id when item id is missing on either side — upstream
    // can omit `id` on `output_item.added`, but `call_id` is always present.
    if (callId && existingCallIds.has(callId)) return false;
    return true;
  });
  if (toAdd.length === 0) return response;
  return { ...response, output: [...existing, ...toAdd] };
}

function withCollectedTextOutput(response: JsonRecord, text: string): JsonRecord {
  if (!text) return response;
  const output = Array.isArray(response.output) ? response.output : [];
  const hasTextOutput = output.some((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return false;
    return item.content.some(
      (part) => isRecord(part) && part.type === 'output_text' && typeof part.text === 'string',
    );
  });
  if (hasTextOutput) return response;

  return {
    ...response,
    output: [
      ...output,
      {
        type: 'message',
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
  };
}

function parseSseEvent(raw: string): { event: string; data: string } | null {
  let event = '';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  return event || data ? { event, data } : null;
}

function safeParse(data: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ResponsesStreamTransformer {
  transform: (chunk: string) => string | null;
  finalize: () => string | null;
}

export interface ResponsesStreamTransformerOptions {
  toolNames?: ResponsesToolNames;
  structuredOutputToolName?: string;
  textFormat?: JsonRecord;
}

interface StreamFunctionCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex?: number;
}

interface ResponsesStreamState {
  toolNames?: ResponsesToolNames;
  toolCalls: Map<number, StreamFunctionCall>;
  nextOutputIndex: number;
  messageOutputIndex: number;

  responseId: string;
  itemId: string;
  model: string;
  createdAt: number;
  usage: unknown;
  text: string;
  structuredOutputToolName?: string;
  structuredToolCallIndexes: Set<number>;
  textFormat?: JsonRecord;
  createdEmitted: boolean;
  itemOpened: boolean;
  completed: boolean;
}

/**
 * Converts an upstream Chat Completions SSE stream into a spec-compliant
 * OpenAI Responses API event stream.
 *
 * Unlike a per-chunk mapper, this is stateful: the Responses API requires a
 * message item and content part to be *opened* (`response.output_item.added`
 * + `response.content_part.added`) before any `response.output_text.delta`,
 * and *closed* (`...output_text.done` / `...content_part.done` /
 * `...output_item.done`) before `response.completed`. Strict clients (Pi,
 * OpenClaw-style) silently drop text deltas that arrive without an open item,
 * which surfaced as empty assistant messages (issue #2064).
 *
 * `transform` runs per upstream event; `finalize` closes the stream and emits
 * the terminal `data: [DONE]`. When a `finalize` is supplied, `pipeStream`
 * delegates termination to it (it does not add its own `[DONE]`).
 */
export function createResponsesStreamTransformer(
  model: string,
  options: ResponsesStreamTransformerOptions = {},
): ResponsesStreamTransformer {
  const state: ResponsesStreamState = {
    toolNames: options.toolNames,
    toolCalls: new Map(),
    nextOutputIndex: 0,
    messageOutputIndex: 0,
    responseId: `resp_${randomUUID().replace(/-/g, '')}`,
    itemId: `msg_${randomUUID().replace(/-/g, '')}`,
    model,
    // Stamp the creation time once so every response snapshot for this id
    // (`response.created`, `.in_progress`, `.completed`) reports the same
    // `created_at`, even on streams that span more than one second.
    createdAt: Math.floor(Date.now() / 1000),
    usage: undefined,
    text: '',
    structuredOutputToolName: options.structuredOutputToolName,
    structuredToolCallIndexes: new Set(),
    textFormat: options.textFormat,
    createdEmitted: false,
    itemOpened: false,
    completed: false,
  };

  return {
    transform: (chunk: string) => transformResponsesStreamChunk(chunk, state),
    finalize: () => finalizeResponsesStream(state),
  };
}

function inProgressResponse(state: ResponsesStreamState): JsonRecord {
  const response = fromChatCompletionResponse(
    { model: state.model, created: state.createdAt, choices: [{ message: { content: '' } }] },
    state.model,
    { textFormat: state.textFormat },
  );
  response.id = state.responseId;
  response.status = 'in_progress';
  response.completed_at = null;
  response.usage = null;
  return response;
}

function emitCreated(state: ResponsesStreamState): string[] {
  if (state.createdEmitted) return [];
  state.createdEmitted = true;
  const response = inProgressResponse(state);
  return [
    formatResponsesEvent('response.created', { type: 'response.created', response }),
    formatResponsesEvent('response.in_progress', { type: 'response.in_progress', response }),
  ];
}

function emitItemOpen(state: ResponsesStreamState): string[] {
  if (state.itemOpened) return [];
  state.itemOpened = true;
  state.messageOutputIndex = state.nextOutputIndex++;
  return [
    formatResponsesEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.messageOutputIndex,
      item: {
        id: state.itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    }),
    formatResponsesEvent('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: state.itemId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
  ];
}

function structuredOutputTextDelta(toolCalls: unknown, state: ResponsesStreamState): string {
  if (!state.structuredOutputToolName || !Array.isArray(toolCalls)) return '';

  let text = '';
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const index = typeof toolCall.index === 'number' ? toolCall.index : 0;
    const fn = isRecord(toolCall.function) ? toolCall.function : null;
    if (!fn) continue;
    if (fn.name === state.structuredOutputToolName) {
      state.structuredToolCallIndexes.add(index);
    }
    if (
      state.structuredToolCallIndexes.has(index) &&
      typeof fn.arguments === 'string' &&
      fn.arguments.length > 0
    ) {
      text += fn.arguments;
    }
  }
  return text;
}

function emitOutputTextDelta(state: ResponsesStreamState, delta: string): string[] {
  if (!delta) return [];
  const events = emitItemOpen(state);
  state.text += delta;
  events.push(
    formatResponsesEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: state.itemId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      delta,
    }),
  );
  return events;
}

function functionCallItem(
  call: StreamFunctionCall,
  state: ResponsesStreamState,
  status: string,
): JsonRecord {
  return {
    type: 'function_call',
    id: call.id,
    call_id: call.callId,
    name: call.name,
    ...state.toolNames?.get(call.name),
    arguments: status === 'in_progress' ? '' : call.arguments,
    status,
  };
}

function openFunctionCall(call: StreamFunctionCall, state: ResponsesStreamState): string[] {
  if (call.outputIndex !== undefined) return [];
  call.outputIndex = state.nextOutputIndex++;
  return [
    formatResponsesEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: call.outputIndex,
      item: functionCallItem(call, state, 'in_progress'),
    }),
  ];
}

function toolCallDeltas(toolCalls: unknown, state: ResponsesStreamState): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const events: string[] = [];
  for (const delta of toolCalls) {
    if (!isRecord(delta) || !isRecord(delta.function)) continue;
    const index = typeof delta.index === 'number' ? delta.index : 0;
    let call = state.toolCalls.get(index);
    if (!call) {
      call = { id: `fc_${randomUUID().replace(/-/g, '')}`, callId: '', name: '', arguments: '' };
      state.toolCalls.set(index, call);
    }
    if (typeof delta.id === 'string') call.callId = delta.id;
    if (typeof delta.function.name === 'string') call.name += delta.function.name;
    const args = typeof delta.function.arguments === 'string' ? delta.function.arguments : '';
    call.arguments += args;
    if (call.name === state.structuredOutputToolName) continue;
    // Production forwards the declared names, so complete names can open
    // immediately even before arguments. Undeclared/partial names wait for
    // finalization; an arguments delta does not prove the name is complete.
    if (!call.name || !call.callId) continue;
    if (state.toolNames ? !state.toolNames.has(call.name) : !call.arguments) continue;
    const first = call.outputIndex === undefined;
    events.push(...openFunctionCall(call, state));
    const text = first ? call.arguments : args;
    if (text)
      events.push(
        formatResponsesEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: call.id,
          output_index: call.outputIndex,
          delta: text,
        }),
      );
  }
  return events;
}

function transformResponsesStreamChunk(chunk: string, state: ResponsesStreamState): string | null {
  const events: string[] = [];

  for (const payload of extractDataPayloads(chunk)) {
    if (payload === '[DONE]') continue;
    const data = safeParse(payload);
    if (!data) continue;

    if (typeof data.model === 'string') state.model = data.model;
    if (isRecord(data.usage)) state.usage = data.usage;

    events.push(...emitCreated(state));

    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    const delta = isRecord(choice?.delta) ? choice.delta : {};

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push(...emitOutputTextDelta(state, delta.content));
    }

    events.push(...toolCallDeltas(delta.tool_calls, state));
    const structuredDelta = structuredOutputTextDelta(delta.tool_calls, state);
    if (structuredDelta) {
      events.push(...emitOutputTextDelta(state, structuredDelta));
    }
  }

  return events.length > 0 ? events.join('') : null;
}

function finalizeResponsesStream(state: ResponsesStreamState): string | null {
  if (state.completed) return null;
  state.completed = true;

  const events: string[] = [...emitCreated(state)];

  if (state.itemOpened) {
    events.push(
      formatResponsesEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: state.itemId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        text: state.text,
      }),
      formatResponsesEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: state.itemId,
        output_index: state.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: state.text, annotations: [] },
      }),
      formatResponsesEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.messageOutputIndex,
        item: {
          id: state.itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: state.text, annotations: [] }],
        },
      }),
    );
  }

  const toolOutput: { index: number; item: JsonRecord }[] = [];
  for (const call of state.toolCalls.values()) {
    if (!call.name || call.name === state.structuredOutputToolName) continue;
    if (!call.callId) call.callId = randomUUID();
    events.push(...openFunctionCall(call, state));
    const item = functionCallItem(call, state, 'completed');
    toolOutput.push({ index: call.outputIndex!, item });
    events.push(
      formatResponsesEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: call.id,
        output_index: call.outputIndex,
        arguments: call.arguments,
      }),
      formatResponsesEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: call.outputIndex,
        item,
      }),
    );
  }

  const response = fromChatCompletionResponse(
    {
      model: state.model,
      created: state.createdAt,
      usage: isRecord(state.usage) ? state.usage : undefined,
      choices: [{ message: { content: state.text } }],
    },
    state.model,
    {
      structuredOutputToolName: state.structuredOutputToolName,
      textFormat: state.textFormat,
    },
  );
  response.id = state.responseId;
  // `created_at` is the stream-start stamp (shared across every snapshot for
  // this id), but `completed_at` must reflect when the stream actually
  // finished — fromChatCompletionResponse defaults it to `created`.
  response.completed_at = Math.floor(Date.now() / 1000);
  if (state.itemOpened && Array.isArray(response.output)) {
    const message = response.output.find((item) => isRecord(item) && item.type === 'message');
    if (isRecord(message)) message.id = state.itemId;
  }

  const output = (response.output as JsonRecord[]).map((item) => ({
    index: state.messageOutputIndex,
    item,
  }));
  response.output = [...output, ...toolOutput]
    .sort((a, b) => a.index - b.index)
    .map(({ item }) => item);

  events.push(
    formatResponsesEvent('response.completed', { type: 'response.completed', response }),
    'data: [DONE]\n\n',
  );

  return events.join('');
}

function extractDataPayloads(chunk: string): string[] {
  const lines = chunk.split('\n').map((line) => line.trim());
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length > 0) return dataLines.map((line) => line.slice(5).trim());
  return [chunk.trim()].filter(Boolean);
}

function formatResponsesEvent(event: string, data: JsonRecord): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
