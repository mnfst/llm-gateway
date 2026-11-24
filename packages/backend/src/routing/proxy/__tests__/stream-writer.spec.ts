import {
  initSseHeaders,
  pipePassthrough,
  pipeStream,
  UpstreamStreamError,
  StreamFailure,
  StreamIdleTimeoutError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  parseStreamIdleTimeoutMs,
  extractUsageFromSse,
  parseUsageObject,
} from '../stream-writer';
import { createSsePayloadParser } from '../sse-parser';

function mockResponse(): {
  res: Record<string, jest.Mock | boolean | number>;
  written: string[];
  headers: Record<string, string>;
} {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      written.push(chunk);
    }),
    end: jest.fn(),
    writableEnded: false,
    statusCode: 201,
  };
  return { res, written, headers };
}

describe('initSseHeaders', () => {
  it('should set SSE headers and flush', () => {
    const { res, headers } = mockResponse();

    initSseHeaders(res as never);

    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers['Connection']).toBe('keep-alive');
    expect(headers['X-Accel-Buffering']).toBe('no');
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it('should preserve the current status code unless one is provided', () => {
    const { res } = mockResponse();

    initSseHeaders(res as never);

    expect(res.statusCode).toBe(201);
  });

  it('should set the status code when provided', () => {
    const { res } = mockResponse();

    initSseHeaders(res as never, {}, 200);

    expect(res.statusCode).toBe(200);
  });

  it('should set extra headers when provided', () => {
    const { res, headers } = mockResponse();

    initSseHeaders(res as never, {
      'X-Manifest-Tier': 'complex',
      'X-Manifest-Model': 'gpt-4o',
    });

    expect(headers['X-Manifest-Tier']).toBe('complex');
    expect(headers['X-Manifest-Model']).toBe('gpt-4o');
    expect(headers['Content-Type']).toBe('text/event-stream');
  });

  it('should work with empty extra headers', () => {
    const { res, headers } = mockResponse();

    initSseHeaders(res as never, {});

    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(res.flushHeaders).toHaveBeenCalled();
  });
});

describe('createSsePayloadParser', () => {
  it('should parse a single SSE event', () => {
    const parser = createSsePayloadParser();

    expect(parser.feed('data: {"text":"hello"}\n\n')).toEqual(['{"text":"hello"}']);
  });

  it('should parse CRLF-delimited SSE events', () => {
    const parser = createSsePayloadParser();

    expect(parser.feed('data: {"text":"hello"}\r\n\r\n')).toEqual(['{"text":"hello"}']);
  });

  it('should parse multiple SSE events', () => {
    const parser = createSsePayloadParser();
    const input = 'data: {"a":1}\n\ndata: {"b":2}\n\n';

    expect(parser.feed(input)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('should allow large batches of complete events under a small buffer cap', () => {
    const parser = createSsePayloadParser({ maxBufferSize: 10 });
    const input = 'data: x\n\ndata: y\n\ndata: z\n\n';

    expect(parser.feed(input)).toEqual(['x', 'y', 'z']);
  });

  it('should buffer partial chunks until they complete', () => {
    const parser = createSsePayloadParser();
    const input = 'data: {"done":true}\n\ndata: {"partial":';

    expect(parser.feed(input)).toEqual(['{"done":true}']);
    expect(parser.feed('false}\n\n')).toEqual(['{"partial":false}']);
  });

  it('should skip [DONE] events', () => {
    const parser = createSsePayloadParser();
    const input = 'data: {"text":"hi"}\n\ndata: [DONE]\n\n';

    expect(parser.feed(input)).toEqual(['{"text":"hi"}']);
  });

  it('should skip empty events', () => {
    const parser = createSsePayloadParser();
    const input = '\n\ndata: {"a":1}\n\n\n\n';

    expect(parser.feed(input)).toEqual(['{"a":1}']);
  });

  it('should handle multi-line data events', () => {
    const parser = createSsePayloadParser();
    const input = 'data: line1\ndata: line2\n\n';

    expect(parser.feed(input)).toEqual(['line1\nline2']);
  });

  it('should ignore SSE comments instead of treating them as payload', () => {
    const parser = createSsePayloadParser();
    const input = ': OPENROUTER PROCESSING\n\ndata: {"a":1}\n\n';

    expect(parser.feed(input)).toEqual(['{"a":1}']);
  });

  it('should preserve event and id fields for protocol-specific transformers', () => {
    const parser = createSsePayloadParser();
    const input = 'event: response.completed\nid: evt_1\ndata: {"a":1}\n\n';

    expect(parser.feed(input)).toEqual(['event: response.completed\nid: evt_1\n{"a":1}']);
  });

  it('should flush a trailing partial event when the stream closes', () => {
    const parser = createSsePayloadParser();

    expect(parser.feed('data: partial')).toEqual([]);
    expect(parser.flush()).toEqual(['partial']);
  });

  it('should ignore unknown SSE fields', () => {
    const parser = createSsePayloadParser();
    const input = 'raw content\n\n';

    expect(parser.feed(input)).toEqual([]);
  });

  it('preserves named event metadata while stripping data prefixes', () => {
    const parser = createSsePayloadParser();
    const input =
      'event: response.completed\n' +
      'data: {"response":{"usage":{"input_tokens":12,"output_tokens":2}}}\n\n';

    expect(parser.feed(input)).toEqual([
      'event: response.completed\n{"response":{"usage":{"input_tokens":12,"output_tokens":2}}}',
    ]);
  });
});

describe('pipeStream', () => {
  it('uses a safe configurable stream idle timeout', () => {
    expect(parseStreamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(parseStreamIdleTimeoutMs('2500')).toBe(2500);
    expect(parseStreamIdleTimeoutMs('0')).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(parseStreamIdleTimeoutMs('invalid')).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });

  it('fails a stream that stays idle between events', async () => {
    const { res } = mockResponse();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
      },
    });

    await expect(
      pipeStream(stream, res as never, undefined, undefined, undefined, {
        idleTimeoutMs: 10,
        protocol: 'openai_chat_completions',
      }),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(stream.locked).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('fails when a provider closes without a terminal event', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: {"choices":[]}\n\n']);

    await expect(
      pipeStream(stream, res as never, undefined, undefined, undefined, {
        protocol: 'openai_chat_completions',
      }),
    ).rejects.toMatchObject<Partial<StreamFailure>>({ reason: 'incomplete_stream', status: 503 });
    expect(res.end).not.toHaveBeenCalled();
  });

  it('accepts a protocol completion marker', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: {"choices":[]}\n\ndata: [DONE]\n\n']);

    await expect(
      pipeStream(stream, res as never, undefined, undefined, undefined, {
        protocol: 'openai_chat_completions',
      }),
    ).resolves.toBeNull();
    expect(res.end).toHaveBeenCalled();
  });

  it('treats an upstream abort after finish_reason as a completed stream', async () => {
    const { res, written } = mockResponse();
    const encoder = new TextEncoder();
    let sentTerminal = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentTerminal) {
          sentTerminal = true;
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            ),
          );
          return;
        }
        controller.error(new Error('aborted'));
      },
    });

    await expect(
      pipeStream(stream, res as never, undefined, undefined, undefined, {
        protocol: 'openai_chat_completions',
      }),
    ).resolves.toBeNull();
    expect(written.join('')).toContain('"finish_reason":"stop"');
    expect(res.end).toHaveBeenCalled();
  });

  it('still fails a Google stream aborted after a content chunk', async () => {
    const { res } = mockResponse();
    const encoder = new TextEncoder();
    let sentContent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentContent) {
          sentContent = true;
          controller.enqueue(
            encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'),
          );
          return;
        }
        controller.error(new Error('aborted'));
      },
    });

    await expect(
      pipeStream(stream, res as never, undefined, undefined, undefined, {
        protocol: 'google_generate_content',
      }),
    ).rejects.toBeInstanceOf(UpstreamStreamError);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('still fails when an upstream abort happens before a terminal event', async () => {
    const { res } = mockResponse();
    const encoder = new TextEncoder();
    let sentContent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentContent) {
          sentContent = true;
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
          );
          return;
        }
        controller.error(new Error('aborted'));
      },
    });

    await expect(
      pipeStream(stream, res as never, undefined, undefined, undefined, {
        protocol: 'openai_chat_completions',
      }),
    ).rejects.toBeInstanceOf(UpstreamStreamError);
    expect(res.end).not.toHaveBeenCalled();
  });

  function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        } else {
          controller.close();
        }
      },
    });
  }

  it('should pipe chunks directly without a transform', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['hello', ' world']);

    await pipeStream(stream, res as never);

    expect(written).toEqual(['hello', ' world']);
    expect(res.end).toHaveBeenCalled();
  });

  it('should apply transform to SSE events', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: chunk1\n\ndata: chunk2\n\n']);

    const transform = (chunk: string) => `transformed:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    expect(written).toContain('transformed:chunk1\n\n');
    expect(written).toContain('transformed:chunk2\n\n');
    // Should end with [DONE] for transformed streams
    expect(written).toContain('data: [DONE]\n\n');
  });

  it('should skip null results from transform', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: skip\n\ndata: keep\n\n']);

    const transform = (chunk: string) => (chunk === 'skip' ? null : `result:${chunk}\n\n`);

    await pipeStream(stream, res as never, transform);

    expect(written).toContain('result:keep\n\n');
    expect(written.some((w) => w.includes('skip'))).toBe(false);
  });

  it('should preserve SSE keep-alive comments on transformed streams', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream([
      ': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]);

    const transform = (chunk: string) => `data: ${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    expect(written).toContain(': OPENROUTER PROCESSING\n\n');
    expect(written).toContain('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    expect(written).not.toContain('data: : OPENROUTER PROCESSING\n\n');
  });

  it('should flush remaining buffer through transform', async () => {
    const { res, written } = mockResponse();
    // Partial event without trailing \n\n, then stream closes
    const stream = createReadableStream(['data: first\n\n', 'data: leftover']);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    expect(written).toContain('out:first\n\n');
    // The remaining buffer "data: leftover" should be flushed
    expect(written).toContain('out:leftover\n\n');
    expect(written).toContain('data: [DONE]\n\n');
  });

  it('writes the finalize trailer in place of [DONE] and captures usage from it', async () => {
    // Anthropic SSE self-terminates with message_stop, so we must NOT
    // append the OpenAI [DONE] sentinel afterward — some Anthropic SDKs
    // refuse to parse trailing unknown payloads.
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: chunk1\n\n']);
    const transform = (chunk: string) => `out:${chunk}\n\n`;
    const finalize = () =>
      'event: message_delta\ndata: {"usage":{"input_tokens":7,"output_tokens":3}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const usage = await pipeStream(stream, res as never, transform, finalize);

    const concatenated = written.join('');
    expect(concatenated).toContain('event: message_stop');
    expect(concatenated).not.toContain('data: [DONE]');
    expect(usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3 });
  });

  it('skips the trailer write entirely when the response stream is already ended', async () => {
    // Cubic flagged: client disconnect mid-stream sets writableEnded=true,
    // and a trailing dest.write would throw ERR_STREAM_WRITE_AFTER_END.
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: chunk\n\n']);
    const transform = (chunk: string) => `out:${chunk}\n\n`;
    const finalize = jest.fn().mockReturnValue('event: message_stop\ndata: {}\n\n');

    // Simulate a client disconnect *after* the body is consumed by closing
    // the response immediately when the stream's first `read` resolves.
    let firstRead = true;
    const origReader = stream.getReader.bind(stream);
    (stream as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }).getReader = () => {
      const reader = origReader();
      const origRead = reader.read.bind(reader);
      reader.read = async () => {
        const r = await origRead();
        if (firstRead) {
          firstRead = false;
          res.writableEnded = true;
        }
        return r;
      };
      return reader;
    };

    await pipeStream(stream, res as never, transform, finalize);

    // Finalize was never invoked because the destination was already ended.
    expect(finalize).not.toHaveBeenCalled();
    expect(written.some((w) => w.includes('message_stop'))).toBe(false);
    expect(written.some((w) => w.includes('[DONE]'))).toBe(false);
  });

  it('omits both trailer and [DONE] when finalize returns null (still no OpenAI sentinel)', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: only\n\n']);
    const transform = (chunk: string) => `out:${chunk}\n\n`;
    const finalize = jest.fn().mockReturnValue(null);

    await pipeStream(stream, res as never, transform, finalize);

    expect(finalize).toHaveBeenCalledTimes(1);
    // The `finalize` parameter signals the caller is on a non-OpenAI
    // protocol — even if it returns null we should not fall back to [DONE].
    expect(written.some((w) => w.includes('[DONE]'))).toBe(false);
    expect(written.some((w) => w.startsWith('event: '))).toBe(false);
  });

  it('should not write [DONE] for non-transformed streams', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: test\n\n']);

    await pipeStream(stream, res as never);

    expect(written).not.toContain('data: [DONE]\n\n');
  });

  it('should release the reader lock on completion', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['hello']);

    await pipeStream(stream, res as never);

    // Stream should be consumable again if lock is released
    expect(res.end).toHaveBeenCalled();
  });

  it('should not call end if dest is already ended', async () => {
    const { res } = mockResponse();
    res.writableEnded = true;
    const stream = createReadableStream(['hello']);

    await pipeStream(stream, res as never);

    expect(res.end).not.toHaveBeenCalled();
  });

  it('should stop reading when dest.writableEnded becomes true', async () => {
    const { res, written } = mockResponse();
    let readCount = 0;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        readCount++;
        if (readCount === 1) {
          controller.enqueue(encoder.encode('first'));
        } else if (readCount === 2) {
          // Simulate client disconnect
          (res as Record<string, unknown>).writableEnded = true;
          controller.enqueue(encoder.encode('second'));
        } else {
          controller.enqueue(encoder.encode('should-not-reach'));
        }
      },
    });

    await pipeStream(stream, res as never);

    expect(written).toEqual(['first']);
  });

  it('should handle empty stream', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream([]);

    await pipeStream(stream, res as never);

    expect(written).toEqual([]);
    expect(res.end).toHaveBeenCalled();
  });

  it('should skip [DONE] in remaining flush buffer', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: [DONE]']);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    // [DONE] in remaining should be skipped
    const nonDone = written.filter((w) => w.includes('out:'));
    expect(nonDone).toHaveLength(0);
  });

  it('should stop reading and not write [DONE] when dest.writableEnded with transform', async () => {
    const { res, written } = mockResponse();
    let readCount = 0;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        readCount++;
        if (readCount === 1) {
          controller.enqueue(encoder.encode('data: event1\n\n'));
        } else if (readCount === 2) {
          // Simulate client disconnect mid-stream
          (res as Record<string, unknown>).writableEnded = true;
          controller.enqueue(encoder.encode('data: event2\n\n'));
        } else {
          controller.enqueue(encoder.encode('data: event3\n\n'));
        }
      },
    });

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    // Only event1 should have been transformed and written
    expect(written).toContain('out:event1\n\n');
    // event2 should NOT be written because writableEnded was set before the loop checked
    const hasEvent2 = written.some((w) => w.includes('event2'));
    expect(hasEvent2).toBe(false);
    // [DONE] should NOT be written when dest is already ended
    // (the finally block checks writableEnded before calling end)
  });

  it('should not process SSE events when writableEnded is true from the start with transform', async () => {
    const { res, written } = mockResponse();
    res.writableEnded = true;
    const stream = createReadableStream(['data: event1\n\n']);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    // No SSE events should be transformed and written
    const transformedWrites = written.filter((w) => w.includes('out:'));
    expect(transformedWrites).toHaveLength(0);
    // end should not be called since writableEnded is already true
    expect(res.end).not.toHaveBeenCalled();
  });

  it('should release reader lock even when stream errors out', async () => {
    const { res } = mockResponse();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream read error'));
      },
    });

    await expect(pipeStream(stream, res as never)).rejects.toBeInstanceOf(UpstreamStreamError);

    expect(stream.locked).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('should not write remaining whitespace-only buffer through transform', async () => {
    const { res, written } = mockResponse();
    // Stream ends with only whitespace remaining (no actual event data)
    const stream = createReadableStream(['data: real-event\n\n', '   \n  ']);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    // The real event should be transformed
    expect(written).toContain('out:real-event\n\n');
    // Whitespace-only remaining should NOT produce a transform call
    const spurious = written.filter((w) => w.includes('out:') && !w.includes('real-event'));
    expect(spurious).toHaveLength(0);
  });

  it('should handle transform returning null for remaining buffer', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: keep\n\n', 'data: discard-at-end']);

    const transform = (chunk: string) => (chunk.includes('discard') ? null : `out:${chunk}\n\n`);

    await pipeStream(stream, res as never, transform);

    expect(written).toContain('out:keep\n\n');
    // The remaining buffer "discard-at-end" should be flushed through transform,
    // which returns null, so nothing extra is written
    const hasDiscard = written.some((w) => w.includes('discard'));
    expect(hasDiscard).toBe(false);
    // [DONE] should still be written for transformed streams
    expect(written).toContain('data: [DONE]\n\n');
  });

  it('should ignore trailing unknown raw lines when transforming SSE', async () => {
    const { res, written } = mockResponse();
    const stream = createReadableStream(['data: first\n\n', '{"raw":"remaining"}']);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    expect(written).toContain('out:first\n\n');
    expect(written).not.toContain('out:{"raw":"remaining"}\n\n');
    expect(written).toContain('data: [DONE]\n\n');
  });

  it('should throw when SSE buffer exceeds MAX_SSE_BUFFER_SIZE', async () => {
    const { res } = mockResponse();
    // Create a stream that sends a massive chunk with no event boundary (\n\n)
    const hugeChunk = 'x'.repeat(1_048_577); // 1 byte over the 1MB limit
    const stream = createReadableStream([hugeChunk]);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await expect(pipeStream(stream, res as never, transform)).rejects.toThrow(
      'SSE buffer overflow: provider sent data without event boundaries',
    );
    expect(res.end).toHaveBeenCalled();
  });

  it('should throw when passthrough buffer exceeds MAX_SSE_BUFFER_SIZE', async () => {
    const { res } = mockResponse();
    // Create a stream that sends a massive chunk with no event boundary (\n\n)
    const hugeChunk = 'x'.repeat(1_048_577); // 1 byte over the 1MB limit
    const stream = createReadableStream([hugeChunk]);

    // No transform → passthrough path
    await expect(pipeStream(stream, res as never)).rejects.toThrow(
      'SSE buffer overflow: provider sent data without event boundaries',
    );
    expect(res.end).toHaveBeenCalled();
  });

  it('should handle multiple chunks that split an SSE event with transform', async () => {
    const { res, written } = mockResponse();
    // An SSE event split across two TCP reads
    const stream = createReadableStream(['data: {"part', '":"complete"}\n\n']);

    const transform = (chunk: string) => `out:${chunk}\n\n`;

    await pipeStream(stream, res as never, transform);

    // The event should be reassembled and transformed
    expect(written).toContain('out:{"part":"complete"}\n\n');
    expect(written).toContain('data: [DONE]\n\n');
  });

  it('should capture usage from transformed stream output', async () => {
    const { res } = mockResponse();
    const usageChunk = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 50, cache_read_tokens: 20 },
    });
    const stream = createReadableStream([`data: ${usageChunk}\n\n`]);
    const transform = (chunk: string) => `data: ${chunk}\n\n`;

    const usage = await pipeStream(stream, res as never, transform);

    expect(usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_tokens: 20,
      cache_creation_tokens: undefined,
    });
  });

  it('should capture usage from passthrough stream', async () => {
    const { res } = mockResponse();
    const contentChunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    const usageChunk = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 200, completion_tokens: 80, cache_creation_tokens: 10 },
    })}\n\n`;
    const stream = createReadableStream([contentChunk, usageChunk, 'data: [DONE]\n\n']);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toEqual({
      prompt_tokens: 200,
      completion_tokens: 80,
      cache_read_tokens: undefined,
      cache_creation_tokens: 10,
    });
  });

  it('captures usage from native Responses API named SSE events', async () => {
    const { res, written } = mockResponse();
    const completed =
      'event: response.completed\n' +
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 12,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens: 2,
            total_tokens: 14,
          },
        },
      })}\n\n`;
    const stream = createReadableStream([
      'event: response.created\n' +
        `data: ${JSON.stringify({ type: 'response.created', response: { usage: null } })}\n\n`,
      completed,
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(written.join('')).toContain(completed);
    expect(usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 2,
      cache_read_tokens: 3,
      cache_creation_tokens: 0,
    });
  });

  it('should return null usage when stream has no usage data', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'text' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toBeNull();
  });

  it('should capture usage from passthrough stream with missing completion_tokens', async () => {
    const { res } = mockResponse();
    const usageChunk = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 300 },
    })}\n\n`;
    const stream = createReadableStream([usageChunk, 'data: [DONE]\n\n']);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toEqual({
      prompt_tokens: 300,
      completion_tokens: 0,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('should capture usage from leftover passthrough buffer', async () => {
    const { res } = mockResponse();
    const usagePayload = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 31, completion_tokens: 10, cache_read_tokens: 5 },
    });
    // Final chunk with usage does NOT end with \n\n — stays buffered until stream close.
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `data: ${usagePayload}`,
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toEqual({
      prompt_tokens: 31,
      completion_tokens: 10,
      cache_read_tokens: 5,
      cache_creation_tokens: undefined,
    });
  });

  it('should capture response.usage from leftover passthrough buffer', async () => {
    const { res } = mockResponse();
    const usagePayload = JSON.stringify({
      response: {
        usage: {
          input_tokens: 7,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: 2 },
        },
      },
    });
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `data: ${usagePayload}`,
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 9,
      cache_read_tokens: 2,
      cache_creation_tokens: 0,
    });
  });

  it('captures response.usage from a leftover native Responses API named event', async () => {
    const { res } = mockResponse();
    const usagePayload = JSON.stringify({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 8,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 1 },
        },
      },
    });
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `event: response.completed\ndata: ${usagePayload}`,
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 5,
      cache_read_tokens: 1,
      cache_creation_tokens: 0,
    });
  });

  it('should handle non-JSON leftover in passthrough buffer', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      'data: not-valid-json',
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toBeNull();
  });

  it('should skip [DONE] in passthrough flush buffer', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      'data: [DONE]',
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toBeNull();
  });

  it('should not flush passthrough buffer when whitespace-only', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      '   \n  ',
    ]);

    const usage = await pipeStream(stream, res as never);

    expect(usage).toBeNull();
  });

  it('should capture usage from leftover buffer in flush section with transform', async () => {
    const { res } = mockResponse();
    const usagePayload = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    });
    // Send a chunk that ends mid-event so it stays in the buffer until flush
    const stream = createReadableStream([`data: ${usagePayload}`]);
    const transform = (chunk: string) =>
      `data: ${JSON.stringify({ choices: [], usage: JSON.parse(chunk).usage })}\n\n`;

    const usage = await pipeStream(stream, res as never, transform);

    expect(usage).toEqual(expect.objectContaining({ prompt_tokens: 50, completion_tokens: 25 }));
  });
});

describe('pipePassthrough', () => {
  function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        } else {
          controller.close();
        }
      },
    });
  }

  it('writes upstream SSE bytes through unchanged so framing is preserved', async () => {
    const { res, written } = mockResponse();
    const raw =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n';
    const stream = createReadableStream([raw]);
    const tap = jest.fn(() => null);

    await pipePassthrough(stream, res as never, tap);

    // The original SSE — event: lines, data: prefixes, blank-line
    // separators — round-trips intact. No [DONE] sentinel appended.
    expect(written.join('')).toBe(raw);
  });

  it('passes upstream SSE comments through unchanged without tapping them as events', async () => {
    const { res, written } = mockResponse();
    const raw =
      ': OPENROUTER PROCESSING\n\n' +
      'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n';
    const stream = createReadableStream([raw]);
    const tap = jest.fn(() => 'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n');

    const usage = await pipePassthrough(stream, res as never, tap);

    expect(written.join('')).toBe(raw);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledWith('{"usage":{"prompt_tokens":2,"completion_tokens":1}}');
    expect(usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 1,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('passes raw upstream text to the capture callback', async () => {
    const { res } = mockResponse();
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
    ];
    const stream = createReadableStream(chunks);
    const onClientChunk = jest.fn();

    await pipePassthrough(stream, res as never, () => null, onClientChunk);

    expect(onClientChunk).toHaveBeenCalledTimes(2);
    expect(onClientChunk.mock.calls.map(([chunk]) => chunk).join('')).toBe(chunks.join(''));
  });

  it('runs the tap on each parsed event for telemetry side effects', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream([
      'event: message_start\ndata: {"type":"a"}\n\nevent: message_delta\ndata: {"type":"b"}\n\n',
    ]);
    const seen: string[] = [];
    const tap = jest.fn((event: string) => {
      seen.push(event);
      return null;
    });

    await pipePassthrough(stream, res as never, tap);

    // The payload parser strips `data: ` per line — that's the same shape the
    // Anthropic stream transformer expects.
    expect(seen).toEqual([
      'event: message_start\n{"type":"a"}',
      'event: message_delta\n{"type":"b"}',
    ]);
  });

  it('captures usage from the tap output when it emits an OpenAI-shape chunk', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream([
      'event: message_delta\ndata: {"type":"message_delta"}\n\n',
    ]);
    const tap = jest.fn(
      () =>
        'data: {"usage":{"input_tokens":50,"output_tokens":12,"cache_read_input_tokens":5}}\n\n',
    );

    const usage = await pipePassthrough(stream, res as never, tap);

    expect(usage).toEqual({
      prompt_tokens: 55,
      completion_tokens: 12,
      cache_read_tokens: 5,
      cache_creation_tokens: 0,
    });
  });

  it('returns null when the tap never emits usage', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: {"type":"ping"}\n\n']);
    const tap = jest.fn(() => null);

    const usage = await pipePassthrough(stream, res as never, tap);

    expect(usage).toBeNull();
  });

  it('ignores tap output that has no usage field', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: {"x":1}\n\n']);
    const tap = jest.fn(() => 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n');

    const usage = await pipePassthrough(stream, res as never, tap);

    expect(usage).toBeNull();
  });

  it('flushes a trailing partial event through the tap so a final usage chunk is not lost', async () => {
    const { res } = mockResponse();
    // Upstream closes without the final blank-line separator.
    const stream = createReadableStream([
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}',
    ]);
    const tap = jest.fn(() => 'data: {"usage":{"input_tokens":3,"output_tokens":1}}\n\n');

    const usage = await pipePassthrough(stream, res as never, tap);

    expect(tap).toHaveBeenCalledWith(
      'event: message_delta\n{"type":"message_delta","usage":{"output_tokens":1}}',
    );
    expect(usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 1,
      cache_read_tokens: undefined,
      cache_creation_tokens: 0,
    });
  });

  it('ignores a whitespace-only trailing buffer', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: real\n\n', '   ']);
    const tap = jest.fn(() => null);

    await pipePassthrough(stream, res as never, tap);

    // Only the real event triggers tap; the whitespace tail is silently dropped.
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('skips a trailing [DONE] sentinel in the flush buffer', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: [DONE]']);
    const tap = jest.fn();

    await pipePassthrough(stream, res as never, tap);

    expect(tap).not.toHaveBeenCalled();
  });

  it('bails when the destination is already ended', async () => {
    const { res, written } = mockResponse();
    res.writableEnded = true;
    const stream = createReadableStream(['data: x\n\n']);
    const tap = jest.fn();

    await pipePassthrough(stream, res as never, tap);

    expect(written).toHaveLength(0);
    expect(tap).not.toHaveBeenCalled();
  });

  it('calls dest.end() when the upstream closes cleanly', async () => {
    const { res } = mockResponse();
    const stream = createReadableStream(['data: x\n\n']);
    await pipePassthrough(stream, res as never, () => null);
    expect(res.end).toHaveBeenCalled();
  });

  it('throws when the SSE buffer exceeds the safety limit', async () => {
    const { res } = mockResponse();
    const huge = 'x'.repeat(1_048_577); // 1 MiB + 1 byte
    const stream = createReadableStream([huge]);
    await expect(pipePassthrough(stream, res as never, () => null)).rejects.toThrow(
      'SSE buffer overflow',
    );
  });

  it('leaves the destination open when the upstream reader fails', async () => {
    const { res } = mockResponse();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream disconnected'));
      },
    });

    await expect(pipePassthrough(stream, res as never, () => null)).rejects.toBeInstanceOf(
      UpstreamStreamError,
    );

    expect(stream.locked).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('treats an upstream abort after message_stop as a completed stream', async () => {
    const { res, written } = mockResponse();
    const encoder = new TextEncoder();
    let sentTerminal = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentTerminal) {
          sentTerminal = true;
          controller.enqueue(
            encoder.encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
          );
          return;
        }
        controller.error(new Error('aborted'));
      },
    });

    await expect(
      pipePassthrough(stream, res as never, () => null, undefined, {
        protocol: 'anthropic_messages',
      }),
    ).resolves.toBeNull();
    expect(written.join('')).toContain('message_stop');
    expect(res.end).toHaveBeenCalled();
  });
});

describe('parseUsageObject', () => {
  it('returns null for null/undefined/non-object', () => {
    expect(parseUsageObject(null)).toBeNull();
    expect(parseUsageObject(undefined)).toBeNull();
    expect(parseUsageObject('not an object')).toBeNull();
    expect(parseUsageObject(42)).toBeNull();
  });

  it('returns null when neither prompt_tokens nor input_tokens is present', () => {
    expect(parseUsageObject({ total_tokens: 5 })).toBeNull();
  });

  it('falls back to prompt_tokens_details.cached_tokens when cache_read_tokens is absent', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      cache_read_tokens: 4,
      cache_creation_tokens: undefined,
    });
  });

  it('maps Moonshot top-level cached_tokens to cache reads', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 100,
        completion_tokens: 5,
        cached_tokens: 40,
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 5,
      cache_read_tokens: 40,
      cache_creation_tokens: undefined,
    });
  });

  it('maps DeepSeek prompt cache hit tokens to cache reads', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 120,
        completion_tokens: 8,
        prompt_cache_hit_tokens: 90,
        prompt_cache_miss_tokens: 30,
      }),
    ).toEqual({
      prompt_tokens: 120,
      completion_tokens: 8,
      cache_read_tokens: 90,
      cache_creation_tokens: undefined,
    });
  });

  it('preserves provider-reported OpenAI-compatible usage cost', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 16,
        completion_tokens: 1,
        cost: 0.00005,
        cost_details: { upstream_inference_cost: 0.00000435 },
      }),
    ).toEqual({
      prompt_tokens: 16,
      completion_tokens: 1,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
      reported_cost_usd: 0.00005,
    });
  });

  it('falls back to upstream inference cost when top-level cost is absent', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 16,
        completion_tokens: 1,
        cost_details: { upstream_inference_cost: 0.00000435 },
      }),
    ).toEqual({
      prompt_tokens: 16,
      completion_tokens: 1,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
      reported_cost_usd: 0.00000435,
    });
  });

  it('ignores non-object prompt_tokens_details', () => {
    expect(
      parseUsageObject({ prompt_tokens: 7, completion_tokens: 1, prompt_tokens_details: null }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 1,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('ignores non-numeric cached_tokens in prompt_tokens_details', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 7,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 'oops' },
      }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 1,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('ignores non-object input_tokens_details and missing cached_tokens', () => {
    expect(parseUsageObject({ input_tokens: 3, output_tokens: 2 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      cache_read_tokens: undefined,
      cache_creation_tokens: 0,
    });
    expect(
      parseUsageObject({ input_tokens: 3, output_tokens: 2, input_tokens_details: null }),
    ).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      cache_read_tokens: undefined,
      cache_creation_tokens: 0,
    });
    expect(
      parseUsageObject({
        input_tokens: 3,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 'oops' },
      }),
    ).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      cache_read_tokens: undefined,
      cache_creation_tokens: 0,
    });
  });

  it('passes through cache_creation_tokens for the OpenAI-compat shape', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 5,
        completion_tokens: 5,
        cache_creation_tokens: 11,
      }),
    ).toEqual({
      prompt_tokens: 5,
      completion_tokens: 5,
      cache_read_tokens: undefined,
      cache_creation_tokens: 11,
    });
  });

  it('passes through top-level cache_creation_input_tokens for the OpenAI-compat shape', () => {
    expect(
      parseUsageObject({
        prompt_tokens: 20,
        completion_tokens: 5,
        cache_creation_input_tokens: 9,
      }),
    ).toEqual({
      prompt_tokens: 20,
      completion_tokens: 5,
      cache_read_tokens: undefined,
      cache_creation_tokens: 9,
    });
  });

  it.each([
    ['OpenAI cache_write_tokens', { cache_write_tokens: 7 }],
    ['Qwen cache_creation_input_tokens', { cache_creation_input_tokens: 9 }],
  ])('maps nested %s to cache creation usage', (_label, promptTokensDetails) => {
    expect(
      parseUsageObject({
        prompt_tokens: 20,
        completion_tokens: 5,
        prompt_tokens_details: promptTokensDetails,
      }),
    ).toEqual({
      prompt_tokens: 20,
      completion_tokens: 5,
      cache_read_tokens: undefined,
      cache_creation_tokens: Object.values(promptTokensDetails)[0],
    });
  });

  it('maps Responses cache_write_tokens to cache creation usage', () => {
    expect(
      parseUsageObject({
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 },
      }),
    ).toEqual({
      prompt_tokens: 20,
      completion_tokens: 5,
      cache_read_tokens: 4,
      cache_creation_tokens: 6,
    });
  });

  it('maps Responses cache_creation_input_tokens to cache creation usage', () => {
    expect(
      parseUsageObject({
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 4, cache_creation_input_tokens: 6 },
      }),
    ).toEqual({
      prompt_tokens: 20,
      completion_tokens: 5,
      cache_read_tokens: 4,
      cache_creation_tokens: 6,
    });
  });

  it('defaults output_tokens to 0 in the Anthropic shape when missing', () => {
    expect(parseUsageObject({ input_tokens: 4 })).toEqual({
      prompt_tokens: 4,
      completion_tokens: 0,
      cache_read_tokens: undefined,
      cache_creation_tokens: 0,
    });
  });
});

describe('extractUsageFromSse', () => {
  it('should extract usage from SSE text with data prefix', () => {
    const sseText = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 150, completion_tokens: 60 },
    })}\n\n`;

    expect(extractUsageFromSse(sseText)).toEqual({
      prompt_tokens: 150,
      completion_tokens: 60,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('should return null for SSE text without usage', () => {
    const sseText = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    expect(extractUsageFromSse(sseText)).toBeNull();
  });

  it('should return null for [DONE] event', () => {
    expect(extractUsageFromSse('data: [DONE]\n\n')).toBeNull();
  });

  it('should return null for non-data lines', () => {
    expect(extractUsageFromSse('event: message\nid: 123')).toBeNull();
  });

  it('should handle invalid JSON gracefully', () => {
    expect(extractUsageFromSse('data: {invalid json')).toBeNull();
  });

  it('should default completion_tokens to 0 when missing', () => {
    const sseText = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 100 },
    })}\n\n`;

    expect(extractUsageFromSse(sseText)).toEqual({
      prompt_tokens: 100,
      completion_tokens: 0,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
  });

  it('should extract usage from Responses API usage objects', () => {
    const sseText = `data: ${JSON.stringify({
      usage: {
        input_tokens: 150,
        output_tokens: 60,
        input_tokens_details: { cached_tokens: 25 },
      },
    })}\n\n`;

    expect(extractUsageFromSse(sseText)).toEqual({
      prompt_tokens: 150,
      completion_tokens: 60,
      cache_read_tokens: 25,
      cache_creation_tokens: 0,
    });
  });

  it('should extract cached prompt tokens from prompt_tokens_details (DeepSeek/Z.AI/Mistral shape)', () => {
    const sseText = `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 22,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    })}\n\n`;

    expect(extractUsageFromSse(sseText)).toEqual({
      prompt_tokens: 22,
      completion_tokens: 4,
      cache_read_tokens: 8,
      cache_creation_tokens: undefined,
    });
  });

  it('should prefer top-level cache_read_tokens over prompt_tokens_details when both are present', () => {
    const sseText = `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        cache_read_tokens: 12,
        prompt_tokens_details: { cached_tokens: 99 },
      },
    })}\n\n`;

    expect(extractUsageFromSse(sseText)).toEqual({
      prompt_tokens: 50,
      completion_tokens: 10,
      cache_read_tokens: 12,
      cache_creation_tokens: undefined,
    });
  });

  it('should extract usage from response.completed events', () => {
    const sseText = `data: ${JSON.stringify({
      response: {
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 3 },
        },
      },
    })}\n\n`;

    expect(extractUsageFromSse(sseText)).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      cache_read_tokens: 3,
      cache_creation_tokens: 0,
    });
  });
});
