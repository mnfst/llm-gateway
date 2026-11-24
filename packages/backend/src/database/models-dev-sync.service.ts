import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { normalizeProviderName, type ModelCapability, type ModelModality } from 'manifest-shared';
import { PROVIDER_BY_ID_OR_ALIAS } from '../common/constants/providers';
import {
  capabilitiesFromModelsDev,
  modelModalitiesFromModelsDev,
} from '../model-discovery/model-capabilities';
import { GOOGLE_VARIANT_RE } from '../model-prices/model-name-normalizer';

/**
 * Providers whose models.dev catalog is authoritative for **pricing as well as
 * capabilities**. models.dev uses its own naming convention for provider
 * directories, so this maps our internal ID to theirs.
 *
 * An entry here does more than name a directory. It also decides that
 * models.dev may price the provider (`loadModelsDevEntries` overlays these
 * rates onto the shared pricing cache, keyed by bare model ID), that
 * `buildModelsDevFallback` may synthesize the provider's whole catalog when its
 * API is unreachable, and that a lookup miss is authoritative
 * (`isProviderSupported`). Add a provider here only when its models.dev rates
 * are the rates its connections actually pay. For a provider that only needs
 * modalities and capability flags, use CAPABILITY_ONLY_PROVIDER_ID_MAP.
 */
const PROVIDER_ID_MAP: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  cerebras: 'cerebras',
  openai: 'openai',
  gemini: 'google',
  vertex: 'google-vertex',
  deepseek: 'deepseek',
  fireworks: 'fireworks-ai',
  mistral: 'mistral',
  xai: 'xai',
  bedrock: 'amazon-bedrock',
  minimax: 'minimax',
  moonshot: 'moonshotai',
  nvidia: 'nvidia',
  qwen: 'alibaba',
  zai: 'zai',
  copilot: 'github-copilot',
  groq: 'groq',
  'opencode-go': 'opencode-go',
  'opencode-zen': 'opencode',
  'ollama-cloud': 'ollama-cloud',
};

/**
 * Providers whose models.dev catalog is authoritative for **capabilities only**.
 *
 * These publish no modality data on their own `/models` endpoint, so models.dev
 * is the only source of their modalities and capability flags. They are kept
 * out of PROVIDER_ID_MAP because their models.dev prices must not reach the
 * shared pricing cache: they list resold vendor models under the vendor's own
 * ID (`kilo/openai/gpt-4o-mini`, `pioneer/gpt-4o`), so overlaying them would
 * overwrite the real vendor rate for every client of that model ID. Their
 * connections are priced from their own API instead.
 */
const CAPABILITY_ONLY_PROVIDER_ID_MAP: Readonly<Record<string, string>> = {
  kilo: 'kilo',
  pioneer: 'pioneer',
  'cline-pass': 'cline-pass',
  xiaomi: 'xiaomi',
  // OpenRouter's own /models feed already prices every connection, down to the
  // routing variants (`:free`, `:nitro`, `:batch`) models.dev does not carry,
  // and PricingSyncService keeps it fresh. models.dev is read here only for the
  // modalities and tool-call flags that feed does not publish (#2737).
  openrouter: 'openrouter',
};

const SUPPORTED_PROVIDERS = new Set(Object.keys(PROVIDER_ID_MAP));

/** Resolve a provider ID or alias to our canonical internal ID (e.g., 'alibaba' → 'qwen'). */
function resolveProviderId(providerId: string): string {
  const lower = providerId.toLowerCase();
  if (SUPPORTED_PROVIDERS.has(lower)) return lower;
  const entry = PROVIDER_BY_ID_OR_ALIAS.get(lower);
  return entry?.id ?? lower;
}

/**
 * Time-of-day pricing band: the tier's rates replace the model's base rates
 * inside `windows` (UTC "HH:MM-HH:MM", start inclusive / end exclusive, an end
 * before its start wraps past midnight). Mirrors the models.dev
 * `cost.tiers[].tier.type = "time"` schema (anomalyco/models.dev#4892).
 */
export interface ModelsDevTimeTier {
  windows: readonly string[];
  /**
   * ISO weekdays (1 = Monday … 7 = Sunday) the windows apply on. Null means
   * every day — a tier with no schedule is unrestricted, as it was before this
   * field existed.
   */
  days: readonly number[] | null;
  inputPricePerToken: number | null;
  outputPricePerToken: number | null;
  cacheReadPricePerToken: number | null;
  cacheWritePricePerToken: number | null;
}

export interface ModelsDevModelEntry {
  id: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPricePerToken: number | null;
  outputPricePerToken: number | null;
  cacheReadPricePerToken?: number | null;
  cacheWritePricePerToken?: number | null;
  timeTiers?: readonly ModelsDevTimeTier[] | null;
  capabilities: readonly ModelCapability[];
  inputModalities: readonly ModelModality[];
  outputModalities: readonly ModelModality[];
}

interface RawModelsDevCostTier {
  tier?: { type?: string; size?: number; windows?: string[]; days?: unknown };
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

interface RawModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: RawModelsDevCostTier[];
  };
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
}

interface RawModelsDevProvider {
  id: string;
  name?: string;
  models?: Record<string, RawModelsDevModel>;
}

type RawModelsDevResponse = Record<string, RawModelsDevProvider>;

const MODELS_DEV_API = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 10000;

/** UTC "HH:MM-HH:MM" range, as validated by the models.dev schema. */
const TIME_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/**
 * DeepSeek bills peak/off-peak: peak hours are 01:00-04:00 and 06:00-10:00 UTC
 * **Monday through Friday**, and every other hour — including all 48 weekend
 * hours — is off-peak at half the peak rate. models.dev cannot express
 * time-of-day pricing yet (anomalyco/models.dev#4892 adds
 * `cost.tiers[].tier.type = "time"`), so until the catalog carries a time tier
 * this seed replaces whatever flat rate the sync returns with the real
 * off-peak base plus a peak-window tier.
 *
 * DELETE once models.dev serves time tiers for DeepSeek — the seed only
 * applies when `parseTimeTiers` finds nothing, so it retires itself, but the
 * dead constant should not outlive that. Prices are USD per 1M tokens from
 * https://api-docs.deepseek.com/quick_start/pricing/ (accessed 2026-09-10).
 */
const DEEPSEEK_PEAK_WINDOWS: readonly string[] = ['01:00-04:00', '06:00-10:00'];
/** Monday–Friday: DeepSeek's peak schedule does not run on weekends. */
const DEEPSEEK_PEAK_DAYS: readonly number[] = [1, 2, 3, 4, 5];

type DeepSeekRateCard = {
  input: number;
  output: number;
  cacheRead: number;
  peak: { input: number; output: number; cacheRead: number };
};

/** V4.1 Flash, in effect from 2026-09-10 04:00 UTC. */
const DEEPSEEK_FLASH_RATES: DeepSeekRateCard = {
  input: 0.15,
  output: 0.6,
  cacheRead: 0.003,
  peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
};

/** V4 Pro, unchanged until it starts routing to Flash. */
const DEEPSEEK_PRO_RATES: DeepSeekRateCard = {
  input: 0.66,
  output: 1.98,
  cacheRead: 0.022,
  peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
};

/**
 * 12:00 Beijing on 2026-09-14 = 04:00 UTC. From then, `deepseek-v4-pro` is
 * served by V4.1 Flash and billed on the Flash card.
 */
const DEEPSEEK_PRO_FLASH_CUTOVER_MS = Date.parse('2026-09-14T04:00:00Z');

/** GA id plus the retired aliases DeepSeek still accepts at Flash prices. */
const DEEPSEEK_FLASH_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]);

/** Stub used when the catalog has not listed `deepseek-flash` yet. */
const DEEPSEEK_FLASH_CATALOG_STUB: RawModelsDevModel = {
  id: 'deepseek-flash',
  name: 'DeepSeek V4.1 Flash',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
};

function deepseekSeedRates(modelId: string, atMs = Date.now()): DeepSeekRateCard | undefined {
  if (DEEPSEEK_FLASH_MODEL_IDS.has(modelId)) return DEEPSEEK_FLASH_RATES;
  if (modelId === 'deepseek-v4-pro') {
    return atMs >= DEEPSEEK_PRO_FLASH_CUTOVER_MS ? DEEPSEEK_FLASH_RATES : DEEPSEEK_PRO_RATES;
  }
  return undefined;
}

/** Matches trailing version suffixes like -001, -002 (Google API convention). */
const VERSION_SUFFIX_RE = /-\d{3}$/;
/** Matches trailing date suffixes like -20250514, -2025-04-14. */
const DATE_SUFFIX_RE = /-\d{4}-?\d{2}-?\d{2}$/;
/** Matches short date suffixes like -0709 (MMDD format, used by xAI). */
const SHORT_DATE_SUFFIX_RE = /-\d{4}$/;
/** Common suffix aliases: try appending -latest when the base name is not found. */
const LATEST_SUFFIX = '-latest';
/** xAI reasoning/non-reasoning mode suffixes. */
const REASONING_SUFFIX_RE = /-(reasoning|non-reasoning)$/;
/**
 * Legacy model names that providers still return in their native API
 * but which are listed under a different canonical name in pricing databases.
 * Maps legacy base name (without dated suffix) → canonical name.
 */
const LEGACY_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ['open-mistral-nemo', 'mistral-nemo'], // Mistral renamed open-mistral-nemo → mistral-nemo
  ['mistral-tiny', 'open-mistral-7b'], // mistral-tiny was the internal codename for Mistral 7B
]);
/** AWS sometimes returns an API owner namespace that differs from models.dev's Bedrock key. */
const MODEL_ID_PREFIX_ALIASES: ReadonlyMap<string, string> = new Map([
  ['moonshotai.', 'moonshot.'],
]);
/** Matches instruction-tuned suffixes that models.dev sometimes omits on Bedrock keys. */
const INSTRUCT_SUFFIX_RE = /-instruct$/;
/**
 * Matches an OpenRouter routing variant (`:free`, `:nitro`, `:batch`, ...).
 * The variant selects how a request is routed, not which model answers, so the
 * base entry carries its capabilities. Only applied to OpenRouter: elsewhere a
 * colon is part of the model ID itself (Ollama tags, Bedrock `-v1:0`).
 */
const OPENROUTER_VARIANT_SUFFIX_RE = /:[a-z0-9-]+$/;
/**
 * Matches Ollama release tags that models.dev omits from its base model key
 * (e.g. `deepseek-v4-pro:preview` → `deepseek-v4-pro`). Deliberately narrow:
 * parameter-size tags (`:120b`, `:397b`) and Bedrock-style `-v1:0` versions
 * must not match, since those are part of the canonical model ID.
 */
const OLLAMA_TAG_SUFFIX_RE = /:(?:preview|\d{4})$/;

@Injectable()
export class ModelsDevSyncService implements OnModuleInit {
  private readonly logger = new Logger(ModelsDevSyncService.name);
  /** Map: our provider ID → Map<model ID (native), entry> */
  private cache = new Map<string, Map<string, ModelsDevModelEntry>>();
  /** Map: our provider ID → Map<model ID, entry>, for capability-only providers. */
  private capabilityCache = new Map<string, Map<string, ModelsDevModelEntry>>();
  /** Map: models.dev provider ID → Map<model ID, entry>. Includes providers Manifest does not natively know. */
  private customProviderCache = new Map<string, Map<string, ModelsDevModelEntry>>();
  /** Map: provider id/display-name aliases → models.dev provider ID. */
  private customProviderIndex = new Map<string, string>();
  private lastFetchedAt: Date | null = null;
  private initialLoad: Promise<void> | null = null;

  onModuleInit(): void {
    // Fire-and-forget so a slow models.dev fetch can't delay app.listen() and
    // trip Railway's healthcheck (see #1894). ModelPricingCacheService awaits
    // whenInitialized() before its first reload so warmup still sees data.
    this.initialLoad = this.refreshCache()
      .then(() => undefined)
      .catch((err) => {
        this.logger.error(`Startup models.dev cache refresh failed: ${err}`);
      });
  }

  /** Resolves once the startup refresh has settled (success or handled error). */
  whenInitialized(): Promise<void> {
    return this.initialLoad ?? Promise.resolve();
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshCache(): Promise<number> {
    this.logger.log('Refreshing models.dev cache...');
    const raw = await this.fetchModelsDevData();
    if (!raw) return 0;

    const newCache = new Map<string, Map<string, ModelsDevModelEntry>>();
    const newCustomProviderCache = new Map<string, Map<string, ModelsDevModelEntry>>();
    const newCustomProviderIndex = new Map<string, string>();
    let totalModels = 0;

    for (const [modelsDevId, provider] of Object.entries(raw)) {
      if (!provider?.models) continue;

      const modelMap = new Map<string, ModelsDevModelEntry>();
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!this.isChatCompatible(model)) continue;
        modelMap.set(modelId, this.parseModel(modelsDevId, modelId, model));
      }

      if (modelMap.size > 0) {
        newCustomProviderCache.set(modelsDevId, modelMap);
        this.indexCustomProvider(newCustomProviderIndex, modelsDevId, provider);
      }
    }

    for (const [ourId, modelsDevId] of Object.entries(PROVIDER_ID_MAP)) {
      const provider = raw[modelsDevId];
      if (!provider?.models) continue;

      const modelMap = new Map<string, ModelsDevModelEntry>();
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!this.isChatCompatible(model)) continue;
        const entry = this.parseModel(ourId, modelId, model);
        modelMap.set(modelId, entry);
        totalModels++;
      }
      if (ourId === 'deepseek' && !modelMap.has('deepseek-flash')) {
        modelMap.set(
          'deepseek-flash',
          this.parseModel(ourId, 'deepseek-flash', DEEPSEEK_FLASH_CATALOG_STUB),
        );
        totalModels++;
      }

      if (modelMap.size > 0) {
        newCache.set(ourId, modelMap);
      }
    }

    // Capability-only providers stay out of `cache`, so no pricing or fallback
    // consumer can reach them. `totalModels` counts priced coverage only.
    const newCapabilityCache = new Map<string, Map<string, ModelsDevModelEntry>>();
    for (const [ourId, modelsDevId] of Object.entries(CAPABILITY_ONLY_PROVIDER_ID_MAP)) {
      const provider = raw[modelsDevId];
      if (!provider?.models) continue;

      const modelMap = new Map<string, ModelsDevModelEntry>();
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!this.isChatCompatible(model)) continue;
        modelMap.set(modelId, this.parseModel(ourId, modelId, model));
      }

      if (modelMap.size > 0) {
        newCapabilityCache.set(ourId, modelMap);
      }
    }

    this.cache = newCache;
    this.capabilityCache = newCapabilityCache;
    this.customProviderCache = newCustomProviderCache;
    this.customProviderIndex = newCustomProviderIndex;
    this.lastFetchedAt = new Date();
    this.logger.log(`models.dev cache loaded: ${newCache.size} providers, ${totalModels} models`);

    return totalModels;
  }

  /**
   * Look up a single model by our provider ID and native model ID.
   * Tries multiple fallback strategies for variant model names:
   *   1. Exact match
   *   2. Strip 3-digit version suffix (-001)
   *   3. Strip date suffix (-20250514 or -2025-04-14)
   *   4. Append -latest (mistral-medium → mistral-medium-latest)
   *   5. Strip date then append -latest
   *   6. Strip Google variant suffix (-preview-MM-DD, -exp-MMDD, -latest)
   *   7. Strip -reasoning / -non-reasoning suffix (xAI convention)
   *   8. Strip 4-digit short date suffix (-0709 MMDD format)
   */
  lookupModel(providerId: string, modelId: string): ModelsDevModelEntry | null {
    const resolvedProviderId = resolveProviderId(providerId);
    const providerModels = this.cache.get(resolvedProviderId);
    if (!providerModels) return null;
    return this.lookupModelInProvider(providerModels, modelId, resolvedProviderId);
  }

  /**
   * Look up a model for a user-defined custom provider by matching the custom
   * provider display name against models.dev provider IDs and names.
   */
  lookupCustomProviderModel(providerName: string, modelId: string): ModelsDevModelEntry | null {
    const providerKey = this.resolveCustomProviderKey(providerName);
    if (!providerKey) return null;
    const providerModels = this.customProviderCache.get(providerKey);
    if (!providerModels) return null;
    return this.lookupModelInProvider(providerModels, modelId);
  }

  /**
   * Look up a model for its modalities and capability flags: the priced catalog
   * first, then CAPABILITY_ONLY_PROVIDER_ID_MAP.
   *
   * **Never read pricing from the result.** A capability-only entry carries a
   * reseller's rate for a vendor's model ID, which is not what the connection
   * pays. Callers that need a price must use `lookupModel`.
   */
  lookupModelCapabilities(providerId: string, modelId: string): ModelsDevModelEntry | null {
    const native = this.lookupModel(providerId, modelId);
    if (native) return native;

    const resolvedProviderId = resolveProviderId(providerId);
    const providerModels = this.capabilityCache.get(resolvedProviderId);
    if (!providerModels) return null;
    return this.lookupModelInProvider(providerModels, modelId, resolvedProviderId);
  }

  /**
   * Conservative model-only fallback for custom providers that are not listed
   * on models.dev. Prefer official provider catalogs, then exact IDs from
   * aggregator catalogs. This is intentionally not fuzzy.
   */
  lookupModelAcrossProviders(modelId: string): ModelsDevModelEntry | null {
    const providerScoped = this.lookupProviderScopedModel(modelId);
    if (providerScoped) return providerScoped;

    for (const [providerId, providerModels] of this.cache) {
      const found = this.lookupModelInProvider(providerModels, modelId, providerId);
      if (found) return found;
    }

    for (const providerModels of this.customProviderCache.values()) {
      const exact = providerModels.get(modelId);
      if (exact) return exact;
    }

    return null;
  }

  private lookupProviderScopedModel(modelId: string): ModelsDevModelEntry | null {
    const slash = modelId.indexOf('/');
    if (slash <= 0 || slash === modelId.length - 1) return null;
    const providerPart = modelId.slice(0, slash);
    const nativeModelId = modelId.slice(slash + 1);
    return this.lookupModel(providerPart, nativeModelId);
  }

  private lookupModelInProvider(
    providerModels: Map<string, ModelsDevModelEntry>,
    modelId: string,
    providerId?: string,
  ): ModelsDevModelEntry | null {
    // 1. Exact match
    const exact = providerModels.get(modelId);
    if (exact) return exact;

    // 1a. Provider APIs can omit Bedrock-style version suffixes present in models.dev
    //     (e.g., qwen.qwen3-32b → qwen.qwen3-32b-v1:0).
    const versioned = this.lookupVersionedModelVariant(providerModels, modelId);
    if (versioned) return versioned;

    // 1b. Legacy name alias (e.g., open-mistral-nemo → mistral-nemo)
    //     Strip date, short-date, and -latest suffixes to find the base name for alias lookup.
    const aliasBase = modelId
      .replace(DATE_SUFFIX_RE, '')
      .replace(SHORT_DATE_SUFFIX_RE, '')
      .replace(/-latest$/, '');
    const aliasTarget =
      LEGACY_NAME_ALIASES.get(aliasBase) ??
      LEGACY_NAME_ALIASES.get(modelId) ??
      LEGACY_NAME_ALIASES.get(modelId.replace(/-latest$/, ''));
    if (aliasTarget) {
      const found = providerModels.get(aliasTarget);
      if (found) return found;
    }

    // 1c. Provider prefix aliases inside provider-native IDs
    //     (e.g., moonshotai.kimi-k2-thinking → moonshot.kimi-k2-thinking).
    const prefixAlias = this.applyModelIdPrefixAlias(modelId);
    if (prefixAlias) {
      const found = providerModels.get(prefixAlias);
      if (found) return found;
      const aliasVersioned = this.lookupVersionedModelVariant(providerModels, prefixAlias);
      if (aliasVersioned) return aliasVersioned;
    }

    // 2. Strip 3-digit version suffix (e.g., gemini-2.0-flash-001 → gemini-2.0-flash)
    const noVersion = modelId.replace(VERSION_SUFFIX_RE, '');
    if (noVersion !== modelId) {
      const found = providerModels.get(noVersion);
      if (found) return found;
    }

    // 3. Strip date suffix (e.g., gpt-4.1-2025-04-14 → gpt-4.1)
    const noDate = modelId.replace(DATE_SUFFIX_RE, '');
    if (noDate !== modelId) {
      const found = providerModels.get(noDate);
      if (found) return found;
    }

    // 4. Append -latest (e.g., mistral-medium → mistral-medium-latest)
    if (!modelId.endsWith(LATEST_SUFFIX)) {
      const withLatest = providerModels.get(modelId + LATEST_SUFFIX);
      if (withLatest) return withLatest;
    }

    // 5. Strip date then append -latest (e.g., mistral-small-2603 → mistral-small-latest)
    if (noDate !== modelId && !noDate.endsWith(LATEST_SUFFIX)) {
      const found = providerModels.get(noDate + LATEST_SUFFIX);
      if (found) return found;
    }

    // 6. Strip Google variant suffixes: -preview-MM-DD, -exp-MMDD, -latest
    //    (e.g., gemini-2.5-pro-preview-03-25 → gemini-2.5-pro)
    const noGoogleVariant = modelId.replace(GOOGLE_VARIANT_RE, '');
    if (noGoogleVariant !== modelId) {
      const found = providerModels.get(noGoogleVariant);
      if (found) return found;
    }

    // 7. Strip -reasoning / -non-reasoning suffix (xAI: grok-4-1-fast-reasoning → grok-4-1-fast)
    const noReasoning = modelId.replace(REASONING_SUFFIX_RE, '');
    if (noReasoning !== modelId) {
      const found = providerModels.get(noReasoning);
      if (found) return found;
    }

    if (providerId === 'ollama-cloud') {
      // 7a. Strip Ollama release tags absent from the models.dev key
      //     (e.g. deepseek-v4-pro:preview → deepseek-v4-pro).
      const noTag = modelId.replace(OLLAMA_TAG_SUFFIX_RE, '');
      if (noTag !== modelId) {
        const found = providerModels.get(noTag);
        if (found) return found;
      }
    }

    if (providerId === 'openrouter') {
      // 7a. Strip the routing variant (qwen/qwen3-coder:batch → qwen/qwen3-coder)
      const noVariant = modelId.replace(OPENROUTER_VARIANT_SUFFIX_RE, '');
      if (noVariant !== modelId) {
        const found = providerModels.get(noVariant);
        if (found) return found;
      }
    }

    if (providerId === 'bedrock') {
      // 7b. Strip instruction-tuned suffix when models.dev stores the same Bedrock
      //     model under its shorter base name.
      const noInstruct = modelId.replace(INSTRUCT_SUFFIX_RE, '');
      if (noInstruct !== modelId) {
        const found = providerModels.get(noInstruct);
        if (found) return found;
        const versionedBase = this.lookupVersionedModelVariant(providerModels, noInstruct);
        if (versionedBase) return versionedBase;
      }
    }

    // 8. Strip 4-digit short date suffix (xAI: grok-4-0709 → grok-4)
    const noShortDate = modelId.replace(SHORT_DATE_SUFFIX_RE, '');
    if (noShortDate !== modelId) {
      const found = providerModels.get(noShortDate);
      if (found) return found;
      // 9. Strip short date then append -latest (mistral-small-2603 → mistral-small-latest)
      if (!noShortDate.endsWith(LATEST_SUFFIX)) {
        const withLatest = providerModels.get(noShortDate + LATEST_SUFFIX);
        if (withLatest) return withLatest;
      }
    }

    // 10. Strip -latest and search for any dated variant of the base name
    //     (e.g. devstral-latest → devstral-2512, ministral-14b-latest → ministral-14b-2512)
    if (modelId.endsWith(LATEST_SUFFIX)) {
      const base = modelId.slice(0, -LATEST_SUFFIX.length);
      const prefix = `${base}-`;
      for (const [key, entry] of providerModels) {
        if (key.startsWith(prefix) && key !== modelId) return entry;
      }
      // Also try exact base name (e.g. gemini-pro-latest → gemini-pro is unlikely
      // but handles edge cases where models.dev stores the bare name)
      const baseMatch = providerModels.get(base);
      if (baseMatch) return baseMatch;
    }

    return null;
  }

  private lookupVersionedModelVariant(
    providerModels: Map<string, ModelsDevModelEntry>,
    modelId: string,
  ): ModelsDevModelEntry | null {
    for (const suffix of ['-v1:0', '-v1', '-1:0', '-1']) {
      const found = providerModels.get(`${modelId}${suffix}`);
      if (found) return found;
    }

    const dottedVersion = modelId.replace(/^(.*\.[A-Za-z0-9-]*\d)\.(\d+)$/, '$1-v$2:0');
    if (dottedVersion !== modelId) {
      const found = providerModels.get(dottedVersion);
      if (found) return found;
    }

    const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const variantRe = new RegExp(`^${escaped}-(?:v\\d+(?::\\d+)?|\\d+:\\d+)$`);
    for (const [key, entry] of providerModels) {
      if (variantRe.test(key)) return entry;
    }
    return null;
  }

  private applyModelIdPrefixAlias(modelId: string): string | null {
    for (const [from, to] of MODEL_ID_PREFIX_ALIASES) {
      if (modelId.startsWith(from)) return `${to}${modelId.slice(from.length)}`;
    }
    return null;
  }

  private resolveCustomProviderKey(providerName: string): string | null {
    const trimmed = providerName.trim();
    if (!trimmed) return null;
    return (
      this.customProviderIndex.get(trimmed.toLowerCase()) ??
      this.customProviderIndex.get(normalizeProviderName(trimmed)) ??
      null
    );
  }

  /**
   * Get all models for a provider (by our internal provider ID).
   * Returns an empty array if the provider is not found.
   */
  getModelsForProvider(providerId: string): ModelsDevModelEntry[] {
    const providerModels = this.cache.get(resolveProviderId(providerId));
    if (!providerModels) return [];
    return [...providerModels.values()];
  }

  /** Whether a provider ID is mapped for models.dev lookups. */
  isProviderSupported(providerId: string): boolean {
    return SUPPORTED_PROVIDERS.has(resolveProviderId(providerId));
  }

  getLastFetchedAt(): Date | null {
    return this.lastFetchedAt;
  }

  private indexCustomProvider(
    index: Map<string, string>,
    modelsDevId: string,
    provider: RawModelsDevProvider,
  ): void {
    this.addCustomProviderIndexEntry(index, modelsDevId, modelsDevId);
    if (provider.id) this.addCustomProviderIndexEntry(index, provider.id, modelsDevId);
    if (provider.name) this.addCustomProviderIndexEntry(index, provider.name, modelsDevId);
  }

  private addCustomProviderIndexEntry(
    index: Map<string, string>,
    value: string,
    modelsDevId: string,
  ): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (!index.has(lower)) index.set(lower, modelsDevId);
    const normalized = normalizeProviderName(trimmed);
    if (!index.has(normalized)) index.set(normalized, modelsDevId);
  }

  /**
   * ISO weekdays a time tier is restricted to, or null for "every day".
   *
   * A malformed list is dropped **whole**, never filtered entry by entry:
   * salvaging `[1,2,3,4,5,'6']` down to `[1..5]` would read as a clean weekday
   * rule and quietly discount a day the provider charges peak for. Dropping it
   * falls back to the unrestricted tier, which is what the catalog meant
   * before the field existed and never bills below the published rate.
   */
  private parseTierDays(days: unknown): readonly number[] | null {
    if (!Array.isArray(days) || days.length === 0) return null;
    const valid = days.every(
      (day) => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7,
    );
    return valid ? (days as number[]) : null;
  }

  /**
   * Extract time-of-day pricing tiers from a raw models.dev cost block.
   * Context-size tiers (`tier.type = "context"`) are ignored — Manifest does
   * not price by context band. Returns null when no valid time tier exists.
   */
  private parseTimeTiers(raw: RawModelsDevModel): ModelsDevTimeTier[] | null {
    const tiers = raw.cost?.tiers;
    if (!Array.isArray(tiers)) return null;

    const parsed: ModelsDevTimeTier[] = [];
    for (const tier of tiers) {
      if (tier?.tier?.type !== 'time') continue;
      // Zero-length windows (e.g. "06:00-06:00") are rejected: only an end
      // before the start wraps midnight, so equal endpoints would read as a
      // full-day band and override the base rate around the clock.
      const windows = (tier.tier.windows ?? []).filter(
        (window) =>
          typeof window === 'string' &&
          TIME_WINDOW_RE.test(window) &&
          window.slice(0, 5) !== window.slice(6),
      );
      if (windows.length === 0) continue;
      parsed.push({
        windows,
        days: this.parseTierDays(tier.tier.days),
        inputPricePerToken: tier.input != null ? tier.input / 1_000_000 : null,
        outputPricePerToken: tier.output != null ? tier.output / 1_000_000 : null,
        cacheReadPricePerToken: tier.cache_read != null ? tier.cache_read / 1_000_000 : null,
        cacheWritePricePerToken: tier.cache_write != null ? tier.cache_write / 1_000_000 : null,
      });
    }
    return parsed.length > 0 ? parsed : null;
  }

  private parseModel(
    providerId: string,
    modelId: string,
    raw: RawModelsDevModel,
  ): ModelsDevModelEntry {
    let inputPerMillion = raw.cost?.input ?? null;
    let outputPerMillion = raw.cost?.output ?? null;
    let cacheReadPerMillion = raw.cost?.cache_read ?? null;
    let cacheWritePerMillion = raw.cost?.cache_write ?? null;
    let timeTiers = this.parseTimeTiers(raw);

    // Peak/off-peak seed for DeepSeek's own API until models.dev can carry
    // the schedule itself (see deepseekSeedRates). Catalog data wins the
    // moment it exists.
    if (providerId === 'deepseek' && !timeTiers) {
      const seed = deepseekSeedRates(modelId);
      if (seed) {
        inputPerMillion = seed.input;
        outputPerMillion = seed.output;
        cacheReadPerMillion = seed.cacheRead;
        // DeepSeek bills cache writes at the plain input rate (no premium), so
        // clear any stale catalog value; the cost calculator falls back to the
        // effective input price when cache-write pricing is null.
        cacheWritePerMillion = null;
        timeTiers = [
          {
            windows: DEEPSEEK_PEAK_WINDOWS,
            days: DEEPSEEK_PEAK_DAYS,
            inputPricePerToken: seed.peak.input / 1_000_000,
            outputPricePerToken: seed.peak.output / 1_000_000,
            cacheReadPricePerToken: seed.peak.cacheRead / 1_000_000,
            cacheWritePricePerToken: null,
          },
        ];
      }
    }

    const modalities = modelModalitiesFromModelsDev(raw.modalities);

    return {
      id: modelId,
      name: raw.name || modelId,
      family: raw.family,
      reasoning: raw.reasoning ?? false,
      toolCall: raw.tool_call ?? false,
      structuredOutput: raw.structured_output ?? false,
      contextWindow: raw.limit?.context,
      maxOutputTokens: raw.limit?.output,
      capabilities: capabilitiesFromModelsDev(providerId, modelId, raw.modalities, raw.tool_call),
      inputModalities: modalities.input,
      outputModalities: modalities.output,
      inputPricePerToken: inputPerMillion !== null ? inputPerMillion / 1_000_000 : null,
      outputPricePerToken: outputPerMillion !== null ? outputPerMillion / 1_000_000 : null,
      cacheReadPricePerToken: cacheReadPerMillion !== null ? cacheReadPerMillion / 1_000_000 : null,
      cacheWritePricePerToken:
        cacheWritePerMillion !== null ? cacheWritePerMillion / 1_000_000 : null,
      timeTiers,
    };
  }

  /**
   * Filter to models that accept text input and can produce text output.
   * Uses "includes text" (not "text-only") so multimodal models that
   * also produce text (e.g. GPT-4o) pass through.
   */
  private isChatCompatible(model: RawModelsDevModel): boolean {
    const inputMods = model.modalities?.input?.map((m) => m.toLowerCase());
    if (inputMods && inputMods.length > 0 && !inputMods.includes('text')) {
      return false;
    }
    const outputMods = model.modalities?.output?.map((m) => m.toLowerCase());
    if (outputMods && outputMods.length > 0) {
      return outputMods.includes('text');
    }
    return true;
  }

  private async fetchModelsDevData(): Promise<RawModelsDevResponse | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(MODELS_DEV_API, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.error(`models.dev API returned ${res.status}`);
        return null;
      }
      return (await res.json()) as RawModelsDevResponse;
    } catch (err) {
      this.logger.error(`Failed to fetch models.dev data: ${err}`);
      return null;
    }
  }
}
