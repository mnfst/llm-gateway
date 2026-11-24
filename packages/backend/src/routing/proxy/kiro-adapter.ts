import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';

export const KIRO_BASE_URL = 'https://q.us-east-1.amazonaws.com';
export const KIRO_MODELS_TARGET = 'AmazonCodeWhispererService.ListAvailableModels';
export const KIRO_CHAT_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';

const logger = new Logger('KiroAdapter');

const KIRO_ORIGIN = 'KIRO_CLI';
const KIRO_AGENT_MODE = 'SUPERVISED';
const DEFAULT_KIRO_CONTEXT_WINDOW = 200000;
const AUTO_KIRO_CONTEXT_WINDOW = 1000000;
/**
 * Rough fallback when a Kiro stream reports context usage but no per-token
 * breakdown: Claude/GPT tokenizers average around four characters per token.
 */
const KIRO_ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Kiro event types that carry no usage or content. `meteringEvent` reports
 * spend in credits, not tokens, so it cannot fill the token columns; the rest
 * are stream lifecycle/footnote events. Anything outside this set (and outside
 * the handled event types) is logged so wire-format changes surface early.
 */
const IGNORED_KIRO_EVENT_TYPES = new Set([
  'initial-response',
  'meteringevent',
  'messagestopevent',
  'metricsevent',
  'codereferenceevent',
  'supplementaryweblinksevent',
]);

/**
 * Kiro's tool schema bounds. Names must match `[A-Za-z0-9_-]+`, tool-use ids are
 * limited to the same character set, and descriptions are capped to keep the
 * upstream request under CodeWhisperer's size limit.
 */
const KIRO_TOOL_NAME_MAX_LENGTH = 64;
const KIRO_TOOL_DESCRIPTION_MAX_LENGTH = 10237;
const KIRO_TOOL_ID_MAX_LENGTH = 64;
const KIRO_TOOL_NAME_ILLEGAL = /[^a-zA-Z0-9_-]/g;
const KIRO_TOOL_NAME_ALLOWED = /^[a-zA-Z0-9_-]$/;
const KIRO_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function buildKiroHeaders(apiKey: string, target: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/x-amz-json-1.0',
    'x-amz-target': target,
  };
}

export function toKiroModelId(model: string): string {
  return model.replace(/^kiro\//i, '');
}

function formatKiroModelId(modelId: string): string {
  return modelId.toLowerCase().startsWith('kiro/') ? modelId : `kiro/${modelId}`;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readKiroContextWindow(entry: Record<string, unknown>, modelId: string): number {
  const tokenLimits = (entry.tokenLimits ?? entry.token_limits) as
    Record<string, unknown> | undefined;
  return (
    readNumber(entry.contextWindowTokens) ??
    readNumber(entry.context_window_tokens) ??
    readNumber(tokenLimits?.contextWindowTokens) ??
    readNumber(tokenLimits?.context_window_tokens) ??
    readNumber(tokenLimits?.maxInputTokens) ??
    readNumber(tokenLimits?.max_input_tokens) ??
    (modelId === 'auto' ? AUTO_KIRO_CONTEXT_WINDOW : DEFAULT_KIRO_CONTEXT_WINDOW)
  );
}

export function parseKiroModels(body: unknown, provider = 'kiro'): DiscoveredModel[] {
  const models = (body as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) return [];

  return models
    .map((raw) => raw as Record<string, unknown>)
    .filter((entry) => typeof (entry.modelId ?? entry.model_id) === 'string')
    .map((entry) => {
      const rawId = String(entry.modelId ?? entry.model_id);
      const id = formatKiroModelId(rawId);
      const displayName = String(entry.modelName ?? entry.model_name ?? rawId);
      return {
        id,
        displayName,
        provider,
        contextWindow: readKiroContextWindow(entry, rawId),
        inputPricePerToken: 0,
        outputPricePerToken: 0,
        capabilityReasoning: false,
        capabilityCode: true,
        capabilities: ['tools'] as const,
        qualityScore: 3,
      };
    });
}

type OpenAiToolCall = {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type OpenAiMessage = {
  role?: string;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
};

type KiroToolSpec = {
  toolSpecification: {
    name: string;
    description?: string;
    inputSchema: { json: Record<string, unknown> };
  };
};

type KiroToolUse = {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
};

type KiroToolResult = {
  toolUseId: string;
  status: 'success' | 'error';
  content: Array<{ text: string }>;
};

type KiroUserContext = {
  tools?: KiroToolSpec[];
  toolResults?: KiroToolResult[];
};

type KiroUserMessage = {
  userInputMessage: {
    content: string;
    origin: string;
    modelId?: string;
    userInputMessageContext?: KiroUserContext;
  };
};

type KiroAssistantMessage = {
  assistantResponseMessage: {
    content: string;
    toolUses?: KiroToolUse[];
  };
};

type KiroMessage = KiroUserMessage | KiroAssistantMessage;

export interface KiroConversation {
  body: Record<string, unknown>;
  /** Kiro-side sanitized tool name → the caller's original tool name. */
  toolNameMap: Map<string, string>;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') return record.text;
        if (record.type === 'image_url' || record.type === 'input_image') return '[image omitted]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function appendText(current: string, extra: string): string {
  if (!extra) return current;
  return current ? `${current}\n\n${extra}` : extra;
}

function trimToLength(value: string, max: number): string {
  return [...value].slice(0, max).join('');
}

function isUserMessage(message: KiroMessage): message is KiroUserMessage {
  return 'userInputMessage' in message;
}

function isAssistantMessage(message: KiroMessage): message is KiroAssistantMessage {
  return 'assistantResponseMessage' in message;
}

function toUserMessage(
  content: string,
  options: { modelId?: string; toolResults?: KiroToolResult[] } = {},
): KiroUserMessage {
  const context: KiroUserContext | undefined = options.toolResults?.length
    ? { toolResults: options.toolResults }
    : undefined;
  return {
    userInputMessage: {
      content,
      origin: KIRO_ORIGIN,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(context ? { userInputMessageContext: context } : {}),
    },
  };
}

function toAssistantMessage(content: string, toolUses?: KiroToolUse[]): KiroAssistantMessage {
  return {
    assistantResponseMessage: {
      content,
      ...(toolUses && toolUses.length > 0 ? { toolUses } : {}),
    },
  };
}

/**
 * Recursively drop schema keywords Kiro rejects. `additionalProperties` and an
 * empty `required` array are valid JSON Schema but make CodeWhisperer answer the
 * whole request with REQUEST_BODY_INVALID.
 */
function cleanSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchemaValue);
  if (!value || typeof value !== 'object') return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'additionalProperties') continue;
    if (key === 'required' && Array.isArray(child) && child.length === 0) continue;
    cleaned[key] = cleanSchemaValue(child);
  }
  return cleaned;
}

function normalizeToolSchema(schema: unknown): Record<string, unknown> {
  const cleaned =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (cleanSchemaValue(schema) as Record<string, unknown>)
      : {};
  cleaned.type = 'object';
  if (
    !cleaned.properties ||
    typeof cleaned.properties !== 'object' ||
    Array.isArray(cleaned.properties)
  ) {
    cleaned.properties = {};
  }
  if (Array.isArray(cleaned.required)) {
    const properties = new Set(Object.keys(cleaned.properties as Record<string, unknown>));
    const required = [
      ...new Set(
        cleaned.required.filter((name) => typeof name === 'string' && properties.has(name)),
      ),
    ];
    if (required.length === 0) delete cleaned.required;
    else cleaned.required = required;
  }
  return cleaned;
}

/**
 * Normalize a caller tool name to Kiro's `[A-Za-z0-9_-]+` alphabet in one
 * linear pass. The obvious regex chain (`_+` with anchored alternatives) is a
 * polynomial-time match on adversarial input, which CodeQL flags.
 */
function sanitizeToolName(rawName: string): string {
  const chars: string[] = [];
  let previousUnderscore = false;
  for (const char of rawName.trim()) {
    const sanitized = KIRO_TOOL_NAME_ALLOWED.test(char) ? char : '_';
    if (sanitized === '_') {
      if (previousUnderscore) continue;
      previousUnderscore = true;
    } else {
      previousUnderscore = false;
    }
    chars.push(sanitized);
  }

  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === '_') start += 1;
  while (end > start && chars[end - 1] === '_') end -= 1;
  return chars.slice(start, end).join('');
}

function uniqueToolName(rawName: string, used: Set<string>): string {
  const base = trimToLength(sanitizeToolName(rawName) || 'tool', KIRO_TOOL_NAME_MAX_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix}`;
    suffix += 1;
    candidate = `${base.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

function buildKiroToolSpecs(tools: unknown): {
  specs: KiroToolSpec[];
  toKiroName: Map<string, string>;
  toolNameMap: Map<string, string>;
} {
  const specs: KiroToolSpec[] = [];
  const toKiroName = new Map<string, string>();
  const toolNameMap = new Map<string, string>();
  const used = new Set<string>();
  if (!Array.isArray(tools)) return { specs, toKiroName, toolNameMap };

  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    const fn = (tool.function ?? {}) as Record<string, unknown>;
    const rawName = fn.name ?? tool.name;
    if (typeof rawName !== 'string' || !rawName.trim()) continue;
    if (toKiroName.has(rawName)) continue;

    const name = uniqueToolName(rawName, used);
    toKiroName.set(rawName, name);
    if (name !== rawName) toolNameMap.set(name, rawName);

    const rawDescription = fn.description ?? tool.description;
    const description = trimToLength(
      typeof rawDescription === 'string' && rawDescription.trim()
        ? rawDescription
        : `Tool: ${rawName}`,
      KIRO_TOOL_DESCRIPTION_MAX_LENGTH,
    );
    const schema = fn.parameters ?? tool.parameters ?? tool.input_schema;
    specs.push({
      toolSpecification: { name, description, inputSchema: { json: normalizeToolSchema(schema) } },
    });
  }

  return { specs, toKiroName, toolNameMap };
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed argument JSON carries no usable input.
    }
  }
  return {};
}

function toolUsesFromAssistant(
  message: OpenAiMessage,
  toKiroName: Map<string, string>,
): KiroToolUse[] {
  if (!Array.isArray(message.tool_calls)) return [];

  const uses: KiroToolUse[] = [];
  message.tool_calls.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const call = raw as OpenAiToolCall;
    const name = call.function?.name;
    if (typeof name !== 'string' || !name) return;
    uses.push({
      toolUseId: typeof call.id === 'string' && call.id ? call.id : `call_${index + 1}`,
      name: toKiroName.get(name) ?? name,
      input: parseToolInput(call.function?.arguments),
    });
  });
  return uses;
}

function toolResultFromMessage(message: OpenAiMessage): KiroToolResult {
  return {
    toolUseId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
    status: 'success',
    content: [{ text: stringifyContent(message.content) }],
  };
}

/**
 * Convert OpenAI chat messages into Kiro's strictly alternating user/assistant
 * turns. Consecutive same-role messages merge because Kiro rejects two turns in
 * a row; assistant `tool_calls` become `toolUses`, and `tool` role messages
 * become `toolResults` on the following (merged) user turn.
 */
function buildKiroTurns(messages: OpenAiMessage[], toKiroName: Map<string, string>): KiroMessage[] {
  const turns: KiroMessage[] = [];
  let user: KiroUserMessage | null = null;
  let assistant: KiroAssistantMessage | null = null;

  const flushUser = (): void => {
    if (user) {
      turns.push(user);
      user = null;
    }
  };
  const flushAssistant = (): void => {
    if (assistant) {
      turns.push(assistant);
      assistant = null;
    }
  };

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;

    if (message.role === 'assistant') {
      flushUser();
      const content = stringifyContent(message.content);
      const toolUses = toolUsesFromAssistant(message, toKiroName);
      if (!content && toolUses.length === 0) continue;

      if (assistant) {
        assistant.assistantResponseMessage.content = appendText(
          assistant.assistantResponseMessage.content,
          content,
        );
        if (toolUses.length > 0) {
          assistant.assistantResponseMessage.toolUses = [
            ...(assistant.assistantResponseMessage.toolUses ?? []),
            ...toolUses,
          ];
        }
      } else {
        assistant = toAssistantMessage(content || '...', toolUses);
      }
      continue;
    }

    flushAssistant();
    const result = message.role === 'tool' ? toolResultFromMessage(message) : null;
    const content = result ? '' : stringifyContent(message.content);
    if (user) {
      user.userInputMessage.content = appendText(user.userInputMessage.content, content);
      if (result) {
        const context = (user.userInputMessage.userInputMessageContext ??= {});
        context.toolResults = [...(context.toolResults ?? []), result];
      }
    } else {
      user = toUserMessage(content, { toolResults: result ? [result] : undefined });
    }
  }

  flushAssistant();
  flushUser();
  return turns;
}

function flattenToolUse(toolUse: KiroToolUse): string {
  return `[Tool call: ${toolUse.name}(${JSON.stringify(toolUse.input)})]`;
}

function flattenToolResult(result: KiroToolResult): string {
  const text = result.content.map((part) => part.text).join('\n');
  return `[Tool result${result.status === 'error' ? ' (error)' : ''}: ${text}]`;
}

function deleteEmptyContext(message: KiroUserMessage): void {
  const context = message.userInputMessage.userInputMessageContext;
  if (!context) return;
  if (!context.toolResults?.length) delete context.toolResults;
  if (!context.tools?.length) delete context.tools;
  if (Object.keys(context).length === 0) delete message.userInputMessage.userInputMessageContext;
}

function reserveToolUseId(rawId: string, fallback: string, used: Set<string>): string {
  const sanitized = rawId.replace(KIRO_TOOL_NAME_ILLEGAL, '');
  const base = trimToLength(
    KIRO_TOOL_ID_PATTERN.test(sanitized) && sanitized ? sanitized : fallback,
    KIRO_TOOL_ID_MAX_LENGTH,
  );
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix}`;
    suffix += 1;
    candidate = `${base.slice(0, KIRO_TOOL_ID_MAX_LENGTH - tail.length)}${tail}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Kiro requires each assistant `toolUses` entry to have a matching `toolResults`
 * entry in the very next user turn, and every called tool to be declared in the
 * request's tool specs. When a caller has a broken history (missing result, an
 * orphan result, or a call to an undeclared tool), inline it as text rather than
 * sending a body Kiro answers with REQUEST_BODY_INVALID.
 */
function reconcileToolPairs(turns: KiroMessage[], specNames: Set<string>): void {
  const usedIds = new Set<string>();

  for (let index = 0; index < turns.length - 1; index += 1) {
    const assistant = turns[index];
    const user = turns[index + 1];
    if (!isAssistantMessage(assistant) || !isUserMessage(user)) continue;

    const calls = assistant.assistantResponseMessage.toolUses ?? [];
    const context = user.userInputMessage.userInputMessageContext;
    const results = context?.toolResults ?? [];

    if (calls.length === 0) {
      if (results.length > 0) {
        user.userInputMessage.content = appendText(
          user.userInputMessage.content,
          results.map(flattenToolResult).join('\n\n'),
        );
        if (context) delete context.toolResults;
        deleteEmptyContext(user);
      }
      continue;
    }

    const resultQueues = new Map<string, KiroToolResult[]>();
    for (const result of results) {
      const queue = resultQueues.get(result.toolUseId) ?? [];
      queue.push(result);
      resultQueues.set(result.toolUseId, queue);
    }

    const keptCalls: KiroToolUse[] = [];
    const keptResults: KiroToolResult[] = [];
    const flattened: string[] = [];

    for (const call of calls) {
      const result = resultQueues.get(call.toolUseId)?.shift();
      if (result && specNames.has(call.name)) {
        const toolUseId = reserveToolUseId(
          call.toolUseId,
          `call_${index}_${keptCalls.length}`,
          usedIds,
        );
        keptCalls.push({ ...call, toolUseId });
        keptResults.push({ ...result, toolUseId });
      } else {
        flattened.push(flattenToolUse(call));
        if (result) flattened.push(flattenToolResult(result));
      }
    }

    for (const queue of resultQueues.values()) {
      for (const result of queue) flattened.push(flattenToolResult(result));
    }

    if (flattened.length > 0) {
      user.userInputMessage.content = appendText(
        user.userInputMessage.content,
        flattened.join('\n\n'),
      );
    }
    if (keptCalls.length > 0) assistant.assistantResponseMessage.toolUses = keptCalls;
    else delete assistant.assistantResponseMessage.toolUses;
    if (context && keptResults.length > 0) context.toolResults = keptResults;
    else if (context) delete context.toolResults;
    deleteEmptyContext(user);
  }
}

function finalizeKiroConversation(
  turns: KiroMessage[],
  specs: KiroToolSpec[],
  model: string,
): { history: KiroMessage[]; currentMessage: KiroUserMessage } {
  const working = [...turns];
  if (working.length === 0) {
    working.push(toUserMessage('continue', { modelId: model }));
  }
  if (isAssistantMessage(working[0])) {
    working.unshift(toUserMessage('continue'));
  }
  if (isAssistantMessage(working[working.length - 1])) {
    working.push(toUserMessage('continue'));
  }

  reconcileToolPairs(working, new Set(specs.map((spec) => spec.toolSpecification.name)));

  let currentIndex = working.length - 1;
  while (currentIndex >= 0 && !isUserMessage(working[currentIndex])) currentIndex -= 1;
  const currentMessage = working[currentIndex] as KiroUserMessage;
  return { history: working.slice(0, currentIndex), currentMessage };
}

function buildKiroConversation(body: Record<string, unknown>, model: string): KiroConversation {
  const messages = Array.isArray(body.messages) ? (body.messages as OpenAiMessage[]) : [];
  const systemText = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => stringifyContent(message.content))
    .filter(Boolean)
    .join('\n\n');

  const { specs, toKiroName, toolNameMap } = buildKiroToolSpecs(body.tools);
  const { history, currentMessage } = finalizeKiroConversation(
    buildKiroTurns(messages, toKiroName),
    specs,
    model,
  );

  if (specs.length > 0) {
    const context = (currentMessage.userInputMessage.userInputMessageContext ??= {});
    context.tools = specs;
  }

  const currentText = currentMessage.userInputMessage.content;
  const toolResults = currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? [];
  const hasToolResults = toolResults.length > 0;
  if (hasToolResults && !currentText) {
    // The latest turn is a tool result with no new user text: Kiro continues the
    // pending task only when `content` is empty. A fabricated "continue" (or the
    // system prompt) reads as a fresh, context-free user message and makes the
    // model drop the conversation. The system prompt has no dedicated Kiro field
    // and lands on the current turn everywhere else, so move it onto the
    // conversation's first user turn to keep delivering it.
    currentMessage.userInputMessage.content = '';
    const firstUser = history.find(isUserMessage);
    if (firstUser) {
      if (systemText) {
        firstUser.userInputMessage.content = `System instructions:\n${systemText}\n\nUser:\n${firstUser.userInputMessage.content}`;
      }
    } else {
      // No earlier user turn: this tool result is the conversation's first turn
      // and has no assistant tool-use to pair with, so Kiro rejects it as an
      // orphan. Inline the result; the system prompt belongs on this first turn.
      const context = currentMessage.userInputMessage.userInputMessageContext!;
      const inlined = toolResults.map(flattenToolResult).join('\n\n');
      currentMessage.userInputMessage.content = systemText
        ? `System instructions:\n${systemText}\n\nUser:\n${inlined}`
        : inlined;
      delete context.toolResults;
      deleteEmptyContext(currentMessage);
    }
  } else {
    currentMessage.userInputMessage.content = systemText
      ? `System instructions:\n${systemText}\n\nUser:\n${currentText || 'Hello'}`
      : currentText || 'Hello';
  }
  currentMessage.userInputMessage.modelId ??= model;

  return {
    body: {
      conversationState: {
        conversationId: randomUUID(),
        history,
        currentMessage,
        chatTriggerType: 'MANUAL',
      },
      agentMode: KIRO_AGENT_MODE,
    },
    toolNameMap,
  };
}

export function buildKiroChatRequest(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return buildKiroConversation(body, model).body;
}

export interface KiroEvent {
  eventType?: string;
  messageType?: string;
  payload: unknown;
}

function parseEventHeaders(buffer: Buffer): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  let offset = 0;

  while (offset < buffer.length) {
    const nameLength = buffer.readUInt8(offset);
    offset += 1;
    const name = buffer.toString('utf8', offset, offset + nameLength);
    offset += nameLength;
    const type = buffer.readUInt8(offset);
    offset += 1;

    if (type === 0 || type === 1) {
      headers[name] = type === 0;
    } else if (type === 2) {
      headers[name] = buffer.readInt8(offset);
      offset += 1;
    } else if (type === 3) {
      headers[name] = buffer.readInt16BE(offset);
      offset += 2;
    } else if (type === 4) {
      headers[name] = buffer.readInt32BE(offset);
      offset += 4;
    } else if (type === 5) {
      headers[name] = buffer.readBigInt64BE(offset);
      offset += 8;
    } else if (type === 6) {
      const valueLength = buffer.readUInt16BE(offset);
      offset += 2;
      headers[name] = Buffer.from(buffer.subarray(offset, offset + valueLength));
      offset += valueLength;
    } else if (type === 7) {
      const valueLength = buffer.readUInt16BE(offset);
      offset += 2;
      headers[name] = buffer.toString('utf8', offset, offset + valueLength);
      offset += valueLength;
    } else if (type === 8) {
      headers[name] = new Date(Number(buffer.readBigInt64BE(offset)));
      offset += 8;
    } else if (type === 9) {
      const value = buffer.subarray(offset, offset + 16).toString('hex');
      headers[name] = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
        12,
        16,
      )}-${value.slice(16, 20)}-${value.slice(20)}`;
      offset += 16;
    } else {
      // Future header value types have type-specific lengths. Keep the payload
      // usable instead of guessing how many bytes to skip and corrupting the
      // remaining header parse.
      break;
    }
  }

  return headers;
}

export class KiroEventStreamParser {
  private pending = Buffer.alloc(0);

  push(chunk: Uint8Array): KiroEvent[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const events: KiroEvent[] = [];

    while (this.pending.length >= 12) {
      const totalLength = this.pending.readUInt32BE(0);
      const headersLength = this.pending.readUInt32BE(4);
      if (totalLength < 16 || headersLength > totalLength - 16) {
        throw new Error('Invalid Kiro event stream frame');
      }
      if (this.pending.length < totalLength) break;

      const frame = this.pending.subarray(0, totalLength);
      this.pending = this.pending.subarray(totalLength);
      const headersStart = 12;
      const payloadStart = headersStart + headersLength;
      const payloadEnd = totalLength - 4;
      const headers = parseEventHeaders(frame.subarray(headersStart, payloadStart));
      const payloadBytes = frame.subarray(payloadStart, payloadEnd);
      const payloadText = payloadBytes.toString('utf8');
      const payload = payloadText ? JSON.parse(payloadText) : null;

      events.push({
        eventType: typeof headers[':event-type'] === 'string' ? headers[':event-type'] : undefined,
        messageType:
          typeof headers[':message-type'] === 'string' ? headers[':message-type'] : undefined,
        payload,
      });
    }

    return events;
  }

  finish(): void {
    if (this.pending.length > 0) throw new Error('Truncated Kiro event stream');
  }
}

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  prompt_tokens_details?: { cached_tokens: number; cache_write_tokens: number };
  /** True when token counts were derived locally because Kiro reported none. */
  estimated?: boolean;
}

interface KiroToolCallState {
  id: string;
  name: string;
  input: string;
}

interface KiroCollectState {
  content: string;
  reasoning: string;
  usage?: OpenAiUsage;
  toolCalls: Map<string, KiroToolCallState>;
  toolOrder: string[];
}

function createKiroCollectState(): KiroCollectState {
  return { content: '', reasoning: '', toolCalls: new Map(), toolOrder: [] };
}

function eventPayload(event: KiroEvent): Record<string, unknown> {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  if (event.eventType && record[event.eventType] && typeof record[event.eventType] === 'object') {
    return record[event.eventType] as Record<string, unknown>;
  }
  return record;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== undefined) return value;
  }
  return 0;
}

function normalizeUsage(value: unknown): OpenAiUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const uncachedInput = numberField(usage, 'uncachedInputTokens', 'uncached_input_tokens');
  const cacheRead = numberField(
    usage,
    'cacheReadInputTokens',
    'cache_read_input_tokens',
    'cached_tokens',
  );
  const cacheWrite = numberField(
    usage,
    'cacheWriteInputTokens',
    'cache_write_input_tokens',
    'cache_creation_input_tokens',
  );
  const prompt =
    numberField(usage, 'prompt_tokens', 'inputTokens', 'input_tokens') ||
    uncachedInput + cacheRead + cacheWrite;
  const completion = numberField(usage, 'completion_tokens', 'outputTokens', 'output_tokens');
  const total = numberField(usage, 'total_tokens', 'totalTokens') || prompt + completion;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    // Kiro reports cache reads/writes separately from the prompt total. Keep the
    // breakdown so `cache_read_tokens` / `cache_creation_tokens` populate the
    // request log instead of being discarded with the raw event.
    ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_creation_tokens: cacheWrite } : {}),
    ...(cacheRead > 0 || cacheWrite > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
          },
        }
      : {}),
  };
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / KIRO_ESTIMATED_CHARS_PER_TOKEN);
}

/** Text the model emitted this turn: visible content, reasoning, and tool input. */
function kiroCompletionText(state: KiroCollectState): string {
  const parts = [state.content, state.reasoning];
  for (const id of state.toolOrder) {
    // toolOrder only ever holds ids registered in toolCalls alongside a tool.
    const tool = state.toolCalls.get(id) as KiroToolCallState;
    parts.push(tool.name, tool.input);
  }
  return parts.filter(Boolean).join('\n');
}

/** Envelope fields that are not prompt content and would inflate the estimate. */
const KIRO_NON_PROMPT_KEYS = new Set([
  'conversationid',
  'modelid',
  'chattriggertype',
  'agentmode',
  'origin',
  'status',
  'tooluseid',
]);

/** Every prompt-bearing string in the built Kiro conversation, i.e. text + tools. */
function collectKiroStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKiroStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!KIRO_NON_PROMPT_KEYS.has(key.toLowerCase())) collectKiroStrings(item, out);
    }
  }
}

/**
 * Kiro does not return prompt tokens, so estimate them from the request the
 * adapter actually sends (system prompt, history, tool specs, tool results).
 */
export function estimateKiroPromptTokens(conversation: Record<string, unknown>): number {
  const parts: string[] = [];
  collectKiroStrings(conversation, parts);
  return estimateTokensFromText(parts.join('\n'));
}

/**
 * Kiro's GenerateAssistantResponse does not report per-token counts on the
 * wire captures we have (only `assistantResponseEvent` and `meteringEvent`,
 * which is credits, not tokens). When Kiro does send an explicit `tokenUsage`
 * block it wins; otherwise estimate prompt tokens from the outgoing
 * conversation and completion tokens from the emitted text, and mark the
 * result as estimated.
 */
function resolveKiroUsage(state: KiroCollectState, promptTokens: number): OpenAiUsage | undefined {
  if (state.usage) return state.usage;
  const completionText = estimateTokensFromText(kiroCompletionText(state));
  if (promptTokens <= 0 && completionText <= 0) return undefined;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionText,
    total_tokens: promptTokens + completionText,
    estimated: true,
  };
}

function extractErrorMessage(event: KiroEvent): string | null {
  const payload = eventPayload(event);
  const message = payload.message ?? payload.errorMessage ?? payload.error;
  return typeof message === 'string' ? message : null;
}

/**
 * Kiro streams tool calls as `toolUseEvent` frames whose `input` is a JSON
 * fragment; fragments accumulate per `toolUseId` until the frame sets `stop`.
 */
function collectKiroToolUse(state: KiroCollectState, payload: Record<string, unknown>): void {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return;

  const rawId = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
  const id = rawId || `call_${state.toolOrder.length + 1}`;
  let tool = state.toolCalls.get(id);
  if (!tool) {
    tool = { id, name, input: '' };
    state.toolCalls.set(id, tool);
    state.toolOrder.push(id);
  }

  const input = payload.input;
  if (typeof input === 'string') {
    tool.input += input;
  } else if (input && typeof input === 'object') {
    tool.input = JSON.stringify(input);
  }
}

function applyKiroEvent(state: KiroCollectState, event: KiroEvent): Record<string, unknown> | null {
  const eventType = event.eventType?.toLowerCase() ?? '';
  const payload = eventPayload(event);

  if (event.messageType === 'exception') {
    throw new Error(extractErrorMessage(event) ?? 'Kiro returned an exception event');
  }
  if (eventType.includes('assistantresponse')) {
    const content = typeof payload.content === 'string' ? payload.content : '';
    state.content += content;
    return content ? { content } : null;
  }
  if (eventType.includes('reasoningcontent')) {
    const text = typeof payload.text === 'string' ? payload.text : '';
    state.reasoning += text;
    return text ? { reasoning_content: text } : null;
  }
  if (eventType.includes('tooluse')) {
    const values = Array.isArray(payload) ? payload : [payload];
    for (const value of values) {
      if (value && typeof value === 'object') {
        collectKiroToolUse(state, value as Record<string, unknown>);
      }
    }
    return null;
  }
  // `metadataEvent` carries a `tokenUsage` block on some Kiro responses; use it
  // when present. It also sometimes carries `contextUsagePercentage`, but that
  // is a fraction of an unknown context window, so it cannot yield absolute
  // token counts — the text estimate in `resolveKiroUsage` is preferred.
  if (eventType.includes('metadata') || eventType.includes('contextusage')) {
    const tokenUsage = payload.tokenUsage ?? payload.token_usage;
    if (tokenUsage) state.usage = normalizeUsage(tokenUsage);
    return null;
  }
  if (event.eventType && !IGNORED_KIRO_EVENT_TYPES.has(eventType)) {
    logger.debug(`Unhandled Kiro event type: ${event.eventType}`);
  }
  return null;
}

interface KiroToolCall {
  id: string;
  name: string;
  arguments: string;
}

function kiroToolCalls(state: KiroCollectState, toolNameMap?: Map<string, string>): KiroToolCall[] {
  return state.toolOrder.map((id) => {
    const tool = state.toolCalls.get(id) as KiroToolCallState;
    return {
      id: tool.id,
      name: toolNameMap?.get(tool.name) ?? tool.name,
      arguments: tool.input.trim() || '{}',
    };
  });
}

function openAiChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: OpenAiUsage,
): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

export function createKiroOpenAiStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  toolNameMap?: Map<string, string>,
  promptTokens = 0,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parser = new KiroEventStreamParser();
  const state = createKiroCollectState();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(value)) {
            const delta = applyKiroEvent(state, event);
            if (delta) controller.enqueue(encoder.encode(openAiChunk(model, delta)));
          }
        }
        parser.finish();

        const toolCalls = kiroToolCalls(state, toolNameMap);
        toolCalls.forEach((tool, index) => {
          controller.enqueue(
            encoder.encode(
              openAiChunk(model, {
                tool_calls: [
                  {
                    index,
                    id: tool.id,
                    type: 'function',
                    function: { name: tool.name, arguments: tool.arguments },
                  },
                ],
              }),
            ),
          );
        });

        const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
        controller.enqueue(
          encoder.encode(
            openAiChunk(model, {}, finishReason, resolveKiroUsage(state, promptTokens)),
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

async function collectKiroCompletion(
  source: ReadableStream<Uint8Array>,
  model: string,
  promptTokens: number,
  toolNameMap?: Map<string, string>,
): Promise<Record<string, unknown>> {
  const parser = new KiroEventStreamParser();
  const state = createKiroCollectState();
  const reader = source.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(value)) {
      applyKiroEvent(state, event);
    }
  }
  parser.finish();

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: state.content,
  };
  if (state.reasoning) message.reasoning_content = state.reasoning;

  const toolCalls = kiroToolCalls(state, toolNameMap);
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tool) => ({
      id: tool.id,
      type: 'function',
      function: { name: tool.name, arguments: tool.arguments },
    }));
  }

  const usage = resolveKiroUsage(state, promptTokens);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  };
}

export async function forwardKiroChat(opts: {
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  stream: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  const headers = {
    ...buildKiroHeaders(opts.apiKey, KIRO_CHAT_TARGET),
    'x-amzn-kiro-agent-mode': KIRO_AGENT_MODE,
    ...opts.extraHeaders,
  };
  const { body, toolNameMap } = buildKiroConversation(opts.body, opts.model);
  // Kiro reports no token counts, so seed the estimated usage with the prompt
  // size of the conversation we are about to send.
  const promptTokens = estimateKiroPromptTokens(body);
  const upstream = await fetch(KIRO_BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: fetchSignal,
    redirect: 'error',
  });

  if (!upstream.ok || !upstream.body) return upstream;
  if (opts.stream) {
    return new Response(
      createKiroOpenAiStream(upstream.body, opts.model, toolNameMap, promptTokens),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  }

  const completion = await collectKiroCompletion(
    upstream.body,
    opts.model,
    promptTokens,
    toolNameMap,
  );
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
