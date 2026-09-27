import { consumeProviderStream } from './playground-stream';
import type { ProviderClient } from '../routing/proxy/provider-client';
import type { ForwardResult } from '../routing/proxy/provider-client';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

type Forward = Pick<ForwardResult, 'isGoogle' | 'isAnthropic' | 'isChatGpt' | 'isCodeAssist'>;
const OPENAI: Forward = { isGoogle: false, isAnthropic: false, isChatGpt: false };

function providerClientStub(over: Partial<ProviderClient> = {}): ProviderClient {
  return {
    convertGoogleStreamChunk: jest.fn(),
    createAnthropicStreamTransformer: jest.fn(),
    createChatGptStreamTransformer: jest.fn(),
    ...over,
  } as unknown as ProviderClient;
}

describe('consumeProviderStream', () => {
  it('accumulates OpenAI passthrough deltas and usage, invoking onDelta per fragment', async () => {
    const deltas: string[] = [];
    const result = await consumeProviderStream(
      sseStream([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ]),
      OPENAI,
      'openai/gpt-4o',
      providerClientStub(),
      (t) => deltas.push(t),
      Date.now(),
    );

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result.content).toBe('Hello');
    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      cache_read_tokens: undefined,
      cache_creation_tokens: undefined,
    });
    expect(result.ttftMs).not.toBeNull();
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ttftMs=null and totalMs from "now" when nothing streamed', async () => {
    const startedAt = Date.now() - 50;
    const result = await consumeProviderStream(
      sseStream(['data: [DONE]\n\n']),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      startedAt,
    );

    expect(result.content).toBe('');
    expect(result.ttftMs).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.totalMs).toBeGreaterThanOrEqual(50);
  });

  it('skips empty data lines and unparseable JSON without throwing', async () => {
    const result = await consumeProviderStream(
      sseStream([
        ': OPENROUTER PROCESSING\n\n',
        'data: \n\n',
        'data: not-json\n\n',
        'event: ping\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      ]),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('ok');
  });

  it('uses the Google chunk converter for Google-format streams', async () => {
    const convertGoogleStreamChunk = jest.fn(
      (_e: string, _m: string): { chunk: string | null } => ({
        chunk: 'data: {"choices":[{"delta":{"content":"G"}}]}\n\n',
      }),
    );
    const pc = providerClientStub({
      convertGoogleStreamChunk: convertGoogleStreamChunk as never,
    });
    const result = await consumeProviderStream(
      sseStream(['data: {"candidates":[]}\n\n']),
      { isGoogle: true, isAnthropic: false, isChatGpt: false },
      'gemini/x',
      pc,
      () => undefined,
      Date.now(),
    );
    expect(convertGoogleStreamChunk).toHaveBeenCalledWith('{"candidates":[]}', 'gemini/x');
    expect(result.content).toBe('G');
  });

  it('unwraps CodeAssist Google stream payloads before conversion', async () => {
    const convertGoogleStreamChunk = jest.fn(
      (_e: string, _m: string): { chunk: string | null } => ({
        chunk: 'data: {"choices":[{"delta":{"content":"C"}}]}\n\n',
      }),
    );
    const pc = providerClientStub({
      convertGoogleStreamChunk: convertGoogleStreamChunk as never,
    });
    const inner = { candidates: [{ content: { parts: [{ text: 'from-codeassist' }] } }] };
    const result = await consumeProviderStream(
      sseStream([`data: ${JSON.stringify({ response: inner, traceId: 'trace-1' })}\n\n`]),
      { isGoogle: true, isAnthropic: false, isChatGpt: false, isCodeAssist: true },
      'gemini/x',
      pc,
      () => undefined,
      Date.now(),
    );

    expect(convertGoogleStreamChunk).toHaveBeenCalledWith(JSON.stringify(inner), 'gemini/x');
    expect(result.content).toBe('C');
  });

  it('skips Google chunks that convert to a null chunk', async () => {
    const pc = providerClientStub({
      convertGoogleStreamChunk: jest.fn(() => ({ chunk: null })) as never,
    });
    const result = await consumeProviderStream(
      sseStream(['data: {"candidates":[]}\n\n']),
      { isGoogle: true, isAnthropic: false, isChatGpt: false },
      'gemini/x',
      pc,
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('');
  });

  it('creates a stateful Anthropic transformer once and feeds events through it', async () => {
    const transformer = jest.fn((e: string): string | null =>
      e.includes('skip') ? null : 'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
    );
    const createAnthropicStreamTransformer = jest.fn(() => transformer);
    const pc = providerClientStub({
      createAnthropicStreamTransformer: createAnthropicStreamTransformer as never,
    });

    const result = await consumeProviderStream(
      sseStream(['data: {"type":"skip"}\n\n', 'data: {"type":"content_block_delta"}\n\n']),
      { isGoogle: false, isAnthropic: true, isChatGpt: false },
      'anthropic/claude',
      pc,
      () => undefined,
      Date.now(),
    );

    expect(createAnthropicStreamTransformer).toHaveBeenCalledTimes(1);
    expect(createAnthropicStreamTransformer).toHaveBeenCalledWith('anthropic/claude');
    expect(transformer).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('A');
  });

  it('uses a per-stream ChatGPT transformer for Responses-format streams', async () => {
    const transformer = jest.fn(
      (): string | null => 'data: {"choices":[{"delta":{"content":"C"}}]}\n\n',
    );
    const createChatGptStreamTransformer = jest.fn(() => transformer);
    const pc = providerClientStub({
      createChatGptStreamTransformer: createChatGptStreamTransformer as never,
    });
    const result = await consumeProviderStream(
      sseStream(['data: {"type":"response.output_text.delta"}\n\n']),
      { isGoogle: false, isAnthropic: false, isChatGpt: true },
      'openai/gpt-5',
      pc,
      () => undefined,
      Date.now(),
    );
    expect(createChatGptStreamTransformer).toHaveBeenCalledWith('openai/gpt-5');
    expect(transformer).toHaveBeenCalled();
    expect(result.content).toBe('C');
  });

  it('skips ChatGPT chunks that convert to null', async () => {
    const pc = providerClientStub({
      createChatGptStreamTransformer: jest.fn(() => jest.fn(() => null)) as never,
    });
    const result = await consumeProviderStream(
      sseStream(['data: {"type":"response.created"}\n\n']),
      { isGoogle: false, isAnthropic: false, isChatGpt: true },
      'openai/gpt-5',
      pc,
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('');
  });

  it('flushes a trailing usage chunk that arrives without a final blank line', async () => {
    const result = await consumeProviderStream(
      // No trailing \n\n on the usage chunk → it sits in the buffer until tail flush.
      sseStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}',
      ]),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('hi');
    expect(result.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 1 });
  });

  it('ignores a trailing [DONE] left in the buffer (no error)', async () => {
    const result = await consumeProviderStream(
      sseStream(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: [DONE]']),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('x');
  });

  it('ignores a tail that is empty after stripping the data prefix', async () => {
    const result = await consumeProviderStream(
      sseStream(['data: {"choices":[{"delta":{"content":"y"}}]}\n\n', 'data: ']),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('y');
  });

  it('throws when the buffer overflows without event boundaries', async () => {
    const huge = 'data: ' + 'x'.repeat(1_048_577);
    await expect(
      consumeProviderStream(
        sseStream([huge]),
        OPENAI,
        'm',
        providerClientStub(),
        () => undefined,
        Date.now(),
      ),
    ).rejects.toThrow(/SSE buffer overflow/);
  });

  it('releases the reader lock even when the stream throws', async () => {
    const body = sseStream(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n']);
    await consumeProviderStream(
      body,
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      Date.now(),
    );
    // Lock was released → a second getReader() must not throw.
    expect(() => body.getReader()).not.toThrow();
  });

  it('handles a chunk split across multiple reads (partial SSE event)', async () => {
    const result = await consumeProviderStream(
      sseStream(['data: {"choices":[{"delta":', '{"content":"split"}}]}\n\n']),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('split');
  });

  it('ignores an inline data:[DONE] line inside a converted multi-line chunk', async () => {
    // The converter emits a chunk that itself contains both a content line and
    // a trailing `data: [DONE]` line — extractDeltas must keep the content and
    // skip the [DONE] sentinel without throwing.
    const pc = providerClientStub({
      convertGoogleStreamChunk: jest.fn(() => ({
        chunk: 'data: {"choices":[{"delta":{"content":"D"}}]}\ndata: [DONE]\n\n',
      })) as never,
    });
    const result = await consumeProviderStream(
      sseStream(['data: {"candidates":[]}\n\n']),
      { isGoogle: true, isAnthropic: false, isChatGpt: false },
      'gemini/x',
      pc,
      () => undefined,
      Date.now(),
    );
    expect(result.content).toBe('D');
  });

  it('records ttft only on the first text delta, not on usage-only chunks', async () => {
    const startedAt = Date.now();
    const result = await consumeProviderStream(
      sseStream([
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":0}}\n\n',
        'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
      ]),
      OPENAI,
      'm',
      providerClientStub(),
      () => undefined,
      startedAt,
    );
    expect(result.ttftMs).not.toBeNull();
    expect(result.content).toBe('late');
  });
});
