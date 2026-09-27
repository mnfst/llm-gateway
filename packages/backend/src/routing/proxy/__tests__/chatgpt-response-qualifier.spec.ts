import { collectChatGptSseResponse } from '../chatgpt-adapter';
import {
  DEFAULT_CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS,
  parseCodexSemanticOutputTimeoutMs,
  qualifyChatGptResponse,
} from '../chatgpt-response-qualifier';

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function codexResponse(sse: string, headers?: Record<string, string>): Response {
  return new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function chunkedCodexResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('qualifyChatGptResponse', () => {
  it('replays a normal stream unchanged after the first text delta', async () => {
    const sse = [
      event('response.created', { response: { id: 'resp_1' } }),
      event('response.output_text.delta', { delta: 'Hello' }),
      event('response.completed', {
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
        },
      }),
      'data: [DONE]\n\n',
    ].join('');

    const response = await qualifyChatGptResponse(codexResponse(sse), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(sse);
  });

  it('continues streaming chunks that arrive after qualification', async () => {
    const first = event('response.output_text.delta', { delta: 'Hello' });
    const second = event('response.completed', {
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
      },
    });

    const response = await qualifyChatGptResponse(chunkedCodexResponse([first, second]), {
      downstreamFormat: 'chat-completions',
    });

    await expect(response.text()).resolves.toBe(first + second);
  });

  it('recognizes a streamed tool declaration as deliverable output', async () => {
    const added = event('response.output_item.added', {
      output_index: 0,
      item: { type: 'function_call', call_id: 'call_1', name: 'search' },
    });

    const response = await qualifyChatGptResponse(codexResponse(added), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(added);
  });

  it('turns an empty completed event into a retryable HTTP failure', async () => {
    const response = await qualifyChatGptResponse(
      codexResponse(event('response.completed', { response: { output: [] } }), {
        'x-codex-turn-state': 'turn-1',
      }),
      { downstreamFormat: 'chat-completions' },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('x-codex-turn-state')).toBe('turn-1');
    await expect(response.json()).resolves.toEqual({
      error: {
        message: 'ChatGPT Codex completed without text or tool output',
        type: 'upstream_response_error',
        code: 'empty_response',
      },
    });
  });

  it('does not treat reasoning-only output as a usable assistant response', async () => {
    const sse = [
      event('response.reasoning_summary.delta', { delta: 'Internal reasoning' }),
      event('response.completed', {
        response: {
          output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Internal reasoning' }] },
          ],
        },
      }),
    ].join('');

    const response = await qualifyChatGptResponse(codexResponse(sse), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(502);
  });

  it('keeps incomplete terminal events valid instead of bypassing content filtering', async () => {
    const incomplete = event('response.incomplete', {
      response: { incomplete_details: { reason: 'content_filter' } },
    });

    const response = await qualifyChatGptResponse(codexResponse(incomplete), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(incomplete);
  });

  it('recovers full terminal text when Codex omitted its delta events', async () => {
    const completed = `id: event_1\n${event('response.completed', {
      response: {
        output: [
          {
            id: 'msg_1',
            type: 'message',
            content: [{ type: 'output_text', text: 'Recovered answer' }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    })}`;

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'chat-completions',
    });
    const recoveredSse = await response.text();
    const collected = collectChatGptSseResponse(recoveredSse, 'gpt-5');

    expect(response.status).toBe(200);
    expect(recoveredSse).toContain('event: response.output_text.delta');
    expect(collected).toMatchObject({
      choices: [{ message: { content: 'Recovered answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  it('recovers terminal reasoning alongside text and ignores malformed content parts', async () => {
    const completed = event('response.completed', {
      response: {
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
            summary: [null, { text: 42 }, { text: 'Reasoning summary' }],
          },
          {
            type: 'message',
            content: [
              null,
              { type: 'output_text', text: '' },
              { type: 'output_text', text: 'Answer' },
            ],
          },
        ],
      },
    });

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'chat-completions',
    });
    const collected = collectChatGptSseResponse(await response.text(), 'gpt-5');

    expect(collected).toMatchObject({
      choices: [
        {
          message: { content: 'Answer', reasoning_content: 'Reasoning summary' },
        },
      ],
    });
  });

  it('recovers a full terminal tool call when Codex omitted its delta events', async () => {
    const completed = event('response.completed', {
      response: {
        output: [
          {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
        ],
      },
    });

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'chat-completions',
    });
    const collected = collectChatGptSseResponse(await response.text(), 'gpt-5');

    expect(response.status).toBe(200);
    expect(collected).toMatchObject({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
    });
  });

  it('recovers a terminal tool call with empty arguments', async () => {
    const completed = event('response.completed', {
      response: {
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '',
          },
        ],
      },
    });

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.not.toContain('response.function_call_arguments.delta');
  });

  it('recovers output when optional reasoning and tool metadata is absent', async () => {
    const completed = event('response.completed', {
      response: {
        output: [
          { type: 'reasoning', summary: 'invalid' },
          { type: 'reasoning', summary: [{ text: 'Reasoning without an id' }] },
          { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
        ],
      },
    });

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'chat-completions',
    });
    const recovered = await response.text();

    expect(response.status).toBe(200);
    expect(recovered).toContain('Reasoning without an id');
    expect(recovered).toContain('response.function_call_arguments.delta');
  });

  it('maps a failed SSE event to its HTTP status before fallback selection', async () => {
    const failed = event('response.failed', {
      response: {
        error: { code: 'rate_limit_exceeded', message: 'Too many requests' },
      },
    });

    const response = await qualifyChatGptResponse(codexResponse(failed), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: { message: 'Too many requests', code: 'rate_limit_exceeded' },
    });
  });

  it('keeps terminal-only Responses output in the native protocol', async () => {
    const completed = event('response.completed', {
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Native answer' }] }],
      },
    });

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'responses',
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(completed);
  });

  it('handles a terminal event completed by the parser flush', async () => {
    const completed = event('response.completed', {
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Native answer' }] }],
      },
    }).trimEnd();

    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'responses',
    });

    expect(response.status).toBe(200);
  });

  it('returns upstream HTTP failures unchanged', async () => {
    const upstream = new Response('rate limited', { status: 429 });

    const response = await qualifyChatGptResponse(upstream, {
      downstreamFormat: 'chat-completions',
    });

    expect(response).toBe(upstream);
  });

  it('rejects a successful status with no response body', async () => {
    const response = await qualifyChatGptResponse(new Response(null, { status: 204 }), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(502);
  });

  it('rejects a stream that ends without any Responses events', async () => {
    const response = await qualifyChatGptResponse(codexResponse('not an SSE event'), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'empty_response' } });
  });

  it('ignores malformed and non-deliverable Responses events', async () => {
    const malformed = [
      'data: {"type":"response.created"}\n\n',
      'event: response.created\ndata: not-json\n\n',
      event('response.output_item.added', { item: null }),
      event('response.completed', { response: { output: [] } }),
    ].join('');

    const response = await qualifyChatGptResponse(codexResponse(malformed), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(502);
  });

  it.each([
    ['missing terminal response', event('response.completed', {})],
    ['malformed terminal output', event('response.completed', { response: { output: null } })],
  ])('rejects %s', async (_case, completed) => {
    const response = await qualifyChatGptResponse(codexResponse(completed), {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(502);
  });

  it('times out while waiting for semantic output', async () => {
    const hanging = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          // Keep the read pending until the qualifier cancels it on timeout.
        },
      }),
      { status: 200 },
    );

    const response = await qualifyChatGptResponse(hanging, {
      downstreamFormat: 'chat-completions',
      timeoutMs: 5,
    });

    expect(response.status).toBe(504);
  });

  it('applies the semantic-output timeout across non-deliverable chunks', async () => {
    jest.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const reasoning = event('response.reasoning_summary.delta', { delta: 'Still thinking' });
      const source = new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 4));
            controller.enqueue(encoder.encode(reasoning));
          },
        }),
        { status: 200 },
      );

      const pending = qualifyChatGptResponse(source, {
        downstreamFormat: 'chat-completions',
        timeoutMs: 10,
      });
      await jest.advanceTimersByTimeAsync(10);

      const response = await pending;
      expect(response.status).toBe(504);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds non-output data buffered before qualification', async () => {
    const response = await qualifyChatGptResponse(codexResponse('noise'), {
      downstreamFormat: 'chat-completions',
      maxBufferSize: 4,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'stream_buffer_overflow' },
    });
  });

  it('maps source stream errors to an HTTP failure', async () => {
    const failed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('socket closed'));
        },
      }),
      { status: 200 },
    );

    const response = await qualifyChatGptResponse(failed, {
      downstreamFormat: 'chat-completions',
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'ChatGPT Codex stream failed before producing output',
        code: 'upstream_stream_error',
      },
    });
  });

  it('propagates source errors that happen after qualification', async () => {
    let pullCount = 0;
    const source = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount++ === 0) {
            controller.enqueue(
              new TextEncoder().encode(event('response.output_text.delta', { delta: 'Hello' })),
            );
          } else {
            controller.error(new Error('stream failed later'));
          }
        },
      }),
      { status: 200 },
    );
    const response = await qualifyChatGptResponse(source, {
      downstreamFormat: 'chat-completions',
    });

    await expect(response.text()).rejects.toThrow('stream failed later');
  });

  it('cancels the source when the qualified response is cancelled', async () => {
    let cancelled = false;
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(event('response.output_text.delta', { delta: 'Hello' })),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
    const response = await qualifyChatGptResponse(source, {
      downstreamFormat: 'chat-completions',
    });

    await response.body?.cancel('client disconnected');

    expect(cancelled).toBe(true);
  });
});

describe('parseCodexSemanticOutputTimeoutMs', () => {
  it('accepts a positive integer', () => {
    expect(parseCodexSemanticOutputTimeoutMs('90000')).toBe(90_000);
    expect(parseCodexSemanticOutputTimeoutMs('2147483647')).toBe(2_147_483_647);
  });

  it.each([undefined, '', '0', '-1', '1.5', '12abc', '2147483648', 'invalid'])(
    'uses the default for %p',
    (value) => {
      expect(parseCodexSemanticOutputTimeoutMs(value)).toBe(
        DEFAULT_CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS,
      );
    },
  );
});
