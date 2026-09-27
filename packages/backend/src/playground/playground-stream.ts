import type { ForwardResult, ProviderClient } from '../routing/proxy/provider-client';
import { unwrapCodeAssistStreamPayload } from '../routing/oauth/gemini/codeassist-envelope';
import { createSsePayloadParser } from '../routing/proxy/sse-parser';
import { parseUsageObject, type StreamUsage } from '../routing/proxy/stream-writer';

export interface ConsumeStreamResult {
  content: string;
  usage: StreamUsage | null;
  /** ms from start to first usable delta; null if nothing streamed. */
  ttftMs: number | null;
  /** ms from start to the last delta (total generation wall time). */
  totalMs: number;
}

/**
 * One upstream SSE event (data prefix stripped by the SSE parser) →
 * an OpenAI-format `data: {...}\n\n` chunk string, or null to skip. Mirrors the
 * exact converter selection the production proxy uses in handleStreamResponse
 * so playground streaming inherits the same provider coverage instead of
 * reimplementing Anthropic/Google/ChatGPT SSE parsing.
 */
type ChunkTransform = (event: string) => string | null;

function buildChunkTransform(
  forward: Pick<ForwardResult, 'isGoogle' | 'isAnthropic' | 'isChatGpt' | 'isCodeAssist'>,
  model: string,
  providerClient: ProviderClient,
): ChunkTransform {
  if (forward.isGoogle) {
    return (event) => {
      const innerEvent = forward.isCodeAssist ? unwrapCodeAssistStreamPayload(event) : event;
      return providerClient.convertGoogleStreamChunk(innerEvent, model).chunk;
    };
  }
  if (forward.isAnthropic) {
    // Stateful: must be created once per stream and fed events in order.
    const transformer = providerClient.createAnthropicStreamTransformer(model);
    return (event) => transformer(event);
  }
  if (forward.isChatGpt) {
    // Stateful: must be created once per stream and fed events in order.
    return providerClient.createChatGptStreamTransformer(model);
  }
  // OpenAI-compatible passthrough: re-wrap the bare JSON payload so the same
  // line parser below handles every provider uniformly.
  return (event) => `data: ${event}\n\n`;
}

/** Pull incremental text + usage out of an OpenAI-format SSE chunk string. */
function extractDeltas(sse: string): { text: string; usage: StreamUsage | null } {
  let text = '';
  let usage: StreamUsage | null = null;
  for (const line of sse.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const json = trimmed.slice(5).trim();
    if (!json || json === '[DONE]') continue;
    try {
      const obj = JSON.parse(json) as {
        choices?: { delta?: { content?: unknown } }[];
        usage?: unknown;
      };
      const piece = obj.choices?.[0]?.delta?.content;
      if (typeof piece === 'string') text += piece;
      const u = parseUsageObject(obj.usage);
      if (u) usage = u;
    } catch {
      /* ignore non-JSON / partial events */
    }
  }
  return { text, usage };
}

const MAX_STREAM_BUFFER = 1_048_576;

/**
 * Consumes the upstream provider stream, invoking `onDelta` with each text
 * fragment as it arrives, and returns the accumulated content, final usage,
 * time-to-first-token, and total generation time.
 *
 * Timing is measured here (not around `forward()`), which fixes the prior bug
 * where duration stopped when response headers arrived — before any tokens.
 */
export async function consumeProviderStream(
  body: ReadableStream<Uint8Array>,
  forward: Pick<ForwardResult, 'isGoogle' | 'isAnthropic' | 'isChatGpt' | 'isCodeAssist'>,
  model: string,
  providerClient: ProviderClient,
  onDelta: (text: string) => void,
  startedAt: number,
): Promise<ConsumeStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const transform = buildChunkTransform(forward, model, providerClient);

  let content = '';
  let usage: StreamUsage | null = null;
  let ttftMs: number | null = null;
  let lastDeltaAt = startedAt;
  const parser = createSsePayloadParser({ maxBufferSize: MAX_STREAM_BUFFER });

  const apply = (event: string): void => {
    const sse = transform(event);
    if (!sse) return;
    const { text, usage: u } = extractDeltas(sse);
    if (u) usage = u;
    if (text) {
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      content += text;
      lastDeltaAt = Date.now();
      onDelta(text);
    }
  };

  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        const text = decoder.decode(result.value, { stream: !done });
        for (const event of parser.feed(text)) apply(event);
      }
    }
    // Flush any bytes the decoder held back from a multi-byte char split
    // across the last chunk boundary (the final read often has no value).
    for (const event of parser.feed(decoder.decode())) apply(event);
    // The final usage chunk often arrives without a trailing blank line, so it
    // sits unparsed when the stream closes — flush it.
    for (const event of parser.flush()) apply(event);
  } finally {
    reader.releaseLock();
  }

  return {
    content,
    usage,
    ttftMs,
    totalMs: (content ? lastDeltaAt : Date.now()) - startedAt,
  };
}
