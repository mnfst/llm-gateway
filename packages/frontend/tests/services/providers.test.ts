import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  STAGES,
  getModelLabel,
  getProvider,
  buildProviderDef,
} from '../../src/services/providers';
import { validateApiKey, validateSubscriptionKey } from '../../src/services/provider-utils';
import {
  EMAIL_PROVIDER_API_KEY_URLS,
  SUBSCRIPTION_PROVIDER_KEY_URLS,
  getRoutingProviderApiKeyUrl,
  getEmailProviderApiKeyUrl,
  getSubscriptionProviderKeyUrl,
} from '../../src/services/provider-api-key-urls';

/* ── getProvider ────────────────────────────────── */

describe('getProvider', () => {
  it('returns the provider definition for a known ID', () => {
    const result = getProvider('openai');
    expect(result).toBeDefined();
    expect(result!.name).toBe('OpenAI');
  });

  it('returns undefined for an unknown ID', () => {
    expect(getProvider('nonexistent')).toBeUndefined();
  });
});

/* ── validateApiKey ─────────────────────────────── */

describe('validateApiKey', () => {
  it('returns valid for a provider that requires no key', () => {
    const ollama = getProvider('ollama')!;
    expect(validateApiKey(ollama, '')).toEqual({ valid: true });
  });

  it('returns invalid when key is empty', () => {
    const openai = getProvider('openai')!;
    expect(validateApiKey(openai, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
  });

  it('returns invalid when key is only whitespace', () => {
    const openai = getProvider('openai')!;
    expect(validateApiKey(openai, '   ')).toEqual({
      valid: false,
      error: 'API key is required',
    });
  });

  it('returns invalid when key does not match expected prefix', () => {
    const anthropic = getProvider('anthropic')!;
    expect(
      validateApiKey(anthropic, 'wrong-prefix-key-that-is-long-enough-for-validation'),
    ).toEqual({
      valid: false,
      error: 'Anthropic keys start with "sk-ant-"',
    });
  });

  it('returns invalid when key is too short', () => {
    const openai = getProvider('openai')!;
    expect(validateApiKey(openai, 'sk-short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 50 characters)',
    });
  });

  it('returns valid for a correct key', () => {
    const openai = getProvider('openai')!;
    const validKey = 'sk-' + 'a'.repeat(60);
    expect(validateApiKey(openai, validKey)).toEqual({ valid: true });
  });

  it('validates MiniMax key prefix and length', () => {
    const minimax = getProvider('minimax')!;
    expect(validateApiKey(minimax, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(minimax, 'wrong-prefix-key-that-is-long-enough-for-validation')).toEqual({
      valid: false,
      error: 'MiniMax keys start with "sk-"',
    });
    expect(validateApiKey(minimax, 'sk-api-short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 30 characters)',
    });
    expect(validateApiKey(minimax, 'sk-api-' + 'a'.repeat(30))).toEqual({ valid: true });
  });

  it('validates Z.ai key with no prefix and minimum length', () => {
    const zai = getProvider('zai')!;
    expect(validateApiKey(zai, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(zai, 'short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 30 characters)',
    });
    expect(validateApiKey(zai, 'a'.repeat(30))).toEqual({ valid: true });
  });

  it('validates Fireworks AI key prefix and length', () => {
    const fireworks = getProvider('fireworks')!;
    expect(validateApiKey(fireworks, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(fireworks, 'sk-wrong-prefix-that-is-long-enough')).toEqual({
      valid: false,
      error: 'Fireworks AI keys start with "fw_"',
    });
    expect(validateApiKey(fireworks, 'fw_short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 20 characters)',
    });
    expect(validateApiKey(fireworks, 'fw_' + 'a'.repeat(20))).toEqual({ valid: true });
  });

  it('validates Cerebras keys by length without enforcing an undocumented prefix', () => {
    const cerebras = getProvider('cerebras')!;
    expect(cerebras.keyPlaceholder).toBe('Cerebras API key');
    expect(validateApiKey(cerebras, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(cerebras, 'short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 20 characters)',
    });
    expect(validateApiKey(cerebras, 'x'.repeat(20))).toEqual({ valid: true });
  });

  it('validates Pioneer key prefix and length', () => {
    const pioneer = getProvider('pioneer')!;
    expect(pioneer.keyPlaceholder).toBe('pio_sk_...');
    expect(validateApiKey(pioneer, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(pioneer, 'sk-wrong-prefix-that-is-long-enough')).toEqual({
      valid: false,
      error: 'Pioneer keys start with "pio_sk_"',
    });
    expect(validateApiKey(pioneer, 'pio_sk_short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 20 characters)',
    });
    expect(validateApiKey(pioneer, 'pio_sk_' + 'a'.repeat(20))).toEqual({ valid: true });
  });

  it('validates AWS Bedrock raw bearer-token and legacy API-key lengths', () => {
    const bedrock = getProvider('bedrock')!;
    expect(validateApiKey(bedrock, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(bedrock, 'bedrock-api-key-short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 100 characters)',
    });
    expect(validateApiKey(bedrock, 'ABSKTWFudGxlQXBpS2V5LWV4YW1wbGU='.padEnd(100, 'A'))).toEqual({
      valid: true,
    });
    expect(validateApiKey(bedrock, 'bedrock-api-key-' + 'a'.repeat(100))).toEqual({
      valid: true,
    });
  });

  it('validates Xiaomi MiMo API key prefix and length', () => {
    const xiaomi = getProvider('xiaomi')!;
    expect(xiaomi.keyPlaceholder).toBe('sk-xxxxx');
    expect(validateApiKey(xiaomi, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(xiaomi, 'wrong-prefix-key')).toEqual({
      valid: false,
      error: 'Xiaomi MiMo keys start with "sk-"',
    });
    expect(validateApiKey(xiaomi, 'sk-short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 50 characters)',
    });
    expect(validateApiKey(xiaomi, `sk-${'a'.repeat(47)}`)).toEqual({ valid: true });
  });

  it('validates Meta Model API key prefix and length', () => {
    const meta = getProvider('meta')!;
    expect(meta.keyPlaceholder).toBe('LLM_...');
    expect(validateApiKey(meta, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(meta, 'wrong-prefix-key-that-is-long-enough')).toEqual({
      valid: false,
      error: 'Meta keys start with "LLM_"',
    });
    expect(validateApiKey(meta, 'LLM_short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 20 characters)',
    });
    expect(validateApiKey(meta, `LLM_${'a'.repeat(20)}`)).toEqual({ valid: true });
  });

  it('validates NVIDIA NIM key length without enforcing an undocumented prefix', () => {
    const nvidia = getProvider('nvidia')!;
    expect(nvidia.keyPlaceholder).toBe('nvapi-...');
    expect(validateApiKey(nvidia, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(nvidia, 'short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 20 characters)',
    });
    expect(validateApiKey(nvidia, 'x'.repeat(20))).toEqual({ valid: true });
  });

  it('validates Hugging Face access tokens', () => {
    const huggingface = getProvider('huggingface')!;
    expect(validateApiKey(huggingface, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(huggingface, 'sk_wrong_prefix_but_long_enough')).toEqual({
      valid: false,
      error: 'Hugging Face keys start with "hf_"',
    });
    expect(validateApiKey(huggingface, 'hf_short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 20 characters)',
    });
    expect(validateApiKey(huggingface, `hf_${'a'.repeat(20)}`)).toEqual({ valid: true });
  });
});

/* ── validateSubscriptionKey ────────────────────── */

describe('validateSubscriptionKey', () => {
  it('returns invalid when token is empty', () => {
    const anthropic = getProvider('anthropic')!;
    expect(validateSubscriptionKey(anthropic, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
  });

  it('returns invalid when token is too short (no subscription prefix configured)', () => {
    // Pick a provider without a SUBSCRIPTION_PREFIXES entry so the length
    // check fires before any prefix gate would.
    const deepseek = getProvider('deepseek')!;
    expect(validateSubscriptionKey(deepseek, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
  });

  it('returns invalid when Anthropic token has wrong prefix', () => {
    const anthropic = getProvider('anthropic')!;
    expect(validateSubscriptionKey(anthropic, 'sk-wrong-prefix-long-enough-token')).toEqual({
      valid: false,
      error: 'Anthropic subscription tokens start with "sk-ant-oat"',
    });
  });

  it('returns valid for a correct Anthropic subscription token', () => {
    const anthropic = getProvider('anthropic')!;
    expect(validateSubscriptionKey(anthropic, 'sk-ant-oat01-valid-token-here')).toEqual({
      valid: true,
    });
  });

  it('returns valid for an OpenAI subscription token (JWT format)', () => {
    const openai = getProvider('openai')!;
    expect(validateSubscriptionKey(openai, 'eyJhbGciOiJSUzI1NiIsInR5cCI6Ikp')).toEqual({
      valid: true,
    });
  });

  it('returns invalid for an empty OpenAI subscription token', () => {
    const openai = getProvider('openai')!;
    expect(validateSubscriptionKey(openai, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
  });

  it('returns invalid for a too-short OpenAI subscription token', () => {
    const openai = getProvider('openai')!;
    expect(validateSubscriptionKey(openai, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
  });

  it('rejects an OpenAI API key in subscription mode', () => {
    const openai = getProvider('openai')!;
    expect(validateSubscriptionKey(openai, 'sk-proj-1234567890abcdef')).toEqual({
      valid: false,
      error: 'This looks like an API key. Use the API Key tab instead.',
    });
  });

  it('does not reject non-API-key tokens for providers without API_KEY_PREFIXES', () => {
    const deepseek = getProvider('deepseek')!;
    expect(validateSubscriptionKey(deepseek, 'some-valid-token-here')).toEqual({
      valid: true,
    });
  });

  it('rejects a MiniMax subscription token without the sk-cp- prefix', () => {
    const minimax = getProvider('minimax')!;
    expect(validateSubscriptionKey(minimax, 'sk-api-some-long-enough-token')).toEqual({
      valid: false,
      error: 'MiniMax subscription tokens start with "sk-cp-"',
    });
  });

  it('accepts a valid MiniMax sk-cp- Coding Plan token', () => {
    const minimax = getProvider('minimax')!;
    expect(validateSubscriptionKey(minimax, 'sk-cp-' + 'a'.repeat(40))).toEqual({
      valid: true,
    });
  });

  it('rejects a regular Qwen API key in Token Plan subscription mode', () => {
    const qwen = getProvider('qwen')!;
    expect(validateSubscriptionKey(qwen, 'sk-' + 'a'.repeat(40))).toEqual({
      valid: false,
      error: 'Alibaba Cloud subscription tokens start with "sk-sp-"',
    });
  });

  it('accepts a valid Qwen Token Plan sk-sp API key', () => {
    const qwen = getProvider('qwen')!;
    expect(validateSubscriptionKey(qwen, 'sk-sp-' + 'a'.repeat(40))).toEqual({
      valid: true,
    });
  });

  it('rejects a too-short Qwen Token Plan key', () => {
    const qwen = getProvider('qwen')!;
    expect(validateSubscriptionKey(qwen, 'sk-sp-1234')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 30 characters)',
    });
  });

  it('rejects a regular Xiaomi MiMo API key in Token Plan subscription mode', () => {
    const xiaomi = getProvider('xiaomi')!;
    expect(validateSubscriptionKey(xiaomi, 'sk-mimo-valid')).toEqual({
      valid: false,
      error: 'Xiaomi MiMo subscription tokens start with "tp-"',
    });
  });

  it('accepts a valid Xiaomi MiMo Token Plan key', () => {
    const xiaomi = getProvider('xiaomi')!;
    expect(validateSubscriptionKey(xiaomi, 'tp-mimo-valid')).toEqual({
      valid: true,
    });
  });

  it("rejects a MiniMax Coding Plan token shorter than the provider's minKeyLength", () => {
    const minimax = getProvider('minimax')!;
    // sk-cp- prefix (6) + 4 chars = 10 total: passes the generic 10-char floor
    // but should fail MiniMax's stricter 30-char minimum.
    expect(validateSubscriptionKey(minimax, 'sk-cp-1234')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 30 characters)',
    });
  });

  it('exposes the MiniMax Coding Plan token alternative on the provider def', () => {
    const minimax = getProvider('minimax')!;
    expect(minimax.subscriptionTokenAlternative).toEqual({
      prefix: 'sk-cp-',
      placeholder: 'sk-cp-...',
      dividerLabel: expect.stringContaining('Coding Plan token'),
    });
  });
});

/* ── getModelLabel ──────────────────────────────── */

describe('getModelLabel', () => {
  it('returns the static label for known models', () => {
    // OpenAI has a static models list, so exact match returns the label
    expect(getModelLabel('openai', 'gpt-4o')).toBe('GPT-4o');
    // Anthropic has empty models[], so getModelLabel falls back to formatModelSlug
    expect(getModelLabel('anthropic', 'claude-opus-4')).toBe('Claude Opus 4');
  });

  it('returns modelValue when providerId is not found', () => {
    expect(getModelLabel('nonexistent', 'some-model')).toBe('some-model');
  });

  it('formats via formatModelSlug when date suffix is present', () => {
    // No models in PROVIDERS, so date-suffix stripping finds nothing;
    // falls back to formatModelSlug on the full slug
    expect(getModelLabel('anthropic', 'claude-sonnet-4-20261231')).toBe('Claude Sonnet 4 20261231');
  });

  it('formats via formatModelSlug for non-8-digit suffixes', () => {
    // No models in PROVIDERS to match; formatModelSlug processes the full slug
    expect(getModelLabel('anthropic', 'claude-sonnet-4-1234567')).toBe('Claude Sonnet 4 1234567');
  });

  it('returns prefix-matched label for extended model names', () => {
    // OpenAI has gpt-4o in its models list; prefix match returns that label
    expect(getModelLabel('openai', 'gpt-4o-something-custom')).toBe('GPT-4o');
  });

  it('formats via formatModelSlug as fallback when nothing matches', () => {
    expect(getModelLabel('openai', 'completely-unknown-model')).toBe('Completely Unknown Model');
  });

  it('returns static label for dated model variant', () => {
    expect(getModelLabel('openai', 'gpt-4o-2024-11-20')).toBe('GPT-4o (2024-11-20)');
  });

  it('formats anthropic dated models via formatModelSlug', () => {
    // No models in PROVIDERS, so all paths fall through to formatModelSlug
    expect(getModelLabel('anthropic', 'claude-opus-4-20250514')).toBe('Claude Opus 4 20250514');
    expect(getModelLabel('anthropic', 'claude-opus-4-20260101')).toBe('Claude Opus 4 20260101');
  });

  it('resolves vendor-prefixed model names via cross-provider lookup', () => {
    // Anthropic has empty models[], so formatModelSlug on bare name
    expect(getModelLabel('openrouter', 'anthropic/claude-opus-4-6')).toBe('Claude Opus 4 6');
    // OpenAI has gpt-4o in its models list, so cross-provider lookup finds it
    expect(getModelLabel('openrouter', 'openai/gpt-4o')).toBe('GPT-4o');
  });

  it('formats bare name via formatModelSlug when vendor-prefixed model is unknown', () => {
    expect(getModelLabel('openrouter', 'newvendor/unknown-model')).toBe('Unknown Model');
  });

  it('formats vendor-prefixed model with dots via formatModelSlug', () => {
    // No models to find, formatModelSlug on bare name "claude-opus-4.6"
    // formatModelSlug replaces dashes with spaces (dots are untouched)
    expect(getModelLabel('openrouter', 'anthropic/claude-opus-4.6')).toBe('Claude Opus 4.6');
  });

  it('formats vendor-prefixed model with dashes via formatModelSlug', () => {
    // "anthropic/claude-opus-4-6" → bare "claude-opus-4-6" → formatModelSlug → "Claude Opus 4 6"
    expect(getModelLabel('openrouter', 'anthropic/claude-opus-4-6')).toBe('Claude Opus 4 6');
  });

  it('falls through dot-to-dash normalization when normalized model is not found', () => {
    // "vendor/unknown.model.name" → bare "unknown.model.name" → not found →
    // normalized "unknown-model-name" → still not found → returns bare
    expect(getModelLabel('openrouter', 'vendor/unknown.model.name')).toBe('Unknown.Model.Name');
  });

  it('strips Bedrock-style dot provider namespaces', () => {
    expect(getModelLabel('bedrock', 'us.anthropic.claude-opus-4.6')).toBe('Claude Opus 4.6');
    expect(getModelLabel('bedrock', 'mistral.magistral-small-2509')).toBe('Magistral Small 2509');
    expect(getModelLabel('bedrock', 'z.ai.glm-4.6')).toBe('Glm 4.6');
  });
});

/* ── PROVIDERS constant ────────────────────────── */

describe('PROVIDERS', () => {
  it('providers are sorted alphabetically by name', () => {
    const names = PROVIDERS.map((p) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('Ollama is marked localOnly with no key required', () => {
    const ollama = PROVIDERS.find((p) => p.id === 'ollama')!;
    expect(ollama).toBeDefined();
    expect(ollama.noKeyRequired).toBe(true);
    expect(ollama.localOnly).toBe(true);
    expect(ollama.models).toEqual([]);
    expect(ollama.minKeyLength).toBe(0);
  });

  it('exposes Gemini Free as a managed free provider', () => {
    const provider = PROVIDERS.find((entry) => entry.id === 'gemini-free')!;
    expect(provider.name).toBe('Gemini Free');
    expect(provider.subtitle).toBe('Free Gemini models via Manifest');
    expect(provider.keyPlaceholder).toBe('sk-...');
    expect(getRoutingProviderApiKeyUrl('gemini-free')).toBe(
      'https://calendly.com/sebastien-manifest/30min',
    );
  });

  it('exposes the current Meta Muse Spark catalog and Contributor warning', () => {
    const meta = PROVIDERS.find((provider) => provider.id === 'meta')!;
    expect(meta.name).toBe('Meta');
    expect(meta.models.map((model) => model.value)).toEqual([
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ]);
    expect(meta.models[1].label).toMatch(/may train Meta/);
    expect(getRoutingProviderApiKeyUrl('meta')).toBe('https://dev.meta.ai/');
  });

  it('each provider has required fields', () => {
    for (const p of PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.color).toBeTruthy();
      expect(p.initial).toBeTruthy();
      expect(p.subtitle).toBeTruthy();
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  it('OpenAI supports subscription with OAuth browser flow', () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai')!;
    expect(openai.supportsSubscription).toBe(true);
    expect(openai.subscriptionLabel).toBe('ChatGPT Plus/Pro/Team');
    expect(openai.subscriptionKeyPlaceholder).toBeUndefined();
    expect(openai.subscriptionCommand).toBeUndefined();
    expect(openai.subscriptionAuthMode).toBe('popup_oauth');
  });

  it('Anthropic supports subscription via paste-code OAuth', () => {
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic')!;
    expect(anthropic.supportsSubscription).toBe(true);
    expect(anthropic.subscriptionLabel).toBe('Claude Max / Pro subscription');
    expect(anthropic.subscriptionAuthMode).toBe('popup_paste');
    expect(anthropic.subscriptionCommand).toBeUndefined();
    expect(anthropic.subscriptionKeyPlaceholder).toBeUndefined();
  });

  it('AWS Bedrock exposes API-key region choices', () => {
    const bedrock = PROVIDERS.find((p) => p.id === 'bedrock')!;
    expect(bedrock.name).toBe('AWS Bedrock');
    expect(bedrock.apiKeyEndpointRegions?.[0]).toEqual({
      value: 'us-east-1',
      label: 'US East (N. Virginia)',
    });
    expect(bedrock.apiKeyEndpointRegions).toContainEqual({
      value: 'eu-west-1',
      label: 'Europe (Ireland)',
    });
    expect(bedrock.apiKeyEndpointRegions).not.toContainEqual({
      value: 'eu-west-3',
      label: 'Europe (Paris)',
    });
  });

  it('GitHub Copilot is subscription-only', () => {
    const copilot = PROVIDERS.find((p) => p.id === 'copilot')!;
    expect(copilot.supportsSubscription).toBe(true);
    expect(copilot.subscriptionOnly).toBe(true);
    expect(copilot.deviceLogin).toBe(true);
    expect(copilot.subscriptionAuthMode).toBe('device_code');
  });

  it('Command Code is subscription-only with API-key token paste flow', () => {
    const commandcode = PROVIDERS.find((p) => p.id === 'commandcode')!;
    expect(commandcode).toBeDefined();
    expect(commandcode.name).toBe('Command Code');
    expect(commandcode.supportsSubscription).toBe(true);
    expect(commandcode.subscriptionOnly).toBe(true);
    expect(commandcode.subscriptionAuthMode).toBe('token');
    expect(commandcode.subscriptionCredentialKind).toBe('api-key');
    expect(commandcode.subscriptionLabel).toBe('Command Code subscription');
    expect(commandcode.subscriptionKeyPlaceholder).toBe('Paste your Command Code API key');
    expect(commandcode.subscriptionRequirementNote).toBe('Requires Command Code Pro or higher.');
    expect(commandcode.subscriptionSignInUrl).toBeUndefined();
    expect(commandcode.subscriptionSignInLabel).toBeUndefined();
    expect(commandcode.subscriptionSignInHint).toBeUndefined();
    expect(commandcode.models).toEqual([]);
  });

  it('BytePlus is subscription-only with ModelArk Coding Plan token paste flow', () => {
    const byteplus = PROVIDERS.find((p) => p.id === 'byteplus')!;
    expect(byteplus).toBeDefined();
    expect(byteplus.name).toBe('BytePlus');
    expect(byteplus.supportsSubscription).toBe(true);
    expect(byteplus.subscriptionOnly).toBe(true);
    expect(byteplus.subscriptionAuthMode).toBe('token');
    expect(byteplus.subscriptionCredentialKind).toBe('api-key');
    expect(byteplus.subscriptionCredentialName).toBe('ModelArk Coding Plan');
    expect(byteplus.subscriptionLabel).toBe('ModelArk Coding Plan');
    expect(byteplus.subscriptionKeyPlaceholder).toBe('Paste your ModelArk Coding Plan API key');
    expect(byteplus.models).toEqual([]);
  });

  it('ClinePass is subscription-only with API-key token paste flow', () => {
    const clinePass = PROVIDERS.find((p) => p.id === 'cline-pass')!;
    expect(clinePass).toBeDefined();
    expect(clinePass.name).toBe('ClinePass');
    expect(clinePass.supportsSubscription).toBe(true);
    expect(clinePass.subscriptionOnly).toBe(true);
    expect(clinePass.subscriptionAuthMode).toBe('token');
    expect(clinePass.subscriptionCredentialKind).toBe('api-key');
    expect(clinePass.subscriptionLabel).toBe('ClinePass subscription');
    expect(clinePass.subscriptionKeyPlaceholder).toBe('Paste your ClinePass API key');
    expect(clinePass.subscriptionSignInUrl).toBe('https://app.cline.bot');
    expect(clinePass.subscriptionSignInLabel).toBe('Sign in to ClinePass');
    expect(clinePass.models).toEqual([]);
  });

  it('Cerebras is an API-key provider with dynamic models', () => {
    const cerebras = PROVIDERS.find((p) => p.id === 'cerebras')!;
    expect(cerebras).toBeDefined();
    expect(cerebras.name).toBe('Cerebras');
    expect(cerebras.supportsSubscription).toBeUndefined();
    expect(cerebras.subscriptionOnly).toBeUndefined();
    expect(cerebras.keyPlaceholder).toBe('Cerebras API key');
    expect(cerebras.minKeyLength).toBe(20);
    expect(cerebras.models).toEqual([]);
  });

  it('Pioneer is an API-key provider with dynamic models', () => {
    const pioneer = PROVIDERS.find((p) => p.id === 'pioneer')!;
    expect(pioneer).toBeDefined();
    expect(pioneer.name).toBe('Pioneer');
    expect(pioneer.supportsSubscription).toBeUndefined();
    expect(pioneer.subscriptionOnly).toBeUndefined();
    expect(pioneer.keyPrefix).toBe('pio_sk_');
    expect(pioneer.keyPlaceholder).toBe('pio_sk_...');
    expect(pioneer.minKeyLength).toBe(20);
    expect(pioneer.models).toEqual([]);
  });

  it('Hugging Face is an API-key provider with dynamic models', () => {
    const huggingface = PROVIDERS.find((p) => p.id === 'huggingface')!;
    expect(huggingface).toBeDefined();
    expect(huggingface.name).toBe('Hugging Face');
    expect(huggingface.supportsSubscription).toBeUndefined();
    expect(huggingface.subscriptionOnly).toBeUndefined();
    expect(huggingface.keyPrefix).toBe('hf_');
    expect(huggingface.keyPlaceholder).toBe('hf_...');
    expect(huggingface.minKeyLength).toBe(20);
    expect(huggingface.models).toEqual([]);
  });

  it('MiniMax supports subscription with device-code flow', () => {
    const minimax = PROVIDERS.find((p) => p.id === 'minimax')!;
    expect(minimax.supportsSubscription).toBe(true);
    expect(minimax.subscriptionLabel).toBe('MiniMax Coding Plan');
    expect(minimax.subscriptionAuthMode).toBe('device_code');
  });

  it('Mistral supports Vibe subscription with token flow', () => {
    const mistral = PROVIDERS.find((p) => p.id === 'mistral')!;
    expect(mistral.supportsSubscription).toBe(true);
    expect(mistral.subscriptionLabel).toBe('Mistral Vibe subscription');
    expect(mistral.subscriptionAuthMode).toBe('token');
    expect(mistral.subscriptionCredentialKind).toBe('api-key');
    expect(mistral.subscriptionCredentialName).toBe('Mistral Vibe');
    expect(mistral.subscriptionKeyPlaceholder).toBe('Paste your Mistral Vibe API key');
    expect(mistral.subscriptionOnly).toBeUndefined();
  });

  it('Qwen supports Token Plan subscription with token flow', () => {
    const qwen = PROVIDERS.find((p) => p.id === 'qwen')!;
    expect(qwen.apiKeyEndpointRegions?.[0]).toEqual({
      value: 'auto',
      label: 'Auto-detect',
    });
    expect(qwen.apiKeyEndpointRegions).toContainEqual({
      value: 'workspace-cn-hongkong',
      label: 'China (Hong Kong)',
      baseUrlPlaceholder: 'https://<workspace-id>.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1',
    });
    expect(qwen.apiKeyEndpointRegions).toContainEqual({
      value: 'workspace-eu-central-1',
      label: 'Germany (Frankfurt)',
      baseUrlPlaceholder:
        'https://<workspace-id>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
    });
    expect(qwen.apiKeyEndpointRegions).toContainEqual({
      value: 'workspace-ap-northeast-1',
      label: 'Japan (Tokyo)',
      baseUrlPlaceholder:
        'https://<workspace-id>.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
    });
    expect(qwen.apiKeyEndpointRegions).toContainEqual({
      value: 'custom',
      label: 'Custom endpoint',
      baseUrlPlaceholder:
        'https://<workspace-id>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
    });
    expect(qwen.supportsSubscription).toBe(true);
    expect(qwen.subscriptionLabel).toBe('Qwen Token Plan');
    expect(qwen.subscriptionAuthMode).toBe('token');
    expect(qwen.subscriptionKeyPlaceholder).toBe('Paste your Qwen Token Plan API key');
    expect(qwen.subscriptionCredentialKind).toBe('api-key');
    expect(qwen.subscriptionCredentialName).toBe('Qwen Token Plan');
    expect(qwen.subscriptionOnly).toBeUndefined();
  });

  it('Xiaomi MiMo supports Token Plan subscription with selectable token hosts', () => {
    const xiaomi = PROVIDERS.find((p) => p.id === 'xiaomi')!;
    expect(xiaomi.supportsSubscription).toBe(true);
    expect(xiaomi.subscriptionLabel).toBe('Xiaomi MiMo Token Plan');
    expect(xiaomi.subscriptionAuthMode).toBe('token');
    expect(xiaomi.subscriptionKeyPlaceholder).toBe('Paste your MiMo Token Plan API key');
    expect(xiaomi.subscriptionCredentialKind).toBe('api-key');
    expect(xiaomi.subscriptionCredentialName).toBe('MiMo Token Plan');
    expect(xiaomi.subscriptionEndpointRegions).toEqual([
      { value: 'cn', label: 'China (token-plan-cn)' },
      { value: 'sgp', label: 'Singapore (token-plan-sgp)' },
      { value: 'ams', label: 'Europe (token-plan-ams)' },
    ]);
    expect(xiaomi.subscriptionOnly).toBeUndefined();
  });

  it('Moonshot supports Kimi Coding Plan subscription with token flow', () => {
    const moonshot = PROVIDERS.find((p) => p.id === 'moonshot')!;
    expect(moonshot.supportsSubscription).toBe(true);
    expect(moonshot.subscriptionLabel).toBe('Kimi Coding Plan');
    expect(moonshot.subscriptionAuthMode).toBe('token');
    expect(moonshot.subscriptionKeyPlaceholder).toBe('Paste your Kimi Code API key');
    expect(moonshot.subscriptionCredentialKind).toBe('api-key');
    expect(moonshot.subscriptionCredentialName).toBe('Kimi Code');
  });

  it('Ollama Cloud is subscription-only with token paste flow', () => {
    const cloud = PROVIDERS.find((p) => p.id === 'ollama-cloud')!;
    expect(cloud).toBeDefined();
    expect(cloud.name).toBe('Ollama Cloud');
    expect(cloud.supportsSubscription).toBe(true);
    expect(cloud.subscriptionOnly).toBe(true);
    expect(cloud.subscriptionLabel).toBe('Ollama Cloud subscription');
    expect(cloud.subscriptionAuthMode).toBe('token');
    expect(cloud.subscriptionKeyPlaceholder).toBe('Paste your Ollama Cloud API key');
    expect(cloud.subscriptionCredentialKind).toBe('api-key');
    expect(cloud.localOnly).toBeUndefined();
    expect(cloud.noKeyRequired).toBeUndefined();
    expect(cloud.subscriptionCommand).toBeUndefined();
  });

  it('NousResearch is subscription-only with API-key token paste flow', () => {
    const nous = PROVIDERS.find((p) => p.id === 'nous')!;
    expect(nous).toBeDefined();
    expect(nous.name).toBe('NousResearch');
    expect(nous.supportsSubscription).toBe(true);
    expect(nous.subscriptionOnly).toBe(true);
    expect(nous.subscriptionAuthMode).toBe('token');
    expect(nous.subscriptionCredentialKind).toBe('api-key');
    expect(nous.subscriptionLabel).toBe('NousResearch subscription');
    expect(nous.subscriptionKeyPlaceholder).toBe('Paste your NousResearch API key');
    expect(nous.models).toEqual([]);
  });

  it('Kilo is an API-key gateway provider with dynamic models', () => {
    const kilo = PROVIDERS.find((p) => p.id === 'kilo')!;
    expect(kilo).toBeDefined();
    expect(kilo.name).toBe('Kilo');
    expect(kilo.supportsSubscription).toBeUndefined();
    expect(kilo.subscriptionOnly).toBeUndefined();
    expect(kilo.keyPlaceholder).toBe('Kilo Gateway API key');
    expect(kilo.minKeyLength).toBe(10);
    expect(kilo.models).toEqual([]);
  });

  it('provides an API key URL for ollama-cloud in both the API-key and subscription maps', () => {
    expect(getRoutingProviderApiKeyUrl('ollama-cloud')).toBe('https://ollama.com/settings/keys');
    expect(getSubscriptionProviderKeyUrl('ollama-cloud')).toBe('https://ollama.com/settings/keys');
  });

  it('provides a subscription-key URL for Moonshot/Kimi pointing at the Kimi Code console', () => {
    expect(getSubscriptionProviderKeyUrl('moonshot')).toBe('https://www.kimi.com/code/console');
  });

  it('provides distinct API-key and subscription-key URLs for Mistral', () => {
    expect(getRoutingProviderApiKeyUrl('mistral')).toBe('https://console.mistral.ai/api-keys/');
    expect(getSubscriptionProviderKeyUrl('mistral')).toBe(
      'https://chat.mistral.ai/code/extensions',
    );
  });

  it('provides only the subscription-key URL for Command Code', () => {
    expect(getRoutingProviderApiKeyUrl('commandcode')).toBeUndefined();
    expect(getSubscriptionProviderKeyUrl('commandcode')).toBe('https://commandcode.ai/studio');
  });

  it('provides only the subscription-key URL for BytePlus', () => {
    expect(getRoutingProviderApiKeyUrl('byteplus')).toBeUndefined();
    expect(getSubscriptionProviderKeyUrl('byteplus')).toBe(
      'https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey',
    );
  });

  it('provides only the subscription-key URL for Nous', () => {
    expect(getRoutingProviderApiKeyUrl('nous')).toBeUndefined();
    expect(getSubscriptionProviderKeyUrl('nous')).toBe('https://portal.nousresearch.com');
  });

  it('provides a subscription-key URL for Qwen Token Plan', () => {
    expect(getSubscriptionProviderKeyUrl('qwen')).toBe('https://home.qwencloud.com/api-keys');
  });

  it('provides API-key and subscription-key URLs for Xiaomi MiMo', () => {
    expect(getRoutingProviderApiKeyUrl('xiaomi')).toBe(
      'https://platform.xiaomimimo.com/console/api-keys',
    );
    expect(getSubscriptionProviderKeyUrl('xiaomi')).toBe(
      'https://platform.xiaomimimo.com/token-plan',
    );
  });

  it('provides an API-key URL for Kilo', () => {
    expect(getRoutingProviderApiKeyUrl('kilo')).toBe('https://app.kilo.ai');
    expect(getSubscriptionProviderKeyUrl('kilo')).toBeUndefined();
  });

  it('exposes a subscription-key URL for every token-mode subscription-only provider', () => {
    const missing = PROVIDERS.filter(
      (p) =>
        p.subscriptionOnly &&
        p.subscriptionAuthMode === 'token' &&
        !p.subscriptionSignInUrl &&
        !SUBSCRIPTION_PROVIDER_KEY_URLS[p.id],
    ).map((p) => p.id);
    expect(missing).toEqual([]);
  });

  it('Z.ai supports GLM Coding Plan subscription with token flow', () => {
    const zai = PROVIDERS.find((p) => p.id === 'zai')!;
    expect(zai.supportsSubscription).toBe(true);
    expect(zai.subscriptionLabel).toBe('GLM Coding Plan');
    expect(zai.subscriptionAuthMode).toBe('token');
    expect(zai.subscriptionKeyPlaceholder).toBe('Paste your Z.ai API key');
    expect(zai.subscriptionEndpointRegions).toEqual([
      { value: 'global', label: 'Outside China (api.z.ai)' },
      { value: 'cn', label: 'China Mainland (open.bigmodel.cn)' },
    ]);
    expect(zai.subscriptionOnly).toBeUndefined();
  });

  it('xAI supports Grok subscription with OAuth flow and dynamic models', () => {
    const xai = PROVIDERS.find((p) => p.id === 'xai')!;
    expect(xai.supportsSubscription).toBe(true);
    expect(xai.subscriptionLabel).toBe('Grok subscription');
    expect(xai.subscriptionAuthMode).toBe('popup_oauth');
    expect(xai.subscriptionCredentialKind).toBeUndefined();
    expect(xai.subscriptionKeyPlaceholder).toBeUndefined();
    expect(xai.subscriptionOnly).toBeUndefined();
    expect(xai.models).toEqual([]);
  });

  it('provides a subscription-key URL for Z.ai pointing at the API key dashboard', () => {
    expect(getSubscriptionProviderKeyUrl('zai')).toBe('https://z.ai/manage-apikey/apikey-list');
  });

  it('provides an API key URL for NVIDIA NIM', () => {
    expect(getRoutingProviderApiKeyUrl('nvidia')).toBe(
      'https://build.nvidia.com/settings/api-keys',
    );
  });

  it('provides an API key URL for Fireworks AI', () => {
    expect(getRoutingProviderApiKeyUrl('fireworks')).toBe('https://app.fireworks.ai/api-keys');
  });

  it('provides an API key URL for Hugging Face', () => {
    expect(getRoutingProviderApiKeyUrl('huggingface')).toBe(
      'https://huggingface.co/settings/tokens',
    );
  });

  it('provides an API key URL for Cerebras', () => {
    expect(getRoutingProviderApiKeyUrl('cerebras')).toBe('https://cloud.cerebras.ai');
  });

  it('provides an API key URL for Pioneer', () => {
    expect(getRoutingProviderApiKeyUrl('pioneer')).toBe('https://pioneer.ai');
  });

  it('OpenCode Go is subscription-only with a sign-in URL', () => {
    const og = PROVIDERS.find((p) => p.id === 'opencode-go')!;
    expect(og).toBeDefined();
    expect(og.supportsSubscription).toBe(true);
    expect(og.subscriptionOnly).toBe(true);
    expect(og.subscriptionAuthMode).toBe('token');
    expect(og.subscriptionLabel).toBe('OpenCode Go (beta)');
    expect(og.subscriptionKeyPlaceholder).toBe('Paste your OpenCode API key');
    expect(og.subscriptionSignInUrl).toBe('https://opencode.ai/auth');
    expect(og.subscriptionSignInLabel).toBe('Sign in to OpenCode Go');
    expect(og.subscriptionSignInHint).toMatch(/Sign in to OpenCode Go/);
    expect(og.subscriptionSignInHint).not.toMatch(/Zen/i);
    expect(og.beta).toBe(true);
  });

  it('OpenCode Go has no hardcoded model list (catalog is dynamic)', () => {
    const og = PROVIDERS.find((p) => p.id === 'opencode-go')!;
    expect(og.models).toEqual([]);
  });

  it('OpenCode Zen is registered as an API-key provider with no subscription mode', () => {
    const oz = PROVIDERS.find((p) => p.id === 'opencode-zen')!;
    expect(oz).toBeDefined();
    expect(oz.name).toBe('OpenCode Zen');
    expect(oz.supportsSubscription).toBeUndefined();
    expect(oz.subscriptionOnly).toBeUndefined();
    expect(oz.deviceLogin).toBeUndefined();
    expect(oz.models).toEqual([]);
  });

  it('OpenCode Zen exposes an API-key signup URL', () => {
    expect(getRoutingProviderApiKeyUrl('opencode-zen')).toBe('https://opencode.ai/auth');
  });

  it('Kiro is subscription-only with device-code OAuth flow and dynamic models', () => {
    const kiro = PROVIDERS.find((p) => p.id === 'kiro')!;
    expect(kiro).toBeDefined();
    expect(kiro.name).toBe('Kiro');
    expect(kiro.supportsSubscription).toBe(true);
    expect(kiro.subscriptionOnly).toBe(true);
    expect(kiro.subscriptionAuthMode).toBe('device_code');
    expect(kiro.subscriptionLabel).toBe('Kiro subscription');
    expect(kiro.subscriptionKeyPlaceholder).toBeUndefined();
    expect(kiro.subscriptionSignInUrl).toBeUndefined();
    expect(kiro.beta).toBe(true);
    expect(kiro.models).toEqual([]);
  });

  it('provides the Kiro account URL in both provider maps', () => {
    expect(getRoutingProviderApiKeyUrl('kiro')).toBe('https://app.kiro.dev');
    expect(getSubscriptionProviderKeyUrl('kiro')).toBe('https://app.kiro.dev');
  });

  it('OpenCode Go subscription key is validated with generic min-length check', () => {
    const og = PROVIDERS.find((p) => p.id === 'opencode-go')!;
    expect(validateSubscriptionKey(og, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
    expect(validateSubscriptionKey(og, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
    expect(validateSubscriptionKey(og, 'a-valid-opencode-token-1234')).toEqual({
      valid: true,
    });
  });

  it('Command Code subscription key is validated with generic token length', () => {
    const commandcode = PROVIDERS.find((p) => p.id === 'commandcode')!;
    expect(validateSubscriptionKey(commandcode, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
    expect(validateSubscriptionKey(commandcode, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
    expect(validateSubscriptionKey(commandcode, 'user_' + 'a'.repeat(40))).toEqual({
      valid: true,
    });
  });

  it('BytePlus subscription key is validated with generic token length', () => {
    const byteplus = PROVIDERS.find((p) => p.id === 'byteplus')!;
    expect(validateSubscriptionKey(byteplus, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
    expect(validateSubscriptionKey(byteplus, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
    expect(validateSubscriptionKey(byteplus, 'bp-valid-token-1234')).toEqual({
      valid: true,
    });
  });

  it('ClinePass subscription key is validated with generic token length', () => {
    const clinePass = PROVIDERS.find((p) => p.id === 'cline-pass')!;
    expect(validateSubscriptionKey(clinePass, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
    expect(validateSubscriptionKey(clinePass, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
    expect(validateSubscriptionKey(clinePass, 'cp-valid-token-1234')).toEqual({
      valid: true,
    });
  });

  it('Nous subscription key is validated with generic token length', () => {
    const nous = PROVIDERS.find((p) => p.id === 'nous')!;
    expect(validateSubscriptionKey(nous, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
    expect(validateSubscriptionKey(nous, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
    expect(validateSubscriptionKey(nous, 'nous-valid-token-1234')).toEqual({
      valid: true,
    });
  });

  it('Mistral Vibe subscription key is validated with generic token length', () => {
    const mistral = PROVIDERS.find((p) => p.id === 'mistral')!;
    expect(validateSubscriptionKey(mistral, '')).toEqual({
      valid: false,
      error: 'Token is required',
    });
    expect(validateSubscriptionKey(mistral, 'short')).toEqual({
      valid: false,
      error: 'Token is too short (minimum 10 characters)',
    });
    expect(validateSubscriptionKey(mistral, 'mistral-vibe-token-1234')).toEqual({
      valid: true,
    });
  });

  it('Kilo API key is validated with generic min-length check', () => {
    const kilo = PROVIDERS.find((p) => p.id === 'kilo')!;
    expect(validateApiKey(kilo, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(kilo, 'short')).toEqual({
      valid: false,
      error: 'Key is too short (minimum 10 characters)',
    });
    expect(validateApiKey(kilo, 'eyJhbGciOiJKiloToken')).toEqual({
      valid: true,
    });
  });

  it('Requesty is an API-key router with a key URL and generic key validation', () => {
    const requesty = PROVIDERS.find((p) => p.id === 'requesty')!;
    expect(requesty).toBeDefined();
    expect(requesty.name).toBe('Requesty');
    expect(requesty.supportsSubscription).toBeUndefined();
    expect(requesty.subscriptionOnly).toBeUndefined();
    expect(requesty.models).toEqual([]);
    expect(getRoutingProviderApiKeyUrl('requesty')).toBe('https://app.requesty.ai/api-keys');
    expect(validateApiKey(requesty, '')).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(validateApiKey(requesty, 'sk-' + 'a'.repeat(30))).toEqual({ valid: true });
  });

  it('requires an API key URL for every provider that needs one', () => {
    const missingProviderIds = PROVIDERS.filter(
      (provider) =>
        !provider.noKeyRequired &&
        !provider.deviceLogin &&
        !provider.subscriptionOnly &&
        !getRoutingProviderApiKeyUrl(provider.id),
    ).map((provider) => provider.id);
    expect(missingProviderIds).toEqual([]);
  });

  it('does not have API-key-specific fields', () => {
    for (const p of PROVIDERS) {
      expect(p).not.toHaveProperty('inputType');
      expect(p).not.toHaveProperty('inputLabel');
      expect(p).not.toHaveProperty('placeholder');
      expect(p).not.toHaveProperty('keyPattern');
      expect(p).not.toHaveProperty('keyHint');
      expect(p).not.toHaveProperty('docsUrl');
    }
  });
});

/* ── STAGES constant ───────────────────────────── */

describe('STAGES', () => {
  it('has 4 stages', () => {
    expect(STAGES).toHaveLength(4);
  });

  it('has correct stage IDs', () => {
    expect(STAGES.map((s) => s.id)).toEqual(['simple', 'standard', 'complex', 'reasoning']);
  });
});

/* ── EMAIL_PROVIDER_API_KEY_URLS ─────────────── */

describe('EMAIL_PROVIDER_API_KEY_URLS', () => {
  it('has a URL for every email provider', () => {
    expect(EMAIL_PROVIDER_API_KEY_URLS).toHaveProperty('resend');
    expect(EMAIL_PROVIDER_API_KEY_URLS).toHaveProperty('mailgun');
    expect(EMAIL_PROVIDER_API_KEY_URLS).toHaveProperty('sendgrid');
  });
});

/* ── getRoutingProviderApiKeyUrl ─────────────── */

describe('getRoutingProviderApiKeyUrl', () => {
  it('returns a URL for a known provider', () => {
    expect(getRoutingProviderApiKeyUrl('openai')).toBe('https://platform.openai.com/api-keys');
  });

  it('returns the ClinePass API-key settings URL', () => {
    expect(getRoutingProviderApiKeyUrl('cline-pass')).toBe(
      'https://app.cline.bot/settings/api-keys',
    );
  });

  it('returns undefined for an unknown provider', () => {
    expect(getRoutingProviderApiKeyUrl('unknown')).toBeUndefined();
  });
});

/* ── getSubscriptionProviderKeyUrl ─────────── */

describe('getSubscriptionProviderKeyUrl', () => {
  it('returns the Ollama settings page URL for ollama-cloud', () => {
    expect(getSubscriptionProviderKeyUrl('ollama-cloud')).toBe('https://ollama.com/settings/keys');
  });

  it('returns the ClinePass API-key settings URL', () => {
    expect(getSubscriptionProviderKeyUrl('cline-pass')).toBe(
      'https://app.cline.bot/settings/api-keys',
    );
  });

  it('returns undefined for subscription providers whose token comes from elsewhere (e.g. anthropic setup-token via CLI)', () => {
    expect(getSubscriptionProviderKeyUrl('anthropic')).toBeUndefined();
  });

  it('returns undefined for an unknown provider', () => {
    expect(getSubscriptionProviderKeyUrl('unknown')).toBeUndefined();
  });
});

/* ── getEmailProviderApiKeyUrl ───────────────── */

describe('getEmailProviderApiKeyUrl', () => {
  it('returns a URL for a known email provider', () => {
    expect(getEmailProviderApiKeyUrl('resend')).toBe('https://resend.com/api-keys');
  });

  it('returns undefined for an unknown provider', () => {
    expect(getEmailProviderApiKeyUrl('unknown')).toBeUndefined();
  });
});

/* ── buildProviderDef error path ──────────────── */

describe('buildProviderDef', () => {
  it('throws when shared provider has no UI overlay', () => {
    const fakeShared = {
      id: 'nonexistent-provider',
      displayName: 'Fake',
      color: '#000',
      keyPrefix: '',
      minKeyLength: 0,
      keyPlaceholder: '',
    } as any;
    expect(() => buildProviderDef(fakeShared)).toThrow(
      'Missing UI overlay for shared provider "nonexistent-provider"',
    );
  });
});
