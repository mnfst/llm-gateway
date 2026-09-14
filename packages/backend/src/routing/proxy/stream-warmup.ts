/**
 * Stream warm-up: peek at the first bytes of a streaming response before
 * committing it to the client.  If the provider returned HTTP 200 but the
 * stream stalls or dies before producing any data, we can still fall back
 * to another provider instead of sending the client a truncated response.
 *
 * @see https://github.com/mnfst/manifest/issues/1656
 */

export const DEFAULT_STREAM_WARMUP_MS = 15_000;

export function parseStreamWarmupMs(rawValue = process.env.STREAM_WARMUP_MS): number {
  const value = rawValue ?? '';
  if (!/^\d+$/.test(value)) {
    return DEFAULT_STREAM_WARMUP_MS;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_WARMUP_MS;
}

export const STREAM_WARMUP_MS = parseStreamWarmupMs();

/** Bounds for tier/provider warmup overrides. */
export const MIN_STREAM_WARMUP_MS = 1_000;
export const MAX_STREAM_WARMUP_MS = 120_000;

/** Clamp a candidate override; returns undefined when out of bounds. */
export function clampStreamWarmupMs(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const ms = Math.round(n);
  return ms >= MIN_STREAM_WARMUP_MS && ms <= MAX_STREAM_WARMUP_MS ? ms : undefined;
}

export interface WarmupSuccess {
  ok: true;
  /** A new ReadableStream that yields the buffered chunk first, then the rest. */
  stream: ReadableStream<Uint8Array>;
}

export interface WarmupFailure {
  ok: false;
  reason: 'timeout' | 'error' | 'empty';
  message: string;
}

export type WarmupResult = WarmupSuccess | WarmupFailure;

/**
 * Read the first chunk from `source`.  If data arrives within `timeoutMs`,
 * return a new stream that replays the buffered chunk followed by the
 * remaining data.  If the stream stalls, errors, or ends with no data,
 * return a failure so the caller can try a fallback.
 */
export async function peekStream(
  source: ReadableStream<Uint8Array>,
  timeoutMs: number = STREAM_WARMUP_MS,
): Promise<WarmupResult> {
  const reader = source.getReader();

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      reader.read(),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    clearTimeout(timer);

    if ('timedOut' in first) {
      reader.cancel().catch(() => {});
      reader.releaseLock();
      return { ok: false, reason: 'timeout', message: `No data within ${timeoutMs}ms` };
    }

    const { done, value } = first as ReadableStreamReadResult<Uint8Array>;

    if (done || !value || value.length === 0) {
      reader.releaseLock();
      return { ok: false, reason: 'empty', message: 'Stream ended with no data' };
    }

    // Build a new stream: buffered chunk first, then pipe the rest.
    const buffered = value;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(buffered);
      },
      async pull(controller) {
        try {
          const { done: nextDone, value: nextValue } = await reader.read();
          if (nextDone) {
            controller.close();
            reader.releaseLock();
          } else if (nextValue) {
            controller.enqueue(nextValue);
          }
        } catch (err) {
          reader.releaseLock();
          controller.error(err);
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
        reader.releaseLock();
      },
    });

    return { ok: true, stream };
  } catch (err) {
    reader.cancel().catch(() => {});
    reader.releaseLock();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'error', message };
  }
}
