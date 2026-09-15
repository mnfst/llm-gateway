import {
  SUBSCRIPTION_PROVIDER_CONFIGS,
  SUPPORTED_SUBSCRIPTION_PROVIDER_IDS,
  getSubscriptionProviderConfig,
  supportsSubscriptionProvider,
  getSubscriptionKnownModels,
  getSubscriptionKnownModelsMatch,
  getSubscriptionCapabilities,
} from '../src/subscription';

describe('SUBSCRIPTION_PROVIDER_CONFIGS', () => {
  it('contains all supported subscription provider IDs', () => {
    expect(Object.keys(SUBSCRIPTION_PROVIDER_CONFIGS)).toEqual(
      expect.arrayContaining([
        'anthropic',
        'byteplus',
        'openai',
        'minimax',
        'mistral',
        'xiaomi',
        'qwen',
        'moonshot',
        'nous',
        'copilot',
        'commandcode',
        'ollama-cloud',
        'zai',
        'opencode-go',
        'gemini',
        'xai',
      ]),
    );
  });

  it('ollama-cloud config is frozen', () => {
    expect(Object.isFrozen(SUBSCRIPTION_PROVIDER_CONFIGS['ollama-cloud'])).toBe(true);
    expect(
      Object.isFrozen(SUBSCRIPTION_PROVIDER_CONFIGS['ollama-cloud'].subscriptionCapabilities),
    ).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SUBSCRIPTION_PROVIDER_CONFIGS)).toBe(true);
  });
});

describe('SUPPORTED_SUBSCRIPTION_PROVIDER_IDS', () => {
  it('matches the keys of SUBSCRIPTION_PROVIDER_CONFIGS', () => {
    expect([...SUPPORTED_SUBSCRIPTION_PROVIDER_IDS].sort()).toEqual(
      Object.keys(SUBSCRIPTION_PROVIDER_CONFIGS).sort(),
    );
  });
});

describe('getSubscriptionProviderConfig', () => {
  it('returns config for anthropic', () => {
    const config = getSubscriptionProviderConfig('anthropic');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Claude Max / Pro subscription',
      subscriptionAuthMode: 'token',
    });
  });

  it('lists claude-opus-5 explicitly — the claude-opus-4 prefix does not cover it', () => {
    const config = getSubscriptionProviderConfig('anthropic');
    const knownModels = config?.knownModels ?? [];
    expect(knownModels).toContain('claude-opus-5');
    // Anthropic matches by prefix, so claude-opus-4-8 rides on 'claude-opus-4'.
    // The 5 generation dropped that prefix — without its own entry, an Opus 5
    // subscription model would be filtered out of the curated catalog.
    expect(knownModels.some((m) => 'claude-opus-5'.startsWith(m) && m !== 'claude-opus-5')).toBe(
      false,
    );
  });

  it('returns config for openai', () => {
    const config = getSubscriptionProviderConfig('openai');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionAuthMode: 'popup_oauth',
    });
  });

  it('returns config for BytePlus ModelArk Coding Plan', () => {
    const config = getSubscriptionProviderConfig('byteplus');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'ModelArk Coding Plan',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your ModelArk Coding Plan API key',
      knownModelsMatch: 'exact',
    });
    expect(config?.knownModels).toEqual(
      expect.arrayContaining([
        'ark-code-latest',
        'bytedance-seed-code',
        'deepseek-v4-flash',
        'deepseek-v4-pro',
      ]),
    );
  });

  it('returns config for minimax', () => {
    const config = getSubscriptionProviderConfig('minimax');
    expect(config).toMatchObject({
      subscriptionAuthMode: 'device_code',
    });
  });

  it('returns config for Mistral Vibe subscription', () => {
    const config = getSubscriptionProviderConfig('mistral');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Mistral Vibe subscription',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your Mistral Vibe API key',
      knownModelsMatch: 'exact',
    });
    expect(config?.knownModels).toEqual(['mistral-vibe-cli-latest']);
  });

  it('returns config for Xiaomi MiMo Token Plan', () => {
    const config = getSubscriptionProviderConfig('xiaomi');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Xiaomi MiMo Token Plan',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your MiMo Token Plan API key',
      subscriptionTokenPrefix: 'tp-',
      knownModelsMatch: 'exact',
    });
    expect(config?.knownModels).toEqual([
      'mimo-v2.5-pro',
      'mimo-v2-pro',
      'mimo-v2.5',
      'mimo-v2-omni',
      'mimo-v2-flash',
    ]);
  });

  it('returns config for Qwen Token Plan', () => {
    const config = getSubscriptionProviderConfig('qwen');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Qwen Token Plan',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your Qwen Token Plan API key',
      subscriptionTokenPrefix: 'sk-sp-',
    });
    expect(config?.knownModels).toBeUndefined();
    expect(config?.knownModelsMatch).toBeUndefined();
  });

  it('returns config for moonshot Kimi Coding Plan', () => {
    const config = getSubscriptionProviderConfig('moonshot');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Kimi Coding Plan',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your Kimi Code API key',
      knownModelsMatch: 'exact',
    });
  });

  it('returns config for copilot', () => {
    const config = getSubscriptionProviderConfig('copilot');
    expect(config).toMatchObject({
      subscriptionLabel: 'GitHub Copilot subscription',
      subscriptionAuthMode: 'device_code',
    });
  });

  it('returns config for Command Code', () => {
    const config = getSubscriptionProviderConfig('commandcode');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Command Code subscription',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your Command Code API key',
    });
  });

  it('returns config for NousResearch', () => {
    const config = getSubscriptionProviderConfig('nous');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'NousResearch subscription',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your NousResearch API key',
    });
  });

  it('returns config for ollama-cloud', () => {
    const config = getSubscriptionProviderConfig('ollama-cloud');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Ollama Cloud subscription',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your Ollama API key',
    });
    // Ollama Cloud accepts any API key format — no prefix constraint.
    expect(config?.subscriptionTokenPrefix).toBeUndefined();
  });

  it('returns config for zai', () => {
    const config = getSubscriptionProviderConfig('zai');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'GLM Coding Plan',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your Z.ai API key',
    });
  });

  it('returns config for opencode-go', () => {
    const config = getSubscriptionProviderConfig('opencode-go');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'OpenCode Go (beta)',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'Paste your OpenCode API key',
    });
    expect(config?.subscriptionCapabilities).toMatchObject({
      maxContextWindow: 200000,
      supportsPromptCaching: false,
      supportsBatching: false,
    });
  });

  it('publishes the curated opencode-go subscription models', () => {
    const config = getSubscriptionProviderConfig('opencode-go');
    expect(config?.knownModels).toEqual([
      'opencode-go/deepseek-flash',
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/muse-spark-1.3-contributor',
      'opencode-go/omen-alpha',
    ]);
    expect(config?.knownModelsMatch).toBe('exact');
  });

  it('returns config for xai', () => {
    const config = getSubscriptionProviderConfig('xai');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Grok subscription',
      subscriptionAuthMode: 'popup_oauth',
    });
  });

  it('publishes the curated xai subscription models', () => {
    const config = getSubscriptionProviderConfig('xai');
    expect(config?.knownModels).toEqual(['grok-4.6', 'grok-4.5']);
  });

  it('returns config for gemini', () => {
    const config = getSubscriptionProviderConfig('gemini');
    expect(config).toMatchObject({
      supportsSubscription: true,
      subscriptionLabel: 'Sign in with Google',
      subscriptionAuthMode: 'popup_oauth',
      knownModelsMatch: 'exact',
    });
    expect(config?.knownModels).toEqual(
      expect.arrayContaining([
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
      ]),
    );
    expect(config?.knownModels).not.toContain('gemini-3.1-flash-lite-preview');
    expect(config?.knownModels).not.toContain('gemini-3.1-pro-preview');
    expect(config?.knownModels).not.toContain('gemini-3-flash-preview');
    expect(config?.knownModels).not.toContain('gemini-3.6-flash');
    expect(config?.subscriptionCapabilities).toMatchObject({
      maxContextWindow: 1000000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('is case-insensitive', () => {
    expect(getSubscriptionProviderConfig('ANTHROPIC')).not.toBeNull();
    expect(getSubscriptionProviderConfig('OpenAI')).not.toBeNull();
  });

  it('resolves provider aliases to subscription configs', () => {
    expect(getSubscriptionProviderConfig('google')).toBe(getSubscriptionProviderConfig('gemini'));
    expect(getSubscriptionProviderConfig('Google')).toBe(getSubscriptionProviderConfig('gemini'));
  });

  it('returns null for unsupported providers', () => {
    expect(getSubscriptionProviderConfig('unknown')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getSubscriptionProviderConfig('')).toBeNull();
  });
});

describe('supportsSubscriptionProvider', () => {
  it('returns true for supported providers', () => {
    expect(supportsSubscriptionProvider('anthropic')).toBe(true);
    expect(supportsSubscriptionProvider('byteplus')).toBe(true);
    expect(supportsSubscriptionProvider('openai')).toBe(true);
    expect(supportsSubscriptionProvider('minimax')).toBe(true);
    expect(supportsSubscriptionProvider('mistral')).toBe(true);
    expect(supportsSubscriptionProvider('xiaomi')).toBe(true);
    expect(supportsSubscriptionProvider('qwen')).toBe(true);
    expect(supportsSubscriptionProvider('moonshot')).toBe(true);
    expect(supportsSubscriptionProvider('nous')).toBe(true);
    expect(supportsSubscriptionProvider('copilot')).toBe(true);
    expect(supportsSubscriptionProvider('commandcode')).toBe(true);
    expect(supportsSubscriptionProvider('ollama-cloud')).toBe(true);
    expect(supportsSubscriptionProvider('zai')).toBe(true);
    expect(supportsSubscriptionProvider('opencode-go')).toBe(true);
    expect(supportsSubscriptionProvider('gemini')).toBe(true);
    expect(supportsSubscriptionProvider('xai')).toBe(true);
  });

  it('returns true for aliases of supported providers', () => {
    expect(supportsSubscriptionProvider('google')).toBe(true);
    expect(supportsSubscriptionProvider('Google')).toBe(true);
  });

  it('returns false for unsupported providers', () => {
    expect(supportsSubscriptionProvider('deepseek')).toBe(false);
    expect(supportsSubscriptionProvider('kilo')).toBe(false);
  });
});

describe('getSubscriptionKnownModels', () => {
  it('returns known models for anthropic', () => {
    const models = getSubscriptionKnownModels('anthropic');
    expect(models).toContain('claude-fable-5');
    expect(models).toContain('claude-opus-4');
    expect(models).toContain('claude-sonnet-4');
    // claude-sonnet-5 (launched 2026-06-30) is served on the Claude plan.
    expect(models).toContain('claude-sonnet-5');
  });

  it('returns the curated ChatGPT plan models for OpenAI', () => {
    const models = getSubscriptionKnownModels('openai');
    expect(models).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    );
    expect(models).not.toContain('gpt-5.6-sol-pro');
    expect(models).not.toContain('gpt-5.6-terra-pro');
    expect(models).not.toContain('gpt-5.6-luna-pro');
  });

  it('returns known models for copilot', () => {
    const models = getSubscriptionKnownModels('copilot');
    expect(models).toContain('copilot/claude-opus-4.6');
    expect(models).toContain('copilot/gpt-5.4');
  });

  it('returns known models for BytePlus ModelArk Coding Plan', () => {
    const models = getSubscriptionKnownModels('byteplus');
    expect(models).toEqual(
      expect.arrayContaining(['ark-code-latest', 'bytedance-seed-code', 'glm-5.1', 'kimi-k2.5']),
    );
  });

  it('returns null for Command Code (dynamic Provider API catalog, no hardcoded list)', () => {
    expect(getSubscriptionKnownModels('commandcode')).toBeNull();
  });

  it('returns null for Nous (dynamic Portal catalog, no hardcoded list)', () => {
    expect(getSubscriptionKnownModels('nous')).toBeNull();
  });

  it('returns known models for minimax including M2.7', () => {
    const models = getSubscriptionKnownModels('minimax');
    expect(models).toContain('MiniMax-M2.7');
    expect(models).toContain('MiniMax-M2.7-highspeed');
    expect(models).toContain('MiniMax-M2.5');
  });

  it('returns the fixed model id for Mistral Vibe', () => {
    expect(getSubscriptionKnownModels('mistral')).toEqual(['mistral-vibe-cli-latest']);
  });

  it('returns known models for Xiaomi MiMo Token Plan', () => {
    const models = getSubscriptionKnownModels('xiaomi');
    expect(models).toEqual([
      'mimo-v2.5-pro',
      'mimo-v2-pro',
      'mimo-v2.5',
      'mimo-v2-omni',
      'mimo-v2-flash',
    ]);
  });

  it('returns null known models for Qwen Token Plan (relies on live /v1/models discovery)', () => {
    expect(getSubscriptionKnownModels('qwen')).toBeNull();
  });

  it('returns the fixed model ids for moonshot Kimi Coding Plan', () => {
    expect(getSubscriptionKnownModels('moonshot')).toEqual([
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
  });

  it('returns known models for cline-pass including Kimi K3', () => {
    const models = getSubscriptionKnownModels('cline-pass');
    expect(models).toContain('cline-pass/kimi-k3');
  });

  it('returns null known models for ollama-cloud (relies on live /api/tags discovery)', () => {
    const models = getSubscriptionKnownModels('ollama-cloud');
    expect(models).toBeNull();
  });

  it('returns known models for zai', () => {
    const models = getSubscriptionKnownModels('zai');
    expect(models).toContain('glm-5.1');
    expect(models).toContain('glm-5');
    expect(models).toContain('glm-4.7');
  });

  it('returns known models for opencode-go', () => {
    expect(getSubscriptionKnownModels('opencode-go')).toEqual([
      'opencode-go/deepseek-flash',
      'opencode-go/deepseek-v4.1-flash',
      'opencode-go/muse-spark-1.3-contributor',
      'opencode-go/omen-alpha',
    ]);
  });

  it('returns known models for gemini', () => {
    const models = getSubscriptionKnownModels('gemini');
    expect(models).toContain('gemini-3.5-flash');
    expect(models).toContain('gemini-3.1-flash-lite');
    expect(models).toContain('gemini-2.5-pro');
    expect(models).toContain('gemini-2.5-flash');
    expect(models).toContain('gemini-2.5-flash-lite');
    expect(models).not.toContain('gemini-3.1-flash-lite-preview');
    expect(models).not.toContain('gemini-3.1-pro-preview');
    expect(models).not.toContain('gemini-3-flash-preview');
    expect(models).not.toContain('gemini-3.6-flash');
  });

  it('returns known models for xai', () => {
    const models = getSubscriptionKnownModels('xai');
    expect(models).toEqual(['grok-4.6', 'grok-4.5']);
  });

  it('returns null for unsupported providers', () => {
    expect(getSubscriptionKnownModels('unknown')).toBeNull();
  });
});

describe('getSubscriptionKnownModelsMatch', () => {
  it('returns prefix for providers with no knownModelsMatch override (default)', () => {
    // anthropic has no knownModelsMatch field → defaults to 'prefix'
    expect(getSubscriptionKnownModelsMatch('anthropic')).toBe('prefix');
  });

  it('returns exact for openai', () => {
    expect(getSubscriptionKnownModelsMatch('openai')).toBe('exact');
  });

  it('returns exact for gemini', () => {
    // gemini has knownModelsMatch: 'exact' — only explicitly allowed CodeAssist
    // model IDs are shown.
    expect(getSubscriptionKnownModelsMatch('gemini')).toBe('exact');
  });

  it('returns exact for BytePlus ModelArk Coding Plan', () => {
    expect(getSubscriptionKnownModelsMatch('byteplus')).toBe('exact');
  });

  it('returns exact for moonshot Kimi Coding Plan', () => {
    expect(getSubscriptionKnownModelsMatch('moonshot')).toBe('exact');
  });

  it('returns exact for Mistral Vibe', () => {
    expect(getSubscriptionKnownModelsMatch('mistral')).toBe('exact');
  });

  it('returns exact for Xiaomi MiMo Token Plan', () => {
    expect(getSubscriptionKnownModelsMatch('xiaomi')).toBe('exact');
  });

  it('returns prefix for Qwen Token Plan (no hardcoded known-model matching)', () => {
    expect(getSubscriptionKnownModelsMatch('qwen')).toBe('prefix');
  });

  it('returns prefix for unsupported providers (graceful fallback)', () => {
    expect(getSubscriptionKnownModelsMatch('unknown')).toBe('prefix');
  });

  it('is case-insensitive', () => {
    expect(getSubscriptionKnownModelsMatch('GEMINI')).toBe('exact');
    expect(getSubscriptionKnownModelsMatch('Anthropic')).toBe('prefix');
  });
});

describe('getSubscriptionCapabilities', () => {
  it('returns capabilities for anthropic', () => {
    const caps = getSubscriptionCapabilities('anthropic');
    expect(caps).toMatchObject({
      maxContextWindow: 200000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
    expect(caps?.modelContextWindows?.['claude-opus-4-8']).toBe(1000000);
    // Opus 5 is 1M too; without an entry it would fall back to the 200k default.
    expect(caps?.modelContextWindows?.['claude-opus-5']).toBe(1000000);
  });

  it('returns capabilities for OpenAI subscription', () => {
    const caps = getSubscriptionCapabilities('openai');
    expect(caps).toMatchObject({
      maxContextWindow: 200000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
    expect(caps?.modelContextWindows).toMatchObject({
      'gpt-5.6-sol': 1050000,
      'gpt-5.6-terra': 1050000,
      'gpt-5.6-luna': 1050000,
    });
  });

  it('returns capabilities for MiniMax Coding Plan', () => {
    const caps = getSubscriptionCapabilities('minimax');
    expect(caps).toMatchObject({
      maxContextWindow: 1000000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for all supported providers', () => {
    for (const id of SUPPORTED_SUBSCRIPTION_PROVIDER_IDS) {
      const caps = getSubscriptionCapabilities(id);
      expect(caps).not.toBeNull();
      expect(caps!.maxContextWindow).toBeGreaterThan(0);
      expect(typeof caps!.supportsPromptCaching).toBe('boolean');
      expect(typeof caps!.supportsBatching).toBe('boolean');
    }
  });

  it('returns capabilities for ollama-cloud', () => {
    const caps = getSubscriptionCapabilities('ollama-cloud');
    expect(caps).toMatchObject({
      maxContextWindow: 128000,
      supportsPromptCaching: false,
      supportsBatching: false,
    });
  });

  it('returns capabilities for BytePlus ModelArk Coding Plan', () => {
    const caps = getSubscriptionCapabilities('byteplus');
    expect(caps).toMatchObject({
      maxContextWindow: 256000,
      supportsPromptCaching: false,
      supportsBatching: false,
    });
  });

  it('returns capabilities for zai with 204800 context window', () => {
    const caps = getSubscriptionCapabilities('zai');
    expect(caps).toMatchObject({
      maxContextWindow: 204800,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for moonshot Kimi Coding Plan', () => {
    const caps = getSubscriptionCapabilities('moonshot');
    expect(caps).toMatchObject({
      maxContextWindow: 262144,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
    expect(caps?.modelContextWindows?.['k3']).toBe(1048576);
    expect(caps?.modelContextWindows?.['k3-256k']).toBe(262144);
  });

  it('returns capabilities for Qwen Token Plan', () => {
    const caps = getSubscriptionCapabilities('qwen');
    expect(caps).toMatchObject({
      maxContextWindow: 991000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for Mistral Vibe subscription', () => {
    const caps = getSubscriptionCapabilities('mistral');
    expect(caps).toMatchObject({
      maxContextWindow: 200000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for Xiaomi MiMo Token Plan', () => {
    const caps = getSubscriptionCapabilities('xiaomi');
    expect(caps).toMatchObject({
      maxContextWindow: 1048576,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for xai', () => {
    const caps = getSubscriptionCapabilities('xai');
    expect(caps).toMatchObject({
      maxContextWindow: 500000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for Gemini subscription', () => {
    const caps = getSubscriptionCapabilities('gemini');
    expect(caps).toMatchObject({
      maxContextWindow: 1000000,
      supportsPromptCaching: true,
      supportsBatching: false,
    });
  });

  it('returns capabilities for Command Code', () => {
    const caps = getSubscriptionCapabilities('commandcode');
    expect(caps).toMatchObject({
      maxContextWindow: 1000000,
      supportsPromptCaching: false,
      supportsBatching: false,
    });
  });

  it('returns capabilities for Nous', () => {
    const caps = getSubscriptionCapabilities('nous');
    expect(caps).toMatchObject({
      maxContextWindow: 1000000,
      supportsPromptCaching: false,
      supportsBatching: false,
    });
  });

  it('returns null for unsupported providers', () => {
    expect(getSubscriptionCapabilities('unknown')).toBeNull();
  });
});
