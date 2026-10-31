/**
 * Converts between OpenAI chat completion format and Google Gemini format.
 * Only used when the resolved provider is Google; all other providers
 * accept the OpenAI format directly.
 */

import { randomUUID } from 'crypto';

import { OpenAIMessage, SignatureLookup } from './proxy-types';

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  // Present on model-emitted functionCalls. Must round-trip to the paired
  // functionResponse so Google can correlate parallel tool calls.
  id?: string;
}

interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
  // Mirrors the id on the originating functionCall. Required for parallel
  // tool calling — without it, Google pairs responses by position instead
  // of id, which breaks when call and response order differ.
  id?: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string };
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  // Google attaches thoughtSignature at the Part level (sibling of functionCall),
  // not inside the functionCall object. Gemini 3 rejects tool-use follow-ups
  // that don't round-trip this field.
  thoughtSignature?: string;
}

const DATA_IMAGE_URL_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is;

/**
 * JSON Schema fields not supported by the Gemini API.
 * These must be stripped recursively before sending tool parameters.
 */
const UNSUPPORTED_SCHEMA_FIELDS = new Set([
  'patternProperties',
  'propertyNames',
  'additionalProperties',
  'additionalItems',
  'prefixItems',
  'uniqueItems',
  'multipleOf',
  'contains',
  'minContains',
  'maxContains',
  '$schema',
  '$id',
  '$ref',
  // Some tool emitters strip the `$` prefix to satisfy parsers that reject
  // dollar-prefixed field names (Protobuf is one of them). Treat the
  // dollar-less variant as equivalent so it doesn't leak through to Google.
  'ref',
  '$defs',
  'definitions',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentMediaType',
  'contentEncoding',
  'examples',
  'default',
  'const',
  'title',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'readOnly',
  'writeOnly',
  'deprecated',
  '$comment',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$vocabulary',
]);

function sanitizeSchema(schema: unknown, isPropertiesMap = false): unknown {
  if (schema === null || schema === undefined || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchema(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    // Inside a `properties` map, keys are user-defined property names
    // (e.g. "title", "default"), not JSON Schema keywords — keep them all.
    // Their values are sub-schemas, so recurse normally (not as properties map).
    if (!isPropertiesMap && UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((item): item is string => typeof item === 'string');
      const nonNullTypes = types.filter((item) => item !== 'null');
      if (nonNullTypes.length > 0) {
        // Gemini doesn't accept JSON Schema type arrays. Preserve the common
        // nullable-union case with its OpenAPI-style `nullable` flag; if a
        // schema lists multiple concrete types, keep the first as best-effort.
        result.type = nonNullTypes[0];
      }
      if (types.includes('null')) result.nullable = true;
      continue;
    }
    result[key] = sanitizeSchema(value, key === 'properties');
  }
  return result;
}

function safeParseArgs(args: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(args || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/* ── Request conversion ── */

function mapRole(role: string): string {
  if (role === 'assistant') return 'model';
  if (role === 'system') return 'user'; // Gemini treats system as user
  return 'user';
}

function extractImageUrl(imageUrl: unknown): string | null {
  if (typeof imageUrl === 'string') return imageUrl;
  if (!isRecord(imageUrl) || typeof imageUrl.url !== 'string') return null;
  return imageUrl.url;
}

function imageUrlToGooglePart(imageUrl: unknown): GeminiPart | null {
  const url = extractImageUrl(imageUrl);
  if (!url) return null;

  const dataUrl = DATA_IMAGE_URL_RE.exec(url);
  if (dataUrl) {
    const mimeType = dataUrl[1] || 'image/png';
    if (!mimeType.toLowerCase().startsWith('image/')) return null;
    return { inlineData: { mimeType, data: dataUrl[2] } };
  }

  return { fileData: { fileUri: url } };
}

/**
 * Scan the message list for assistant tool_calls and build a map from
 * tool_call_id to function name. Needed because OpenAI's tool-response
 * messages reference the call by id only — Gemini needs the function name
 * (and the id, for parallel calls) on the functionResponse Part.
 */
function buildToolCallNameMap(messages: OpenAIMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (tc && typeof tc.id === 'string' && tc.function?.name) {
        map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}

function messageToContent(
  msg: OpenAIMessage,
  toolNamesById: Map<string, string>,
  signatureLookup?: SignatureLookup,
): GeminiContent | null {
  const parts: GeminiPart[] = [];

  if (typeof msg.content === 'string') {
    parts.push({ text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (
        typeof block.text === 'string' &&
        (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
      ) {
        parts.push({ text: block.text });
      } else if (block.type === 'image_url' || block.type === 'input_image') {
        const imagePart = imageUrlToGooglePart(block.image_url);
        if (imagePart) parts.push(imagePart);
      }
    }
  }

  // Handle tool calls from assistant
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const functionCall: GeminiFunctionCall = {
        name: tc.function.name,
        args: safeParseArgs(tc.function.arguments),
      };
      // Echo the originating id back so Google can pair this call with its
      // response on the next turn (parallel tool calling).
      const hasId = typeof tc.id === 'string' && tc.id !== '';
      if (hasId) functionCall.id = tc.id;
      const part: GeminiPart = { functionCall };
      // Preserve thought_signature from the client (if it echoed it back), or
      // re-inject it from the cache. On the Google wire, the field lives at
      // the Part level as `thoughtSignature`, not inside functionCall.
      const echoed = (tc as Record<string, unknown>).thought_signature;
      const cached = hasId && signatureLookup ? signatureLookup(tc.id) : null;
      const signature = typeof echoed === 'string' && echoed !== '' ? echoed : cached;
      // Gemini 3.x requires a thoughtSignature on every functionCall part.
      // When the history comes from another model (fallback) or the cache has
      // expired, inject the documented dummy signature so the request isn't
      // rejected with "Function call is missing a thought_signature".
      part.thoughtSignature =
        typeof signature === 'string' && signature !== ''
          ? signature
          : 'context_engineering_is_the_way_to_go';
      parts.push(part);
    }
  }

  // Handle tool response. Chat completions also accepts a tool message's
  // content as an array of text parts; it still has to become a
  // functionResponse, or the preceding functionCall is left unanswered.
  const toolResult =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? parts.map((part) => part.text ?? '').join('')
        : null;
  if (msg.role === 'tool' && toolResult !== null) {
    const toolCallId = (msg.tool_call_id as string) || '';
    // Resolve the real function name from the tool_call history. Falling back
    // to the id (or 'unknown') is wrong semantically but avoids hard failures
    // for clients that drop tool_calls from history; Gemini 2.x tolerates it.
    const functionName = toolNamesById.get(toolCallId) || 'unknown';
    const functionResponse: GeminiFunctionResponse = {
      name: functionName,
      response: { result: toolResult },
    };
    if (toolCallId) functionResponse.id = toolCallId;
    return { role: 'user', parts: [{ functionResponse }] };
  }

  if (parts.length === 0) return null;
  return { role: mapRole(msg.role), parts };
}

function convertTools(tools?: Record<string, unknown>[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const declarations = tools
    .map((t) => {
      const fn = t.function as
        { name: string; description?: string; parameters?: unknown } | undefined;
      if (!fn) return null;
      return {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ? sanitizeSchema(fn.parameters) : undefined,
      };
    })
    .filter(Boolean);

  if (declarations.length === 0) return undefined;
  return [{ functionDeclarations: declarations }];
}

/**
 * chat_completions `tool_choice` → Gemini `toolConfig`. A named function is
 * forced with mode `ANY` limited to that one function.
 */
function toGoogleToolConfig(choice: unknown): Record<string, unknown> | undefined {
  let functionCallingConfig: Record<string, unknown> | undefined;
  if (choice === 'auto') functionCallingConfig = { mode: 'AUTO' };
  else if (choice === 'none') functionCallingConfig = { mode: 'NONE' };
  else if (choice === 'required') functionCallingConfig = { mode: 'ANY' };
  else if (
    isRecord(choice) &&
    choice.type === 'function' &&
    isRecord(choice.function) &&
    typeof choice.function.name === 'string'
  ) {
    functionCallingConfig = { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
  }
  return functionCallingConfig ? { functionCallingConfig } : undefined;
}

function applyResponseFormatToGenerationConfig(
  genConfig: Record<string, unknown>,
  responseFormat: unknown,
): void {
  if (!isRecord(responseFormat)) return;

  if (responseFormat.type === 'json_object') {
    genConfig.responseMimeType = 'application/json';
    delete genConfig.responseSchema;
    return;
  }
  if (responseFormat.type !== 'json_schema') return;

  genConfig.responseMimeType = 'application/json';
  const jsonSchema = isRecord(responseFormat.json_schema) ? responseFormat.json_schema : null;
  if (!jsonSchema || jsonSchema.schema === undefined) {
    delete genConfig.responseSchema;
    return;
  }

  // Gemini rejects several OpenAI-compatible JSON Schema keywords. In
  // particular, dropping `additionalProperties: false` means strict mode is
  // best-effort here, not identical to OpenAI's constrained output.
  genConfig.responseSchema = sanitizeSchema(jsonSchema.schema);
}

/**
 * System prompts may arrive as content-part arrays (OpenAI SDK clients,
 * translated Responses `developer` items), not only as plain strings.
 */
function systemContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { text: string } =>
        isRecord(part) &&
        typeof part.text === 'string' &&
        (part.type === 'text' || part.type === 'input_text'),
    )
    .map((part) => part.text)
    .join('\n');
}

/** Extracted thought_signature entries from a Gemini response. */
export interface ExtractedSignature {
  toolCallId: string;
  signature: string;
}

export function toGoogleRequest(
  body: Record<string, unknown>,
  _model: string,
  signatureLookup?: SignatureLookup,
): Record<string, unknown> {
  const messages = (body.messages as OpenAIMessage[]) || [];
  const contents: GeminiContent[] = [];
  const toolNamesById = buildToolCallNameMap(messages);

  // Extract system instruction
  const isSystem = (m: OpenAIMessage) => m.role === 'system' || m.role === 'developer';
  const systemMsgs = messages.filter(isSystem);
  const systemText = systemMsgs
    .map((m) => systemContentText(m.content))
    .filter(Boolean)
    .join('\n');

  for (const msg of messages) {
    if (isSystem(msg)) continue;
    const content = messageToContent(msg, toolNamesById, signatureLookup);
    if (content) contents.push(content);
  }

  // Merge consecutive user-role turns that contain only functionResponse parts
  // into a single turn. Gemini requires that N functionCall parts in a model
  // turn be answered by exactly N functionResponse parts in one user turn —
  // separate turns trigger "number of function response parts is not equal".
  const merged: GeminiContent[] = [];
  for (const content of contents) {
    const prev = merged[merged.length - 1];
    const allFunctionResponses =
      content.role === 'user' && content.parts.every((p) => p.functionResponse);
    if (
      allFunctionResponses &&
      prev &&
      prev.role === 'user' &&
      prev.parts.every((p) => p.functionResponse)
    ) {
      prev.parts.push(...content.parts);
    } else {
      merged.push(content);
    }
  }

  const result: Record<string, unknown> = { contents: merged };

  if (systemText) {
    result.systemInstruction = {
      parts: [{ text: systemText }],
    };
  }

  const tools = convertTools(body.tools as Record<string, unknown>[] | undefined);
  if (tools) {
    result.tools = tools;
    const toolConfig = toGoogleToolConfig(body.tool_choice);
    if (toolConfig) result.toolConfig = toolConfig;
  }

  const genConfig: Record<string, unknown> = isRecord(body.generationConfig)
    ? cloneRecord(body.generationConfig)
    : {};
  // OpenAI SDKs send the output cap as `max_completion_tokens` (the
  // replacement for the deprecated `max_tokens`); accept either.
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens !== undefined) genConfig.maxOutputTokens = maxTokens;
  if (body.temperature !== undefined) genConfig.temperature = body.temperature;
  if (body.top_p !== undefined) genConfig.topP = body.top_p;
  // chat_completions `stop` accepts a string or string[]; Gemini
  // `stopSequences` is always an array. An explicit empty `stop` ([] or '')
  // means "no stop sequences", so it also clears native ones.
  if (Array.isArray(body.stop) && body.stop.length > 0) {
    genConfig.stopSequences = body.stop;
  } else if (typeof body.stop === 'string' && body.stop) {
    genConfig.stopSequences = [body.stop];
  } else if (Array.isArray(body.stop) || body.stop === '') {
    delete genConfig.stopSequences;
  }
  applyResponseFormatToGenerationConfig(genConfig, body.response_format);
  if (Object.keys(genConfig).length > 0) result.generationConfig = genConfig;

  return result;
}

/* ── Response conversion ── */

export function fromGoogleResponse(
  googleResp: Record<string, unknown>,
  model: string,
): Record<string, unknown> & { _extractedSignatures?: ExtractedSignature[] } {
  const candidates = (googleResp.candidates as Array<Record<string, unknown>>) || [];
  const candidate = candidates[0];

  if (!candidate) {
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
    };
  }

  const content = candidate.content as { parts?: Array<Record<string, unknown>> } | undefined;
  const parts = content?.parts || [];

  let textContent = '';
  const toolCalls: Record<string, unknown>[] = [];
  const extractedSignatures: ExtractedSignature[] = [];

  for (const part of parts) {
    // Thinking summaries come back as text parts with `thought: true`. Skip
    // them — the OpenAI-compat surface doesn't expose them, and including
    // them in `content` would leak chain-of-thought into the assistant reply.
    if (part.text && !part.thought) textContent += part.text;
    if (part.functionCall) {
      const fc = part.functionCall as GeminiFunctionCall;
      // Prefer Google's own id so parallel tool calls can be correlated back
      // to their originating functionCall when building the next turn. Fall
      // back to a synthetic id only for older responses that don't set one.
      const toolCallId = typeof fc.id === 'string' && fc.id ? fc.id : `call_${randomUUID()}`;
      const toolCall: Record<string, unknown> = {
        id: toolCallId,
        type: 'function',
        function: { name: fc.name, arguments: JSON.stringify(fc.args) },
      };
      const sig = part.thoughtSignature;
      if (typeof sig === 'string' && sig) {
        toolCall.thought_signature = sig;
        extractedSignatures.push({ toolCallId, signature: sig });
      }
      toolCalls.push(toolCall);
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: textContent || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = googleResp.usageMetadata as Record<string, number> | undefined;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message, finish_reason: mapFinishReason(candidate, toolCalls.length > 0) },
    ],
    usage: usage ? toChatUsage(usage) : undefined,
    ...(extractedSignatures.length > 0 ? { _extractedSignatures: extractedSignatures } : {}),
  };
}

/**
 * Gemini counts thinking tokens in `thoughtsTokenCount`, apart from
 * `candidatesTokenCount`, and bills them as output. Fold them into
 * `completion_tokens` (and report them as `reasoning_tokens`, like OpenAI) so
 * thinking models are not under-counted and under-priced.
 */
function toChatUsage(usage: Record<string, number>): Record<string, unknown> {
  const reasoningTokens = usage.thoughtsTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  return {
    prompt_tokens: usage.promptTokenCount ?? 0,
    completion_tokens: (usage.candidatesTokenCount ?? 0) + reasoningTokens,
    total_tokens: usage.totalTokenCount ?? 0,
    prompt_tokens_details: { cached_tokens: cachedTokens },
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
    cache_read_tokens: cachedTokens,
    cache_creation_tokens: 0,
  };
}

function mapFinishReason(candidate: Record<string, unknown>, hasToolCalls = false): string {
  const reason = candidate.finishReason as string | undefined;
  if (!reason || reason === 'STOP') {
    return hasToolCalls ? 'tool_calls' : 'stop';
  }
  const map: Record<string, string> = {
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    BLOCKLIST: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    SPII: 'content_filter',
    IMAGE_SAFETY: 'content_filter',
  };
  return map[reason] ?? 'stop';
}

/* ── Stream chunk conversion ── */

/**
 * Result of transforming one Google SSE chunk. `chunk` is the OpenAI-formatted
 * SSE text to forward to the client (null when the input chunk produced no
 * output). `signatures` lists any thoughtSignature values extracted from
 * functionCall parts in this chunk, which the caller should cache so they can
 * be re-injected on the next turn (Gemini 3 requires this).
 */
export interface GoogleStreamChunkResult {
  chunk: string | null;
  signatures: ExtractedSignature[];
}

/**
 * Per-stream state. Gemini sends each functionCall in its own SSE event and
 * repeats usage on every event, so the completion id, tool-call indices, the
 * finish reason, and the usage must span the whole stream, not one event.
 */
export interface GoogleStreamState {
  id: string;
  created: number;
  toolCallCount: number;
  /** Latest cumulative usageMetadata seen, reported on the terminal event. */
  usage?: Record<string, number>;
  /** Set once the finish chunk is sent, so a later usage trailer adds no second one. */
  finished: boolean;
  /** Set once the usage chunk is sent, so the stream reports usage exactly once. */
  usageSent: boolean;
}

export function createGoogleStreamState(): GoogleStreamState {
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    toolCallCount: 0,
    finished: false,
    usageSent: false,
  };
}

/**
 * Transform one Google SSE event. Pass the same `state` for every event of a
 * stream; omitting it treats the event as a stream of its own.
 */
export function transformGoogleStreamChunk(
  chunk: string,
  model: string,
  state: GoogleStreamState = createGoogleStreamState(),
): GoogleStreamChunkResult {
  const empty: GoogleStreamChunkResult = { chunk: null, signatures: [] };
  if (!chunk.trim()) return empty;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(chunk);
  } catch {
    return empty;
  }

  const candidates = (data.candidates as Array<Record<string, unknown>>) || [];
  const candidate = candidates[0];
  const content = candidate?.content as { parts?: Array<Record<string, unknown>> } | undefined;
  const parts = content?.parts || [];
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('');

  const toolCalls: Record<string, unknown>[] = [];
  const signatures: ExtractedSignature[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      const fc = part.functionCall as GeminiFunctionCall;
      const toolCallId = typeof fc.id === 'string' && fc.id ? fc.id : `call_${randomUUID()}`;
      const toolCall: Record<string, unknown> = {
        index: state.toolCallCount++,
        id: toolCallId,
        type: 'function',
        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
      };
      const sig = part.thoughtSignature;
      if (typeof sig === 'string' && sig) {
        toolCall.thought_signature = sig;
        signatures.push({ toolCallId, signature: sig });
      }
      toolCalls.push(toolCall);
    }
  }

  let result = '';

  if (text || toolCalls.length > 0) {
    const delta: Record<string, unknown> = {};
    if (text) delta.content = text;
    if (toolCalls.length > 0) delta.tool_calls = toolCalls;
    result += `data: ${JSON.stringify({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;
  }

  // Gemini repeats cumulative usageMetadata on every event, so only the
  // terminal event (a finishReason, or a usage-only trailer with no
  // candidate) closes the stream; its usage is the total.
  const usage = data.usageMetadata as Record<string, number> | undefined;
  if (usage) state.usage = usage;
  const isTerminal = Boolean(candidate?.finishReason) || (Boolean(usage) && !candidate);
  if (isTerminal) {
    if (!state.finished) {
      state.finished = true;
      const finishReason = mapFinishReason(candidate ?? {}, state.toolCallCount > 0);
      result += `data: ${JSON.stringify({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`;
    }
    // A trailer after the finish event can still supply usage the finish
    // event lacked, but never a second usage chunk.
    if (state.usage && !state.usageSent) {
      state.usageSent = true;
      result += usageChunk(state, state.usage, model);
    }
  }

  return { chunk: result || null, signatures };
}

function usageChunk(
  state: GoogleStreamState,
  usage: Record<string, number>,
  model: string,
): string {
  return `data: ${JSON.stringify({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model,
    choices: [],
    usage: toChatUsage(usage),
  })}\n\n`;
}

/**
 * End-of-stream hook. Gemini has no terminal event of its own, so an upstream
 * that ends before any finishReason never reported usage; return the last
 * cumulative usage seen so the request still records it. Usage only: no
 * finish chunk is invented for a stream the provider did not finish.
 */
export function finishGoogleStream(state: GoogleStreamState, model: string): string | null {
  if (state.usageSent || !state.usage) return null;
  state.usageSent = true;
  return usageChunk(state, state.usage, model);
}
