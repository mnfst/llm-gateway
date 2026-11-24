/**
 * Responses stream events as Bedrock Runtime sends them: the frames carry no
 * `event:` line (the type is only in `data.type`), and a reasoning item takes
 * `output_index` 0, so the first function_call arrives at `output_index` 1. The
 * Chat Completions stream built from them must name events by `data.type` and
 * number tool calls densely from 0, which is what the OpenAI SDK accumulates by.
 */

import { createChatGptStreamTransformer, transformResponsesStreamChunk } from '../chatgpt-adapter';

const MODEL = 'us.openai.gpt-6-luna';

type Payload = Record<string, unknown> & { type: string };

/** A frame as Bedrock Runtime sends it: `data:` only. */
function bare(payload: Payload): string {
  return `data: ${JSON.stringify(payload)}`;
}

/** The same event with the `event:` line OpenAI and the Codex backend add. */
function named(payload: Payload): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}`;
}

interface ParsedChoice {
  delta: Record<string, unknown>;
  finish_reason: string | null;
  usage?: Record<string, unknown>;
}

/** Every Chat Completions chunk inside the frames a transformer returned. */
function parseOutput(output: string | null): ParsedChoice[] {
  if (!output) return [];
  return output
    .split('\n\n')
    .filter((part) => part.startsWith('data: ') && !part.includes('[DONE]'))
    .map((part) => {
      const chunk = JSON.parse(part.slice('data: '.length)) as {
        choices: { delta: Record<string, unknown>; finish_reason: string | null }[];
        usage?: Record<string, unknown>;
      };
      return {
        delta: chunk.choices[0].delta,
        finish_reason: chunk.choices[0].finish_reason,
        ...(chunk.usage ? { usage: chunk.usage } : {}),
      };
    });
}

function runStream(frames: string[]): ParsedChoice[] {
  const transform = createChatGptStreamTransformer(MODEL);
  return frames.flatMap((frame) => parseOutput(transform(frame)));
}

type ToolCallDelta = {
  index: number;
  id?: string;
  type?: string;
  function?: Record<string, string>;
};

function toolCallsOf(choices: ParsedChoice[]): ToolCallDelta[] {
  return choices.flatMap(
    (choice) => (choice.delta.tool_calls as ToolCallDelta[] | undefined) ?? [],
  );
}

const created: Payload = {
  type: 'response.created',
  response: { id: 'resp_test', status: 'in_progress' },
};

const reasoningAdded = (outputIndex: number): Payload => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: { type: 'reasoning', id: 'rs_test', summary: [] },
});

const reasoningDelta = (outputIndex: number, delta: string): Payload => ({
  type: 'response.reasoning_summary_text.delta',
  item_id: 'rs_test',
  output_index: outputIndex,
  summary_index: 0,
  delta,
});

const messageAdded = (outputIndex: number): Payload => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: { type: 'message', id: 'msg_test', role: 'assistant', content: [] },
});

const textDelta = (outputIndex: number, delta: string): Payload => ({
  type: 'response.output_text.delta',
  item_id: 'msg_test',
  output_index: outputIndex,
  content_index: 0,
  delta,
});

const callAdded = (outputIndex: number, callId: string, name: string): Payload => ({
  type: 'response.output_item.added',
  output_index: outputIndex,
  item: {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: '',
    status: 'in_progress',
  },
});

const argsDelta = (outputIndex: number, delta: string): Payload => ({
  type: 'response.function_call_arguments.delta',
  output_index: outputIndex,
  delta,
});

const argsDone = (outputIndex: number, args: string): Payload => ({
  type: 'response.function_call_arguments.done',
  output_index: outputIndex,
  arguments: args,
});

const completed = (output: Record<string, unknown>[]): Payload => ({
  type: 'response.completed',
  response: {
    id: 'resp_test',
    status: 'completed',
    output,
    usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
  },
});

const reasoningOutput = {
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Checking.' }],
};
const callOutput = (callId: string, name: string, args: string) => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: args,
});

describe('Responses stream frames without an event: line', () => {
  it('reads a text stream from data.type alone', () => {
    const choices = runStream(
      [
        created,
        messageAdded(0),
        textDelta(0, 'Hel'),
        textDelta(0, 'lo'),
        completed([{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }]),
      ].map(bare),
    );

    expect(choices.map((c) => c.delta.content).filter((c) => c !== undefined)).toEqual([
      'Hel',
      'lo',
    ]);
    const finish = choices[choices.length - 1];
    expect(finish.finish_reason).toBe('stop');
    expect(finish.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 34 });
  });

  it('reads reasoning summary deltas from data.type alone', () => {
    const choices = runStream(
      [
        created,
        reasoningAdded(0),
        reasoningDelta(0, 'Check '),
        reasoningDelta(0, 'units.'),
        completed([reasoningOutput]),
      ].map(bare),
    );

    expect(choices.map((c) => c.delta.reasoning_content).filter(Boolean)).toEqual([
      'Check ',
      'units.',
    ]);
  });

  it('reads a function call announcement, argument deltas and completion from data.type alone', () => {
    const choices = runStream(
      [
        created,
        callAdded(0, 'call_1', 'get_weather'),
        argsDelta(0, '{"city":'),
        argsDelta(0, '"Paris"}'),
        argsDone(0, '{"city":"Paris"}'),
        completed([callOutput('call_1', 'get_weather', '{"city":"Paris"}')]),
      ].map(bare),
    );

    expect(toolCallsOf(choices)).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '' },
      },
      { index: 0, function: { arguments: '{"city":' } },
      { index: 0, function: { arguments: '"Paris"}' } },
    ]);
    expect(choices[choices.length - 1].finish_reason).toBe('tool_calls');
  });

  it('reads a response.incomplete terminal event from data.type alone', () => {
    const choices = runStream(
      [
        textDelta(0, 'Partial'),
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        } as Payload,
      ].map(bare),
    );

    expect(choices[choices.length - 1].finish_reason).toBe('length');
  });

  it('reads an error event from data.type alone', () => {
    const transform = createChatGptStreamTransformer(MODEL);
    const out = transform(
      bare({ type: 'error', code: 'server_error', message: 'upstream exploded' }),
    );

    expect(out).toContain('upstream exploded');
    expect(out).toContain('[DONE]');
  });

  it('keeps ignoring a frame whose type is not recognised', () => {
    const transform = createChatGptStreamTransformer(MODEL);

    expect(transform(bare({ type: 'response.something_new', value: 1 }))).toBeNull();
    expect(transform('data: {"value":1}')).toBeNull();
    expect(transform('data: not json')).toBeNull();
    expect(transform('data: [DONE]')).toBeNull();
    expect(transform(': keep-alive')).toBeNull();
    expect(transform('')).toBeNull();
  });

  it('ignores a non-string data.type', () => {
    const transform = createChatGptStreamTransformer(MODEL);

    expect(transform('data: {"type":5,"delta":"x"}')).toBeNull();
    expect(transform('data: {"type":null,"delta":"x"}')).toBeNull();
  });
});

describe('dense tool call index in the Chat Completions stream', () => {
  describe.each([
    ['without event lines', bare],
    ['with event lines', named],
  ])('%s', (_label, wire) => {
    it('numbers a function call after a reasoning item from 0', () => {
      const choices = runStream(
        [
          created,
          reasoningAdded(0),
          reasoningDelta(0, 'Check units.'),
          callAdded(1, 'call_1', 'get_weather'),
          argsDelta(1, '{"city":'),
          argsDelta(1, '"Paris"}'),
          argsDone(1, '{"city":"Paris"}'),
          completed([reasoningOutput, callOutput('call_1', 'get_weather', '{"city":"Paris"}')]),
        ].map(wire),
      );

      expect(toolCallsOf(choices)).toEqual([
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
        { index: 0, function: { arguments: '{"city":' } },
        { index: 0, function: { arguments: '"Paris"}' } },
      ]);
      expect(choices.map((c) => c.delta.reasoning_content).filter(Boolean)).toEqual([
        'Check units.',
      ]);
      expect(choices[choices.length - 1].finish_reason).toBe('tool_calls');
    });

    it('numbers two function calls at output_index 1 and 2 as 0 and 1', () => {
      const choices = runStream(
        [
          reasoningAdded(0),
          callAdded(1, 'call_1', 'get_weather'),
          argsDelta(1, '{"city":"Paris"}'),
          callAdded(2, 'call_2', 'get_time'),
          argsDelta(2, '{"tz":"UTC"}'),
          completed([
            reasoningOutput,
            callOutput('call_1', 'get_weather', '{"city":"Paris"}'),
            callOutput('call_2', 'get_time', '{"tz":"UTC"}'),
          ]),
        ].map(wire),
      );

      expect(toolCallsOf(choices)).toEqual([
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
        { index: 0, function: { arguments: '{"city":"Paris"}' } },
        { index: 1, id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '' } },
        { index: 1, function: { arguments: '{"tz":"UTC"}' } },
      ]);
    });

    it('skips non-function output items when numbering', () => {
      const choices = runStream(
        [
          reasoningAdded(0),
          messageAdded(1),
          textDelta(1, 'Looking it up.'),
          callAdded(2, 'call_1', 'get_weather'),
          argsDelta(2, '{}'),
          callAdded(4, 'call_2', 'get_time'),
          argsDelta(4, '{}'),
        ].map(wire),
      );

      expect(toolCallsOf(choices).map((call) => call.index)).toEqual([0, 0, 1, 1]);
    });

    it('keeps interleaved argument deltas on the call they belong to', () => {
      const choices = runStream(
        [
          reasoningAdded(0),
          callAdded(1, 'call_1', 'get_weather'),
          callAdded(2, 'call_2', 'get_time'),
          argsDelta(1, '{"city":'),
          argsDelta(2, '{"tz":'),
          argsDelta(1, '"Paris"}'),
          argsDelta(2, '"UTC"}'),
        ].map(wire),
      );

      const deltas = toolCallsOf(choices).filter((call) => call.function?.arguments);
      expect(deltas).toEqual([
        { index: 0, function: { arguments: '{"city":' } },
        { index: 1, function: { arguments: '{"tz":' } },
        { index: 0, function: { arguments: '"Paris"}' } },
        { index: 1, function: { arguments: '"UTC"}' } },
      ]);
    });

    it('keeps a delta that arrives before its announcement aligned with it', () => {
      const choices = runStream(
        [
          reasoningAdded(0),
          callAdded(1, 'call_1', 'get_weather'),
          argsDelta(2, '{"tz":'),
          callAdded(2, 'call_2', 'get_time'),
          argsDelta(2, '"UTC"}'),
        ].map(wire),
      );

      expect(toolCallsOf(choices)).toEqual([
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
        { index: 1, function: { arguments: '{"tz":' } },
        { index: 1, id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '' } },
        { index: 1, function: { arguments: '"UTC"}' } },
      ]);
    });

    it('starts every stream from 0', () => {
      const first = runStream([reasoningAdded(0), callAdded(1, 'call_1', 'get_weather')].map(wire));
      const second = runStream([reasoningAdded(0), callAdded(1, 'call_9', 'get_time')].map(wire));

      expect(toolCallsOf(first)[0].index).toBe(0);
      expect(toolCallsOf(second)[0].index).toBe(0);
    });

    it('keeps index 0 when the function call is the first output item', () => {
      const choices = runStream(
        [
          callAdded(0, 'call_1', 'get_weather'),
          argsDelta(0, '{}'),
          completed([callOutput('call_1', 'get_weather', '{}')]),
        ].map(wire),
      );

      expect(toolCallsOf(choices).map((call) => call.index)).toEqual([0, 0]);
      expect(choices[choices.length - 1].finish_reason).toBe('tool_calls');
    });

    it('streams a text answer unchanged', () => {
      const choices = runStream(
        [
          created,
          reasoningAdded(0),
          reasoningDelta(0, 'Think.'),
          messageAdded(1),
          textDelta(1, 'Sunny'),
          completed([
            reasoningOutput,
            { type: 'message', content: [{ type: 'output_text', text: 'Sunny' }] },
          ]),
        ].map(wire),
      );

      expect(choices.map((c) => c.delta.content).filter((c) => c !== undefined)).toEqual(['Sunny']);
      expect(toolCallsOf(choices)).toEqual([]);
      expect(choices[choices.length - 1].finish_reason).toBe('stop');
    });
  });

  describe('without stream state', () => {
    it('keeps the raw output_index', () => {
      const announce = transformResponsesStreamChunk(
        named(callAdded(1, 'call_1', 'get_weather')),
        MODEL,
      );
      const delta = transformResponsesStreamChunk(named(argsDelta(1, '{}')), MODEL);
      const later = transformResponsesStreamChunk(named(argsDelta(2, '{}')), MODEL);

      expect(toolCallsOf(parseOutput(announce))[0].index).toBe(1);
      expect(toolCallsOf(parseOutput(delta))[0].index).toBe(1);
      expect(toolCallsOf(parseOutput(later))[0].index).toBe(2);
    });

    it('defaults to index 0 when the event has no output_index', () => {
      const delta = transformResponsesStreamChunk(
        named({ type: 'response.function_call_arguments.delta', delta: '{}' }),
        MODEL,
      );

      expect(toolCallsOf(parseOutput(delta))[0].index).toBe(0);
    });

    it('defaults to index 0 when a function call announcement has no output_index', () => {
      const announce = transformResponsesStreamChunk(
        named({
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'call_1', name: 'get_weather' },
        }),
        MODEL,
      );

      expect(toolCallsOf(parseOutput(announce))[0].index).toBe(0);
    });

    it('reads data.type without an event line and keeps the raw output_index', () => {
      const announce = transformResponsesStreamChunk(
        bare(callAdded(1, 'call_1', 'get_weather')),
        MODEL,
      );

      expect(toolCallsOf(parseOutput(announce))[0].index).toBe(1);
    });
  });
});
