/**
 * Parallel tool calls from the ChatGPT backend can carry their arguments only on
 * `response.function_call_arguments.done`, with no `.delta` events (#3118).
 */

import { collectChatGptSseResponse, createChatGptStreamTransformer } from './chatgpt-adapter';

function ev(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;
}

function call(outputIndex: number, callId: string, args: string): string[] {
  const item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'get_weather' };
  return [
    ev('response.output_item.added', { output_index: outputIndex, item: { ...item, arguments: '' } }),
    ev('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: outputIndex,
      arguments: args,
    }),
    ev('response.output_item.done', { output_index: outputIndex, item: { ...item, arguments: args } }),
  ];
}

const completed = ev('response.completed', {
  response: { output: [{ type: 'function_call' }, { type: 'function_call' }] },
});

const parallel = [
  ...call(0, 'call_a', '{"city": "Sydney"}'),
  ...call(1, 'call_b', '{"city": "Melbourne"}'),
  completed,
];

function streamedArgs(events: string[]): Record<number, string> {
  const transform = createChatGptStreamTransformer('gpt-5.6-luna');
  const args: Record<number, string> = {};
  for (const e of events) {
    const frame = transform(e);
    if (!frame) continue;
    for (const part of frame.split('\n\n')) {
      if (!part.startsWith('data: {')) continue;
      const delta = JSON.parse(part.slice(6)).choices[0].delta as Record<string, unknown>;
      const toolCalls = (delta.tool_calls ?? []) as Array<{
        index: number;
        function?: { arguments?: string };
      }>;
      for (const tc of toolCalls) {
        args[tc.index] = (args[tc.index] ?? '') + (tc.function?.arguments ?? '');
      }
    }
  }
  return args;
}

describe('ChatGPT parallel tool calls with arguments only on .done', () => {
  it('streams the full arguments for every call', () => {
    expect(streamedArgs(parallel)).toEqual({ 0: '{"city": "Sydney"}', 1: '{"city": "Melbourne"}' });
  });

  it('does not repeat arguments that already streamed as deltas', () => {
    const events = [
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '' },
      }),
      ev('response.function_call_arguments.delta', { output_index: 0, delta: '{"city":' }),
      ev('response.function_call_arguments.delta', { output_index: 0, delta: '"Sydney"}' }),
      ev('response.function_call_arguments.done', { output_index: 0, arguments: '{"city":"Sydney"}' }),
      completed,
    ];
    expect(streamedArgs(events)).toEqual({ 0: '{"city":"Sydney"}' });
  });

  it('streams .done arguments when only empty deltas arrived', () => {
    const events = [
      ev('response.output_item.added', {
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '' },
      }),
      ev('response.function_call_arguments.delta', { output_index: 0, delta: '' }),
      ev('response.function_call_arguments.done', { output_index: 0, arguments: '{"city":"Sydney"}' }),
      completed,
    ];
    expect(streamedArgs(events)).toEqual({ 0: '{"city":"Sydney"}' });
  });

  it('collects the full arguments for a non-streaming request', () => {
    const body = collectChatGptSseResponse(parallel.join('\n\n') + '\n\n', 'gpt-5.6-luna');
    const choices = body.choices as Array<{
      message: { tool_calls: Array<{ function: { arguments: string } }> };
    }>;
    expect(choices[0].message.tool_calls.map((t) => t.function.arguments)).toEqual([
      '{"city": "Sydney"}',
      '{"city": "Melbourne"}',
    ]);
  });
});
