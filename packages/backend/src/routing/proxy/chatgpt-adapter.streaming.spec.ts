/**
 * Streaming edge-case tests for the ChatGPT Responses adapter.
 *
 * Focus: tool-call argument deltas that arrive as truncated JSON fragments
 * across multiple SSE chunks. The transformer must NEVER attempt to parse the
 * inner `delta` string — it is meant to be concatenated verbatim into the
 * tool_calls[].function.arguments string and reassembled by the client only
 * once the stream completes.
 *
 * Split out of chatgpt-adapter.spec.ts to keep each file under 300 lines.
 */

import {
  collectChatGptSseResponse,
  createChatGptStreamTransformer,
  transformResponsesStreamChunk,
} from './chatgpt-adapter';

function parseFrame(frame: string | null): Record<string, unknown> | null {
  if (!frame) return null;
  const first = frame.split('\n\n')[0];
  return JSON.parse(first.replace(/^data: /, '')) as Record<string, unknown>;
}

function deltaFromFrame(frame: string | null): string {
  const parsed = parseFrame(frame);
  if (!parsed) throw new Error('expected frame to parse');
  const choices = parsed.choices as Array<Record<string, unknown>>;
  const delta = choices[0].delta as Record<string, unknown>;
  const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
  const fn = toolCalls[0].function as Record<string, unknown>;
  return fn.arguments as string;
}

describe('chatgpt-adapter streaming: truncated tool-call argument JSON', () => {
  describe('transformResponsesStreamChunk forwards partial deltas verbatim', () => {
    it('forwards an incomplete JSON argument fragment unchanged on a single delta', () => {
      // The upstream chunk boundary lands mid-string: '{"arg":"val' has an
      // unterminated string. The transformer must NOT try to parse it — it
      // should just pass the partial text through.
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"arg\\":\\"val"}';
      expect(deltaFromFrame(transformResponsesStreamChunk(chunk, 'gpt-5'))).toBe('{"arg":"val');
    });

    it('forwards the completing fragment on a subsequent delta', () => {
      // The next chunk closes the string + object. The transformer must again
      // forward the literal text — concatenation is the consumer's job.
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"ue\\"}"}';
      expect(deltaFromFrame(transformResponsesStreamChunk(chunk, 'gpt-5'))).toBe('ue"}');
    });

    it('forwards a delta that splits a Unicode escape sequence (\\u00...)', () => {
      // é ('é') split mid-escape: first chunk ends with "\u00".
      // The transformer must pass the half-escape through without throwing.
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"q\\":\\"caf\\\\u00"}';
      expect(deltaFromFrame(transformResponsesStreamChunk(chunk, 'gpt-5'))).toBe('{"q":"caf\\u00');
    });

    it('forwards the completing half of the Unicode escape on the next delta', () => {
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"e9\\"}"}';
      expect(deltaFromFrame(transformResponsesStreamChunk(chunk, 'gpt-5'))).toBe('e9"}');
    });

    it('preserves backslash characters in deltas (escape-only fragment)', () => {
      // A fragment that is literally just a backslash. JSON-encoded as "\\\\"
      // on the wire (envelope JSON encodes one backslash as two characters).
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"\\\\"}';
      expect(deltaFromFrame(transformResponsesStreamChunk(chunk, 'gpt-5'))).toBe('\\');
    });

    it('returns null when the SSE envelope JSON itself is malformed (not the delta)', () => {
      // Truncating the outer envelope (the line after `data: `) is a different
      // failure mode from a truncated delta. The transformer's safeParse catches
      // it and returns null instead of throwing.
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":';
      expect(transformResponsesStreamChunk(chunk, 'gpt-5')).toBeNull();
    });

    it('treats a non-string delta as empty without throwing', () => {
      // If the upstream ever drops the string type (e.g. delta: null), the
      // transformer must coerce to '' rather than emit `null` into the
      // arguments stream — that would otherwise inject the literal string
      // "null" into the consumer's concatenation.
      const chunk =
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":null}';
      expect(deltaFromFrame(transformResponsesStreamChunk(chunk, 'gpt-5'))).toBe('');
    });
  });

  describe('collectChatGptSseResponse reassembles tool-call arguments correctly', () => {
    it('concatenates a JSON fragment that was split mid-string', () => {
      // Reassembles to {"arg":"value"}. Each chunk on its own is invalid JSON
      // because the string is unterminated, but concatenation yields valid
      // JSON. The collector must NOT attempt to parse intermediate state.
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c1","name":"foo"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"arg\\":\\"val"}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"ue\\"}"}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ].join('\n\n');

      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      expect(message.tool_calls).toEqual([
        {
          id: 'c1',
          type: 'function',
          function: { name: 'foo', arguments: '{"arg":"value"}' },
        },
      ]);
      // The reassembled arguments string must itself be parseable JSON.
      const fnArgs = (
        (message.tool_calls as Array<Record<string, unknown>>)[0].function as Record<
          string,
          unknown
        >
      ).arguments as string;
      expect(JSON.parse(fnArgs)).toEqual({ arg: 'value' });
    });

    it('concatenates a fragment split across a Unicode escape sequence', () => {
      // The escape é ('é') is split: ..."caf\u00 | e9"...
      // The collector must keep the bytes intact so the final string is
      // {"q":"café"} after JSON parsing by the consumer.
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c2","name":"search"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"q\\":\\"caf\\\\u00"}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"e9\\"}"}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ].join('\n\n');

      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      const fnArgs = (toolCalls[0].function as Record<string, unknown>).arguments as string;
      // Concatenated literal text first.
      expect(fnArgs).toBe('{"q":"caf\\u00e9"}');
      // Then verify the consumer can parse it into 'café'.
      expect(JSON.parse(fnArgs)).toEqual({ q: 'café' });
    });

    it('reassembles many small (1-3 char) fragments into valid JSON', () => {
      // Stress: every chunk boundary is intentionally inside JSON syntax — a
      // worst-case streaming scenario.
      const parts = ['{', '"a"', ':', '[', '1', ',', '2', ',', '3', ']', '}'];
      const events = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"cN","name":"f"}}',
        ...parts.map((p) => {
          // Each part must be JSON-encoded inside the envelope. Use
          // JSON.stringify on the envelope itself to handle escaping correctly.
          return `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
            output_index: 0,
            delta: p,
          })}`;
        }),
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ];

      const out = collectChatGptSseResponse(events.join('\n\n'), 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      const fnArgs = (toolCalls[0].function as Record<string, unknown>).arguments as string;
      expect(fnArgs).toBe('{"a":[1,2,3]}');
      expect(JSON.parse(fnArgs)).toEqual({ a: [1, 2, 3] });
    });

    it('keeps empty-string deltas as no-ops (does not append "undefined" or "null")', () => {
      // An empty delta between two real deltas must contribute nothing — the
      // final arguments string must be {"x":1}, not {"x":1}undefined.
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c3","name":"foo"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"x\\":"}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":""}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"1}"}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ].join('\n\n');

      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      const fnArgs = (toolCalls[0].function as Record<string, unknown>).arguments as string;
      expect(fnArgs).toBe('{"x":1}');
      expect(JSON.parse(fnArgs)).toEqual({ x: 1 });
    });

    it('coerces a non-string delta value to empty when concatenating', () => {
      // If upstream sends `"delta": null` between two real deltas, the
      // arguments string must still be valid JSON. The risk: a naive
      // implementation might concatenate the literal "null".
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c4","name":"foo"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"y\\":"}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":null}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"2}"}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ].join('\n\n');

      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      const fnArgs = (toolCalls[0].function as Record<string, unknown>).arguments as string;
      expect(fnArgs).toBe('{"y":2}');
      expect(JSON.parse(fnArgs)).toEqual({ y: 2 });
    });

    it('drops only the envelope-malformed delta and keeps surrounding deltas intact', () => {
      // If the outer SSE envelope JSON is broken on one event, that event is
      // discarded by safeParse but the surrounding deltas must still arrive
      // intact. This is the recovery path for occasional upstream corruption.
      const sse = [
        'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c5","name":"foo"}}',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"k\\":"}',
        'event: response.function_call_arguments.delta\ndata: this-is-not-json',
        'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"42}"}',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
      ].join('\n\n');

      const out = collectChatGptSseResponse(sse, 'gpt-5');
      const choices = out.choices as Array<Record<string, unknown>>;
      const message = choices[0].message as Record<string, unknown>;
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      const fnArgs = (toolCalls[0].function as Record<string, unknown>).arguments as string;
      // The middle event is dropped; the two valid deltas still concatenate.
      expect(fnArgs).toBe('{"k":42}');
      expect(JSON.parse(fnArgs)).toEqual({ k: 42 });
    });
  });
});

describe('chatgpt-adapter streaming: finish_reason with empty response.completed output', () => {
  it('emits finish_reason tool_calls when the tool call streamed before completed (output: [])', () => {
    // GPT/Codex Responses streams frequently emit response.completed with an
    // empty output array — the tool call was already streamed earlier via
    // response.output_item.added + response.function_call_arguments.delta.
    // Inspecting only the completed payload mislabels this as "stop", which
    // makes OpenAI Chat Completions clients end the turn without executing
    // the tool. The transformer tracks tool calls across the whole stream.
    const stream = createChatGptStreamTransformer('gpt-5');
    const seen: string[] = [];
    for (const chunk of [
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read_file"}}',
      'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"path\\":\\"/tmp/test.txt\\"}"}',
      'event: response.completed\ndata: {"response":{"output":[]}}',
    ]) {
      const out = stream(chunk);
      if (out) seen.push(out);
    }
    const final = seen[seen.length - 1];
    expect(final).toContain('"finish_reason":"tool_calls"');
  });

  it('still emits finish_reason stop for a plain text completion', () => {
    // Guard against the fix leaking: a stream that produced only text must
    // keep finishing as "stop".
    const stream = createChatGptStreamTransformer('gpt-5');
    const seen: string[] = [];
    for (const chunk of [
      'event: response.output_text.delta\ndata: {"delta":"hello"}',
      'event: response.completed\ndata: {"response":{"output":[{"type":"output_text","text":"hello"}]}}',
    ]) {
      const out = stream(chunk);
      if (out) seen.push(out);
    }
    const final = seen[seen.length - 1];
    expect(final).toContain('"finish_reason":"stop"');
  });

  it('keeps finish_reason tool_calls when completed payload still contains the function call', () => {
    // Isolate the completed-payload path: without a preceding streamed tool
    // call, this assertion specifically guards hasFunctionCalls.
    const stream = createChatGptStreamTransformer('gpt-5');
    const seen: string[] = [];
    for (const chunk of [
      'event: response.completed\ndata: {"response":{"output":[{"type":"function_call"}]}}',
    ]) {
      const out = stream(chunk);
      if (out) seen.push(out);
    }
    const final = seen[seen.length - 1];
    expect(final).toContain('"finish_reason":"tool_calls"');
  });
});
