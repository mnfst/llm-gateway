import type { AuthType } from 'manifest-shared';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';
import type { ModelRoute } from 'manifest-shared';
import {
  describeUnresolvedFallback,
  describeUnresolvedModel,
  matchesModelName,
  resolveFallbackRoutes,
  resolveModelRoute,
} from '../resolve-model-route';

const CUSTOM = 'custom:6f1c2b9e-0000-4000-8000-000000000001';

const model = (
  id: string,
  provider: string,
  authType: AuthType | undefined = 'api_key',
  extra: Partial<DiscoveredModel> = {},
): DiscoveredModel =>
  ({
    id,
    displayName: id,
    provider,
    authType,
    contextWindow: 0,
    inputPricePerToken: 0,
    outputPricePerToken: 0,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 1,
    ...extra,
  }) as DiscoveredModel;

const available = [
  model('llama-3.3-70b', 'groq'),
  model('codestral-latest', 'mistral'),
  model('deepseek/deepseek-chat-v3.1:free', 'openrouter'),
  model(`${CUSTOM}/deepseek-v4-pro`, CUSTOM),
  model('custom:aliased/qwen-3-14b', 'custom:aliased', 'api_key', {
    providerAlias: 'vercel-ai-gateway',
  }),
  model('gpt-5.4', 'openai', 'subscription'),
];

describe('matchesModelName', () => {
  it.each([
    ['the internal id', 'deepseek/deepseek-chat-v3.1:free', available[2]],
    [
      'the public provider-qualified id',
      'openrouter/deepseek/deepseek-chat-v3.1:free',
      available[2],
    ],
    ['a custom model by its internal key', `${CUSTOM}/deepseek-v4-pro`, available[3]],
    ['a custom model by its bare name', 'deepseek-v4-pro', available[3]],
    ['a custom model by its alias', 'vercel-ai-gateway/qwen-3-14b', available[4]],
    ['a subscription model by its public id', 'openai/gpt-5.4-subscription', available[5]],
  ])('accepts %s', (_label, name, target) => {
    expect(matchesModelName(target, name)).toBe(true);
  });

  it('matches a bare name to a custom model only, never to a native model id suffix', () => {
    const native = model('deepseek/deepseek-v4-pro', 'openrouter');
    expect(matchesModelName(native, 'deepseek-v4-pro')).toBe(false);
    expect(matchesModelName(available[3], 'deepseek-v4-pro')).toBe(true);
  });
});

describe('resolveModelRoute', () => {
  it('resolves a custom model named bare next to its provider (issue #2962)', () => {
    expect(resolveModelRoute('deepseek-v4-pro', available, { provider: CUSTOM })).toEqual({
      ok: true,
      route: { provider: CUSTOM, authType: 'api_key', model: `${CUSTOM}/deepseek-v4-pro` },
    });
  });

  it('stores the internal id when given the public /v1/models id', () => {
    expect(
      resolveModelRoute('openrouter/deepseek/deepseek-chat-v3.1:free', available, {
        provider: 'openrouter',
        authType: 'api_key',
      }),
    ).toEqual({
      ok: true,
      route: {
        provider: 'openrouter',
        authType: 'api_key',
        model: 'deepseek/deepseek-chat-v3.1:free',
      },
    });
  });

  it('matches the provider case-insensitively and returns its canonical spelling', () => {
    const result = resolveModelRoute('llama-3.3-70b', available, { provider: 'GROQ' });
    expect(result).toEqual({
      ok: true,
      route: { provider: 'groq', authType: 'api_key', model: 'llama-3.3-70b' },
    });
  });

  it('keeps an explicit auth type and key label', () => {
    expect(
      resolveModelRoute('gpt-5.4', available, {
        provider: 'openai',
        authType: 'subscription',
        keyLabel: 'Work',
      }),
    ).toEqual({
      ok: true,
      route: { provider: 'openai', authType: 'subscription', model: 'gpt-5.4', keyLabel: 'Work' },
    });
  });

  it('reports an unknown model', () => {
    expect(resolveModelRoute('nope', available)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports a model the named provider does not offer', () => {
    expect(resolveModelRoute('llama-3.3-70b', available, { provider: 'mistral' })).toEqual({
      ok: false,
      reason: 'wrong_provider',
    });
  });

  it('reports a bare name carried by several routes', () => {
    const both = [
      model('gpt-5.4', 'openai', 'api_key'),
      model('gpt-5.4', 'openai', 'subscription'),
    ];
    expect(resolveModelRoute('gpt-5.4', both)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(resolveModelRoute('gpt-5.4', both, { provider: 'openai', authType: 'api_key' })).toEqual(
      { ok: true, route: { provider: 'openai', authType: 'api_key', model: 'gpt-5.4' } },
    );
  });

  it('refuses an auth type discovery does not offer for the model', () => {
    // A subscription-only model must never be stored as a metered api_key route.
    expect(
      resolveModelRoute('openai/gpt-5.4-subscription', available, { authType: 'api_key' }),
    ).toEqual({ ok: false, reason: 'wrong_auth_type' });
  });

  it('ignores discovered models without an auth type', () => {
    expect(
      resolveModelRoute('orphan', [model('orphan', 'groq', 'api_key', { authType: undefined })]),
    ).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('describeUnresolvedModel', () => {
  it('suggests the named provider’s own models under their public ids', () => {
    const message = describeUnresolvedModel('nope', 'not_found', available, {
      provider: 'openrouter',
    });
    expect(message).toBe(
      'Model "nope" is not in this agent\'s discovered model list (provider: openrouter). ' +
        'Connect the appropriate provider first, or choose from: ' +
        'openrouter/deepseek/deepseek-chat-v3.1:free',
    );
  });

  it('says when the agent has no models from the named provider', () => {
    expect(describeUnresolvedModel('x', 'not_found', available, { provider: 'xai' })).toBe(
      'Model "x" is not in this agent\'s discovered model list (provider: xai). ' +
        'This agent has no models from "xai": connect it or enable it for this agent first.',
    );
  });

  it('lists every model when no provider is named, truncated after twenty', () => {
    const many = Array.from({ length: 21 }, (_, i) => model(`m-${i}`, 'groq'));
    const message = describeUnresolvedModel('x', 'not_found', many);
    expect(message).toContain('choose from: groq/m-0, ');
    expect(message).toContain('groq/m-19, …');
    expect(message).not.toContain('groq/m-20');
  });

  it('explains an auth type the model is not offered with', () => {
    expect(
      describeUnresolvedModel('m', 'wrong_auth_type', available, {
        provider: 'openai',
        authType: 'api_key',
      }),
    ).toBe(
      'Model "m" is not offered with auth type "api_key" by provider "openai" for this agent.',
    );
    expect(
      describeUnresolvedModel('m', 'wrong_auth_type', available, { authType: 'api_key' }),
    ).toBe('Model "m" is not offered with auth type "api_key" for this agent.');
  });

  it('explains a wrong provider and an ambiguous name', () => {
    expect(describeUnresolvedModel('m', 'wrong_provider', available, { provider: 'groq' })).toBe(
      'Model "m" is not offered by provider "groq" for this agent.',
    );
    expect(describeUnresolvedModel('m', 'ambiguous', available)).toBe(
      'Model "m" is offered by multiple providers — pass an explicit provider + authType so the route is unambiguous.',
    );
  });
});

describe('resolveFallbackRoutes', () => {
  const route = (
    provider: string,
    authType: ModelRoute['authType'],
    m: string,
    keyLabel?: string,
  ) => (keyLabel ? { provider, authType, model: m, keyLabel } : { provider, authType, model: m });

  it('keeps the key pin of a caller route given by its public id', () => {
    const given = route(
      'openrouter',
      'api_key',
      'openrouter/deepseek/deepseek-chat-v3.1:free',
      'Work',
    );
    expect(resolveFallbackRoutes([given.model], available, [given])).toEqual({
      ok: true,
      routes: [route('openrouter', 'api_key', 'deepseek/deepseek-chat-v3.1:free', 'Work')],
    });
  });

  it('carries over persisted routes without re-checking discovery', () => {
    const stale = route('anthropic', 'api_key', 'claude-gone');
    expect(resolveFallbackRoutes([stale.model], available, [stale], [stale])).toEqual({
      ok: true,
      routes: [stale],
    });
    expect(resolveFallbackRoutes([stale.model], available, undefined, [stale])).toEqual({
      ok: true,
      routes: [stale],
    });
  });

  it('resolves names alone when the caller routes do not line up or do not resolve', () => {
    expect(
      resolveFallbackRoutes(['llama-3.3-70b'], available, [route('groq', 'api_key', 'other')]),
    ).toEqual({ ok: true, routes: [route('groq', 'api_key', 'llama-3.3-70b')] });
    expect(
      resolveFallbackRoutes(['llama-3.3-70b'], available, [
        route('mistral', 'api_key', 'llama-3.3-70b'),
      ]),
    ).toEqual({ ok: true, routes: [route('groq', 'api_key', 'llama-3.3-70b')] });
  });

  it('names the first fallback it cannot resolve', () => {
    expect(resolveFallbackRoutes(['llama-3.3-70b', 'nope'], available)).toEqual({
      ok: false,
      model: 'nope',
    });
    expect(describeUnresolvedFallback('nope')).toBe(
      'Cannot resolve fallback model "nope" to a single connected provider. ' +
        'Pass an explicit (provider, authType, model) route, or connect exactly one provider that offers this model.',
    );
  });
});
