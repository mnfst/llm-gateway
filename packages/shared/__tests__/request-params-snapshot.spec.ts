import { snapshotRequestParams } from '../src/request-params-snapshot';
import type { ProviderParamSpec } from '../src/provider-params-spec';

const specs: readonly ProviderParamSpec[] = [
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'thinking.budget_tokens',
    type: 'integer',
    label: 'Thinking budget',
    description: 'Maximum Anthropic extended thinking token budget.',
    default: 4096,
    range: { min: 1024, max: 32768, step: 1024 },
    group: 'reasoning',
    applicability: { only: { 'thinking.type': 'enabled' } },
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'thinking.type',
    type: 'enum',
    label: 'Thinking mode',
    description: 'Controls Anthropic thinking mode.',
    default: 'disabled',
    values: ['disabled', 'adaptive', 'enabled'],
    group: 'reasoning',
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'temperature',
    type: 'number',
    label: 'Temperature',
    description: 'Controls sampling randomness.',
    default: 1,
    range: { min: 0, max: 1, step: 0.1 },
    group: 'sampling',
    applicability: { except: { 'thinking.type': ['enabled', 'adaptive'] } },
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'top_p',
    type: 'number',
    label: 'Top P',
    description: 'Controls nucleus sampling.',
    default: 1,
    range: { min: 0, max: 1, step: 0.01 },
    group: 'sampling',
    applicability: {
      except: [{ 'thinking.type': ['enabled', 'adaptive'] }, { temperature: { not: 1 } }],
    },
  },
];

describe('snapshotRequestParams', () => {
  it('returns null when the resolved model has no specs', () => {
    expect(
      snapshotRequestParams({
        body: { messages: [] },
        modelParams: null,
        specs: [],
      }),
    ).toBeNull();
  });

  it('falls back to provider defaults for known params', () => {
    expect(
      snapshotRequestParams({
        body: { messages: [] },
        modelParams: null,
        specs,
      }),
    ).toEqual({ temperature: 1, top_p: 1, thinking: { type: 'disabled' } });
  });

  it('records saved per-route params and nested sibling defaults', () => {
    expect(
      snapshotRequestParams({
        body: { messages: [] },
        modelParams: { thinking: { type: 'enabled' } },
        specs,
      }),
    ).toEqual({ thinking: { type: 'enabled', budget_tokens: 4096 } });
  });

  it('records saved Manifest params over client body values at the same path', () => {
    expect(
      snapshotRequestParams({
        body: { temperature: 0.4, messages: [] },
        modelParams: { temperature: 0.8 },
        specs,
      }),
    ).toEqual({ temperature: 0.8, thinking: { type: 'disabled' } });
  });

  it('records client body params that are not configured in Manifest', () => {
    expect(
      snapshotRequestParams({
        body: { temperature: 0.4, messages: [] },
        modelParams: { thinking: { type: 'disabled' } },
        specs,
      }),
    ).toEqual({ temperature: 0.4, thinking: { type: 'disabled' } });
  });

  it('omits unavailable params from the snapshot', () => {
    expect(
      snapshotRequestParams({
        body: { messages: [] },
        modelParams: { temperature: 0.7, thinking: { type: 'adaptive' } },
        specs,
      }),
    ).toEqual({ thinking: { type: 'adaptive' } });
  });

  it('records a caller-sent knob the route has no spec for', () => {
    // claude-opus-4-8-style case: the catalog (correctly) dropped temperature
    // for the model, the caller sent it anyway, the provider rejected it — the
    // snapshot must show the knob that was actually on the wire.
    const speclessTemperature = specs.filter((s) => s.path.split('.')[0] !== 'temperature');
    expect(
      snapshotRequestParams({
        body: { temperature: 0.2, messages: [] },
        modelParams: { thinking: { type: 'enabled' } },
        specs: speclessTemperature,
      }),
    ).toEqual({ temperature: 0.2, thinking: { type: 'enabled', budget_tokens: 4096 } });
  });

  it('records spec-less scalar knobs even when the route has no specs at all', () => {
    expect(
      snapshotRequestParams({
        body: { temperature: 0.7, parallel_tool_calls: false, service_tier: 'flex', messages: [] },
        modelParams: null,
        specs: [],
      }),
    ).toEqual({ temperature: 0.7, parallel_tool_calls: false, service_tier: 'flex' });
  });

  it('records spec-less structured knobs from the raw body', () => {
    expect(
      snapshotRequestParams({
        body: {
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
          thinking: { type: 'enabled' },
          stop: ['\\n\\n'],
          logit_bias: null,
        },
        modelParams: null,
        specs: [],
      }),
    ).toEqual({
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
      stop: ['\\n\\n'],
      // An explicit null is part of the raw request and is kept as sent.
      logit_bias: null,
    });
  });

  it('never records content-bearing spec-less keys', () => {
    expect(
      snapshotRequestParams({
        body: {
          messages: [{ role: 'user', content: 'hi' }],
          system: 'you are a bot',
          user: 'user-123',
          seed_note: 'x'.repeat(65),
          smuggled: { nested: { prompt: 'y'.repeat(65) } },
          functions: [{ name: 'f', parameters: { type: 'object' } }],
          'dotted.key': true,
          oversized: { keys: Array.from({ length: 600 }, (_, i) => `key_${i}`) },
          not_json: { cb: () => 'x' },
          verbosity: 'high',
        },
        modelParams: null,
        specs: [],
      }),
    ).toEqual({ verbosity: 'high' });
  });

  it('omits conflicted defaults from the snapshot', () => {
    expect(
      snapshotRequestParams({
        body: { messages: [] },
        modelParams: { temperature: 0.2, top_p: 0.7 },
        specs,
      }),
    ).toEqual({ temperature: 0.2, thinking: { type: 'disabled' } });
  });
});
