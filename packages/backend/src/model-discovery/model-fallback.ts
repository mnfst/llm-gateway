import { DiscoveredModel, DEFAULT_CONTEXT_WINDOW } from './model-fetcher';
import {
  OPENROUTER_PREFIX_TO_PROVIDER,
  PROVIDER_BY_ID_OR_ALIAS,
} from '../common/constants/providers';
import {
  getSubscriptionKnownModels,
  getSubscriptionKnownModelsMatch,
  getSubscriptionCapabilities,
  META_MODEL_API_CONTEXT_WINDOW,
  META_MODEL_API_MODEL_BY_ID,
  type SubscriptionCapabilities,
} from 'manifest-shared';
import { normalizeAnthropicShortModelId } from '../common/utils/anthropic-model-id';
import { GOOGLE_VARIANT_RE } from '../model-prices/model-name-normalizer';

interface PricingLookup {
  lookupPricing(key: string): {
    input: number;
    output: number;
    contextWindow?: number;
    displayName?: string;
  } | null;
  getAll(): ReadonlyMap<
    string,
    { input: number; output: number; contextWindow?: number; displayName?: string }
  >;
}

function normalizeProviderModelId(providerId: string, modelId: string): string {
  return providerId.toLowerCase() === 'anthropic'
    ? normalizeAnthropicShortModelId(modelId)
    : modelId;
}

/**
 * Find the OpenRouter vendor prefix for a provider ID.
 * E.g. "anthropic" → "anthropic", "gemini" → "google", "qwen" → "qwen"
 */
export function findOpenRouterPrefix(providerId: string): string | null {
  const lower = providerId.toLowerCase();
  if (OPENROUTER_PREFIX_TO_PROVIDER.has(lower)) return lower;

  const entry = PROVIDER_BY_ID_OR_ALIAS.get(lower);
  if (entry) {
    for (const prefix of entry.openRouterPrefixes) {
      if (OPENROUTER_PREFIX_TO_PROVIDER.has(prefix)) return prefix;
    }
  }

  for (const [prefix, displayName] of OPENROUTER_PREFIX_TO_PROVIDER) {
    if (displayName.toLowerCase() === lower) return prefix;
  }
  return null;
}

/**
 * Provider-native model names that differ from OpenRouter naming.
 * Maps the name fragment from the provider API → the OpenRouter equivalent.
 */
const OPENROUTER_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ['voxtral-small', 'voxtral-small-24b'], // Mistral API omits the 24b size indicator
  ['open-mistral-nemo', 'mistral-nemo'], // Mistral renamed open-mistral-nemo → mistral-nemo
  ['mistral-tiny', 'open-mistral-7b'], // mistral-tiny was internal codename for Mistral 7B
]);

const META_FALLBACK_MODEL_IDS = new Set(META_MODEL_API_MODEL_BY_ID.keys());

/**
 * Look up pricing with name normalization variants.
 * Providers use different conventions: Anthropic uses dashes (claude-sonnet-4-6),
 * OpenRouter uses dots (claude-sonnet-4.6). Try both.
 */
export function lookupWithVariants(
  pricingSync: PricingLookup,
  prefix: string,
  modelId: string,
): { input: number; output: number; contextWindow?: number; displayName?: string } | null {
  const exact = pricingSync.lookupPricing(`${prefix}/${modelId}`);
  if (exact) return exact;

  // Try OpenRouter name aliases (e.g., voxtral-small-2507 → voxtral-small-24b-2507)
  for (const [from, to] of OPENROUTER_NAME_ALIASES) {
    if (modelId.includes(from)) {
      const aliased = modelId.replace(from, to);
      const aliasResult = pricingSync.lookupPricing(`${prefix}/${aliased}`);
      if (aliasResult) return aliasResult;
    }
  }

  const dotVariant = modelId.replace(/-(\d+)-(\d)/g, '-$1.$2');
  if (dotVariant !== modelId) {
    const dotResult = pricingSync.lookupPricing(`${prefix}/${dotVariant}`);
    if (dotResult) return dotResult;
  }

  const dashVariant = modelId.replace(/\.(\d)/g, '-$1');
  if (dashVariant !== modelId) {
    const dashResult = pricingSync.lookupPricing(`${prefix}/${dashVariant}`);
    if (dashResult) return dashResult;
  }

  const prefixedModel = providerPrefixedModelId(prefix, modelId);
  if (prefixedModel) {
    const prefixedResult = pricingSync.lookupPricing(`${prefix}/${prefixedModel}`);
    if (prefixedResult) return prefixedResult;
  }

  const noDate = modelId.replace(/-\d{8}$/, '');
  if (noDate !== modelId) {
    const noDateResult = pricingSync.lookupPricing(`${prefix}/${noDate}`);
    if (noDateResult) return noDateResult;

    const noDateDot = noDate.replace(/-(\d+)-(\d)/g, '-$1.$2');
    if (noDateDot !== noDate) {
      const noDateDotResult = pricingSync.lookupPricing(`${prefix}/${noDateDot}`);
      if (noDateDotResult) return noDateDotResult;
    }
  }

  // Try :free suffix (OpenRouter lists some models as "provider/model:free")
  const freeResult = pricingSync.lookupPricing(`${prefix}/${modelId}:free`);
  if (freeResult) return freeResult;

  // Strip Google variant suffixes: -preview-MM-DD, -exp-MMDD, -latest
  const noGoogleVariant = modelId.replace(GOOGLE_VARIANT_RE, '');
  if (noGoogleVariant !== modelId) {
    const result = pricingSync.lookupPricing(`${prefix}/${noGoogleVariant}`);
    if (result) return result;
  }

  // Strip -latest and search for dated variants in the cache
  // (e.g. ministral-14b-latest → mistralai/ministral-14b-2512)
  if (modelId.endsWith('-latest')) {
    const base = modelId.slice(0, -'-latest'.length);
    const scanPrefix = `${prefix}/${base}-`;
    for (const [key] of pricingSync.getAll()) {
      if (key.startsWith(scanPrefix)) {
        const found = pricingSync.lookupPricing(key);
        if (found) return found;
      }
    }
  }

  return null;
}

function providerPrefixedModelId(prefix: string, modelId: string): string | null {
  const normalizedPrefix = prefix.toLowerCase();
  if (modelId.toLowerCase().startsWith(`${normalizedPrefix}-`)) return null;
  return `${prefix}-${modelId}`;
}

function resolveSubscriptionContextWindow(
  modelId: string,
  contextWindow: number,
  capabilities: Readonly<SubscriptionCapabilities> | null,
): number {
  let modelContextWindow: number | undefined;
  let matchLength = -1;
  const normalizedModelId = modelId.toLowerCase();
  for (const [configuredModelId, configuredContextWindow] of Object.entries(
    capabilities?.modelContextWindows ?? {},
  )) {
    const normalizedConfiguredModelId = configuredModelId.toLowerCase();
    if (
      normalizedModelId !== normalizedConfiguredModelId &&
      !normalizedModelId.startsWith(`${normalizedConfiguredModelId}-`)
    ) {
      continue;
    }
    if (
      typeof configuredContextWindow === 'number' &&
      Number.isFinite(configuredContextWindow) &&
      configuredContextWindow > 0 &&
      normalizedConfiguredModelId.length > matchLength
    ) {
      modelContextWindow = configuredContextWindow;
      matchLength = normalizedConfiguredModelId.length;
    }
  }
  if (modelContextWindow) return modelContextWindow;
  if (capabilities?.maxContextWindow && contextWindow > capabilities.maxContextWindow) {
    return capabilities.maxContextWindow;
  }
  return contextWindow;
}

/**
 * Build a fallback model list from models.dev cache.
 * Uses native provider model IDs — no prefix stripping or variant matching needed.
 */
export function buildModelsDevFallback(
  modelsDevSync: {
    getModelsForProvider(id: string): {
      id: string;
      name: string;
      contextWindow?: number;
      inputPricePerToken: number | null;
      outputPricePerToken: number | null;
      reasoning?: boolean;
      toolCall?: boolean;
      inputModalities?: DiscoveredModel['inputModalities'];
      outputModalities?: DiscoveredModel['outputModalities'];
    }[];
  } | null,
  providerId: string,
  options: { idPrefix?: string } = {},
): DiscoveredModel[] {
  if (!modelsDevSync) return [];
  const entries = modelsDevSync.getModelsForProvider(providerId);
  const idPrefix = options.idPrefix;
  return entries.map((e) => ({
    id: idPrefix ? `${idPrefix}/${e.id}` : e.id,
    displayName: e.name || e.id,
    provider: providerId,
    contextWindow: e.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    inputPricePerToken: e.inputPricePerToken,
    outputPricePerToken: e.outputPricePerToken,
    capabilityReasoning: e.reasoning ?? false,
    capabilityCode: e.toolCall ?? false,
    ...(e.inputModalities ? { inputModalities: e.inputModalities } : {}),
    ...(e.outputModalities ? { outputModalities: e.outputModalities } : {}),
    qualityScore: 3,
  }));
}

/**
 * Build a fallback model list from OpenRouter cache
 * for providers whose native /models API is unavailable.
 *
 * When `confirmedModels` is provided and non-empty, only models that exist
 * in the confirmed set are included. This filters out phantom models that
 * OpenRouter lists but the provider's native API doesn't actually serve.
 * When null or empty, all OpenRouter models for the provider are returned
 * (graceful degradation for fresh installs with no native data yet).
 */
export function buildFallbackModels(
  pricingSync: PricingLookup | null,
  providerId: string,
  confirmedModels?: ReadonlySet<string> | null,
): DiscoveredModel[] {
  if (!pricingSync) return [];
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  const hasConfirmed = confirmedModels != null && confirmedModels.size > 0;

  const orPrefix = findOpenRouterPrefix(providerId);
  if (!orPrefix) return [];
  const isMeta = providerId.toLowerCase() === 'meta';

  for (const [fullId, entry] of pricingSync.getAll()) {
    if (!fullId.startsWith(`${orPrefix}/`)) continue;
    // `:batch` variants are only served through OpenRouter's async Batch API,
    // never through the synchronous chat completions proxy.
    if (fullId.endsWith(':batch')) continue;
    const modelId = normalizeProviderModelId(providerId, fullId.substring(orPrefix.length + 1));
    if (seen.has(modelId)) continue;

    if (hasConfirmed && !confirmedModels!.has(modelId.toLowerCase())) continue;
    if (isMeta && !META_FALLBACK_MODEL_IDS.has(modelId)) continue;

    seen.add(modelId);
    const metaModel = isMeta ? META_MODEL_API_MODEL_BY_ID.get(modelId) : undefined;
    models.push({
      id: modelId,
      displayName: metaModel?.displayName ?? entry.displayName ?? modelId,
      provider: providerId,
      contextWindow:
        entry.contextWindow ?? (metaModel ? META_MODEL_API_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW),
      inputPricePerToken: entry.input,
      outputPricePerToken: entry.output,
      capabilityReasoning: !!metaModel,
      capabilityCode: !!metaModel,
      ...(metaModel
        ? {
            inputModalities: ['text', 'image', 'audio', 'video'] as const,
            outputModalities: ['text'] as const,
          }
        : {}),
      qualityScore: 3,
    });
  }

  return models;
}

/**
 * Build a curated fallback model list for subscription providers.
 * Model availability comes exclusively from the provider's knownModels list.
 */
export function buildSubscriptionFallbackModels(providerId: string): DiscoveredModel[] {
  const knownModels = getSubscriptionKnownModels(providerId);
  if (!knownModels) return [];
  const capabilities = getSubscriptionCapabilities(providerId);
  const defaultCtx = capabilities?.maxContextWindow ?? 200000;
  return knownModels.map((modelId) => ({
    id: modelId,
    displayName: modelId,
    provider: providerId,
    contextWindow: resolveSubscriptionContextWindow(modelId, defaultCtx, capabilities),
    contextWindowSource: 'subscription_config',
    inputPricePerToken: 0,
    outputPricePerToken: 0,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
  }));
}

/**
 * Recalculate context windows that were copied from subscription configuration.
 * Provider values and legacy rows without provenance remain unchanged.
 */
export function reconcileCachedSubscriptionContextWindow(
  model: DiscoveredModel,
  providerId: string,
): DiscoveredModel {
  if (model.contextWindowSource !== 'subscription_config') return model;

  const knownModels = getSubscriptionKnownModels(providerId);
  if (!knownModels) return model;
  const matchMode = getSubscriptionKnownModelsMatch(providerId);
  const normalizedModelId = model.id.toLowerCase();
  const isKnownModel = knownModels.some((knownModel) => {
    const normalizedKnownModel = knownModel.toLowerCase();
    if (normalizedKnownModel === normalizedModelId) return true;
    return matchMode !== 'exact' && normalizedModelId.startsWith(`${normalizedKnownModel}-`);
  });
  if (!isKnownModel) return model;

  const capabilities = getSubscriptionCapabilities(providerId);
  const contextWindow = resolveSubscriptionContextWindow(
    model.id,
    capabilities?.maxContextWindow ?? 200000,
    capabilities,
  );
  if (contextWindow === model.contextWindow) return model;

  return { ...model, contextWindow };
}

/**
 * Supplement discovered models with knownModels from subscription-capabilities.
 * Ensures subscription users always have the known models available as selectable options,
 * even if the live provider API did not return them.
 */
export function supplementWithKnownModels(
  raw: DiscoveredModel[],
  providerId: string,
): DiscoveredModel[] {
  const knownModels = getSubscriptionKnownModels(providerId);
  if (!knownModels) return raw;
  const matchMode = getSubscriptionKnownModelsMatch(providerId);

  const capabilities = getSubscriptionCapabilities(providerId);
  const defaultCtx = capabilities?.maxContextWindow ?? 200000;

  for (const modelId of knownModels) {
    const lowerModelId = modelId.toLowerCase();
    // Skip if this model is already present. Prefix-mode providers also treat
    // a more specific version (e.g., with a date suffix) as covered.
    const covered = raw.some((m) => {
      const lowerDiscovered = m.id.toLowerCase();
      if (lowerDiscovered === lowerModelId) return true;
      return matchMode !== 'exact' && lowerDiscovered.startsWith(`${lowerModelId}-`);
    });
    if (covered) continue;
    raw.push({
      id: modelId,
      displayName: modelId,
      provider: providerId,
      contextWindow: resolveSubscriptionContextWindow(modelId, defaultCtx, capabilities),
      contextWindowSource: 'subscription_config',
      inputPricePerToken: 0,
      outputPricePerToken: 0,
      capabilityReasoning: false,
      capabilityCode: false,
      qualityScore: 3,
    });
  }

  return raw;
}
