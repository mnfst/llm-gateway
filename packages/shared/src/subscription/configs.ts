import type { SubscriptionProviderConfig } from './types';

export const SUBSCRIPTION_PROVIDER_CONFIGS: Readonly<
  Record<string, Readonly<SubscriptionProviderConfig>>
> = Object.freeze({
  anthropic: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Claude Max / Pro subscription',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your setup-token',
    subscriptionCommand: 'claude setup-token',
    subscriptionTokenPrefix: 'sk-ant-oat',
    knownModels: Object.freeze([
      'claude-fable-5',
      // Anthropic subscription membership comes exclusively from this curated
      // list (no live discovery), so point releases callers address directly
      // need their own entry — the claude-fable-5 prefix alone never emits it.
      'claude-fable-5-1',
      'claude-opus-4',
      'claude-sonnet-4',
      'claude-haiku-4',
      // claude-opus-4-6 / claude-haiku-4-5 are already matched by the
      // claude-opus-4 / claude-haiku-4 prefixes above. claude-opus-5 is not —
      // the 5 generation dropped the 4.x prefix, so it needs its own entry.
      'claude-opus-5',
      'claude-sonnet-5',
    ]),
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 200000,
      modelContextWindows: Object.freeze({
        'claude-opus-4-8': 1000000,
        'claude-opus-5': 1000000,
        'claude-sonnet-5': 1000000,
      }),
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  byteplus: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'ModelArk Coding Plan',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your ModelArk Coding Plan API key',
    knownModels: Object.freeze([
      'ark-code-latest',
      'bytedance-seed-code',
      'glm-5.1',
      'glm-4.7',
      'deepseek-v3.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.5',
      'gpt-oss-120b',
    ]),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 256000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
  openai: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'ChatGPT Plus/Pro/Team',
    subscriptionAuthMode: 'popup_oauth' as const,
    knownModels: Object.freeze([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 200000,
      modelContextWindows: Object.freeze({
        'gpt-5.6-sol': 1050000,
        'gpt-5.6-terra': 1050000,
        'gpt-5.6-luna': 1050000,
      }),
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  minimax: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'MiniMax Coding Plan',
    subscriptionAuthMode: 'device_code' as const,
    knownModels: Object.freeze([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ]),
    subscriptionCapabilities: Object.freeze({
      // MiniMax-M3's 1M window (MSA); M2.x models keep their own lower
      // per-model contexts from the pricing cache — this is only the cap.
      maxContextWindow: 1000000,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  mistral: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Mistral Vibe subscription',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your Mistral Vibe API key',
    knownModels: Object.freeze(['mistral-vibe-cli-latest']),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 200000,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  xiaomi: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Xiaomi MiMo Token Plan',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your MiMo Token Plan API key',
    subscriptionTokenPrefix: 'tp-',
    knownModels: Object.freeze([
      'mimo-v2.5-pro',
      'mimo-v2-pro',
      'mimo-v2.5',
      'mimo-v2-omni',
      'mimo-v2-flash',
    ]),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 1048576,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  qwen: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Qwen Token Plan',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your Qwen Token Plan API key',
    subscriptionTokenPrefix: 'sk-sp-',
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 991000,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  moonshot: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Kimi Coding Plan',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your Kimi Code API key',
    // Wire-format ids expected by https://api.kimi.com/coding — see
    // https://www.kimi.com/code/docs/en/kimi-code/models
    knownModels: Object.freeze(['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 262144,
      modelContextWindows: Object.freeze({
        k3: 1048576,
        // Explicit entry: context-window resolution prefix-matches, so without
        // this k3-256k would inherit the 1M window of its k3 sibling.
        'k3-256k': 262144,
      }),
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  nous: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'NousResearch subscription',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your NousResearch API key',
    // Model list is discovered dynamically from NousResearch Portal's OpenAI-compatible /v1/models.
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 1000000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
  'ollama-cloud': Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Ollama Cloud subscription',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your Ollama API key',
    // No subscriptionTokenPrefix — Ollama Cloud accepts any API key format.
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 128000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
  kiro: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Kiro subscription',
    subscriptionAuthMode: 'device_code' as const,
    knownModels: Object.freeze([
      'kiro/auto',
      'kiro/claude-sonnet-4.5',
      'kiro/claude-sonnet-4',
      'kiro/claude-haiku-4.5',
      'kiro/deepseek-3.2',
      'kiro/minimax-m2.5',
      'kiro/minimax-m2.1',
      'kiro/glm-5',
      'kiro/qwen3-coder-next',
    ]),
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 1000000,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  zai: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'GLM Coding Plan',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your Z.ai API key',
    knownModels: Object.freeze([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-5.2',
      'glm-5.1',
      'glm-5-turbo',
      'glm-5',
      'glm-4.7',
      'glm-4.6',
      'glm-4.5',
      'glm-4.5-air',
    ]),
    subscriptionCapabilities: Object.freeze({
      // Z.ai advertises "200K" as 200 * 1024 = 204800, not 200000 like other providers.
      maxContextWindow: 204800,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  'opencode-go': Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'OpenCode Go (beta)',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your OpenCode API key',
    // Model list is discovered from OpenCode Go's live /models endpoint; models.dev
    // and the docs catalog provide metadata, quota cost, and fallback data.
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 200000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
  gemini: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Sign in with Google',
    subscriptionAuthMode: 'popup_oauth' as const,
    // CodeAssist (gemini-cli) supports a fixed list of Gemini models. The
    // dashboard uses these as fallback when no native /models call returns
    // (CodeAssist does not expose one). Keep this list strict to models that
    // the CodeAssist route recognizes; some current Gemini API model IDs still
    // 404 on the CodeAssist API.
    knownModels: Object.freeze([
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 1000000,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  xai: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Grok subscription',
    subscriptionAuthMode: 'popup_oauth' as const,
    knownModels: Object.freeze(['grok-4.6', 'grok-4.5']),
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 500000,
      supportsPromptCaching: true,
      supportsBatching: false,
    }),
  }),
  copilot: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'GitHub Copilot subscription',
    subscriptionAuthMode: 'device_code' as const,
    knownModels: Object.freeze([
      'copilot/claude-opus-4.6',
      'copilot/claude-sonnet-4.6',
      'copilot/claude-haiku-4.5',
      'copilot/gpt-5.4',
      'copilot/gpt-5.2-codex',
      'copilot/gpt-5-mini',
      'copilot/gpt-4.1',
      'copilot/gpt-4o',
      'copilot/gpt-4o-mini',
      'copilot/gemini-3.1-pro-preview',
      'copilot/grok-code-fast-1',
    ]),
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 200000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
  commandcode: Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'Command Code subscription',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your Command Code API key',
    // Model list is fetched dynamically from Command Code's public Provider API catalog.
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 1000000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
  'cline-pass': Object.freeze({
    supportsSubscription: true as const,
    subscriptionLabel: 'ClinePass subscription',
    subscriptionAuthMode: 'token' as const,
    subscriptionKeyPlaceholder: 'Paste your ClinePass API key',
    knownModels: Object.freeze([
      'cline-pass/glm-5.2',
      'cline-pass/kimi-k2.7-code',
      'cline-pass/kimi-k2.6',
      'cline-pass/kimi-k3',
      'cline-pass/deepseek-v4-pro',
      'cline-pass/deepseek-v4-flash',
      'cline-pass/mimo-v2.5',
      'cline-pass/mimo-v2.5-pro',
      'cline-pass/minimax-m3',
      'cline-pass/qwen3.7-max',
      'cline-pass/qwen3.7-plus',
    ]),
    knownModelsMatch: 'exact' as const,
    subscriptionCapabilities: Object.freeze({
      maxContextWindow: 200000,
      supportsPromptCaching: false,
      supportsBatching: false,
    }),
  }),
});

export const SUPPORTED_SUBSCRIPTION_PROVIDER_IDS: readonly string[] = Object.freeze(
  Object.keys(SUBSCRIPTION_PROVIDER_CONFIGS),
);
