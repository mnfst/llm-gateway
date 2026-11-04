import { bedrockRuntimeChatNeedsResponses } from '../bedrock-runtime-capabilities';
import { hasFunctionTools } from '../function-tools';

const functionTool = {
  type: 'function',
  function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
};
const webSearchTool = { type: 'web_search' };

// The CRIS prefix is resolved by getBedrockInferenceProfileBaseModelId, which has
// its own tests; one prefix per base model is enough here.
const LUNA_FAMILY = ['us.openai.gpt-6-luna', 'us.openai.gpt-6-sol', 'us.openai.gpt-5.6-luna'];
const ASTRA = 'us.openai.gpt-6-astra';
const NOT_ROUTED = [
  'us.moonshotai.kimi-k3',
  // A base model id is served by Mantle, not Runtime.
  'openai.gpt-6-luna',
  'openai.gpt-6-astra',
  // CRIS profile of a model outside the catalog.
  'us.openai.gpt-9-unknown',
  'us.anthropic.claude-sonnet-5',
  'gpt-4o',
];

describe('bedrockRuntimeChatNeedsResponses', () => {
  describe.each(LUNA_FAMILY)('%s (accepts effort none)', (model) => {
    it.each([
      ['absent', undefined, false],
      ['none', 'none', false],
      ['null', null, false],
      ['a number', 5, false],
      ['low', 'low', true],
      ['medium', 'medium', true],
      ['high', 'high', true],
      ['xhigh', 'xhigh', true],
      ['max', 'max', true],
    ])('with function tools and effort %s', (_label, effort, expected) => {
      const body: Record<string, unknown> = { tools: [functionTool] };
      if (effort !== undefined) body.reasoning_effort = effort;

      expect(bedrockRuntimeChatNeedsResponses(model, body)).toBe(expected);
    });

    it.each([
      ['no tools key', {}],
      ['an empty tools array', { tools: [] }],
      ['only a non-function tool', { tools: [webSearchTool] }],
      ['tools that is not an array', { tools: 'get_weather' }],
    ])('is false for effort high with %s', (_label, tools) => {
      expect(bedrockRuntimeChatNeedsResponses(model, { ...tools, reasoning_effort: 'high' })).toBe(
        false,
      );
    });

    it('is true when a function tool sits next to other tools', () => {
      expect(
        bedrockRuntimeChatNeedsResponses(model, {
          tools: [webSearchTool, functionTool],
          reasoning_effort: 'high',
        }),
      ).toBe(true);
    });

    it('is false without tools and without an effort', () => {
      expect(bedrockRuntimeChatNeedsResponses(model, {})).toBe(false);
    });
  });

  describe(`${ASTRA} (rejects effort none)`, () => {
    it.each([
      ['absent', undefined],
      ['null', null],
      ['a number', 5],
      ['low', 'low'],
      ['high', 'high'],
      ['max', 'max'],
      // Chat rejects `none` for Astra; Responses rejects it too, but chat has no
      // valid effort with tools at all, so the request still takes the Responses route.
      ['none', 'none'],
    ])('is true with function tools and effort %s', (_label, effort) => {
      const body: Record<string, unknown> = { tools: [functionTool] };
      if (effort !== undefined) body.reasoning_effort = effort;

      expect(bedrockRuntimeChatNeedsResponses(ASTRA, body)).toBe(true);
    });

    it.each([
      ['no tools key', {}],
      ['an empty tools array', { tools: [] }],
      ['only a non-function tool', { tools: [webSearchTool] }],
    ])('is false with %s, whatever the effort', (_label, tools) => {
      expect(bedrockRuntimeChatNeedsResponses(ASTRA, { ...tools })).toBe(false);
      expect(bedrockRuntimeChatNeedsResponses(ASTRA, { ...tools, reasoning_effort: 'high' })).toBe(
        false,
      );
    });

    it('is true when a function tool sits next to other tools', () => {
      expect(
        bedrockRuntimeChatNeedsResponses(ASTRA, { tools: [webSearchTool, functionTool] }),
      ).toBe(true);
    });
  });

  describe.each(NOT_ROUTED)('%s', (model) => {
    it.each([undefined, 'none', 'low', 'high', 'max'])(
      'is false with function tools and effort %p',
      (effort) => {
        const body: Record<string, unknown> = { tools: [functionTool] };
        if (effort !== undefined) body.reasoning_effort = effort;

        expect(bedrockRuntimeChatNeedsResponses(model, body)).toBe(false);
      },
    );
  });

  it.each(['us.', 'global.', 'eu.', 'bedrock/us.'])(
    'gives the same answer for the %s prefix of one model',
    (prefix) => {
      const model = `${prefix}openai.gpt-6-luna`;
      const withEffort = { tools: [functionTool], reasoning_effort: 'high' };

      expect(bedrockRuntimeChatNeedsResponses(model, withEffort)).toBe(true);
      expect(bedrockRuntimeChatNeedsResponses(model, { tools: [functionTool] })).toBe(false);
    },
  );

  it('does not read process.env', () => {
    const previous = process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'];
    process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'] = 'false';
    try {
      expect(
        bedrockRuntimeChatNeedsResponses('us.openai.gpt-6-luna', {
          tools: [functionTool],
          reasoning_effort: 'high',
        }),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'];
      else process.env['BEDROCK_RUNTIME_CHAT_VIA_RESPONSES'] = previous;
    }
  });
});

describe('hasFunctionTools', () => {
  it.each([
    ['one function tool', [functionTool]],
    ['a flat function tool', [{ type: 'function', name: 'get_weather' }]],
    ['a function tool after another type', [webSearchTool, functionTool]],
    ['a function tool before another type', [functionTool, webSearchTool]],
    ['a function tool next to null entries', [null, functionTool, undefined]],
  ])('is true for %s', (_label, tools) => {
    expect(hasFunctionTools(tools)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty array', []],
    ['only a non-function tool', [webSearchTool]],
    ['only null entries', [null, undefined]],
    ['entries without a type', [{ name: 'get_weather' }]],
    ['a string', 'function'],
    ['a number', 5],
    ['a single tool object instead of an array', functionTool],
  ])('is false for %s', (_label, tools) => {
    expect(hasFunctionTools(tools)).toBe(false);
  });
});
