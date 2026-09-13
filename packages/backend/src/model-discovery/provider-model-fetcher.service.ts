import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DiscoveredModel, FetcherConfig, DEFAULT_CONTEXT_WINDOW } from './model-fetcher';
import {
  getManagedFreeLiteLlmModelsUrl,
  MANAGED_FREE_PROVIDER_CONFIGS,
  ManagedFreeProviderConfig,
} from '../common/constants/managed-free-providers';
import { OLLAMA_CLOUD_HOST, OLLAMA_HOST } from '../common/constants/ollama';
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  CODEX_CLI_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION,
  buildClaudeCodeSubscriptionHeaders,
} from '../common/constants/subscription-clients';
import { normalizeMinimaxSubscriptionBaseUrl } from '../routing/provider-base-url';
import { getQwenCompatibleBaseUrl, normalizeQwenCompatibleBaseUrl } from '../routing/qwen-region';
import { getBedrockMantleBaseUrl, normalizeBedrockMantleBaseUrl } from '../routing/bedrock-region';
import {
  getXiaomiTokenPlanBaseUrl,
  normalizeXiaomiTokenPlanBaseUrl,
} from '../routing/xiaomi-region';
import { getZaiCodingPlanBaseUrl, normalizeZaiCodingPlanBaseUrl } from '../routing/zai-region';
import { OpencodeGoCatalogService } from './opencode-go-catalog.service';
import {
  buildKiroHeaders,
  KIRO_BASE_URL,
  KIRO_MODELS_TARGET,
  parseKiroModels,
} from '../routing/proxy/kiro-adapter';
import {
  getSubscriptionCapabilities,
  getSubscriptionKnownModels,
  META_MODEL_API_CONTEXT_WINDOW,
  META_MODEL_API_MODEL_BY_ID,
  MODEL_MODALITIES,
  type ModelCapability,
  type ModelModality,
} from 'manifest-shared';

const FETCH_TIMEOUT_MS = 5000;
const ANTHROPIC_DEFAULT_CONTEXT = 200000;
const BYTEPLUS_CODING_MODELS_URL = 'https://ark.ap-southeast.bytepluses.com/api/coding/v3/models';
const GEMINI_DEFAULT_CONTEXT = 1000000;
const MINIMAX_SUBSCRIPTION_MODELS_URL = 'https://api.minimax.io/anthropic/v1/models?limit=100';
const COMMAND_CODE_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';
const XIAOMI_MIMO_MODELS_URL = 'https://api.xiaomimimo.com/v1/models';
const XIAOMI_TOKEN_PLAN_MODELS_URL = `${getXiaomiTokenPlanBaseUrl()}/v1/models`;
const QWEN_TOKEN_PLAN_MODELS_URL =
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models';
const QWEN_TOKEN_PLAN_CONTEXT_WINDOW = 991000;
const KILO_GATEWAY_BASE = 'https://api.kilo.ai/api/gateway';
const FIREWORKS_MODELS_URL = 'https://api.fireworks.ai/v1/accounts/fireworks/models';
const HUGGING_FACE_MODELS_URL = 'https://router.huggingface.co/v1/models';
const FIREWORKS_MODELS_PAGE_SIZE = 200;
const FIREWORKS_MODELS_MAX_PAGES = 20;
const NOUS_PORTAL_MODELS_URL = 'https://inference-api.nousresearch.com/v1/models';
const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const PIONEER_MODELS_URL = 'https://api.pioneer.ai/v1/models';
const PIONEER_BASE_MODELS_URL = 'https://api.pioneer.ai/base-models';
const META_MODELS_URL = 'https://api.meta.ai/v1/models';
const COPILOT_AI_CREDIT_USD = 0.01;

/* ── Generic parser factory ── */

interface ModelParserConfig<T> {
  arrayKey: string;
  filter: (entry: T) => boolean;
  getId: (entry: T) => string;
  getDisplayName: (entry: T, id: string) => string;
  contextWindow?: number | ((entry: T) => number);
  contextWindowSource?: (entry: T) => DiscoveredModel['contextWindowSource'];
  inputPricePerToken?: number | null;
  outputPricePerToken?: number | null;
  capabilityReasoning?: boolean;
  capabilityCode?: boolean | ((entry: T) => boolean);
  inputModalities?: readonly ModelModality[];
  outputModalities?: readonly ModelModality[];
  supportedEndpoints?: (entry: T) => readonly string[] | undefined;
  qualityScore?: number;
}

function createModelParser<T>(
  config: ModelParserConfig<T>,
): (body: unknown, provider: string) => DiscoveredModel[] {
  return (body: unknown, provider: string): DiscoveredModel[] => {
    const arr = (body as Record<string, unknown>)?.[config.arrayKey];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m: unknown) => config.filter(m as T))
      .map((m: unknown) => {
        const entry = m as T;
        const id = config.getId(entry);
        const ctxVal = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const contextWindowSource = config.contextWindowSource?.(entry);
        const supportedEndpoints = config.supportedEndpoints?.(entry);
        return {
          id,
          displayName: config.getDisplayName(entry, id),
          provider,
          contextWindow: typeof ctxVal === 'function' ? ctxVal(entry) : ctxVal,
          ...(contextWindowSource ? { contextWindowSource } : {}),
          inputPricePerToken: config.inputPricePerToken ?? null,
          outputPricePerToken: config.outputPricePerToken ?? null,
          capabilityReasoning: config.capabilityReasoning ?? false,
          capabilityCode:
            typeof config.capabilityCode === 'function'
              ? config.capabilityCode(entry)
              : (config.capabilityCode ?? false),
          ...(config.inputModalities ? { inputModalities: config.inputModalities } : {}),
          ...(config.outputModalities ? { outputModalities: config.outputModalities } : {}),
          ...(supportedEndpoints && supportedEndpoints.length > 0 ? { supportedEndpoints } : {}),
          qualityScore: config.qualityScore ?? 3,
        };
      });
  };
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : undefined;
}

/* ── Shared OpenAI-compatible parser ── */

interface OpenAIModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  supported_endpoints?: unknown;
}

interface PioneerModelEntry extends OpenAIModelEntry {
  display_name?: string;
  context_length?: number;
}

interface PioneerBaseModelEntry {
  id: string;
  label?: string;
  context_window?: number;
  input_price_per_million?: number | null;
  output_price_per_million?: number | null;
  supports_inference?: boolean;
  is_chat_model?: boolean;
  supports_image_input?: boolean;
}

interface CommandCodeModelEntry extends OpenAIModelEntry {
  name?: string;
  context_length?: number;
}

interface HuggingFaceProviderEntry {
  status?: string;
  context_length?: number;
  pricing?: {
    input?: number;
    output?: number;
  };
  supports_tools?: boolean;
  throughput?: number;
}

interface HuggingFaceModelEntry extends OpenAIModelEntry {
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  providers?: unknown;
}

const parseOpenAI = createModelParser<OpenAIModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.id.length > 0,
  getId: (entry) => entry.id,
  getDisplayName: (_entry, id) => id,
});

/** Keep only the configured model family and prefer LiteLLM's vendor-prefixed ID. */
function parseManagedFreeLiteLlm(
  body: unknown,
  provider: string,
  config: ManagedFreeProviderConfig,
): DiscoveredModel[] {
  const models = parseOpenAI(body, provider).filter((model) => {
    const bare = model.id.slice(model.id.lastIndexOf('/') + 1);
    return !model.id.includes('*') && bare.startsWith(config.catalogModelIdPrefix);
  });
  const byBareId = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const bare = model.id.slice(model.id.lastIndexOf('/') + 1);
    const existing = byBareId.get(bare);
    if (
      !existing ||
      (model.id.startsWith(config.preferredModelIdPrefix) &&
        !existing.id.startsWith(config.preferredModelIdPrefix))
    ) {
      byBareId.set(bare, model);
    }
  }
  return Array.from(byBareId.values());
}

const parsePioneer = createModelParser<PioneerModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.id.length > 0,
  getId: (entry) => entry.id,
  getDisplayName: (entry, id) => entry.display_name || id,
  contextWindow: (entry) => entry.context_length ?? DEFAULT_CONTEXT_WINDOW,
});

function perMillionToPerToken(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value / 1_000_000
    : null;
}

function parseModalities(value: unknown): readonly ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<ModelModality>(['text', 'image', 'audio', 'video']);
  const modalities: ModelModality[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const modality = raw.toLowerCase() as ModelModality;
    if (allowed.has(modality) && !modalities.includes(modality)) modalities.push(modality);
  }
  return modalities.length > 0 ? modalities : undefined;
}

function fastestLiveHuggingFaceProvider(value: unknown): HuggingFaceProviderEntry | undefined {
  if (!Array.isArray(value)) return undefined;
  const live = value.filter(
    (provider): provider is HuggingFaceProviderEntry =>
      !!provider && typeof provider === 'object' && provider.status === 'live',
  );
  return live.reduce<HuggingFaceProviderEntry | undefined>((fastest, provider) => {
    if (!fastest) return provider;
    const throughput =
      typeof provider.throughput === 'number' && Number.isFinite(provider.throughput)
        ? provider.throughput
        : -1;
    const fastestThroughput =
      typeof fastest.throughput === 'number' && Number.isFinite(fastest.throughput)
        ? fastest.throughput
        : -1;
    return throughput > fastestThroughput ? provider : fastest;
  }, undefined);
}

function parseHuggingFace(body: unknown, provider: string): DiscoveredModel[] {
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((raw): DiscoveredModel[] => {
    const entry = raw as HuggingFaceModelEntry;
    if (typeof entry.id !== 'string' || entry.id.length === 0) return [];
    const fastest = fastestLiveHuggingFaceProvider(entry.providers);
    if (!fastest) return [];

    const inputModalities = parseModalities(entry.architecture?.input_modalities);
    const outputModalities = parseModalities(entry.architecture?.output_modalities);
    const capabilities: ModelCapability[] = [];
    for (const modality of [...(inputModalities ?? []), ...(outputModalities ?? [])]) {
      if (!capabilities.includes(modality)) capabilities.push(modality);
    }
    capabilities.push('stream');
    if (fastest.supports_tools === true) capabilities.push('tools');

    return [
      {
        id: entry.id,
        displayName: entry.id,
        provider,
        contextWindow: fastest.context_length ?? DEFAULT_CONTEXT_WINDOW,
        inputPricePerToken: perMillionToPerToken(fastest.pricing?.input),
        outputPricePerToken: perMillionToPerToken(fastest.pricing?.output),
        capabilityReasoning: false,
        capabilityCode: fastest.supports_tools === true,
        capabilities,
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
        qualityScore: 3,
      },
    ];
  });
}

function parsePioneerBaseCatalog(body: unknown): Map<string, PioneerBaseModelEntry> {
  const models = (body as { models?: unknown[] })?.models;
  const byId = new Map<string, PioneerBaseModelEntry>();
  if (!Array.isArray(models)) return byId;
  for (const model of models) {
    const entry = model as PioneerBaseModelEntry;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    byId.set(entry.id, entry);
  }
  return byId;
}

function enrichPioneerModels(
  models: DiscoveredModel[],
  catalog: Map<string, PioneerBaseModelEntry>,
): DiscoveredModel[] {
  return models.map((model) => {
    const base = catalog.get(model.id);
    if (!base) return model;
    return {
      ...model,
      displayName: base.label || model.displayName,
      contextWindow: base.context_window ?? model.contextWindow,
      inputPricePerToken: perMillionToPerToken(base.input_price_per_million),
      outputPricePerToken: perMillionToPerToken(base.output_price_per_million),
      capabilityCode: base.is_chat_model !== false ? model.capabilityCode : false,
      ...(base.supports_image_input ? { inputModalities: ['text', 'image'] as const } : {}),
    };
  });
}

const parseCommandCode = createModelParser<CommandCodeModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.id.length > 0,
  getId: (entry) => `commandcode/${entry.id}`,
  getDisplayName: (entry, id) => entry.name || id,
  contextWindow: (entry) => entry.context_length ?? DEFAULT_CONTEXT_WINDOW,
  capabilityCode: true,
});

const parseBytePlusCodingPlan = (body: unknown, provider: string): DiscoveredModel[] => {
  const known = new Set(getSubscriptionKnownModels('byteplus') ?? []);
  return parseOpenAI(body, provider).filter((model) => known.has(model.id));
};

const parseQwenTokenPlan = createModelParser<OpenAIModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.id.length > 0,
  getId: (entry) => entry.id,
  getDisplayName: (_entry, id) => id,
  contextWindow: QWEN_TOKEN_PLAN_CONTEXT_WINDOW,
  inputPricePerToken: 0,
  outputPricePerToken: 0,
});

const XIAOMI_MIMO_CONTEXT_WINDOWS = new Map<string, number>([
  ['mimo-v2.5-pro', 1048576],
  ['mimo-v2-pro', 1048576],
  ['mimo-v2.5', 1048576],
  ['mimo-v2-omni', 262144],
  ['mimo-v2-flash', 262144],
]);

const parseXiaomiMimo = createModelParser<OpenAIModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.id.startsWith('mimo-v'),
  getId: (entry) => entry.id,
  getDisplayName: (_entry, id) => id,
  contextWindow: (entry) => XIAOMI_MIMO_CONTEXT_WINDOWS.get(entry.id) ?? DEFAULT_CONTEXT_WINDOW,
  capabilityCode: true,
});

const parseMeta = createModelParser<OpenAIModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && META_MODEL_API_MODEL_BY_ID.has(entry.id),
  getId: (entry) => entry.id,
  getDisplayName: (_entry, id) => META_MODEL_API_MODEL_BY_ID.get(id)?.displayName ?? id,
  contextWindow: META_MODEL_API_CONTEXT_WINDOW,
  capabilityReasoning: true,
  capabilityCode: true,
  inputModalities: ['text', 'image', 'audio', 'video'],
  outputModalities: ['text'],
});

/* ── OpenAI-specific structural filters (not non-chat) ── */

/** Date-suffixed snapshots returned by OpenAI (e.g. gpt-4o-mini-2024-07-18). */
const OPENAI_DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/;

function parseOpenAIDeduped(body: unknown, provider: string): DiscoveredModel[] {
  const parsed = parseOpenAI(body, provider);
  // Deduplicate: if both an alias (gpt-4o-mini) and a dated snapshot
  // (gpt-4o-mini-2024-07-18) exist, keep only the alias.
  const ids = new Set(parsed.map((m) => m.id));
  return parsed.filter((m) => {
    if (!OPENAI_DATE_SUFFIX_RE.test(m.id)) return true;
    const alias = m.id.replace(OPENAI_DATE_SUFFIX_RE, '');
    return !ids.has(alias);
  });
}

function parseOpenAIDedupedById(body: unknown, provider: string): DiscoveredModel[] {
  const parsed = parseOpenAI(body, provider);
  const seen = new Set<string>();
  return parsed.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/* ── Universal non-chat model filter ── */

/**
 * Non-chat patterns common across ALL providers. Models matching these
 * are not compatible with /v1/chat/completions and must be filtered out.
 * Covers: embeddings, TTS, speech recognition, image generation, audio.
 */
export const UNIVERSAL_NON_CHAT_RE =
  /(?:embed|tts|whisper|dall-e|imagen|cogview|wanx|sambert|paraformer|text-embedding|speech-to|voice-|audio-turbo)/i;

/**
 * Provider-specific non-chat patterns that supplement the universal filter.
 * Keyed by the config key used in PROVIDER_CONFIGS.
 */
export const PROVIDER_NON_CHAT: Record<string, RegExp> = {
  openai:
    /(?:moderation|davinci|babbage|^text-|realtime|-transcribe|^sora|^gpt-3\.5-turbo-instruct|audio|^chatgpt-image|^gpt-image-|search-api)/i,
  'openai-subscription':
    /(?:moderation|davinci|babbage|^text-|realtime|-transcribe|^sora|audio|^chatgpt-image|^gpt-image-)/i,
  // `flash-lite-preview-MM-YYYY` matches deprecated dated snapshots
  // (e.g. gemini-2.5-flash-lite-preview-09-2025). The unsuffixed
  // `gemini-3.1-flash-lite-preview` is the canonical preview alias and
  // must NOT be filtered.
  gemini:
    /(?:^aqs-|nano-banana|^deep-research|computer-use|^lyria|^gemini-2\.0-flash-lite$|flash-lite-preview-\d{2}-\d{4}$|robotics)/i,
  // Vertex serves the same non-chat families as the Gemini API, plus Imagen
  // and Veo under their own names.
  vertex:
    /(?:^aqs-|nano-banana|^deep-research|computer-use|^lyria|^imagen|^veo|robotics|flash-lite-preview-\d{2}-\d{4}$)/i,
  ...Object.fromEntries(
    MANAGED_FREE_PROVIDER_CONFIGS.map((config) => [config.id, config.nonChatModelPattern]),
  ),
  mistral:
    /(?:^mistral-ocr|moderation|voxtral-.*-(?:transcribe|realtime)|^labs-|^mistral-vibe-cli)/i,
  'mistral-subscription': /(?:^mistral-ocr|moderation|voxtral-.*-(?:transcribe|realtime)|^labs-)/i,
  // Groq filters:
  //  - compound family: server-side router/agent product (compound,
  //    compound-mini, compound-beta). Not a model the user picks directly,
  //    and OpenRouter's cache surfaces it with the wrong attribution if we
  //    let it through. Match start-of-string, slash-prefixed (models.dev
  //    returns `groq/compound`), and hyphen-prefixed forms.
  //  - prompt-guard: small Llama classifier, not a chat model.
  //  - orpheus: text-to-speech, not chat.
  // Note: do NOT block "safeguard" — Groq's gpt-oss-safeguard-20b is a chat
  // model the user can call.
  groq: /(?:(?:^|\/|-)compound|prompt-guard|orpheus)/i,
  fireworks:
    /(?:flux|stable-diffusion|image|embedding|rerank|speech|audio|whisper|tts|upscaler|controlnet)/i,
  nvidia:
    /(?:flux|cosmos|detector|gliner|calibration|embed|retriever|parse|tts|translate|safety|guard|reward|nvclip|vila|neva)/i,
  xiaomi: /(?:asr|tts)/i,
  'xiaomi-subscription': /(?:asr|tts)/i,
  'qwen-subscription': /(?:^qwen-image-|^wan.*image)/i,
  xai: /imagine/i,
  copilot: /accounts\/[^/]+\/routers\//i,
  bedrock: /(?:^|[./])voxtral-/i,
  pioneer: /(?:gliner|gliguard|privacy-filter|^fastino\/)/i,
};

/**
 * Exact model IDs to block per provider. Use ONLY when no regex pattern
 * or metadata field can catch the model. Document WHY each entry exists.
 */
export const PROVIDER_BLOCKLIST: Record<string, ReadonlySet<string>> = {
  'openai-subscription': new Set([
    'gpt-5.3-codex', // ChatGPT Codex returns 400: not supported with a ChatGPT account
    'gpt-5.2-codex', // ChatGPT Codex returns 400: not supported with a ChatGPT account
    'gpt-5.2', // ChatGPT Codex returns 400: not supported with a ChatGPT account
    'gpt-5.1-codex-max', // ChatGPT Codex returns 400: not supported with a ChatGPT account
    'gpt-5.1-codex', // ChatGPT Codex returns 400: not supported with a ChatGPT account
  ]),
  mistral: new Set([
    'voxtral-mini-2602', // Invalid model returned by API; not a real chat endpoint
  ]),
  'mistral-subscription': new Set([
    'voxtral-mini-2602', // Invalid model returned by API; not a real chat endpoint
  ]),
};

/** Filter models that are not compatible with chat completions. */
export function filterNonChatModels(
  models: DiscoveredModel[],
  configKey: string,
): DiscoveredModel[] {
  const providerFilter = PROVIDER_NON_CHAT[configKey];
  const blocklist = PROVIDER_BLOCKLIST[configKey];
  return models.filter((m) => {
    if (UNIVERSAL_NON_CHAT_RE.test(m.id)) return false;
    if (providerFilter && providerFilter.test(m.id)) return false;
    if (blocklist && blocklist.has(m.id)) return false;
    return true;
  });
}

function bearerHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

function pioneerHeaders(key: string): Record<string, string> {
  return { 'X-API-Key': key };
}

/* ── Provider-specific parsers ── */

interface MistralModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  capabilities?: {
    completion_chat?: boolean;
  };
  deprecation?: string | null;
}

const parseMistral = createModelParser<MistralModelEntry>({
  arrayKey: 'data',
  filter: (entry) => {
    if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
    if (entry.deprecation != null) return false;
    if (entry.capabilities && entry.capabilities.completion_chat === false) return false;
    return true;
  },
  getId: (entry) => entry.id,
  getDisplayName: (_entry, id) => id,
});

const parseMistralVibeSubscription = (body: unknown, provider: string): DiscoveredModel[] => {
  const known = new Set(getSubscriptionKnownModels('mistral') ?? []);
  return parseMistral(body, provider).filter((model) => known.has(model.id));
};

interface AnthropicModelEntry {
  id: string;
  display_name?: string;
  type?: string;
}

const parseAnthropic = createModelParser<AnthropicModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.type === 'model',
  getId: (entry) => entry.id,
  getDisplayName: (entry, id) => entry.display_name || id,
  contextWindow: ANTHROPIC_DEFAULT_CONTEXT,
});

interface GeminiModelEntry {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
}

const GEMINI_VERSION_SUFFIX_RE = /-\d{3}$/;

function parseGemini(body: unknown, provider: string): DiscoveredModel[] {
  const models = (body as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) return [];
  const parsed = models
    .filter((m: unknown) => {
      const entry = m as GeminiModelEntry;
      if (typeof entry.name !== 'string') return false;
      const methods = entry.supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes('generateContent');
    })
    .map((m: unknown) => {
      const entry = m as GeminiModelEntry;
      // name is like "models/gemini-2.5-pro" — strip prefix
      const id = entry.name.replace(/^models\//, '');
      return {
        id,
        displayName: entry.displayName || id,
        provider,
        contextWindow: entry.inputTokenLimit ?? GEMINI_DEFAULT_CONTEXT,
        inputPricePerToken: null,
        outputPricePerToken: null,
        capabilityReasoning: false,
        capabilityCode: false,
        qualityScore: 3,
      };
    });

  // Deduplicate: if both an alias (gemini-2.0-flash) and a versioned
  // variant (gemini-2.0-flash-001) exist, keep only the alias.
  const ids = new Set(parsed.map((m) => m.id));
  return parsed.filter((m) => {
    if (!GEMINI_VERSION_SUFFIX_RE.test(m.id)) return true;
    const alias = m.id.replace(GEMINI_VERSION_SUFFIX_RE, '');
    return !ids.has(alias);
  });
}

interface OpenRouterModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
}

function normalizeOpenRouterModalities(
  values: readonly string[] | undefined,
): readonly ModelModality[] | undefined {
  if (!values?.length) return undefined;
  const upstreamModalities = new Set(values.map((value) => value.toLowerCase()));
  const modalities = MODEL_MODALITIES.filter((modality) => upstreamModalities.has(modality));
  return modalities.length > 0 ? modalities : undefined;
}

interface FireworksModelEntry {
  name: string;
  displayName?: string;
  contextLength?: number;
  supportsServerless?: boolean;
  supportsTools?: boolean;
}

const parseFireworks = createModelParser<FireworksModelEntry>({
  arrayKey: 'models',
  filter: (entry) =>
    typeof entry.name === 'string' && entry.name.length > 0 && entry.supportsServerless !== false,
  getId: (entry) => entry.name,
  getDisplayName: (entry, id) => entry.displayName || id,
  contextWindow: (entry) => entry.contextLength ?? DEFAULT_CONTEXT_WINDOW,
  capabilityCode: (entry) => entry.supportsTools === true,
});

function parseOpenRouter(body: unknown, provider: string): DiscoveredModel[] {
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m: unknown) => {
      const entry = m as OpenRouterModelEntry;
      if (typeof entry.id !== 'string') return false;
      // `:batch` variants are only served through OpenRouter's async Batch API,
      // never through the synchronous chat completions proxy — listing them
      // advertises models that are guaranteed to 404.
      if (entry.id.endsWith(':batch')) return false;
      const output = entry.architecture?.output_modalities?.map((o) => o.toLowerCase());
      if (output && output.length > 0 && !output.every((o) => o === 'text')) {
        return false;
      }
      return true;
    })
    .map((m: unknown) => {
      const entry = m as OpenRouterModelEntry;
      const prompt = entry.pricing?.prompt ? Number(entry.pricing.prompt) : null;
      const completion = entry.pricing?.completion ? Number(entry.pricing.completion) : null;
      const inputModalities = normalizeOpenRouterModalities(entry.architecture?.input_modalities);
      const outputModalities = normalizeOpenRouterModalities(entry.architecture?.output_modalities);
      return {
        id: entry.id,
        displayName: entry.name || entry.id,
        provider,
        contextWindow: entry.context_length ?? DEFAULT_CONTEXT_WINDOW,
        inputPricePerToken:
          prompt !== null && Number.isFinite(prompt) && prompt >= 0 ? prompt : null,
        outputPricePerToken:
          completion !== null && Number.isFinite(completion) && completion >= 0 ? completion : null,
        capabilityReasoning: false,
        capabilityCode: false,
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
        qualityScore: 3,
      };
    });
}

interface KiloModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { output_modalities?: string[] };
  top_provider?: { context_length?: number };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

function parseKilo(body: unknown, provider: string): DiscoveredModel[] {
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m: unknown) => {
      const entry = m as KiloModelEntry;
      if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
      const output = entry.architecture?.output_modalities?.map((o) => o.toLowerCase());
      if (output && output.length > 0 && !output.every((o) => o === 'text')) {
        return false;
      }
      return true;
    })
    .map((m: unknown) => {
      const entry = m as KiloModelEntry;
      const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
      const prompt = entry.pricing?.prompt ? Number(entry.pricing.prompt) : null;
      const completion = entry.pricing?.completion ? Number(entry.pricing.completion) : null;
      return {
        id: entry.id,
        displayName: entry.name || entry.id,
        provider,
        contextWindow:
          entry.context_length ?? entry.top_provider?.context_length ?? DEFAULT_CONTEXT_WINDOW,
        inputPricePerToken:
          prompt !== null && Number.isFinite(prompt) && prompt >= 0 ? prompt : null,
        outputPricePerToken:
          completion !== null && Number.isFinite(completion) && completion >= 0 ? completion : null,
        capabilityReasoning:
          supported.includes('reasoning') || supported.includes('include_reasoning'),
        capabilityCode: supported.includes('tools'),
        qualityScore: 3,
      };
    });
}

interface OllamaModelEntry {
  name: string;
  details?: { family?: string; parameter_size?: string };
}

const parseOllama = createModelParser<OllamaModelEntry>({
  arrayKey: 'models',
  filter: (entry) => typeof entry.name === 'string',
  getId: (entry) => entry.name.replace(/:latest$/, ''),
  getDisplayName: (_entry, id) => id,
  inputPricePerToken: 0,
  outputPricePerToken: 0,
  qualityScore: 2,
});

/* ── OpenAI subscription (Codex CLI models API) ── */

interface OpenAISubscriptionModelEntry {
  slug: string;
  display_name?: string;
  context_window?: number;
  visibility?: string;
  supported_in_api?: boolean;
}

const parseOpenaiSubscription = createModelParser<OpenAISubscriptionModelEntry>({
  arrayKey: 'models',
  filter: (entry) => typeof entry.slug === 'string' && entry.visibility === 'list',
  getId: (entry) => entry.slug,
  getDisplayName: (entry, id) => entry.display_name || id,
  contextWindow: (entry) => entry.context_window ?? 200000,
  contextWindowSource: (entry) =>
    typeof entry.context_window === 'number' ? 'provider' : 'subscription_config',
  inputPricePerToken: 0,
  outputPricePerToken: 0,
  capabilityCode: true,
});

/* ── GitHub Copilot (subscription-only, OpenAI-compatible /models) ── */

interface CopilotTokenPriceTier {
  input_price?: unknown;
  output_price?: unknown;
  cache_price?: unknown;
  cache_read_price?: unknown;
  cache_write_price?: unknown;
  context_max?: unknown;
  max_prompt_tokens?: unknown;
}

interface CopilotModelEntry extends OpenAIModelEntry {
  billing?: {
    token_prices?: {
      batch_size?: unknown;
      default?: CopilotTokenPriceTier;
      long_context?: CopilotTokenPriceTier;
    };
  };
}

function copilotUsdPerToken(price: unknown, batchSize: unknown): number | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  const tokenBatchSize = batchSize ?? 1_000_000;
  if (
    typeof tokenBatchSize !== 'number' ||
    !Number.isFinite(tokenBatchSize) ||
    tokenBatchSize <= 0
  ) {
    return null;
  }
  return (price * COPILOT_AI_CREDIT_USD) / tokenBatchSize;
}

function copilotContextMax(tier: CopilotTokenPriceTier | undefined): number | null {
  const value = tier?.context_max ?? tier?.max_prompt_tokens;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function copilotPriceTier(
  tier: CopilotTokenPriceTier | undefined,
  batchSize: unknown,
): Omit<NonNullable<DiscoveredModel['longContextPricing']>, 'thresholdTokens'> | null {
  const inputPricePerToken = copilotUsdPerToken(tier?.input_price, batchSize);
  const outputPricePerToken = copilotUsdPerToken(tier?.output_price, batchSize);
  if (inputPricePerToken === null || outputPricePerToken === null) return null;

  const cacheReadPricePerToken = copilotUsdPerToken(
    tier?.cache_read_price ?? tier?.cache_price,
    batchSize,
  );
  const cacheWritePricePerToken = copilotUsdPerToken(tier?.cache_write_price, batchSize);
  return {
    inputPricePerToken,
    outputPricePerToken,
    ...(cacheReadPricePerToken !== null ? { cacheReadPricePerToken } : {}),
    ...(cacheWritePricePerToken !== null ? { cacheWritePricePerToken } : {}),
  };
}

function parseCopilot(body: unknown, provider: string): DiscoveredModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((raw): DiscoveredModel[] => {
    const entry = raw as CopilotModelEntry;
    if (typeof entry.id !== 'string' || entry.id.length === 0) return [];

    const tokenPrices = entry.billing?.token_prices;
    const defaultPricing = copilotPriceTier(tokenPrices?.default, tokenPrices?.batch_size);
    const longContextThreshold = copilotContextMax(tokenPrices?.default);
    const longContextTier = copilotPriceTier(tokenPrices?.long_context, tokenPrices?.batch_size);
    const longContextPricing =
      defaultPricing && longContextTier && longContextThreshold
        ? { thresholdTokens: longContextThreshold, ...longContextTier }
        : null;
    const contextWindow =
      copilotContextMax(tokenPrices?.long_context) ??
      longContextThreshold ??
      DEFAULT_CONTEXT_WINDOW;
    const supportedEndpoints = getStringArray(entry.supported_endpoints);

    return [
      {
        id: `copilot/${entry.id}`,
        displayName: entry.id,
        provider,
        contextWindow,
        inputPricePerToken: defaultPricing?.inputPricePerToken ?? 0,
        outputPricePerToken: defaultPricing?.outputPricePerToken ?? 0,
        ...(defaultPricing?.cacheReadPricePerToken !== undefined
          ? { cacheReadPricePerToken: defaultPricing.cacheReadPricePerToken }
          : {}),
        ...(defaultPricing?.cacheWritePricePerToken !== undefined
          ? { cacheWritePricePerToken: defaultPricing.cacheWritePricePerToken }
          : {}),
        ...(longContextPricing ? { longContextPricing } : {}),
        capabilityReasoning: false,
        capabilityCode: false,
        ...(supportedEndpoints ? { supportedEndpoints } : {}),
        qualityScore: 3,
      },
    ];
  });
}

/* ── OpenCode Zen (aggregator, OpenAI-compatible /models) ── */

// Prefix every Zen catalog entry with `opencode-zen/` so the discovered model
// remains an explicit route through the Zen gateway. Forwarding strips the
// prefix before calling Zen, while provider inference and legacy provider-less
// lookups can still distinguish Zen models from the same native IDs exposed by
// directly-connected providers.
const parseOpencodeZen = createModelParser<OpenAIModelEntry>({
  arrayKey: 'data',
  filter: (entry) => typeof entry.id === 'string' && entry.id.length > 0,
  getId: (entry) => `opencode-zen/${entry.id}`,
  getDisplayName: (entry) => entry.id,
});

/* ── Provider configs ── */

const MANAGED_FREE_FETCHER_CONFIGS: Record<string, FetcherConfig> = Object.fromEntries(
  MANAGED_FREE_PROVIDER_CONFIGS.map((config) => [
    config.id,
    {
      endpoint: (_key: string) => getManagedFreeLiteLlmModelsUrl(),
      buildHeaders: bearerHeaders,
      parse: (body: unknown, provider: string) => parseManagedFreeLiteLlm(body, provider, config),
    },
  ]),
);

export const PROVIDER_CONFIGS: Record<string, FetcherConfig> = {
  openai: {
    endpoint: 'https://api.openai.com/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAIDeduped,
  },
  'openai-subscription': {
    endpoint: `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`,
    buildHeaders: (key: string) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      originator: CODEX_CLI_ORIGINATOR,
      'user-agent': CODEX_CLI_USER_AGENT,
    }),
    parse: parseOpenaiSubscription,
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  edenai: {
    endpoint: 'https://api.edenai.run/v3/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  byteplus: {
    endpoint: BYTEPLUS_CODING_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseBytePlusCodingPlan,
  },
  commandcode: {
    endpoint: COMMAND_CODE_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseCommandCode,
  },
  cerebras: {
    endpoint: 'https://api.cerebras.ai/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  huggingface: {
    endpoint: HUGGING_FACE_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseHuggingFace,
  },
  fireworks: {
    endpoint: FIREWORKS_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseFireworks,
  },
  kilo: {
    endpoint: `${KILO_GATEWAY_BASE}/models`,
    buildHeaders: bearerHeaders,
    parse: parseKilo,
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseMistral,
  },
  'mistral-subscription': {
    endpoint: 'https://api.mistral.ai/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseMistralVibeSubscription,
  },
  moonshot: {
    endpoint: 'https://api.moonshot.ai/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  pioneer: {
    endpoint: PIONEER_MODELS_URL,
    buildHeaders: pioneerHeaders,
    parse: parsePioneer,
  },
  nous: {
    endpoint: NOUS_PORTAL_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseOpenRouter,
  },
  nvidia: {
    endpoint: 'https://integrate.api.nvidia.com/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAIDedupedById,
  },
  xai: {
    endpoint: 'https://api.x.ai/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  minimax: {
    endpoint: 'https://api.minimaxi.chat/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  meta: {
    endpoint: META_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseMeta,
  },
  'minimax-subscription': {
    endpoint: MINIMAX_SUBSCRIPTION_MODELS_URL,
    buildHeaders: (key: string) => ({
      Authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
    }),
    parse: parseAnthropic,
  },
  xiaomi: {
    endpoint: XIAOMI_MIMO_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseXiaomiMimo,
  },
  'xiaomi-subscription': {
    endpoint: XIAOMI_TOKEN_PLAN_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseXiaomiMimo,
  },
  qwen: {
    endpoint: `${getQwenCompatibleBaseUrl('beijing')}/v1/models`,
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  'qwen-subscription': {
    endpoint: QWEN_TOKEN_PLAN_MODELS_URL,
    buildHeaders: bearerHeaders,
    parse: parseQwenTokenPlan,
  },
  zai: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/models',
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  'zai-subscription': {
    endpoint: `${getZaiCodingPlanBaseUrl('global')}/models`,
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/models?limit=100',
    buildHeaders: (key: string, authType?: string) => {
      const headers: Record<string, string> = {
        'anthropic-version': '2023-06-01',
      };
      if (authType === 'subscription') {
        return buildClaudeCodeSubscriptionHeaders(key);
      } else {
        headers['x-api-key'] = key;
      }
      return headers;
    },
    parse: parseAnthropic,
  },
  bedrock: {
    endpoint: `${getBedrockMantleBaseUrl()}/v1/models`,
    buildHeaders: bearerHeaders,
    parse: parseOpenAI,
  },
  gemini: {
    endpoint: (key: string) =>
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    buildHeaders: () => ({}),
    parse: parseGemini,
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/models',
    buildHeaders: () => ({}),
    parse: parseOpenRouter,
  },
  ...MANAGED_FREE_FETCHER_CONFIGS,
  ollama: {
    endpoint: `${OLLAMA_HOST}/api/tags`,
    buildHeaders: () => ({}),
    parse: parseOllama,
  },
  'ollama-cloud': {
    endpoint: `${OLLAMA_CLOUD_HOST}/api/tags`,
    buildHeaders: bearerHeaders,
    parse: parseOllama,
  },
  copilot: {
    endpoint: 'https://api.githubcopilot.com/models',
    buildHeaders: (key: string) => ({
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
    }),
    parse: parseCopilot,
  },
  'opencode-zen': {
    endpoint: 'https://opencode.ai/zen/v1/models',
    buildHeaders: bearerHeaders,
    parse: parseOpencodeZen,
  },
};

const OPENCODE_GO_CONTEXT_WINDOW = 200000;

export interface ProviderModelFetchOptions {
  forceRefresh?: boolean;
}

@Injectable()
export class ProviderModelFetcherService {
  private readonly logger = new Logger(ProviderModelFetcherService.name);

  constructor(
    @Optional()
    @Inject(OpencodeGoCatalogService)
    private readonly opencodeGoCatalog: OpencodeGoCatalogService | null = null,
  ) {}

  async fetch(
    providerId: string,
    apiKey: string,
    authType?: string,
    endpointOverride?: string,
    options?: ProviderModelFetchOptions,
  ): Promise<DiscoveredModel[]> {
    let configKey = providerId.toLowerCase();
    // OpenAI subscription tokens use a different models endpoint
    if (configKey === 'openai' && authType === 'subscription') {
      configKey = 'openai-subscription';
    } else if (configKey === 'minimax' && authType === 'subscription') {
      configKey = 'minimax-subscription';
    } else if (configKey === 'mistral' && authType === 'subscription') {
      configKey = 'mistral-subscription';
    } else if (configKey === 'xiaomi' && authType === 'subscription') {
      configKey = 'xiaomi-subscription';
    } else if (configKey === 'moonshot' && authType === 'subscription') {
      // Kimi Code documents a fixed subscription model catalog rather than a
      // subscription-scoped /models endpoint.
      return [];
    } else if (configKey === 'qwen' && authType === 'subscription') {
      configKey = 'qwen-subscription';
    } else if (configKey === 'zai' && authType === 'subscription') {
      configKey = 'zai-subscription';
    } else if (configKey === 'opencode-go') {
      return this.fetchOpencodeGoModels(apiKey, options?.forceRefresh === true);
    } else if (configKey === 'cline-pass') {
      return this.fetchClinePassKnownModels();
    } else if (configKey === 'gemini' && authType === 'subscription') {
      // CodeAssist (`cloudcode-pa.googleapis.com`) does not expose a
      // `/models` endpoint; the discovery fallback chain pulls Gemini
      // models from the OpenRouter cache instead.
      return [];
    } else if (configKey === 'kiro') {
      return this.fetchKiroModels(apiKey);
    }
    const config = PROVIDER_CONFIGS[configKey];
    if (!config) {
      this.logger.warn(`No fetcher config for provider: ${providerId}`);
      return [];
    }

    if (configKey === 'fireworks') {
      return this.fetchFireworksModels(config, apiKey, providerId);
    }
    if (configKey === 'pioneer') {
      return this.fetchPioneerModels(config, apiKey, providerId, authType);
    }

    let url = typeof config.endpoint === 'function' ? config.endpoint(apiKey) : config.endpoint;
    if (endpointOverride && configKey === 'minimax-subscription') {
      const minimaxBaseUrl = normalizeMinimaxSubscriptionBaseUrl(endpointOverride);
      if (minimaxBaseUrl) {
        url = `${minimaxBaseUrl}/models?limit=100`;
      } else {
        this.logger.warn('Ignoring invalid MiniMax subscription endpoint override');
      }
    } else if (endpointOverride && configKey === 'bedrock') {
      const bedrockBaseUrl = normalizeBedrockMantleBaseUrl(endpointOverride);
      if (bedrockBaseUrl) {
        url = `${bedrockBaseUrl}/v1/models`;
      } else {
        this.logger.warn('Ignoring invalid AWS Bedrock endpoint override');
      }
    } else if (endpointOverride && (configKey === 'qwen' || configKey === 'qwen-subscription')) {
      const qwenBaseUrl = normalizeQwenCompatibleBaseUrl(endpointOverride);
      if (qwenBaseUrl) {
        url = `${qwenBaseUrl}/v1/models`;
      } else {
        this.logger.warn('Ignoring invalid Qwen endpoint override');
      }
    } else if (endpointOverride && configKey === 'zai-subscription') {
      const zaiBaseUrl = normalizeZaiCodingPlanBaseUrl(endpointOverride);
      if (zaiBaseUrl) {
        url = `${zaiBaseUrl}/models`;
      } else {
        this.logger.warn('Ignoring invalid Z.ai subscription endpoint override');
      }
    } else if (endpointOverride && configKey === 'xiaomi-subscription') {
      const xiaomiBaseUrl = normalizeXiaomiTokenPlanBaseUrl(endpointOverride);
      if (xiaomiBaseUrl) {
        url = `${xiaomiBaseUrl}/v1/models`;
      } else {
        this.logger.warn('Ignoring invalid Xiaomi MiMo Token Plan endpoint override');
      }
    }

    const headers = config.buildHeaders(apiKey, authType);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(
          `Provider ${providerId} returned ${res.status} from ${url.replace(apiKey, '***')}`,
        );
        return [];
      }

      const body = await res.json();
      return filterNonChatModels(config.parse(body, providerId), configKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch models from ${providerId}: ${message}`);
      return [];
    }
  }

  private async fetchFireworksModels(
    config: FetcherConfig,
    apiKey: string,
    providerId: string,
  ): Promise<DiscoveredModel[]> {
    const headers = config.buildHeaders(apiKey);
    const all: DiscoveredModel[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    const seenPageTokens = new Set<string>();

    try {
      do {
        if (pageToken) {
          if (seenPageTokens.has(pageToken)) {
            this.logger.warn(
              `Stopping Fireworks model pagination after repeated token ${pageToken}`,
            );
            break;
          }
          seenPageTokens.add(pageToken);
        }

        const url = this.buildFireworksModelsUrl(pageToken);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timeout);
        pageCount += 1;

        if (!res.ok) {
          this.logger.warn(`Provider ${providerId} returned ${res.status} from ${url}`);
          return [];
        }

        const body = await res.json();
        all.push(...config.parse(body, providerId));
        const nextPageToken = (body as { nextPageToken?: unknown })?.nextPageToken;
        pageToken =
          typeof nextPageToken === 'string' && nextPageToken.length > 0 ? nextPageToken : undefined;
        if (pageToken && pageCount >= FIREWORKS_MODELS_MAX_PAGES) {
          this.logger.warn(
            `Stopping Fireworks model pagination after ${FIREWORKS_MODELS_MAX_PAGES} pages`,
          );
          pageToken = undefined;
        }
      } while (pageToken);

      return filterNonChatModels(all, 'fireworks');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch models from ${providerId}: ${message}`);
      return [];
    }
  }

  private buildFireworksModelsUrl(pageToken?: string): string {
    const params = new URLSearchParams({
      filter: 'supports_serverless=true',
      pageSize: String(FIREWORKS_MODELS_PAGE_SIZE),
    });
    if (pageToken) params.set('pageToken', pageToken);
    return `${FIREWORKS_MODELS_URL}?${params.toString()}`;
  }

  private async fetchPioneerModels(
    config: FetcherConfig,
    apiKey: string,
    providerId: string,
    authType?: string,
  ): Promise<DiscoveredModel[]> {
    const headers = config.buildHeaders(apiKey, authType);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(PIONEER_MODELS_URL, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(
          `Provider ${providerId} returned ${res.status} from ${PIONEER_MODELS_URL}`,
        );
        return [];
      }

      const models = config.parse(await res.json(), providerId);
      const catalog = await this.fetchPioneerBaseCatalog();
      return filterNonChatModels(enrichPioneerModels(models, catalog), 'pioneer');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch models from ${providerId}: ${message}`);
      return [];
    }
  }

  private async fetchPioneerBaseCatalog(): Promise<Map<string, PioneerBaseModelEntry>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(PIONEER_BASE_MODELS_URL, { signal: controller.signal });
      if (!res.ok) {
        this.logger.warn(`Pioneer base model catalog returned ${res.status}`);
        return new Map();
      }
      return parsePioneerBaseCatalog(await res.json());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch Pioneer base model catalog: ${message}`);
      return new Map();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchOpencodeGoModels(
    apiKey: string,
    forceRefresh = false,
  ): Promise<DiscoveredModel[]> {
    const live = await this.fetchOpencodeGoLiveModels(apiKey);
    if (live.length > 0) return live;
    return this.fetchOpencodeGoDocsCatalog(forceRefresh);
  }

  private async fetchOpencodeGoLiveModels(apiKey: string): Promise<DiscoveredModel[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(OPENCODE_GO_MODELS_URL, {
        headers: apiKey ? bearerHeaders(apiKey) : {},
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`OpenCode Go returned ${res.status} from ${OPENCODE_GO_MODELS_URL}`);
        return [];
      }

      const body = await res.json();
      const models = parseOpenAI(body, 'opencode-go').map((model) => {
        const id = `opencode-go/${model.id}`;
        return {
          ...model,
          id,
          displayName: id,
          provider: 'opencode-go',
          contextWindow: OPENCODE_GO_CONTEXT_WINDOW,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityReasoning: true,
          capabilityCode: true,
        };
      });
      return filterNonChatModels(models, 'opencode-go');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch OpenCode Go models: ${message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchOpencodeGoDocsCatalog(forceRefresh = false): Promise<DiscoveredModel[]> {
    if (!this.opencodeGoCatalog) return [];
    const entries = forceRefresh
      ? await this.opencodeGoCatalog.refresh()
      : await this.opencodeGoCatalog.list();
    return entries.map((entry) => ({
      id: `opencode-go/${entry.id}`,
      displayName: entry.displayName,
      provider: 'opencode-go',
      contextWindow: OPENCODE_GO_CONTEXT_WINDOW,
      inputPricePerToken: 0,
      outputPricePerToken: 0,
      capabilityReasoning: true,
      capabilityCode: true,
      qualityScore: 3,
    }));
  }

  private async fetchKiroModels(apiKey: string): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    let nextToken: string | undefined;

    try {
      for (let page = 0; page < 10; page += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(KIRO_BASE_URL, {
            method: 'POST',
            headers: buildKiroHeaders(apiKey, KIRO_MODELS_TARGET),
            body: JSON.stringify({
              origin: 'KIRO_CLI',
              maxResults: 100,
              ...(nextToken ? { nextToken } : {}),
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!res.ok) {
          this.logger.warn(`Provider kiro returned ${res.status} from ${KIRO_BASE_URL}`);
          return [];
        }

        const body = await res.json();
        models.push(...parseKiroModels(body, 'kiro'));
        const maybeNextToken = (body as { nextToken?: unknown; next_token?: unknown }).nextToken;
        const snakeNextToken = (body as { next_token?: unknown }).next_token;
        nextToken =
          typeof maybeNextToken === 'string'
            ? maybeNextToken
            : typeof snakeNextToken === 'string'
              ? snakeNextToken
              : undefined;
        if (!nextToken) break;
      }

      return filterNonChatModels(models, 'kiro');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch models from kiro: ${message}`);
      return [];
    }
  }

  private fetchClinePassKnownModels(): DiscoveredModel[] {
    const known = getSubscriptionKnownModels('cline-pass') ?? [];
    const contextWindow =
      getSubscriptionCapabilities('cline-pass')?.maxContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    return known.map((id) => ({
      id,
      displayName: id,
      provider: 'cline-pass',
      contextWindow,
      inputPricePerToken: null,
      outputPricePerToken: null,
      capabilityReasoning: true,
      capabilityCode: true,
      qualityScore: 3,
    }));
  }
}
