import {
  createResponsesStreamTransformer,
  collectResponsesSseResponse,
} from '../responses-adapter';
import { responsesToolNames } from '../responses-tools';

function events(sse: string): any[] {
  return sse
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
}
function chunk(tool_calls: unknown, content?: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls, content } }] })}\n\n`;
}

describe('Responses streaming tool calls', () => {
  it('streams fragmented parallel calls with unique lifecycle items and replays exact arguments', () => {
    const t = createResponsesStreamTransformer('auto');
    const sse = [
      t.transform(chunk([{ index: 0, id: 'call_a', function: { name: 'look' } }])),
      t.transform(chunk([{ index: 0, function: { name: 'up', arguments: '{"q":' } }], 'Checking.')),
      t.transform(
        chunk([
          { index: 1, id: 'call_b', function: { name: 'other', arguments: '{}' } },
          { index: 0, function: { arguments: '"Paris"}' } },
        ]),
      ),
      t.finalize(),
    ].join('');
    const list = events(sse);
    const output = collectResponsesSseResponse(sse).output as any[];
    expect(output.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call']);
    expect(output[1]).toMatchObject({
      name: 'lookup',
      call_id: 'call_a',
      arguments: '{"q":"Paris"}',
      status: 'completed',
    });
    expect(output[2]).toMatchObject({ name: 'other', call_id: 'call_b', arguments: '{}' });
    const added = list.filter((e) => e.type === 'response.output_item.added');
    expect(added.map((e) => e.output_index)).toEqual([0, 1, 2]);
    expect(added[1].item.name).toBe('lookup');
    for (const item of output.filter((i) => i.type === 'function_call')) {
      const openIndex = list.findIndex(
        (e) => e.type === 'response.output_item.added' && e.item.id === item.id,
      );
      const deltas = list.filter(
        (e) => e.type === 'response.function_call_arguments.delta' && e.item_id === item.id,
      );
      expect(deltas.map((e) => e.delta).join('')).toBe(item.arguments);
      expect(list.indexOf(deltas[0])).toBeGreaterThan(openIndex);
      expect(
        list.find((e) => e.type === 'response.output_item.done' && e.item.id === item.id).item,
      ).toEqual(item);
      expect(
        list.find(
          (e) => e.type === 'response.function_call_arguments.done' && e.item_id === item.id,
        ).arguments,
      ).toBe(item.arguments);
    }
    expect(t.finalize()).toBeNull();
  });

  it('restores namespaces on every item and keeps tool-before-text ordering', () => {
    const names = responsesToolNames([
      { type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'lookup' }] },
    ]);
    const name = [...names.keys()][0];
    const t = createResponsesStreamTransformer('auto', { toolNames: names });
    const sse = [
      t.transform(chunk([{ id: 'call1', function: { name, arguments: '{}' } }])),
      t.transform(chunk(undefined, 'Done')),
      t.finalize(),
    ].join('');
    const output = collectResponsesSseResponse(sse).output as any[];
    expect(output.map((i) => i.type)).toEqual(['function_call', 'message']);
    expect(output[0]).toMatchObject({ name: 'lookup', namespace: 'crm', arguments: '{}' });
    for (const e of events(sse).filter((e) => e.item?.type === 'function_call')) {
      expect(e.item).toMatchObject({ name: 'lookup', namespace: 'crm' });
    }
  });

  it('finishes no-argument calls and tolerates empty or incomplete deltas', () => {
    const t = createResponsesStreamTransformer('auto');
    const sse = [
      t.transform(
        chunk([
          null,
          {},
          { function: { name: 'missing_id' } },
          { index: 1, id: 'call2', function: { name: 'no_args', arguments: '' } },
        ]),
      ),
      t.finalize(),
    ].join('');
    const output = collectResponsesSseResponse(sse).output as any[];
    expect(output).toHaveLength(2);
    expect(output[0].call_id).toEqual(expect.any(String));
    expect(output[1]).toMatchObject({ call_id: 'call2', name: 'no_args', arguments: '' });
  });

  it('does not expose synthetic structured-output tools as client calls', () => {
    const t = createResponsesStreamTransformer('auto', { structuredOutputToolName: 'schema' });
    const sse = [
      t.transform(chunk([{ id: 'call', function: { name: 'schema', arguments: '{}' } }])),
      t.finalize(),
    ].join('');
    expect(collectResponsesSseResponse(sse).output).toEqual([
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'output_text', text: '{}', annotations: [] }],
      }),
    ]);
    expect(events(sse).some((e) => e.type.startsWith('response.function_call'))).toBe(false);
  });

  it('waits for the call id and emits buffered arguments once', () => {
    const t = createResponsesStreamTransformer('auto');
    const sse = [
      t.transform(chunk([{ function: { name: 'lookup', arguments: '{}' } }])),
      t.transform(chunk([{ id: 'late', function: {} }])),
      t.transform(chunk([{ function: {} }])),
      t.finalize(),
    ].join('');
    expect(
      events(sse)
        .filter((e) => e.type === 'response.function_call_arguments.delta')
        .map((e) => e.delta),
    ).toEqual(['{}']);
  });
  it('opens declared parallel calls before arguments and preserves their order', () => {
    const toolNames = responsesToolNames(
      ['first', 'second'].map((name) => ({ type: 'function', name })),
    );
    const t = createResponsesStreamTransformer('auto', { toolNames });
    const opened = t.transform(
      chunk([
        { index: 0, id: 'call0', function: { name: 'first', arguments: '' } },
        { index: 1, id: 'call1', function: { name: 'second', arguments: '' } },
      ]),
    )!;
    expect(
      events(opened)
        .filter((e) => e.type === 'response.output_item.added')
        .map((e) => e.item.name),
    ).toEqual(['first', 'second']);
    const sse = [
      opened,
      t.transform(chunk([{ index: 1, function: { arguments: '{}' } }])),
      t.transform(chunk([{ index: 0, function: { arguments: '{}' } }])),
      t.finalize(),
    ].join('');
    expect((collectResponsesSseResponse(sse).output as any[]).map((i) => i.name)).toEqual([
      'first',
      'second',
    ]);
  });

  it('buffers arguments until a fragmented name matches a declared tool', () => {
    const toolNames = responsesToolNames([{ type: 'function', name: 'lookup' }]);
    const t = createResponsesStreamTransformer('auto', { toolNames });
    const first = t.transform(chunk([{ id: 'call', function: { name: 'look', arguments: '' } }]))!;
    const args = t.transform(chunk([{ function: { arguments: '{"q":"Paris"}' } }])) || '';
    expect(events(first + args).some((e) => e.type === 'response.output_item.added')).toBe(false);
    const sse = [
      first,
      args,
      t.transform(chunk([{ function: { name: 'up' } }])),
      t.finalize(),
    ].join('');
    expect(
      events(sse)
        .filter((e) => e.item?.type === 'function_call')
        .every((e) => e.item.name === 'lookup'),
    ).toBe(true);
    expect((collectResponsesSseResponse(sse).output as any[])[0]).toMatchObject({
      name: 'lookup',
      arguments: '{"q":"Paris"}',
    });
  });
});
