import { getBedrockInferenceProfileBaseModelId } from './bedrock-region';

export type BedrockRuntimeApi = 'chat_completions' | 'responses' | 'messages' | 'converse';

export type BedrockRuntimeChatTokenParameter = 'max_tokens' | 'max_completion_tokens';

export interface BedrockRuntimeModelCapabilities {
  /** Exact Bedrock foundation-model ID, without a geographic profile prefix. */
  modelId: string;
  /** APIs verified on the bedrock-runtime endpoint. */
  apis: readonly BedrockRuntimeApi[];
  chatTokenParameter?: BedrockRuntimeChatTokenParameter;
  /** AWS model card used to verify the endpoint-specific API contract. */
  sourceUrl: string;
  /** ISO date when the model card and live behavior were last checked. */
  verifiedAt: string;
}

const AWS_BEDROCK_DOCS = 'https://docs.aws.amazon.com/bedrock/latest/userguide';
const VERIFIED_AT = '2026-09-26';

/**
 * Endpoint-specific capability facts that the Bedrock control plane does not
 * expose. Keep this exact-ID catalog conservative: an unknown model stays out
 * of Manifest's OpenAI-compatible catalog until its Runtime APIs are verified.
 */
export const BEDROCK_RUNTIME_CAPABILITY_CATALOG = [
  {
    modelId: 'moonshotai.kimi-k3',
    apis: ['chat_completions', 'responses', 'converse'],
    chatTokenParameter: 'max_tokens',
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-moonshot-ai-kimi-k3.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'moonshotai.kimi-k2.5',
    apis: ['chat_completions', 'converse'],
    chatTokenParameter: 'max_tokens',
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-moonshot-ai-kimi-k2-5.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'moonshotai.kimi-k2-thinking',
    apis: ['converse'],
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-moonshot-ai-kimi-k2-thinking.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-6-astra',
    apis: ['chat_completions', 'responses', 'converse'],
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-openai-gpt-6-astra.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-6-sol',
    apis: ['chat_completions', 'responses'],
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-openai-gpt-6-sol.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-6-luna',
    apis: ['chat_completions', 'responses'],
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-openai-gpt-6-luna.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-5.6-luna',
    apis: ['chat_completions', 'responses', 'converse'],
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_BEDROCK_DOCS}/model-card-openai-gpt-56-luna.html`,
    verifiedAt: VERIFIED_AT,
  },
] as const satisfies readonly BedrockRuntimeModelCapabilities[];

// Keyed by the EXACT foundation-model ID. The catalog is a safety contract:
// an entry certifies verified Runtime APIs for that precise ID, so the lookup
// must be case-sensitive. A mis-cased or otherwise unverified ID must miss the
// catalog (and be treated as unknown) rather than inherit another model's
// verified capabilities and slip past the local M304 guard.
const CAPABILITIES_BY_MODEL = new Map<string, BedrockRuntimeModelCapabilities>(
  BEDROCK_RUNTIME_CAPABILITY_CATALOG.map((entry) => [entry.modelId, entry]),
);

/** Strip only the geographic profile prefix; preserve the base model ID casing. */
function baseModelId(modelOrProfileId: string): string {
  return getBedrockInferenceProfileBaseModelId(modelOrProfileId) ?? modelOrProfileId;
}

export function getBedrockRuntimeCapabilities(
  modelOrProfileId: string,
): BedrockRuntimeModelCapabilities | null {
  return CAPABILITIES_BY_MODEL.get(baseModelId(modelOrProfileId)) ?? null;
}

/** True when the exact model ID has a verified capability-catalog entry. */
export function isBedrockRuntimeModelCatalogued(modelOrProfileId: string): boolean {
  return getBedrockRuntimeCapabilities(modelOrProfileId) !== null;
}

export function bedrockRuntimeSupportsApi(
  modelOrProfileId: string,
  api: BedrockRuntimeApi,
): boolean {
  return getBedrockRuntimeCapabilities(modelOrProfileId)?.apis.includes(api) === true;
}

export function bedrockRuntimeOpenAiEndpoints(modelOrProfileId: string): string[] {
  const capabilities = getBedrockRuntimeCapabilities(modelOrProfileId);
  if (!capabilities) return [];
  const endpoints: string[] = [];
  if (capabilities.apis.includes('chat_completions')) endpoints.push('/v1/chat/completions');
  if (capabilities.apis.includes('responses')) endpoints.push('/v1/responses');
  return endpoints;
}

export function isBedrockRuntimeOpenAiCompatible(modelOrProfileId: string): boolean {
  return bedrockRuntimeOpenAiEndpoints(modelOrProfileId).length > 0;
}
