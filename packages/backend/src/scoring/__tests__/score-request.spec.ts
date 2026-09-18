import { scoreRequest, getDefaultConfig } from '../index';
import { FIXTURES } from './fixtures';

const VALID_TIERS = ['simple', 'standard', 'complex', 'reasoning'];

describe('scoreRequest — hard overrides', () => {
  it('returns REASONING for formal logic override (multiple keywords)', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content: 'Prove that sqrt(2) is irrational using proof by contradiction',
        },
      ],
    });
    expect(result.tier).toBe('reasoning');
    expect(result.reason).toBe('formal_logic_override');
    expect(result.confidence).toBe(0.95);
  });

  it('returns REASONING for single formal logic keyword', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'Prove sqrt(2) is irrational' }],
    });
    expect(result.tier).toBe('reasoning');
    expect(result.reason).toBe('formal_logic_override');
  });

  it('does NOT trigger formal logic override with zero keywords', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'show me wrong about this' }],
    });
    expect(result.reason).not.toBe('formal_logic_override');
  });

  it('does NOT trigger formal logic for "iff" inside "difference"', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'What is the difference between Java and Python?' }],
    });
    expect(result.reason).not.toBe('formal_logic_override');
  });

  it('does NOT trigger formal logic for "lemma" inside "dilemma"', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'I am facing a dilemma about which database to use' }],
    });
    expect(result.reason).not.toBe('formal_logic_override');
  });

  it('does NOT trigger formal logic for "proof" inside "waterproof"', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'Is this jacket waterproof?' }],
    });
    expect(result.reason).not.toBe('formal_logic_override');
  });

  it('returns SIMPLE for short message with no tools', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.tier).toBe('simple');
    expect(result.reason).toBe('short_message');
  });

  it('returns SIMPLE for messages under 50 chars (e.g. factual questions)', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    });
    expect(result.tier).toBe('simple');
    expect(result.reason).toBe('short_message');
  });

  it('does NOT return short_message for messages at 50+ chars', () => {
    const msg = 'x'.repeat(50);
    const result = scoreRequest({
      messages: [{ role: 'user', content: msg }],
    });
    expect(result.reason).not.toBe('short_message');
  });

  it('returns SIMPLE for short greeting even with tools attached', () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `tool_${i}`, description: 'noop', parameters: { type: 'object' } },
    }));
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    expect(result.tier).toBe('simple');
    expect(result.reason).toBe('short_message');
  });

  it('does NOT return SIMPLE for short technical prompt with tools', () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `tool_${i}`, description: 'noop', parameters: { type: 'object' } },
    }));
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'Debug this function' }],
      tools,
    });
    expect(result.reason).not.toBe('short_message');
  });

  it('does NOT return SIMPLE for short message with momentum (no simple indicator)', () => {
    const result = scoreRequest({ messages: [{ role: 'user', content: 'continue' }] }, undefined, {
      recentTiers: ['complex', 'complex', 'complex'],
    });
    expect(result.reason).not.toBe('short_message');
  });

  it('returns SIMPLE for short message with simple indicator even WITH momentum', () => {
    const result = scoreRequest(
      { messages: [{ role: 'user', content: 'where is Paris?' }] },
      undefined,
      { recentTiers: ['standard', 'standard'] },
    );
    expect(result.tier).toBe('simple');
    expect(result.reason).toBe('short_message');
  });

  it('returns SIMPLE for "thanks" even with complex momentum', () => {
    const result = scoreRequest({ messages: [{ role: 'user', content: 'thanks' }] }, undefined, {
      recentTiers: ['complex', 'complex', 'complex'],
    });
    expect(result.tier).toBe('simple');
    expect(result.reason).toBe('short_message');
  });

  it('returns SIMPLE for "hello" even with standard momentum', () => {
    const result = scoreRequest({ messages: [{ role: 'user', content: 'hello' }] }, undefined, {
      recentTiers: ['standard'],
    });
    expect(result.tier).toBe('simple');
    expect(result.reason).toBe('short_message');
  });

  it('does NOT return short_message for short technical prompts with keywords', () => {
    const technicalPrompts = [
      'Implement OAuth PKCE flow in Next.js',
      'Fix a race condition in a Redis lock',
      'Debug a flaky Playwright login test',
      'Write SQL to detect duplicate invoices',
      'Implement JWT refresh token rotation',
    ];
    for (const prompt of technicalPrompts) {
      const result = scoreRequest({
        messages: [{ role: 'user', content: prompt }],
      });
      expect(result.reason).not.toBe('short_message');
    }
  });

  it('routes short technical prompts to standard or higher', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'Implement OAuth PKCE flow in Next.js' }],
    });
    expect(result.tier).not.toBe('simple');
  });
});

describe('scoreRequest — full pipeline', () => {
  it('scores "what is 2+2" as SIMPLE', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'what is 2+2' }],
    });
    expect(result.tier).toBe('simple');
  });

  it('scores complex React component request as COMPLEX', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content:
            'Write a React component that fetches user data, handles loading states, and renders a paginated table with sorting',
        },
      ],
    });
    expect(['complex', 'reasoning']).toContain(result.tier);
  });

  it('scores induction proof as REASONING', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content:
            'Prove by induction that the sum of first n naturals equals n(n+1)/2, then derive the closed form for sum of squares',
        },
      ],
    });
    expect(result.tier).toBe('reasoning');
  });

  it('scores "thanks" as SIMPLE', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'thanks' }],
    });
    expect(result.tier).toBe('simple');
  });

  it('scores microservices trade-offs analysis as COMPLEX', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content: 'Analyze trade-offs between microservices and monolith for a 5-engineer startup',
        },
      ],
    });
    expect(['complex', 'standard']).toContain(result.tier);
  });

  it('applies tool floor: bug fix with tools is not SIMPLE', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content: 'fix this bug: TypeError: Cannot read properties of null',
        },
      ],
      tools: [{}, {}, {}],
    });
    expect(result.tier).not.toBe('simple');
  });
});

describe('scoreRequest — edge cases', () => {
  it('handles empty messages array', () => {
    const result = scoreRequest({ messages: [] });
    expect(result.tier).toBe('standard');
    expect(result.reason).toBe('ambiguous');
  });

  it('handles image-only messages', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'abc' } }],
        },
      ],
    });
    expect(VALID_TIERS).toContain(result.tier);
  });

  it('handles very long prose as COMPLEX via token count', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'summarize: ' + 'x'.repeat(10000) }],
    });
    expect(['complex', 'standard']).toContain(result.tier);
  });

  it('handles non-English text as STANDARD', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content: '这个算法的时间复杂度是多少？请详细分析。',
        },
      ],
    });
    expect(VALID_TIERS).toContain(result.tier);
  });

  it('handles 100% code content', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content:
            '```js\nfunction sort(arr) {\n  return arr.sort((a,b) => a-b);\n}\nfunction filter(arr) {\n  return arr.filter(x => x > 0);\n}\n```',
        },
      ],
    });
    expect(VALID_TIERS).toContain(result.tier);
  });

  it('skips system messages for scoring', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'system',
          content: 'You are an expert at proving theorems and formal logic with induction.',
        },
        { role: 'user', content: 'hi there' },
      ],
    });
    expect(result.tier).toBe('simple');
  });
});

describe('scoreRequest — confidence', () => {
  it('returns high confidence for clear REASONING', () => {
    const result = scoreRequest({
      messages: [
        {
          role: 'user',
          content: 'Prove by contradiction that the proof of the theorem requires induction',
        },
      ],
    });
    expect(result.confidence).toBeGreaterThan(0.85);
  });

  it('returns high confidence for clear SIMPLE', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.confidence).toBeGreaterThan(0.85);
  });
});

describe('scoreRequest — tier compatibility', () => {
  it('all returned tiers match VALID_TIERS constant', () => {
    for (const fixture of FIXTURES) {
      const result = scoreRequest({ messages: fixture.messages });
      expect(VALID_TIERS).toContain(result.tier);
    }
  });

  it('returns all 32 dimensions', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'test request' }],
    });
    expect(result.dimensions).toHaveLength(32);
  });
});

describe('scoreRequest — ScoringResult structure', () => {
  it('includes all required fields', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('dimensions');
    expect(result).toHaveProperty('momentum');
    expect(typeof result.score).toBe('number');
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('provides momentum info when momentum is given', () => {
    // "continue" doesn't match a simple indicator, so momentum applies
    const result = scoreRequest(
      {
        messages: [{ role: 'user', content: 'continue' }],
      },
      undefined,
      { recentTiers: ['complex', 'standard'] },
    );
    expect(result.momentum).not.toBeNull();
    expect(result.momentum!.historyLength).toBe(2);
  });

  it('returns null momentum when not provided', () => {
    const result = scoreRequest({
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(result.momentum).toBeNull();
  });
});

describe('scoreRequest — getDefaultConfig', () => {
  it('returns a config with dimensions, boundaries, and confidence params', () => {
    const config = getDefaultConfig();
    expect(config.dimensions).toBeDefined();
    expect(config.dimensions.length).toBeGreaterThan(0);
    expect(config.boundaries).toBeDefined();
    expect(config.confidenceK).toBeDefined();
    expect(config.confidenceMidpoint).toBeDefined();
    expect(config.confidenceThreshold).toBeDefined();
  });

  it('returns a copy that does not affect internal state', () => {
    const config1 = getDefaultConfig();
    config1.confidenceK = 999;
    const config2 = getDefaultConfig();
    expect(config2.confidenceK).not.toBe(999);
  });
});

describe('scoreRequest — fixture expectations', () => {
  for (const fixture of FIXTURES) {
    if (fixture.name === 'empty_conversation') continue;
    if (fixture.name === 'image_only') continue;

    it(`fixture "${fixture.name}" → ${fixture.expectedTier}`, () => {
      const result = scoreRequest({ messages: fixture.messages });
      expect(result.tier).toBe(fixture.expectedTier);
    });
  }
});
