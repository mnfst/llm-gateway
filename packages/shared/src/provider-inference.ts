import { SHARED_PROVIDERS } from './providers';

/**
 * Infer a provider ID from a model name string.
 * This is the unified superset of all regex patterns from backend and frontend.
 */
const MODEL_PREFIX_MAP: [RegExp, string][] = [
  [/^openrouter\//, 'openrouter'],
  [/^claude-/, 'anthropic'],
  [/^gpt-|^o[134]-|^o[134] |^chatgpt-/, 'openai'],
  [/^gemini-|^gemma-/, 'gemini'],
  [/^deepseek-/, 'deepseek'],
  [/^grok-/, 'xai'],
  [/^mistral-|^codestral|^pixtral|^open-mistral/, 'mistral'],
  // `k3` / `k3-256k` are the bare wire ids of the Kimi Coding Plan — match
  // exactly `k3` or `k3-<suffix>` so unrelated ids (k3pro, k30) stay unmatched.
  [/^kimi-|^moonshot-|^k3(-|$)/, 'moonshot'],
  [/^minimax-/i, 'minimax'],
  [/^mimo-v/i, 'xiaomi'],
  [/^glm-/, 'zai'],
  [/^qwen[23]|^qwq-/, 'qwen'],
  [/^copilot\//, 'copilot'],
  [/^commandcode\//, 'commandcode'],
  [/^pioneer\//, 'pioneer'],
  [/^opencode-go\//, 'opencode-go'],
  [/^opencode-zen\//, 'opencode-zen'],
  [/^kiro\//, 'kiro'],
  [/^llamacpp\//, 'llamacpp'],
  [/^[a-z][\w-]*\//, 'openrouter'],
];

export { MODEL_PREFIX_MAP };

/**
 * Gateway model-id prefixes. A gateway transparently proxies another
 * provider's API, so the id after the prefix is the underlying provider's
 * own model id (e.g. `opencode-go/deepseek-v4-pro` -> `deepseek-v4-pro`).
 */
const GATEWAY_MODEL_PREFIXES = ['opencode-go/', 'opencode-zen/'] as const;

const BEDROCK_PROVIDER_TOKENS = new Map<string, string>();
for (const provider of SHARED_PROVIDERS) {
  const tokens = [provider.id, ...provider.aliases, ...provider.openRouterPrefixes];
  for (const token of tokens) {
    BEDROCK_PROVIDER_TOKENS.set(token.toLowerCase(), provider.id);
  }
}

export function resolveProviderToken(token: string): string | undefined {
  return BEDROCK_PROVIDER_TOKENS.get(token.toLowerCase());
}

/**
 * If `model` is a gateway model id, return the underlying provider's model
 * id; otherwise return `null`. Used to resolve gateway models to the
 * provenance provider whose parameters and capabilities they inherit.
 */
export function underlyingGatewayModel(model: string): string | null {
  for (const prefix of GATEWAY_MODEL_PREFIXES) {
    if (model.startsWith(prefix)) return model.slice(prefix.length);
  }
  return null;
}

export function inferProviderFromModel(model: string): string | undefined {
  if (model.startsWith('custom:')) return 'custom';
  if (!model.includes('/') && /:/.test(model) && !model.endsWith(':free')) return 'ollama';
  const lower = model.toLowerCase();
  for (const [re, id] of MODEL_PREFIX_MAP) {
    if (re.test(lower)) return id;
  }
  return undefined;
}

/**
 * Resolve a `(provider, model)` pair to the underlying provider and model that
 * own its metadata, transparently unwrapping gateway transports. For a gateway
 * model id (e.g. `opencode-go/glm-5.1`) this returns the provenance provider
 * inferred from the underlying id and that bare id
 * (`{ provider: 'zai', model: 'glm-5.1' }`); non-gateway pairs are returned
 * unchanged. The provider is `undefined` when the underlying id matches no
 * known provider, so callers decide whether to fall back. Capability and
 * parameter lookups route through this so any gateway model inherits the
 * underlying model's metadata, not just OpenCode Go's.
 */
export function resolveUnderlyingModelIdentity(
  provider: string | undefined,
  model: string,
): { provider: string | undefined; model: string } {
  const underlying = underlyingGatewayModel(model);
  if (underlying === null) return { provider, model };
  return { provider: inferProviderFromModel(underlying), model: underlying };
}

/**
 * Resolve the provider/model identity that owns model metadata. This must not
 * be used for inference routing: Bedrock still needs the original model id,
 * but pricing/params/capabilities belong to the underlying model vendor.
 */
export function resolveProviderMetadataIdentity(
  provider: string | undefined,
  model: string,
): { provider: string | undefined; model: string } {
  const gateway = resolveUnderlyingModelIdentity(provider, model);
  if (gateway.provider !== provider || gateway.model !== model) return gateway;

  if (provider?.toLowerCase() !== 'bedrock') return { provider, model };

  const parts = model.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    for (let j = parts.length - 1; j > i; j -= 1) {
      const resolvedProvider = resolveProviderToken(parts.slice(i, j).join('.'));
      if (!resolvedProvider || resolvedProvider === 'bedrock') continue;
      const underlyingModel = parts.slice(j).join('.');
      if (underlyingModel) return { provider: resolvedProvider, model: underlyingModel };
    }
  }

  return { provider, model };
}
