import { describe, expect, it, vi } from 'vitest';
import type { AvailableModel } from '../../src/services/api.js';
import {
  findResumableAgent,
  isSuccessfulAgentMessage,
  proposeChain,
} from '../../src/pages/welcome-helpers.js';
import { hasOnboardingBeenDone, markOnboardingDone } from '../../src/services/onboarding.js';

const model = (
  provider: string,
  modelName: string,
  quality: number,
  authType: AvailableModel['auth_type'] = 'api_key',
): AvailableModel => ({
  provider,
  model_name: modelName,
  auth_type: authType,
  quality_score: quality,
  input_price_per_token: null,
  output_price_per_token: null,
  context_window: 128_000,
  capability_reasoning: false,
  capability_code: false,
});

describe('proposeChain', () => {
  it('picks the strongest model from each provider, not each credential', () => {
    const chain = proposeChain([
      model('openai', 'gpt-4.1-mini', 80, 'api_key'),
      model('OPENAI', 'gpt-4.1', 96, 'subscription'),
      model('anthropic', 'claude-sonnet-4', 94),
      model('google', 'gemini-2.5-pro', 92),
    ]);

    expect(chain.map((entry) => entry.model_name)).toEqual([
      'gpt-4.1',
      'claude-sonnet-4',
      'gemini-2.5-pro',
    ]);
    expect(new Set(chain.map((entry) => entry.provider.toLowerCase())).size).toBe(3);
  });

  it('limits the default route to one primary and two independent fallbacks', () => {
    const chain = proposeChain([
      model('openai', 'gpt-4.1', 96),
      model('anthropic', 'claude-sonnet-4', 94),
      model('google', 'gemini-2.5-pro', 92),
      model('mistral', 'mistral-large', 90),
    ]);

    expect(chain).toHaveLength(3);
    expect(chain.map((entry) => entry.provider)).toEqual(['openai', 'anthropic', 'google']);
  });

  it('uses the starred Playground model as primary and keeps independent fallbacks', () => {
    const chain = proposeChain(
      [
        model('openai', 'gpt-4.1', 96),
        model('anthropic', 'claude-sonnet-4', 94),
        model('google', 'gemini-2.5-flash', 80),
      ],
      { model: 'gemini-2.5-flash', provider: 'google', authType: 'api_key' },
    );

    expect(chain.map((entry) => entry.model_name)).toEqual([
      'gemini-2.5-flash',
      'gpt-4.1',
      'claude-sonnet-4',
    ]);
  });
});

describe('onboarding activation helpers', () => {
  it('resumes the newest zero-attempt harness when backend omits has_successful_message', () => {
    // The backend does not return has_successful_message; it only returns message_count.
    // An agent with message_count > 0 is treated as active regardless of success status.
    expect(
      findResumableAgent([
        { agent_name: 'activated', message_count: 3 },
        { agent_name: 'zero-attempts', message_count: 0 },
        { agent_name: 'also-zero', message_count: 0 },
      ])?.agent_name,
    ).toBe('zero-attempts');
  });

  it('uses has_successful_message when the backend provides it', () => {
    // Forward-compat: if the backend ever adds the field, it takes priority over message_count.
    expect(
      findResumableAgent([
        { agent_name: 'activated', message_count: 3, has_successful_message: true },
        { agent_name: 'failed-attempts', message_count: 1, has_successful_message: false },
        { agent_name: 'no-attempts', message_count: 0, has_successful_message: false },
      ])?.agent_name,
    ).toBe('failed-attempts');
  });

  it('does not treat a failed request as activation', () => {
    expect(isSuccessfulAgentMessage({ status: 'failed' })).toBe(false);
    expect(isSuccessfulAgentMessage({ status: 'rate_limited' })).toBe(false);
    expect(isSuccessfulAgentMessage({ status: 'ok' })).toBe(true);
  });

  it('marks onboarding done in local storage', () => {
    const calls: Array<[string, string]> = [];
    vi.stubGlobal('localStorage', {
      setItem: (key: string, value: string) => calls.push([key, value]),
    });

    markOnboardingDone('user-1');

    expect(calls).toEqual([['manifest_onboarding_done_user-1', '1']]);
    vi.unstubAllGlobals();
  });

  it('ignores local storage write failures', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
    });

    expect(() => markOnboardingDone('user-1')).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('hasOnboardingBeenDone returns true after markOnboardingDone', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
    });

    expect(hasOnboardingBeenDone('user-2')).toBe(false);
    markOnboardingDone('user-2');
    expect(hasOnboardingBeenDone('user-2')).toBe(true);
    expect(hasOnboardingBeenDone('user-3')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('hasOnboardingBeenDone returns false when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
    });

    expect(hasOnboardingBeenDone('user-4')).toBe(false);
    vi.unstubAllGlobals();
  });
});
