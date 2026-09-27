import { injectOpenAiMessageCacheControl, injectOpenRouterCacheControl } from './cache-injection';

const EPHEMERAL = { type: 'ephemeral' } as const;

describe('injectOpenRouterCacheControl', () => {
  it('is a no-op when the body has no messages array', () => {
    const body: Record<string, unknown> = {};
    injectOpenRouterCacheControl(body);
    expect(body).toEqual({});
  });

  it('converts a string system message into a text block with cache_control', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    };
    injectOpenRouterCacheControl(body);
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: EPHEMERAL,
        },
      ],
    });
    // User message is untouched.
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('handles developer-role messages the same as system', () => {
    const body = {
      messages: [{ role: 'developer', content: 'system-ish' }],
    };
    injectOpenRouterCacheControl(body);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'system-ish', cache_control: EPHEMERAL },
    ]);
  });

  it('injects cache_control on the last block of a multi-block array content', () => {
    const body = {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      ],
    };
    injectOpenRouterCacheControl(body);
    const blocks = body.messages[0].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'first' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'second', cache_control: EPHEMERAL });
  });

  it('only mutates the last system/developer message', () => {
    const body = {
      messages: [
        { role: 'system', content: 'first system' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'last system' },
      ],
    };
    injectOpenRouterCacheControl(body);
    // The first system message is untouched.
    expect(body.messages[0]).toEqual({ role: 'system', content: 'first system' });
    // The last system message is converted.
    expect(body.messages[2].content).toEqual([
      { type: 'text', text: 'last system', cache_control: EPHEMERAL },
    ]);
  });

  it('skips array content that is empty (no block to stamp)', () => {
    const body = {
      messages: [{ role: 'system', content: [] }],
    };
    injectOpenRouterCacheControl(body);
    expect(body.messages[0].content).toEqual([]);
  });

  it('does nothing when no system/developer message exists', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    injectOpenRouterCacheControl(body);
    expect(body).toEqual(snapshot);
  });

  it('injects cache_control on the last tool definition when tools are present', () => {
    const body = {
      messages: [{ role: 'system', content: 'x' }],
      tools: [
        { type: 'function', function: { name: 'a' } },
        { type: 'function', function: { name: 'b' } },
      ],
    };
    injectOpenRouterCacheControl(body);
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'a' } });
    expect(body.tools[1]).toEqual({
      type: 'function',
      function: { name: 'b' },
      cache_control: EPHEMERAL,
    });
  });

  it('does not touch tools when the array is empty', () => {
    const body = {
      messages: [{ role: 'system', content: 'x' }],
      tools: [],
    };
    injectOpenRouterCacheControl(body);
    expect(body.tools).toEqual([]);
  });

  it('injects message-mode cache_control into the latest user message', () => {
    const body = {
      messages: [
        { role: 'system', content: 'stable instructions' },
        { role: 'user', content: 'reference text' },
      ],
    };
    injectOpenRouterCacheControl(body, 'message');

    expect(body.messages[0]).toEqual({ role: 'system', content: 'stable instructions' });
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'reference text', cache_control: EPHEMERAL },
    ]);
  });

  it('skips assistant messages in message mode', () => {
    const body = {
      messages: [
        { role: 'user', content: 'cache this' },
        { role: 'assistant', content: 'not a cache target' },
      ],
    };
    injectOpenRouterCacheControl(body, 'message');

    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'cache this', cache_control: EPHEMERAL },
    ]);
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'not a cache target' });
  });

  it('does nothing in message mode when no cacheable content exists', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'not a cache target' },
        { role: 'user', content: [] },
      ],
    };
    injectOpenRouterCacheControl(body, 'message');

    expect(body.messages).toEqual([
      { role: 'assistant', content: 'not a cache target' },
      { role: 'user', content: [] },
    ]);
  });

  it('skips malformed message-mode content without stamping invalid blocks', () => {
    const body = {
      messages: [
        { role: 'system', content: { type: 'text', text: 'not an array' } },
        { role: 'user', content: [null, ['nested']] },
      ],
    };
    injectOpenRouterCacheControl(body, 'message');

    expect(body.messages).toEqual([
      { role: 'system', content: { type: 'text', text: 'not an array' } },
      { role: 'user', content: [null, ['nested']] },
    ]);
  });

  it('exposes message-mode injection for OpenAI-compatible providers', () => {
    const body = {
      messages: [
        { role: 'system', content: 'Static instructions' },
        { role: 'user', content: 'Large reference block' },
      ],
    };
    injectOpenAiMessageCacheControl(body);

    expect(body.messages[0].content).toBe('Static instructions');
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'Large reference block', cache_control: EPHEMERAL },
    ]);
  });
});
