import { chatToolName, chatTools, responsesToolNames } from '../responses-tools';
import {
  toChatCompletionsRequest,
  fromChatCompletionResponse,
  toNativeResponsesRequest,
} from '../responses-adapter';

const fn = {
  type: 'function',
  name: 'lookup',
  description: 'Lookup',
  parameters: { type: 'object' },
  strict: true,
};
const tools = [
  fn,
  { type: 'namespace', name: 'crm', tools: [fn] },
  { type: 'namespace', name: 'billing', tools: [fn] },
  { type: 'web_search' },
];

describe('Responses namespace tools', () => {
  it('flattens client functions with distinct bounded names and preserves their schemas', () => {
    const names = responsesToolNames(tools);
    const converted = chatTools(tools, names) as any[];
    expect(converted).toHaveLength(3);
    expect(new Set(converted.map((t) => t.function.name)).size).toBe(3);
    expect(converted[0].function.name).toBe('lookup');
    for (const tool of converted) {
      expect(tool.function).toEqual({ ...fn, type: undefined, name: expect.any(String) });
      expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    expect([...names.values()]).toEqual([
      { name: 'lookup', namespace: 'crm' },
      { name: 'lookup', namespace: 'billing' },
      { name: 'lookup' },
    ]);
  });

  it('preserves names on forced calls, parallel history and non-streamed responses', () => {
    const names = responsesToolNames(tools);
    const wireName = [...names.keys()][0];
    const call = {
      type: 'function_call',
      namespace: 'crm',
      name: 'lookup',
      call_id: 'call1',
      arguments: '{}',
    };
    const body = {
      tools,
      input: [
        call,
        { ...call, namespace: 'billing', call_id: 'call2' },
        { type: 'function_call_output', call_id: 'call1', output: 'one' },
        { type: 'function_call_output', call_id: 'call2', output: 'two' },
      ],
      tool_choice: { type: 'function', namespace: 'crm', name: 'lookup' },
    };
    const chat = toChatCompletionsRequest(body) as any;
    expect(chat.tool_choice).toEqual({ type: 'function', function: { name: wireName } });
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0].tool_calls).toHaveLength(2);
    expect(chat.messages[0].tool_calls[0].function.name).toBe(wireName);
    expect(chat.messages[1]).toEqual({ role: 'tool', tool_call_id: 'call1', content: 'one' });
    const response = fromChatCompletionResponse(
      { choices: [{ message: chat.messages[0] }] },
      'auto',
      { toolNames: names },
    );
    expect(response.output).toEqual([
      expect.objectContaining(call),
      expect.objectContaining({ namespace: 'billing', name: 'lookup', call_id: 'call2' }),
    ]);
    expect(toNativeResponsesRequest(body, 'gpt-5').tools).toEqual(tools);
  });

  it('keeps aliases stable for reordered tools and historical calls', () => {
    const name = chatToolName({ namespace: 'crm', name: 'lookup' }, responsesToolNames(tools));
    expect(
      chatToolName({ namespace: 'crm', name: 'lookup' }, responsesToolNames([...tools].reverse())),
    ).toBe(name);
    expect(chatToolName({ namespace: 'crm', name: 'lookup' }, new Map())).toBe(name);
  });

  it('avoids collisions with top-level names and handles long namespace names', () => {
    const ns = { type: 'namespace', name: 'a.'.repeat(100), tools: [fn] };
    const [original] = responsesToolNames([ns]).keys();
    const names = responsesToolNames([ns, { ...fn, name: original }]);
    expect([...names.keys()][0]).not.toBe(original);
    expect([...names.keys()][0]).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('ignores malformed or hosted definitions without failing conversion', () => {
    expect(responsesToolNames(null).size).toBe(0);
    const invalid = [
      null,
      { type: 'namespace' },
      { type: 'namespace', name: 'crm' },
      {
        type: 'namespace',
        name: 'crm',
        tools: [null, { type: 'web_search' }, { type: 'function' }],
      },
    ];
    expect(responsesToolNames(invalid).size).toBe(0);
    expect(
      chatTools(
        [
          null,
          { type: 'namespace' },
          { type: 'namespace', name: 'crm', tools: [null, { type: 'web_search' }] },
        ],
        new Map(),
      ),
    ).toEqual([]);
    expect(chatToolName({}, new Map())).toBe('unknown');
    expect(chatTools([{ type: 'function', name: 'bare' }], new Map())).toEqual([
      { type: 'function', function: { name: 'bare' } },
    ]);
  });
  it.each([{ type: 'web_search' }, { type: 'file_search' }, null, 'invalid'])(
    'omits unsupported tool choices on the chat path: %j',
    (tool_choice) => {
      const body = { tools, input: 'Hello', tool_choice };
      expect(toChatCompletionsRequest(body)).not.toHaveProperty('tool_choice');
      expect(toNativeResponsesRequest(body, 'gpt-5').tool_choice).toEqual(tool_choice);
    },
  );

  it.each(['auto', 'none', 'required'])('preserves the supported %s tool choice', (tool_choice) => {
    expect(toChatCompletionsRequest({ tools, input: 'Hello', tool_choice }).tool_choice).toBe(
      tool_choice,
    );
  });
});
