import { getBedrockInferenceProfileBaseModelId } from './bedrock-region';
import { hasFunctionTools } from './function-tools';

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
   * Every entry must list both APIs: Manifest keeps the agent's API on Runtime,
   * except for the GPT chat requests `bedrockRuntimeChatNeedsResponses` sends to
   * Responses.
   */
  apis: readonly BedrockRuntimeApi[];
  /** Chat Completions output cap the model accepts; GPT models reject `max_tokens`. */
  chatTokenParameter: 'max_tokens' | 'max_completion_tokens';
  /** Rejects effort `none`, the only one Runtime Chat Completions takes next to function tools. */
  rejectsReasoningNone?: true;
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
    rejectsReasoningNone: true,
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

/**
 * Claude base models checked live on the Runtime `/anthropic/v1/messages`
 * endpoint. Bedrock does not publish which models it serves there (older
 * Sonnet 4.x and Opus 4.1-4.6 reject it with 404), so each entry is verified
 * before it is added.
 *
 * Fable 5 / 5.1 are served here through their cross-Region inference profiles
 * (200 verified on the `us.` and `global.` profiles, 2026-11-03), but only when
 * the account's Bedrock data retention mode for the Region is `aws_review` (or
 * the legacy `provider_data_share`); otherwise Runtime answers 400
 * ValidationException. `aws_review` retains prompts and completions within AWS
 * for up to 30 days and lets AWS review them. It is the account owner's choice,
 * set per Region on the Bedrock control plane:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html
 */
export const BEDROCK_RUNTIME_CLAUDE_MESSAGES_MODELS: readonly {
  modelId: string;
  verifiedAt: string;
}[] = [
  { modelId: 'anthropic.claude-sonnet-5', verifiedAt: '2026-10-01' },
  { modelId: 'anthropic.claude-sonnet-5-5', verifiedAt: '2026-10-01' },
  { modelId: 'anthropic.claude-opus-4-7', verifiedAt: '2026-10-01' },
  { modelId: 'anthropic.claude-opus-4-8', verifiedAt: '2026-10-01' },
  { modelId: 'anthropic.claude-opus-5', verifiedAt: '2026-10-01' },
  { modelId: 'anthropic.claude-opus-5-5', verifiedAt: '2026-10-01' },
  { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', verifiedAt: '2026-10-01' },
  // AWS lists the us./global. CRIS profiles, and Runtime Messages recognises the
  // ID (403 entitlement, not the 400 an unknown ID gets). Not yet a 200.
  { modelId: 'anthropic.claude-haiku-5-5', verifiedAt: '2026-10-09' },
  // Needs data retention aws_review; see above.
  { modelId: 'anthropic.claude-fable-5', verifiedAt: '2026-11-03' },
  { modelId: 'anthropic.claude-fable-5-1', verifiedAt: '2026-11-03' },
];

const CLAUDE_MESSAGES_MODEL_IDS = new Set(
  BEDROCK_RUNTIME_CLAUDE_MESSAGES_MODELS.map((entry) => entry.modelId),
);

const MANIFEST_ENDPOINT_BY_API: Record<BedrockRuntimeApi, string> = {
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
};

/** Manifest endpoints that serve a Claude profile through Runtime Messages. */
const CLAUDE_PROFILE_ENDPOINTS: readonly string[] = ['/v1/chat/completions', '/v1/messages'];

/**
 * Runtime capabilities of a CRIS profile whose base model is in the catalog.
 * Null for anything else, including base model IDs, which Mantle serves.
 */
export function getBedrockRuntimeCapabilities(model: string): BedrockRuntimeCapabilities | null {
  const baseModelId = getBedrockInferenceProfileBaseModelId(model);
  return baseModelId === null ? null : (CATALOG_BY_MODEL_ID.get(baseModelId) ?? null);
}

/**
 * True when a Chat Completions request for a catalogued GPT profile must go to
 * Runtime Responses: Runtime Chat Completions rejects function tools next to
 * any reasoning effort but `none` (mnfst/llm-gateway#3107). "GPT" is
 * `max_completion_tokens`, the same test the chat path uses for #3075, on
 * purpose: both fixes cover exactly the same models.
 */
export function bedrockRuntimeChatNeedsResponses(
  model: string,
  body: Record<string, unknown>,
): boolean {
  const capabilities = getBedrockRuntimeCapabilities(model);
  if (capabilities?.chatTokenParameter !== 'max_completion_tokens') return false;
  if (!hasFunctionTools(body.tools)) return false;
  if (capabilities.rejectsReasoningNone) return true;
  return typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none';
}

/**
 * True for a CRIS profile whose base model is a verified Runtime Messages
 * Claude model. Base model IDs return false: Mantle serves those.
 */
export function isBedrockRuntimeClaudeProfile(model: string): boolean {
  const baseModelId = getBedrockInferenceProfileBaseModelId(model);
  return baseModelId !== null && CLAUDE_MESSAGES_MODEL_IDS.has(baseModelId);
}

/**
 * Manifest endpoints that serve a catalogued or Claude CRIS profile, for model
 * discovery.
 */
export function getBedrockRuntimeSupportedEndpoints(model: string): string[] {
  if (isBedrockRuntimeClaudeProfile(model)) return [...CLAUDE_PROFILE_ENDPOINTS];
  return (
    getBedrockRuntimeCapabilities(model)?.apis.map((api) => MANIFEST_ENDPOINT_BY_API[api]) ?? []
  );
}
