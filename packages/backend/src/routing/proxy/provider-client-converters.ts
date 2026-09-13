import {
  toGoogleRequest,
  fromGoogleResponse,
  transformGoogleStreamChunk,
  type GoogleStreamChunkResult,
} from './google-adapter';
import {
  applyAnthropicAutomaticCacheControl,
  applyAnthropicMessagesMutations,
  extractThinkingBlocksFromMessagesResponse,
  toAnthropicRequest,
  fromAnthropicResponse,
  transformAnthropicStreamChunk,
  createAnthropicStreamTransformer,
  type ThinkingBlocksCallback,
} from './anthropic-adapter';
import {
  toResponsesRequest,
  fromResponsesResponse,
  collectChatGptSseResponse,
} from './chatgpt-adapter';
import {
  normalizeOpenAiReasoningDelta,
  type OpenAiReasoningStreamFormat,
} from './reasoning-format';

/** Convert a ChatGPT Responses API response to OpenAI format. */
export function convertChatGptResponse(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return fromResponsesResponse(body, model);
}

/**
 * Stateful ChatGPT Responses→OpenAI SSE transformer. Created once per stream
 * so the terminal event can backfill reasoning summaries that never streamed
 * as recognizable deltas.
 */
export { createChatGptStreamTransformer } from './chatgpt-adapter';

/** Convert a Google non-streaming response to OpenAI format. */
export function convertGoogleResponse(
  googleBody: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return fromGoogleResponse(googleBody, model);
}

/** Convert a Google SSE chunk to OpenAI SSE format. */
export function convertGoogleStreamChunk(chunk: string, model: string): GoogleStreamChunkResult {
  return transformGoogleStreamChunk(chunk, model);
}

/** Convert an Anthropic non-streaming response to OpenAI format. */
export function convertAnthropicResponse(
  anthropicBody: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  return fromAnthropicResponse(anthropicBody, model);
}

/** Convert an Anthropic SSE chunk to OpenAI SSE format. */
export function convertAnthropicStreamChunk(chunk: string, model: string): string | null {
  return transformAnthropicStreamChunk(chunk, model);
}

/** Create a stateful Anthropic stream transformer that tracks usage across events. */
export function createAnthropicTransformer(
  model: string,
  onThinkingBlocks?: ThinkingBlocksCallback,
): (chunk: string) => string | null {
  return createAnthropicStreamTransformer(model, onThinkingBlocks);
}

// Re-export adapter functions used by ProviderClient.forward()
export {
  applyAnthropicAutomaticCacheControl,
  applyAnthropicMessagesMutations,
  extractThinkingBlocksFromMessagesResponse,
  toGoogleRequest,
  toAnthropicRequest,
  toResponsesRequest,
  collectChatGptSseResponse,
};
export type { GoogleStreamChunkResult } from './google-adapter';
export type { ThinkingBlocksCallback } from './anthropic-adapter';
export type { SignatureLookup, ThinkingBlockLookup } from './proxy-types';

// ─── OpenAI wire normalization (used by ProviderClient.forward) ─────────────

// This layer keeps unconditional wire-format adaptations: provider-level
// protocol facts (a field that is simply not part of a given API) and
// cross-protocol translations. Model- and version-specific corrections — a
// parameter that some models accept and others reject — stay out of here and
// belong to Autofix, where the provider error can scope a patch.

/**
 * Providers that use `max_completion_tokens` without a legacy alias rewrite.
 */
const PASSTHROUGH_PROVIDERS = new Set(['openai', 'openrouter']);

/**
 * OpenAI-only fields other providers reject as "extra inputs not permitted".
 * Stripped before forwarding to non-OpenAI, non-OpenRouter providers: these are
 * not part of those wire protocols, so dropping them cannot remove a parameter
 * the target would have honoured.
 */
const OPENAI_ONLY_FIELDS = new Set([
  'store',
  'metadata',
  'service_tier',
  'stream_options',
  'modalities',
  'audio',
  'prediction',
  'reasoning_effort',
]);

const OLLAMA_ENDPOINTS = new Set(['ollama', 'ollama-cloud']);
const MISTRAL_TOOL_CALL_ID_REGEX = /^[A-Za-z0-9]{9}$/;

/**
 * NVIDIA Nemotron models served through OpenRouter (e.g. `nvidia/nemotron-3-*`)
 * validate request params strictly and reject Anthropic's top-level `thinking`
 * field with a 400 ("Unsupported parameter(s): `thinking`"). NeMo expresses
 * reasoning through `extra_body.chat_template_kwargs.enable_thinking` instead,
 * but OpenRouter is a passthrough provider so we can't inject that shape here —
 * the safe fix is to drop `thinking` for just this family, leaving DeepSeek,
 * Kimi, Gemma, etc. pass through unchanged. Matched on the bare model id so
 * `nvidia/nemotron-3-ultra-550b-a55b` and `nemotron-3-super-120b-a12b` both hit.
 */
const NVIDIA_NEMOTRON_FAMILY_RE = /^nemotron(?:[-_.\d]|$)/i;

/**
 * OpenAI models that require `max_completion_tokens` instead of `max_tokens`.
 * All o-series reasoning models and GPT-5+ models use the new parameter.
 */
const OPENAI_MAX_COMPLETION_TOKENS_RE = /^(o\d|gpt-5)/i;

/**
 * Endpoints that ultimately hit OpenAI infrastructure and therefore need
 * `max_tokens` rewritten to `max_completion_tokens` for o-series / GPT-5+.
 * Copilot belongs here because GitHub Copilot proxies these models to OpenAI
 * (issue mnfst/manifest#1849).
 */
const OPENAI_MAX_COMPLETION_TOKENS_ENDPOINTS = new Set(['openai', 'copilot']);

function usesOpenAiMaxCompletionTokens(endpointKey: string, bareModel: string): boolean {
  return (
    OPENAI_MAX_COMPLETION_TOKENS_ENDPOINTS.has(endpointKey) &&
    OPENAI_MAX_COMPLETION_TOKENS_RE.test(bareModel)
  );
}

export type ReasoningContentCallback = (firstToolCallId: string, content: string) => void;

/**
 * Creates a stateful OpenAI-compatible stream transformer that passes chunks
 * through unchanged while accumulating reasoning_content for tool-call turns.
 */
export function createReasoningContentStreamTransformer(
  onReasoningContent?: ReasoningContentCallback,
  format: OpenAiReasoningStreamFormat = {
    outputStreamDeltaPaths: ['reasoning_content'],
    clientStreamDeltaPath: 'reasoning_content',
  },
): (chunk: string) => string | null {
  let accumulatedReasoning = '';
  let firstToolCallId: string | null = null;
  let storedReasoning = '';

  const storeIfReady = (): void => {
    if (
      onReasoningContent &&
      accumulatedReasoning &&
      firstToolCallId &&
      accumulatedReasoning !== storedReasoning
    ) {
      onReasoningContent(firstToolCallId, accumulatedReasoning);
      storedReasoning = accumulatedReasoning;
    }
  };

  return (chunk: string): string | null => {
    let outChunk = chunk;
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
      const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;

      if (delta) {
        const reasoning = normalizeOpenAiReasoningDelta(delta, format);
        if (reasoning) {
          accumulatedReasoning += reasoning.text;
          if (reasoning.normalized) outChunk = JSON.stringify(parsed);
          storeIfReady();
        }
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls) {
            if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) continue;
            if (firstToolCallId === null && typeof toolCall.id === 'string' && toolCall.id) {
              firstToolCallId = toolCall.id;
            }
          }
          storeIfReady();
        }
      }

      if (choice?.finish_reason === 'tool_calls') storeIfReady();
    } catch {
      // Pass malformed/non-JSON chunks through unchanged.
    }

    return `data: ${outChunk}\n\n`;
  };
}

function normalizeOpenAiMessages(messages: unknown, endpointKey: string): unknown {
  if (!Array.isArray(messages)) return messages;

  const isMistral = endpointKey === 'mistral';
  const mistralIdMap = new Map<string, string>();
  const reservedMistralIds = new Set<string>();
  let generatedMistralIdCounter = 0;

  const reserveMistralToolCallId = (toolCallId: unknown): void => {
    if (!isMistral || typeof toolCallId !== 'string') return;
    if (MISTRAL_TOOL_CALL_ID_REGEX.test(toolCallId)) {
      reservedMistralIds.add(toolCallId);
    }
  };

  if (isMistral) {
    for (const message of messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        continue;
      }
      const rawMessage = message as Record<string, unknown>;
      if (Array.isArray(rawMessage.tool_calls)) {
        for (const toolCall of rawMessage.tool_calls) {
          if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
            continue;
          }
          reserveMistralToolCallId((toolCall as Record<string, unknown>).id);
        }
      }
      if ('tool_call_id' in rawMessage) {
        reserveMistralToolCallId(rawMessage.tool_call_id);
      }
    }
  }

  const nextGeneratedMistralId = (): string => {
    do {
      generatedMistralIdCounter += 1;
      const candidate = `tc${generatedMistralIdCounter.toString(36).padStart(7, '0')}`;
      if (!reservedMistralIds.has(candidate)) return candidate;
    } while (true);
  };

  const normalizeMistralToolCallId = (toolCallId: unknown): unknown => {
    if (!isMistral || typeof toolCallId !== 'string') return toolCallId;
    const existing = mistralIdMap.get(toolCallId);
    if (existing) return existing;

    if (MISTRAL_TOOL_CALL_ID_REGEX.test(toolCallId)) {
      mistralIdMap.set(toolCallId, toolCallId);
      reservedMistralIds.add(toolCallId);
      return toolCallId;
    }

    const rewritten = nextGeneratedMistralId();
    mistralIdMap.set(toolCallId, rewritten);
    reservedMistralIds.add(rewritten);
    return rewritten;
  };

  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return message;
    }

    const normalized = { ...(message as Record<string, unknown>) };

    // OpenRouter dialect fields. Every other OpenAI-compatible host rejects them
    // as unknown message inputs, so their presence is a wire-protocol fact, not a
    // model-specific correction. `reasoning_content` is deliberately NOT touched:
    // it is required by DeepSeek-dialect hosts and rejected by strict hosts
    // serving the same model, a split only the provider error can settle.
    if (endpointKey !== 'openrouter') {
      delete normalized.reasoning;
      delete normalized.reasoning_details;
    }
    delete normalized.reasoning_text;

    if (isMistral && Array.isArray(normalized.tool_calls)) {
      normalized.tool_calls = normalized.tool_calls.map((toolCall) => {
        if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
          return toolCall;
        }
        const normalizedToolCall = { ...(toolCall as Record<string, unknown>) };
        normalizedToolCall.id = normalizeMistralToolCallId(normalizedToolCall.id);
        return normalizedToolCall;
      });
    }

    if (isMistral && 'tool_call_id' in normalized) {
      normalized.tool_call_id = normalizeMistralToolCallId(normalized.tool_call_id);
    }

    return normalized;
  });
}

/**
 * Normalize unconditional OpenAI-compatible wire differences. Provider- and
 * model-specific parameter corrections are intentionally left to Autofix.
 */
export function sanitizeOpenAiBody(
  body: Record<string, unknown>,
  endpointKey: string,
  model: string,
): Record<string, unknown> {
  const passthroughTopLevel = PASSTHROUGH_PROVIDERS.has(endpointKey);

  // Strip vendor prefix (e.g., "openai/gpt-5" → "gpt-5") before matching.
  const bareForRegex = model.includes('/') ? model.substring(model.indexOf('/') + 1) : model;
  const needsMaxCompletionTokens = usesOpenAiMaxCompletionTokens(endpointKey, bareForRegex);
  const convertMaxTokens =
    needsMaxCompletionTokens && 'max_tokens' in body && !('max_completion_tokens' in body);
  // NVIDIA Nemotron hosts (reached through the OpenRouter passthrough) reject the
  // Anthropic-style top-level `thinking` param; scope the strip to that family so
  // the general OpenRouter passthrough stays untouched (mnfst/manifest#2464).
  const isOpenRouterNemotron =
    endpointKey === 'openrouter' && NVIDIA_NEMOTRON_FAMILY_RE.test(bareForRegex);

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'messages') {
      cleaned[key] = normalizeOpenAiMessages(value, endpointKey);
      continue;
    }
    // Rewrite max_tokens → max_completion_tokens for OpenAI-backed endpoints that
    // require it (native OpenAI + Copilot for o-series / GPT-5+). Applies in both
    // passthrough and non-passthrough branches.
    if (convertMaxTokens && key === 'max_tokens') {
      cleaned['max_completion_tokens'] = value;
      continue;
    }
    if (passthroughTopLevel) {
      // OpenRouter forwards the whole body for most models, but NVIDIA Nemotron
      // hosts validate strictly and reject Anthropic-style `thinking`. Drop it
      // only for that family (see NVIDIA_NEMOTRON_FAMILY_RE) — mirroring the
      // Ollama exception below — so DeepSeek/Kimi/Gemma passthrough is unaffected.
      if (key === 'thinking' && isOpenRouterNemotron) continue;
      cleaned[key] = value;
      continue;
    }
    // xAI and DeepSeek implement `reasoning_effort`; keep it there. Every other
    // non-passthrough provider gets the OpenAI-only field stripped below.
    if (key === 'reasoning_effort' && (endpointKey === 'xai' || endpointKey === 'deepseek')) {
      cleaned[key] = value;
      continue;
    }
    if (OPENAI_ONLY_FIELDS.has(key)) continue;
    // Ollama's OpenAI-compatible endpoint does not accept the Anthropic-style
    // `thinking` block; other non-passthrough providers are left to Autofix.
    if (key === 'thinking' && OLLAMA_ENDPOINTS.has(endpointKey.toLowerCase())) continue;
    if (key === 'max_completion_tokens') {
      // Preserve max_completion_tokens for endpoints that require it; otherwise
      // downconvert to max_tokens for OpenAI-compatible providers that only know
      // the legacy field name.
      if (needsMaxCompletionTokens) {
        cleaned[key] = value;
      } else if (!('max_tokens' in body)) {
        cleaned['max_tokens'] = value;
      }
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}
