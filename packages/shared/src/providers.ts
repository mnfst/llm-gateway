/**
 * Canonical provider registry shared between backend and frontend.
 *
 * Every provider the system supports is declared here ONCE. Both the backend
 * (`PROVIDER_REGISTRY`) and the frontend (`PROVIDERS`) consume this list.
 * Backend-only fields (OpenRouter vendor prefixes, key requirement flags) live
 * alongside frontend-only visual bits (color, key prefix) so the two packages
 * can never drift on any shared fact.
 */

export interface SharedProviderEntry {
  /** Internal provider ID (lowercase, no spaces). */
  id: string;
  /** Human-readable display name shown in the UI. */
  displayName: string;
  /** Alternative IDs that map to this provider. */
  aliases: readonly string[];
  /**
   * OpenRouter vendor prefixes that map to this provider.
   * Used to attribute models from OpenRouter's API to their real provider.
   * E.g. "anthropic" prefix in "anthropic/claude-opus-4-6" → Anthropic.
   */
  openRouterPrefixes: readonly string[];
  /** Whether the provider requires an API key for model fetching. */
  requiresApiKey: boolean;
  /** Whether this provider is local-only (e.g. Ollama). */
  localOnly: boolean;
  /** Brand color used in the UI. */
  color: string;
  /** Expected API-key prefix (used for validation / placeholder). */
  keyPrefix: string;
  /** Minimum plausible API-key length. */
  minKeyLength: number;
  /** Placeholder shown in the UI's API-key input. */
  keyPlaceholder: string;
  /** Whether Manifest provisions this provider through its managed free-provider flow. */
  managedFree?: boolean;
  /**
   * Tiles that deep-link users into the local-server detail view (LM
   * Studio today). They do not have a fixed proxy endpoint — once
   * connected, the backend routes through the `custom:<uuid>` path
   * using the user-entered base URL. The proxy endpoint sanity test
   * skips entries with `tileOnly: true`.
   */
  tileOnly?: boolean;
}

export interface MetaModelApiModel {
  id: string;
  displayName: string;
}

export const META_MODEL_API_CONTEXT_WINDOW = 1_048_576;

export const META_MODEL_API_MODELS: readonly MetaModelApiModel[] = [
  { id: 'muse-spark-1.2', displayName: 'Muse Spark 1.2' },
  {
    id: 'muse-spark-1.2-contributor',
    displayName: 'Muse Spark 1.2 Contributor (inputs and outputs may train Meta)',
  },
  { id: 'muse-spark-1.1', displayName: 'Muse Spark 1.1' },
];

export const META_MODEL_API_MODEL_BY_ID: ReadonlyMap<string, MetaModelApiModel> = new Map(
  META_MODEL_API_MODELS.map((model) => [model.id, model]),
);

export const SHARED_PROVIDERS: readonly SharedProviderEntry[] = [
  {
    id: 'qwen',
    displayName: 'Alibaba Cloud',
    aliases: ['alibaba'],
    openRouterPrefixes: ['qwen', 'alibaba'],
    requiresApiKey: true,
    localOnly: false,
    color: '#FF6003',
    keyPrefix: 'sk-',
    minKeyLength: 30,
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    aliases: [],
    openRouterPrefixes: ['anthropic'],
    requiresApiKey: true,
    localOnly: false,
    color: '#d97757',
    keyPrefix: 'sk-ant-',
    minKeyLength: 50,
    keyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    aliases: ['aws-bedrock', 'aws bedrock', 'amazon-bedrock', 'amazon bedrock'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#ff9900',
    keyPrefix: '',
    minKeyLength: 100,
    keyPlaceholder: 'ABSK...',
  },
  {
    id: 'vertex',
    displayName: 'Google Vertex AI',
    aliases: ['google-vertex', 'google vertex', 'vertex-ai', 'vertex ai'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#4285f4',
    keyPrefix: 'AQ.',
    minKeyLength: 40,
    keyPlaceholder: 'AQ...',
  },
  {
    id: 'byteplus',
    displayName: 'BytePlus',
    aliases: ['byteplus-plan', 'byteplus plan', 'modelark', 'modelark-coding-plan'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#0B5CFF',
    keyPrefix: '',
    minKeyLength: 10,
    keyPlaceholder: 'ModelArk Coding Plan API key',
  },
  {
    id: 'cline-pass',
    displayName: 'ClinePass',
    aliases: ['cline'],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: false,
    color: '#9D4EDD',
    keyPrefix: 'sk_',
    minKeyLength: 20,
    keyPlaceholder: 'sk_...',
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    aliases: [],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#F1592A',
    keyPrefix: '',
    minKeyLength: 20,
    keyPlaceholder: 'Cerebras API key',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    aliases: [],
    openRouterPrefixes: ['deepseek'],
    requiresApiKey: true,
    localOnly: false,
    color: '#4d6bfe',
    keyPrefix: 'sk-',
    minKeyLength: 30,
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    aliases: ['fireworks-ai', 'fireworks ai', 'fireworksai'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#FF5A1F',
    keyPrefix: 'fw_',
    minKeyLength: 20,
    keyPlaceholder: 'fw_...',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    aliases: [],
    // Groq has its own native /models endpoint, so we never want to attribute
    // Groq models from the OpenRouter pricing cache here. Mapping OR's
    // `groq/*` prefix to this entry would surface models the user can't
    // actually call (e.g. compound-*) and render them with the OpenRouter
    // logo. Pricing for the native Groq catalog comes from
    // known-model-prices.ts as a last-resort fallback.
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    // Brand orange from groq.com/favicon.svg
    color: '#F43E01',
    keyPrefix: 'gsk_',
    minKeyLength: 50,
    keyPlaceholder: 'gsk_...',
  },
  {
    id: 'huggingface',
    displayName: 'Hugging Face',
    aliases: ['hugging-face', 'hugging face', 'hf'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#FFD21E',
    keyPrefix: 'hf_',
    minKeyLength: 20,
    keyPlaceholder: 'hf_...',
  },
  {
    id: 'kilo',
    displayName: 'Kilo',
    aliases: ['kilocode', 'kilo-code'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#f0e68c',
    keyPrefix: '',
    minKeyLength: 10,
    keyPlaceholder: 'Kilo Gateway API key',
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    aliases: [],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: false,
    color: '#000000',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
  },
  {
    id: 'commandcode',
    displayName: 'Command Code',
    aliases: ['command-code', 'command code', 'cmd'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#000000',
    keyPrefix: 'user_',
    minKeyLength: 50,
    keyPlaceholder: 'user_...',
  },
  {
    id: 'gemini',
    displayName: 'Google',
    aliases: ['google'],
    openRouterPrefixes: ['google'],
    requiresApiKey: true,
    localOnly: false,
    color: '#4285f4',
    keyPrefix: '',
    minKeyLength: 30,
    keyPlaceholder: 'API key',
  },
  {
    id: 'gemini-free',
    displayName: 'Gemini Free',
    aliases: ['gemini free'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#4285f4',
    keyPrefix: 'sk-',
    minKeyLength: 10,
    keyPlaceholder: 'sk-...',
    managedFree: true,
  },
  {
    id: 'kiro',
    displayName: 'Kiro',
    aliases: [],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: false,
    color: '#6D5EF9',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    aliases: [],
    openRouterPrefixes: ['minimax'],
    requiresApiKey: true,
    localOnly: false,
    color: '#E73562',
    keyPrefix: 'sk-',
    minKeyLength: 30,
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'meta',
    displayName: 'Meta',
    aliases: [],
    openRouterPrefixes: ['meta'],
    requiresApiKey: true,
    localOnly: false,
    color: '#0668E1',
    keyPrefix: 'LLM_',
    minKeyLength: 20,
    keyPlaceholder: 'LLM_...',
  },
  {
    id: 'xiaomi',
    displayName: 'Xiaomi MiMo',
    aliases: ['mimo', 'xiaomi-mimo', 'xiaomi mimo'],
    openRouterPrefixes: ['xiaomi'],
    requiresApiKey: true,
    localOnly: false,
    color: '#FF6900',
    keyPrefix: 'sk-',
    minKeyLength: 50,
    keyPlaceholder: 'sk-xxxxx',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    aliases: [],
    openRouterPrefixes: ['mistralai'],
    requiresApiKey: true,
    localOnly: false,
    color: '#f97316',
    keyPrefix: '',
    minKeyLength: 32,
    keyPlaceholder: 'API key',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot',
    aliases: ['kimi'],
    openRouterPrefixes: ['moonshotai'],
    requiresApiKey: true,
    localOnly: false,
    color: '#1a1a2e',
    keyPrefix: 'sk-',
    minKeyLength: 30,
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'nous',
    displayName: 'NousResearch',
    aliases: ['nousresearch', 'nous-research', 'nous research'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#101820',
    keyPrefix: '',
    minKeyLength: 10,
    keyPlaceholder: 'NousResearch API key',
  },
  {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    aliases: ['nvidia-nim', 'nvidia nim', 'nvidianim', 'nim'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#76B900',
    keyPrefix: '',
    minKeyLength: 20,
    keyPlaceholder: 'nvapi-...',
  },
  {
    id: 'llamacpp',
    displayName: 'llama.cpp',
    aliases: ['llama.cpp', 'llama-cpp'],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: true,
    tileOnly: true,
    color: '#2d2d2d',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio',
    aliases: ['lm-studio', 'lm studio'],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: true,
    tileOnly: true,
    color: '#4a90e2',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    aliases: [],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: true,
    color: '#1a1a1a',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
  },
  {
    id: 'ollama-cloud',
    displayName: 'Ollama Cloud',
    aliases: [],
    openRouterPrefixes: [],
    requiresApiKey: false,
    localOnly: false,
    color: '#1a1a1a',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    aliases: [],
    openRouterPrefixes: ['openai'],
    requiresApiKey: true,
    localOnly: false,
    color: '#10a37f',
    keyPrefix: 'sk-',
    minKeyLength: 50,
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'pioneer',
    displayName: 'Pioneer',
    aliases: ['pioneer-ai', 'pioneer ai'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#EA580C',
    keyPrefix: 'pio_sk_',
    minKeyLength: 20,
    keyPlaceholder: 'pio_sk_...',
  },
  {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    aliases: ['opencodego'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#7C3AED',
    keyPrefix: '',
    minKeyLength: 20,
    keyPlaceholder: '',
  },
  {
    id: 'opencode-zen',
    displayName: 'OpenCode Zen',
    aliases: ['opencodezen'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#211E1E',
    keyPrefix: '',
    minKeyLength: 20,
    keyPlaceholder: 'OpenCode Zen API key',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    aliases: [],
    openRouterPrefixes: ['openrouter'],
    requiresApiKey: true,
    localOnly: false,
    color: '#6366f1',
    keyPrefix: 'sk-or-',
    minKeyLength: 60,
    keyPlaceholder: 'sk-or-...',
  },
  {
    id: 'xai',
    displayName: 'xAI',
    aliases: [],
    openRouterPrefixes: ['xai', 'x-ai'],
    requiresApiKey: true,
    localOnly: false,
    color: '#555555',
    keyPrefix: 'xai-',
    minKeyLength: 50,
    keyPlaceholder: 'xai-...',
  },
  {
    id: 'zai',
    displayName: 'Z.ai',
    aliases: ['z.ai'],
    openRouterPrefixes: ['z-ai', 'zhipuai'],
    requiresApiKey: true,
    localOnly: false,
    color: '#2d2d2d',
    keyPrefix: '',
    minKeyLength: 30,
    keyPlaceholder: 'API key',
  },
  {
    id: 'edenai',
    displayName: 'Eden AI',
    aliases: ['eden-ai', 'eden ai'],
    openRouterPrefixes: [],
    requiresApiKey: true,
    localOnly: false,
    color: '#5646ff',
    keyPrefix: '',
    minKeyLength: 40,
    keyPlaceholder: 'Eden AI API key',
  },
] as const;

/**
 * Canonical IDs of providers that run on the user's own machine.
 * Used by the backend (`getAuthType`) and the frontend (provider modal
 * tabs, filtering) to decide whether a provider should be tagged
 * `auth_type: 'local'` and surfaced under the Local tab.
 */
export const CANONICAL_LOCAL_IDS: ReadonlySet<string> = new Set(
  SHARED_PROVIDERS.filter((p) => p.localOnly).map((p) => p.id),
);

/** Map from provider ID → shared entry. */
export const SHARED_PROVIDER_BY_ID: ReadonlyMap<string, SharedProviderEntry> = new Map(
  SHARED_PROVIDERS.map((p) => [p.id, p]),
);

/** Map from any ID or alias → shared entry. */
export const SHARED_PROVIDER_BY_ID_OR_ALIAS: ReadonlyMap<string, SharedProviderEntry> = new Map(
  SHARED_PROVIDERS.flatMap((p) => [
    [p.id, p],
    ...p.aliases.map((a): [string, SharedProviderEntry] => [a, p]),
  ]),
);

/**
 * Collapse whitespace, dots, underscores, and hyphens so variants like
 * "LM Studio", "lm-studio", "lm.studio" and "lmstudio" all normalize to
 * the same alias key. Used wherever we match a free-form provider name
 * (custom-provider row names, deep-link params, test fixtures) against
 * `SHARED_PROVIDER_BY_ID_OR_ALIAS`.
 */
export const normalizeProviderName = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[\s._\-]+/g, '');

/**
 * Setup hints for local-LLM provider tiles: default port, setup command,
 * install URL, and Docker-specific fix copy. Consumed by the frontend
 * detail view to surface actionable guidance when the server is
 * unreachable.
 */
export interface LocalServerHint {
  /** Default port the server listens on. */
  defaultPort: number;
  /** One-line terminal command that starts the server with the right flags. */
  setupCommand: string;
  /** Optional note displayed below the setup command (e.g. to explain placeholders). */
  setupNote?: string;
  /** Where to send users who don't have the server installed yet (homepage / download page). */
  installUrl: string;
  /**
   * Short human-readable note shown at the top of the detail view when
   * the user is running Manifest inside Docker and the server needs to
   * bind `0.0.0.0` (otherwise host.docker.internal can't reach it).
   */
  dockerBindNote?: string;
  /**
   * One-liner CLI command that explicitly rebinds the server to `0.0.0.0`
   * so it's reachable from a Docker container on the same host. Used in
   * the Docker caveat card when the user's default setupCommand doesn't
   * already include the right bind (LM Studio's default is loopback).
   */
  dockerBindCommand?: string;
  /**
   * Human-readable GUI path to flip the "serve on network" toggle in the
   * provider's desktop app. Shown alongside the CLI command for users
   * who prefer not to open a terminal. Only set for providers that have
   * such a toggle (LM Studio).
   */
  dockerGuiFix?: string;
  /**
   * True when the provider's server-start flags persist across restarts
   * (LM Studio remembers the last `--bind`). Surfaces a "one-time setup"
   * reassurance line so users know they don't have to re-run on every
   * launch.
   */
  persistsBindAcrossLaunches?: boolean;
  /**
   * Optional extra copy shown in the failure state under the setup
   * command, with a clickable link that opens the custom-provider form
   * as an escape hatch. Used by llama.cpp to surface that pre-b3800
   * builds don't expose `/v1/models` so the probe can 404 even when the
   * server is up. Structured as three fields so the renderer doesn't
   * have to parse a magic substring out of a free-form string.
   */
  notReachableHint?: {
    before: string;
    linkLabel: string;
    after: string;
  };
}

export const LOCAL_SERVER_HINTS: Readonly<Record<string, LocalServerHint>> = {
  ollama: {
    defaultPort: 11434,
    setupCommand: 'ollama pull llama3.1:8b   # then: ollama serve',
    installUrl: 'https://ollama.com/download',
  },
  lmstudio: {
    defaultPort: 1234,
    setupCommand: 'lms server start',
    installUrl: 'https://lmstudio.ai',
    dockerBindNote:
      'LM Studio listens on 127.0.0.1 by default, which a Docker container can\u2019t reach. Either flip the GUI toggle or run the CLI below.',
    dockerBindCommand: 'lms server start --bind 0.0.0.0 --port 1234 --cors',
    dockerGuiFix:
      'LM Studio \u2192 \u2699 Developer \u2192 enable \u201cServe on Local Network\u201d',
    persistsBindAcrossLaunches: true,
  },
  llamacpp: {
    defaultPort: 8080,
    setupCommand: 'llama-server -m <your-model>.gguf --port 8080',
    setupNote: 'Replace <your-model>.gguf with the path to a GGUF model on your machine.',
    installUrl: 'https://github.com/ggml-org/llama.cpp#obtaining-and-quantizing-models',
    dockerBindNote:
      "llama-server only listens on 0.0.0.0 if you pass --host 0.0.0.0; the default bind isn't reachable from Docker.",
    dockerBindCommand: 'llama-server -m <your-model>.gguf --host 0.0.0.0 --port 8080',
    notReachableHint: {
      before:
        'Recent llama.cpp builds expose /v1/models by default. If yours 404s, upgrade llama-server or use ',
      linkLabel: 'Add custom provider',
      after: ' to register the model manually.',
    },
  },
};
