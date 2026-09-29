import { getBedrockInferenceProfileBaseModelId } from './bedrock-region';

/** A Manifest API that a model serves on Bedrock Runtime. */
export type BedrockRuntimeApi = 'chat_completions' | 'responses';

/**
 * A model verified on Bedrock Runtime. Bedrock does not publish which APIs a
 * model serves there, so each entry is checked against its AWS model card and a
 * live call before it is added.
 */
export interface BedrockRuntimeCapabilities {
  /** Exact base model ID. Lookups are case-sensitive. */
  modelId: string;
  /**
   * Every entry must list both APIs: Manifest keeps the agent's API on Runtime
   * and does not convert between them there.
   */
  apis: readonly BedrockRuntimeApi[];
  /** Chat Completions output cap the model accepts; GPT models reject `max_tokens`. */
  chatTokenParameter: 'max_tokens' | 'max_completion_tokens';
  /** AWS model card listing the model's Runtime APIs. */
  sourceUrl: string;
  /** Date the entry was checked live on Runtime. */
  verifiedAt: string;
}

const AWS_MODEL_CARDS = 'https://docs.aws.amazon.com/bedrock/latest/userguide';
const VERIFIED_AT = '2026-09-28';
const CHAT_AND_RESPONSES: readonly BedrockRuntimeApi[] = ['chat_completions', 'responses'];

export const BEDROCK_RUNTIME_CAPABILITY_CATALOG: readonly BedrockRuntimeCapabilities[] = [
  {
    modelId: 'moonshotai.kimi-k3',
    apis: CHAT_AND_RESPONSES,
    chatTokenParameter: 'max_tokens',
    sourceUrl: `${AWS_MODEL_CARDS}/model-card-moonshot-ai-kimi-k3.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-6-astra',
    apis: CHAT_AND_RESPONSES,
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_MODEL_CARDS}/model-card-openai-gpt-6-astra.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-6-sol',
    apis: CHAT_AND_RESPONSES,
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_MODEL_CARDS}/model-card-openai-gpt-6-sol.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-6-luna',
    apis: CHAT_AND_RESPONSES,
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_MODEL_CARDS}/model-card-openai-gpt-6-luna.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    modelId: 'openai.gpt-5.6-luna',
    apis: CHAT_AND_RESPONSES,
    chatTokenParameter: 'max_completion_tokens',
    sourceUrl: `${AWS_MODEL_CARDS}/model-card-openai-gpt-56-luna.html`,
    verifiedAt: VERIFIED_AT,
  },
];

const CATALOG_BY_MODEL_ID = new Map(
  BEDROCK_RUNTIME_CAPABILITY_CATALOG.map((entry) => [entry.modelId, entry]),
);

const MANIFEST_ENDPOINT_BY_API: Record<BedrockRuntimeApi, string> = {
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
};

/**
 * Runtime capabilities of a CRIS profile whose base model is in the catalog.
 * Null for anything else, including base model IDs, which Mantle serves.
 */
export function getBedrockRuntimeCapabilities(model: string): BedrockRuntimeCapabilities | null {
  const baseModelId = getBedrockInferenceProfileBaseModelId(model);
  return baseModelId === null ? null : (CATALOG_BY_MODEL_ID.get(baseModelId) ?? null);
}

/** Manifest endpoints that serve a catalogued CRIS profile, for model discovery. */
export function getBedrockRuntimeSupportedEndpoints(model: string): string[] {
  return (
    getBedrockRuntimeCapabilities(model)?.apis.map((api) => MANIFEST_ENDPOINT_BY_API[api]) ?? []
  );
}
