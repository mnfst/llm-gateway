import { PROVIDER_BY_ID_OR_ALIAS } from '../common/constants/providers';
import { resolveMetadataEntry } from './metadata-identity';
import { MODEL_MODALITIES } from 'manifest-shared';
import type { AuthType, ModelCapability, ModelModality } from 'manifest-shared';
import type { DiscoveredModel } from './model-fetcher';
import type { ModelsDevModelEntry } from '../database/models-dev-sync.service';
import { lookupKnownModalities } from './known-model-modalities';

type RawModalities = { input?: string[]; output?: string[] } | undefined;

const DEFAULT_MODALITIES: readonly ModelModality[] = ['text'];

const STREAMING_ENDPOINT_PROVIDERS = new Set([
  'anthropic',
  'byteplus',
  'commandcode',
  'copilot',
  'deepseek',
  'fireworks',
  'gemini',
  'groq',
  'huggingface',
  'minimax',
  'mistral',
  'moonshot',
  'nvidia',
  'ollama',
  'ollama-cloud',
  'openai',
  'opencode-go',
  'opencode-zen',
  'openrouter',
  'qwen',
  'xai',
  'xiaomi',
  'zai',
]);

/**
 * Parse an upstream modality list (a provider's /models response, models.dev)
 * into known modalities in canonical order. Unknown values are ignored;
 * returns undefined when nothing is recognised, which callers read as unknown.
 */
export function parseModalities(value: unknown): readonly ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const upstream = new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.toLowerCase()),
  );
  const modalities = MODEL_MODALITIES.filter((modality) => upstream.has(modality));
  return modalities.length > 0 ? modalities : undefined;
}

export interface ModelModalities {
  input: readonly ModelModality[];
  output: readonly ModelModality[];
}

export function mergeModelCapabilities(
  ...capabilityLists: Array<readonly ModelCapability[] | null | undefined>
): readonly ModelCapability[] | undefined {
  const merged: ModelCapability[] = [];
  const seen = new Set<ModelCapability>();
  for (const capabilities of capabilityLists) {
    for (const capability of capabilities ?? []) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      merged.push(capability);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

export function modelModalitiesFromModelsDev(modalities: RawModalities): ModelModalities {
  return {
    input: normalizeModalities(modalities?.input),
    output: normalizeModalities(modalities?.output),
  };
}

export function inputModalitiesFromCapabilities(
  capabilities: readonly ModelCapability[] | null | undefined,
): readonly ModelModality[] {
  const out: ModelModality[] = ['text'];
  for (const capability of capabilities ?? []) {
    if (capability === 'text' || capability === 'stream' || capability === 'tools') continue;
    if (!out.includes(capability)) out.push(capability);
  }
  return out;
}

export function capabilitiesFromModelsDev(
  providerId: string,
  modelId: string,
  modalities: RawModalities,
  toolCall: boolean | undefined,
): readonly ModelCapability[] {
  const out: ModelCapability[] = [];
  const add = (capability: ModelCapability) => {
    if (!out.includes(capability)) out.push(capability);
  };
  const normalized = modelModalitiesFromModelsDev(modalities);
  for (const modality of [...normalized.input, ...normalized.output]) add(modality);
  if (toolCall === true) add('tools');
  if (modelSupportsStreaming(providerId, modelId)) add('stream');
  return out;
}

export interface ResolvedCapabilityMetadata {
  capabilities?: readonly ModelCapability[];
  inputModalities?: readonly ModelModality[];
  outputModalities?: readonly ModelModality[];
  modelsDevEntry: ModelsDevModelEntry | null;
}

/**
 * Resolve a discovered model's capability metadata the way the dashboard's
 * model picker does: merge discovery-time capabilities with the curated
 * param-spec catalog, a live models.dev lookup, and the streaming heuristic.
 * Shared by the routing `available-models` endpoint and the
 * `/v1/models?capabilities=true` proxy projection so both surfaces report the
 * same facts. Fields stay undefined when no source knows them — callers, not
 * this resolver, decide whether to default unknowns for display.
 */
export async function resolveModelCapabilityMetadata(
  model: DiscoveredModel,
  paramSpecs: {
    getCapabilities(
      providerId: string | undefined,
      authType: AuthType | undefined,
      model: string | undefined,
    ): Promise<readonly ModelCapability[] | null>;
  },
  modelsDevSync: {
    lookupModelCapabilities(providerId: string, modelId: string): ModelsDevModelEntry | null;
  },
): Promise<ResolvedCapabilityMetadata> {
  const specCapabilities = await paramSpecs.getCapabilities(
    model.provider,
    model.authType ?? 'api_key',
    model.id,
  );
  // Some routable ids proxy another provider's model namespace (gateway ids,
  // Bedrock vendor-prefixed ids). Resolve that provenance for metadata only.
  // Capability-only providers (Kilo, Pioneer, Cline Pass, Xiaomi, OpenRouter)
  // resolve here too; every field read off this entry is capability metadata or
  // a display name, never a price.
  const { metadata, entry: modelsDevEntry } = resolveMetadataEntry(
    model.provider,
    model.id,
    (providerId, modelId) => modelsDevSync.lookupModelCapabilities(providerId, modelId),
  );
  const metadataProvider = metadata.provider ?? model.provider;
  // Modalities the provider stated in its own /models response win; models.dev
  // fills gaps. Curated facts are the last resort, and applying them here (not
  // only at discovery time) means stale cached_models still resolve correctly.
  const known = lookupKnownModalities(metadataProvider, metadata.model);
  return {
    capabilities: mergeModelCapabilities(
      model.capabilities,
      modelsDevEntry?.capabilities,
      specCapabilities,
      modelSupportsStreaming(metadataProvider, metadata.model) ? ['stream'] : undefined,
      known?.capabilities,
    ),
    inputModalities: model.inputModalities ?? modelsDevEntry?.inputModalities ?? known?.input,
    outputModalities: model.outputModalities ?? modelsDevEntry?.outputModalities ?? known?.output,
    modelsDevEntry,
  };
}

export function modelSupportsStreaming(providerId: string, modelId: string): boolean {
  const provider = resolveProviderId(providerId);
  if (provider.startsWith('custom:')) return true;
  if (!STREAMING_ENDPOINT_PROVIDERS.has(provider)) return false;
  if (provider === 'openai' && isOpenAiNonStreamingModel(modelId)) return false;
  return true;
}

function resolveProviderId(providerId: string): string {
  const lower = providerId.toLowerCase();
  const entry = PROVIDER_BY_ID_OR_ALIAS.get(lower);
  return entry?.id ?? lower;
}

function normalizeModalities(values: readonly string[] | undefined): readonly ModelModality[] {
  return parseModalities(values) ?? DEFAULT_MODALITIES;
}

function isOpenAiNonStreamingModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes('image') ||
    lower.includes('tts') ||
    lower.includes('whisper') ||
    lower.includes('transcribe') ||
    lower.includes('embedding')
  );
}
