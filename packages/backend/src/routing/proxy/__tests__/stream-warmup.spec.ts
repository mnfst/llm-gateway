import {
  DEFAULT_STREAM_WARMUP_MS,
  MIN_STREAM_WARMUP_MS,
  MAX_STREAM_WARMUP_MS,
  parseStreamWarmupMs,
  clampStreamWarmupMs,
  peekStream,
} from '../stream-warmup';

function makeStream(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      // Return a promise that resolves when the stream is cancelled,
      // preventing the process from hanging after the test.
      return new Promise<void>((resolve) => {
        const check = setInterval(() => {
          // Pull is no longer called once the reader is cancelled/released
          clearInterval(check);
          resolve();
        }, 50);
      });
    },
  });
}

function errorStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error(message));
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let done = false;
  while (!done) {
    const read = await reader.read();
    done = read.done;
    if (read.value) result += decoder.decode(read.value, { stream: !done });
  }
  return result;
}

describe('peekStream', () => {
  describe('timeout config', () => {
    it('defaults to 15000 ms when env var is unset', () => {
      expect(parseStreamWarmupMs(undefined)).toBe(DEFAULT_STREAM_WARMUP_MS);
    });

    it('uses the configured value when env var is a positive integer', () => {
      expect(parseStreamWarmupMs('45000')).toBe(45_000);
    });

    it('falls back to 15000 ms when env var is non-numeric', () => {
      expect(parseStreamWarmupMs('abc')).toBe(DEFAULT_STREAM_WARMUP_MS);
    });

    it.each(['45000abc', '45000.5', '45_000', ' 45000'])(
      'falls back to 15000 ms when env var is not digits-only: %s',
      (rawValue) => {
        expect(parseStreamWarmupMs(rawValue)).toBe(DEFAULT_STREAM_WARMUP_MS);
      },
    );

    it('falls back to 15000 ms when env var is negative', () => {
      expect(parseStreamWarmupMs('-1')).toBe(DEFAULT_STREAM_WARMUP_MS);
    });

    it('falls back to 15000 ms when env var is zero', () => {
      expect(parseStreamWarmupMs('0')).toBe(DEFAULT_STREAM_WARMUP_MS);
    });
  });

  describe('clampStreamWarmupMs', () => {
    it('returns the value for an in-range integer', () => {
      expect(clampStreamWarmupMs(30_000)).toBe(30_000);
    });

    it('accepts the lower and upper bounds', () => {
      expect(clampStreamWarmupMs(MIN_STREAM_WARMUP_MS)).toBe(MIN_STREAM_WARMUP_MS);
      expect(clampStreamWarmupMs(MAX_STREAM_WARMUP_MS)).toBe(MAX_STREAM_WARMUP_MS);
    });

    it('rounds fractional values to the nearest integer', () => {
      expect(clampStreamWarmupMs(10_500.6)).toBe(10_501);
    });

    it('coerces numeric strings', () => {
      expect(clampStreamWarmupMs('45000')).toBe(45_000);
    });

    it('returns undefined for values below the minimum', () => {
      expect(clampStreamWarmupMs(999)).toBeUndefined();
    });

    it('returns undefined for values above the maximum', () => {
      expect(clampStreamWarmupMs(120_001)).toBeUndefined();
    });

    it('returns undefined for non-numeric input', () => {
      expect(clampStreamWarmupMs('abc')).toBeUndefined();
      expect(clampStreamWarmupMs(null)).toBeUndefined();
      expect(clampStreamWarmupMs(undefined)).toBeUndefined();
      expect(clampStreamWarmupMs({})).toBeUndefined();
    });
  });

  it('returns success and preserves data for a healthy stream', async () => {
    const data = new TextEncoder().encode('data: {"content":"hello"}\n\n');
    const stream = makeStream([data, new TextEncoder().encode('data: [DONE]\n\n')]);

    const result = await peekStream(stream, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = await collectStream(result.stream);
      expect(text).toContain('hello');
      expect(text).toContain('[DONE]');
    }
  });

  it('returns failure for an empty stream', async () => {
    const result = await peekStream(emptyStream(), 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty');
    }
  });

  it('returns failure when stream times out', async () => {
    const result = await peekStream(hangingStream(), 100);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
  });

  it('returns failure when stream errors immediately', async () => {
    const result = await peekStream(errorStream('provider died'), 5000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
      expect(result.message).toContain('provider died');
    }
  });

  it('replays buffered chunk before remaining data', async () => {
    const chunk1 = new TextEncoder().encode('chunk1');
    const chunk2 = new TextEncoder().encode('chunk2');
    const chunk3 = new TextEncoder().encode('chunk3');
    const stream = makeStream([chunk1, chunk2, chunk3]);

    const result = await peekStream(stream, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = await collectStream(result.stream);
      expect(text).toBe('chunk1chunk2chunk3');
    }
  });

  it('works with a single-chunk stream', async () => {
    const data = new TextEncoder().encode('only-chunk');
    const stream = makeStream([data]);

    const result = await peekStream(stream, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = await collectStream(result.stream);
      expect(text).toBe('only-chunk');
    }
  });

  it('cancels the source reader when the returned stream is cancelled', async () => {
    const data = new TextEncoder().encode('chunk');
    const source = makeStream([data]);

    const result = await peekStream(source, 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(result.stream.cancel()).resolves.toBeUndefined();
    }
  });

  it('propagates mid-stream errors after warmup succeeds', async () => {
    let pullCount = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode('first'));
        } else {
          controller.error(new Error('upstream died mid-stream'));
        }
      },
    });

    const result = await peekStream(source, 5000);
    expect(result.ok).toBe(true);

    if (result.ok) {
      const reader = result.stream.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('first');

      await expect(reader.read()).rejects.toThrow('upstream died mid-stream');
    }
  });
});
