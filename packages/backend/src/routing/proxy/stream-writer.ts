import { Response as ExpressResponse } from 'express';
import type { EventSourceMessage } from 'eventsource-parser';
import {
  createSsePayloadParser,
  DEFAULT_MAX_SSE_BUFFER_SIZE,
  formatSseComment,
} from './sse-parser';
import type { ProviderWireFormat } from './proxy-types';
import {
  StreamFailure,
  StreamIdleTimeoutError,
  StreamProtocolObserver,
  UpstreamStreamError,
} from './stream-protocol';

export {
  StreamFailure,
  StreamIdleTimeoutError,
  UpstreamStreamError,
  STREAM_IDLE_TIMEOUT_MESSAGE,
  STREAM_INTERRUPTED_MESSAGE,
  INCOMPLETE_STREAM_MESSAGE,
} from './stream-protocol';

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reported_cost_usd?: number;
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

export function parseStreamIdleTimeoutMs(rawValue = process.env.STREAM_IDLE_TIMEOUT_MS): number {
  if (!rawValue) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

async function readUpstreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new StreamIdleTimeoutError()), idleTimeoutMs);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof StreamFailure) throw cause;
    throw new UpstreamStreamError(cause);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface StreamRelayOptions {
  idleTimeoutMs?: number;
  protocol?: ProviderWireFormat;
  /** Exact decoded bytes received from the provider, before any API adaptation. */
  onUpstreamChunk?: (text: string) => void;
}

function createProtocolParser(options: StreamRelayOptions): {
  observer: StreamProtocolObserver | null;
  parserOptions: object;
} {
  const observer = options.protocol ? new StreamProtocolObserver(options.protocol) : null;
  return {
    observer,
    parserOptions: observer
      ? { onEvent: (event: EventSourceMessage) => observer.observe(event) }
      : {},
  };
}

function isAbortAfterProviderOutcome(
  error: unknown,
  observer: StreamProtocolObserver | null,
): boolean {
  return error instanceof UpstreamStreamError && observer?.isComplete() === true;
}

/**
 * Read a usage block in either OpenAI-compat (`prompt_tokens`/`completion_tokens`)
 * or Anthropic-native (`input_tokens`/`output_tokens`) shape and normalise it
 * to a `StreamUsage`. Returns null when neither shape is present.
 *
 * OpenAI-compatible providers expose cached prompt tokens under provider-specific
 * usage fields, not always the top-level `cache_read_tokens` key. Falling back
 * to those keys keeps the cache column populated for providers such as DeepSeek,
 * Z.AI, MiniMax, and Mistral.
 */
export function parseUsageObject(usage: unknown): StreamUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const reportedCostUsd = readReportedCostUsd(u);

  if (typeof u.prompt_tokens === 'number') {
    const promptDetails =
      typeof u.prompt_tokens_details === 'object' && u.prompt_tokens_details !== null
        ? (u.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const cacheRead =
      typeof u.cache_read_tokens === 'number'
        ? u.cache_read_tokens
        : typeof u.prompt_cache_hit_tokens === 'number'
          ? u.prompt_cache_hit_tokens
          : typeof u.cached_tokens === 'number'
            ? u.cached_tokens
            : typeof promptDetails?.cached_tokens === 'number'
              ? promptDetails.cached_tokens
              : undefined;
    const cacheCreation =
      typeof u.cache_creation_tokens === 'number'
        ? u.cache_creation_tokens
        : typeof u.cache_creation_input_tokens === 'number'
          ? u.cache_creation_input_tokens
          : typeof promptDetails?.cache_write_tokens === 'number'
            ? promptDetails.cache_write_tokens
            : typeof promptDetails?.cache_creation_input_tokens === 'number'
              ? promptDetails.cache_creation_input_tokens
              : undefined;
    return {
      prompt_tokens: u.prompt_tokens,
      completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      ...(reportedCostUsd !== undefined ? { reported_cost_usd: reportedCostUsd } : {}),
    };
  }

  if (typeof u.input_tokens === 'number') {
    // Two shapes share this branch:
    //   - Anthropic native (`POST /v1/messages` passthrough): cache reads
    //     and creations live at the top of the usage object as
    //     `cache_read_input_tokens` / `cache_creation_input_tokens`, and
    //     `input_tokens` is the non-cached portion. Total prompt tokens =
    //     input + cache_read + cache_creation, matching what the converted
    //     `fromAnthropicResponse` path used to record.
    //   - OpenAI Responses API: cached count nests under
    //     `input_tokens_details.cached_tokens`, and `input_tokens` is
    //     already the total. No summing here or we'd double-count cache.
    const inputDetails =
      typeof u.input_tokens_details === 'object' && u.input_tokens_details !== null
        ? (u.input_tokens_details as Record<string, unknown>)
        : undefined;
    const nativeCacheRead =
      typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
    const nativeCacheCreation =
      typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
    const isAnthropicNative = nativeCacheRead > 0 || nativeCacheCreation > 0;
    const nestedCacheRead =
      typeof inputDetails?.cached_tokens === 'number' ? inputDetails.cached_tokens : 0;
    const nestedCacheCreation =
      typeof inputDetails?.cache_write_tokens === 'number'
        ? inputDetails.cache_write_tokens
        : typeof inputDetails?.cache_creation_input_tokens === 'number'
          ? inputDetails.cache_creation_input_tokens
          : 0;
    const promptTokens = isAnthropicNative
      ? u.input_tokens + nativeCacheRead + nativeCacheCreation
      : u.input_tokens;
    const cacheRead = nativeCacheRead || nestedCacheRead;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
      cache_read_tokens: isAnthropicNative ? nativeCacheRead : cacheRead || undefined,
      cache_creation_tokens: isAnthropicNative ? nativeCacheCreation : nestedCacheCreation,
      ...(reportedCostUsd !== undefined ? { reported_cost_usd: reportedCostUsd } : {}),
    };
  }

  return null;
}

function readReportedCostUsd(usage: Record<string, unknown>): number | undefined {
  const direct = readNonNegativeFiniteNumber(usage.cost);
  if (direct !== undefined) return direct;

  const details =
    typeof usage.cost_details === 'object' && usage.cost_details !== null
      ? (usage.cost_details as Record<string, unknown>)
      : undefined;
  return readNonNegativeFiniteNumber(details?.upstream_inference_cost);
}

function readNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractUsageFromObject(obj: unknown): StreamUsage | null {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  const fromUsage = parseUsageObject(record.usage);
  if (fromUsage) return fromUsage;
  const response = record.response;
  if (response && typeof response === 'object') {
    return parseUsageObject((response as Record<string, unknown>).usage);
  }
  return null;
}

function extractUsageFromJsonPayload(payload: string): StreamUsage | null {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === '[DONE]') return null;
  try {
    return extractUsageFromObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function extractJsonPayloadFromParsedEvent(eventText: string): string {
  return eventText
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('event:') &&
        !line.startsWith('id:') &&
        !line.startsWith('retry:') &&
        !line.startsWith(':'),
    )
    .map((line) => (line.startsWith('data:') ? line.slice(5).trim() : line))
    .join('\n')
    .trim();
}

/** Extract usage data from SSE text, parsed SSE event text, or raw JSON. */
export function extractUsageFromSse(sseText: string): StreamUsage | null {
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const json = trimmed.slice(5).trim();
    const usage = extractUsageFromJsonPayload(json);
    if (usage) return usage;
  }

  const usage = extractUsageFromJsonPayload(sseText);
  if (usage) return usage;

  const payload = extractJsonPayloadFromParsedEvent(sseText);
  if (!payload || payload === sseText.trim()) return null;
  return extractUsageFromJsonPayload(payload);
}

export function initSseHeaders(
  res: ExpressResponse,
  extraHeaders: Record<string, string> = {},
  statusCode?: number,
): void {
  if (statusCode !== undefined) {
    res.statusCode = statusCode;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.flushHeaders();
}

const MAX_SSE_BUFFER_SIZE = DEFAULT_MAX_SSE_BUFFER_SIZE;

/**
 * Forward an SSE stream byte-for-byte from `source` to `dest` while running a
 * `tap` parser over the parsed events for telemetry side effects. The wire
 * bytes are written unchanged, so SSE framing (`event:` headers, multi-line
 * `data:` payloads, blank-line separators) is preserved end-to-end. Used by
 * the `/v1/messages` → Anthropic passthrough path where translation must
 * NOT touch the wire format but Manifest still needs to extract usage and
 * cache thinking blocks.
 *
 * The tap receives the same parsed-event shape `pipeStream` would have
 * passed to its `transform`. Its return value (an OpenAI-shape chunk in
 * practice) is parsed for usage; nothing it returns is written to `dest`.
 */
export async function pipePassthrough(
  source: ReadableStream<Uint8Array>,
  dest: ExpressResponse,
  tap: (parsedEvent: string) => string | null,
  onClientChunk?: (text: string) => void,
  options: StreamRelayOptions = {},
): Promise<StreamUsage | null> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let capturedUsage: StreamUsage | null = null;
  let streamFailed = false;
  const protocol = createProtocolParser(options);
  const parser = createSsePayloadParser({
    maxBufferSize: MAX_SSE_BUFFER_SIZE,
    ...protocol.parserOptions,
  });
  const idleTimeoutMs = options.idleTimeoutMs ?? parseStreamIdleTimeoutMs();

  try {
    let done = false;
    while (!done) {
      if (dest.writableEnded) break;
      const result = await readUpstreamChunk(reader, idleTimeoutMs);
      done = result.done;
      if (result.value) {
        const text = decoder.decode(result.value, { stream: !done });
        options.onUpstreamChunk?.(text);
        const events = parser.feed(text);
        // Observe provider errors before forwarding their bytes. The controller
        // then emits one normalized error event in the caller's API format.
        dest.write(Buffer.from(result.value));
        if (onClientChunk) onClientChunk(text);
        for (const event of events) {
          const tapped = tap(event);
          if (tapped) {
            const usage = extractUsageFromSse(tapped);
            if (usage) capturedUsage = usage;
          }
        }
      }
    }
    const finalText = decoder.decode();
    if (finalText) {
      options.onUpstreamChunk?.(finalText);
      for (const event of parser.feed(finalText)) {
        const tapped = tap(event);
        if (tapped) {
          const usage = extractUsageFromSse(tapped);
          if (usage) capturedUsage = usage;
        }
      }
    }
    for (const event of parser.flush()) {
      const tapped = tap(event);
      if (tapped) {
        const usage = extractUsageFromSse(tapped);
        if (usage) capturedUsage = usage;
      }
    }
    protocol.observer?.assertComplete();
  } catch (error) {
    if (isAbortAfterProviderOutcome(error, protocol.observer)) return capturedUsage;
    streamFailed = error instanceof StreamFailure;
    if (error instanceof StreamIdleTimeoutError) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    if (!streamFailed && !dest.writableEnded) dest.end();
  }

  return capturedUsage;
}

export async function pipeStream(
  source: ReadableStream<Uint8Array>,
  dest: ExpressResponse,
  transform?: (chunk: string) => string | null,
  finalize?: () => string | null,
  onClientChunk?: (text: string) => void,
  options: StreamRelayOptions = {},
): Promise<StreamUsage | null> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let capturedUsage: StreamUsage | null = null;
  let streamFailed = false;
  const protocol = createProtocolParser(options);
  const idleTimeoutMs = options.idleTimeoutMs ?? parseStreamIdleTimeoutMs();

  const writeOut = (s: string): void => {
    dest.write(s);
    if (onClientChunk) onClientChunk(s);
  };
  const transformParser = transform
    ? createSsePayloadParser({
        maxBufferSize: MAX_SSE_BUFFER_SIZE,
        ...protocol.parserOptions,
        onComment: (comment) => {
          if (!dest.writableEnded) writeOut(formatSseComment(comment));
        },
      })
    : null;
  const passthroughParser = transform
    ? null
    : createSsePayloadParser({
        maxBufferSize: MAX_SSE_BUFFER_SIZE,
        ...protocol.parserOptions,
      });

  const applyTransformedEvents = (events: string[]): void => {
    if (!transform) return;
    for (const event of events) {
      const transformed = transform(event);
      if (transformed) {
        writeOut(transformed);
        const usage = extractUsageFromSse(transformed);
        if (usage) capturedUsage = usage;
      }
    }
  };

  const capturePassthroughUsage = (events: string[]): void => {
    for (const ev of events) {
      const usage = extractUsageFromSse(ev);
      if (usage) capturedUsage = usage;
    }
  };

  const consumeText = (text: string): void => {
    if (!text) return;
    if (transform && transformParser) {
      applyTransformedEvents(transformParser.feed(text));
      return;
    }
    if (passthroughParser) capturePassthroughUsage(passthroughParser.feed(text));
    writeOut(text);
  };

  try {
    let done = false;
    while (!done) {
      if (dest.writableEnded) break;

      const result = await readUpstreamChunk(reader, idleTimeoutMs);
      done = result.done;

      if (result.value) {
        const text = decoder.decode(result.value, { stream: !done });
        options.onUpstreamChunk?.(text);
        consumeText(text);
      }
    }

    const finalText = decoder.decode();
    if (finalText) options.onUpstreamChunk?.(finalText);
    consumeText(finalText);
    if (transform && transformParser) {
      applyTransformedEvents(transformParser.flush());
    } else if (passthroughParser) {
      capturePassthroughUsage(passthroughParser.flush());
    }
    protocol.observer?.assertComplete();

    if (transform && !dest.writableEnded) {
      if (finalize) {
        const trailing = finalize();
        if (trailing && !dest.writableEnded) {
          writeOut(trailing);
          const usage = extractUsageFromSse(trailing);
          if (usage) capturedUsage = usage;
        }
      } else if (!dest.writableEnded) {
        writeOut('data: [DONE]\n\n');
      }
    }
  } catch (error) {
    if (isAbortAfterProviderOutcome(error, protocol.observer)) return capturedUsage;
    streamFailed = error instanceof StreamFailure;
    if (error instanceof StreamIdleTimeoutError) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    if (!streamFailed && !dest.writableEnded) dest.end();
  }

  return capturedUsage;
}
