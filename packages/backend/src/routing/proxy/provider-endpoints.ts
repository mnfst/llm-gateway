import {
  getManagedFreeLiteLlmBaseUrl,
  MANAGED_FREE_PROVIDER_CONFIGS,
} from '../../common/constants/managed-free-providers';
import { OLLAMA_CLOUD_HOST, OLLAMA_HOST } from '../../common/constants/ollama';
import { stripVendorPrefix } from '../../common/constants/openai-models';
import { PROVIDER_BY_ID_OR_ALIAS } from '../../common/constants/providers';
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION,
  buildClaudeCodeSubscriptionHeaders,
} from '../../common/constants/subscription-clients';
import { normalizeProviderBaseUrl } from '../provider-base-url';
import { getBedrockMantleBaseUrl } from '../bedrock-region';
import { getQwenCompatibleBaseUrl } from '../qwen-region';
import { getXiaomiTokenPlanBaseUrl } from '../xiaomi-region';
import { getZaiCodingPlanBaseUrl } from '../zai-region';
import { buildKiroHeaders, KIRO_BASE_URL, KIRO_CHAT_TARGET } from './kiro-adapter';

export interface ProviderEndpoint {
  baseUrl: string;
  buildHeaders: (apiKey: string, authType?: string) => Record<string, string>;
  buildPath: (model: string) => string;
  /**
   * Optional override used when the request is a stream. Some upstreams
   * (notably the CodeAssist API) expose a separate `:streamGenerateContent`
   * method instead of accepting `?alt=sse` on the non-streaming path. When
   * absent, the proxy falls back to `buildPath` and appends `?alt=sse` for
   * `format: 'google'` streams.
   */
  buildStreamPath?: (model: string) => string;
  format: 'openai' | 'google' | 'anthropic' | 'chatgpt' | 'kiro';
  /**
   * How this endpoint can report exact token usage for streaming responses.
   * `openai_stream_options` means the proxy should request a final usage event
   * by sending `stream_options.include_usage`.
   */
  streamUsageReporting?: 'openai_stream_options';
  /**
   * Set to `true` for endpoints whose `baseUrl` is user-supplied (custom
   * providers, subscription resource URLs). The proxy re-runs SSRF
   * validation against this URL immediately before each forward to defend
   * against DNS rebinding — the hostname might have resolved to a public
   * IP at registration time but rebinds to a private/metadata address at
   * forward time.
   */
  requiresSsrfRevalidation?: boolean;
  /**
   * When `true`, the proxy wraps the outgoing Google-shape request body in
   * the CodeAssist envelope (`{ model, project, request }`) and unwraps
   * `{ response }` from the upstream reply. The project id is read from
   * the OAuth blob's `u` field. Only valid alongside `format: 'google'`.
   */
  codeAssistEnvelope?: boolean;
  /**
   * Subscription routes using the Anthropic wire format usually need the
   * Claude-agent identity prompt. Disable it for API-key based third-party
   * endpoints that only reuse the Anthropic protocol shape.
   */
  skipSubscriptionIdentity?: boolean;
  /** Forward the caller's streaming choice to a Responses-shaped endpoint. */
  forwardResponsesStream?: boolean;
  /** Map Chat Completions token caps to `max_output_tokens`. */
  acceptsMaxOutputTokens?: boolean;
}

const openaiStreamUsage = { streamUsageReporting: 'openai_stream_options' as const };

const openaiHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});

const pioneerHeaders = (apiKey: string) => ({
  'X-API-Key': apiKey,
  'Content-Type': 'application/json',
});

const openaiPath = () => '/v1/chat/completions';
const BEDROCK_OPENAI_MODEL_RE = /(?:^|\.)openai\./i;
const BEDROCK_GPT_5_MODEL_RE = /(?:^|\.)openai\.gpt-5(?:[.-]|$)/i;
const BEDROCK_ANTHROPIC_MODEL_RE = /(?:^|\.)anthropic\./i;

const bedrockResponsesPath = (model: string) =>
  BEDROCK_GPT_5_MODEL_RE.test(stripVendorPrefix(model)) ? '/openai/v1/responses' : '/v1/responses';

export function resolveBedrockEndpointKey(
  model: string,
): 'bedrock' | 'bedrock-responses' | 'bedrock-anthropic' {
  const bareModel = stripVendorPrefix(model);
  if (BEDROCK_OPENAI_MODEL_RE.test(bareModel)) return 'bedrock-responses';
  if (BEDROCK_ANTHROPIC_MODEL_RE.test(bareModel)) return 'bedrock-anthropic';
  return 'bedrock';
}

const anthropicHeaders = (apiKey: string, authType?: string): Record<string, string> => {
  if (authType === 'subscription') {
    return buildClaudeCodeSubscriptionHeaders(apiKey);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  headers['x-api-key'] = apiKey;
  return headers;
};

const anthropicBearerHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
});

// Some Anthropic-compatible /v1/messages endpoints authenticate via the
// `x-api-key` header, not `Authorization: Bearer`.
const anthropicApiKeyHeaders = (apiKey: string): Record<string, string> => ({
  'x-api-key': apiKey,
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
});

/**
 * ChatGPT subscription OAuth tokens use the Codex backend,
 * which requires specific headers to avoid 403 responses.
 * Note: These headers mimic the Codex CLI client. This is required for the
 * endpoint to accept requests, but may break if OpenAI changes validation.
 */
const CHATGPT_SUBSCRIPTION_BASE = 'https://chatgpt.com/backend-api';
const BYTEPLUS_CODING_BASE = 'https://ark.ap-southeast.bytepluses.com/api/coding';
const COMMAND_CODE_PROVIDER_BASE = 'https://api.commandcode.ai/provider';
const KIMI_CODING_SUBSCRIPTION_BASE = 'https://api.kimi.com/coding';
const MINIMAX_SUBSCRIPTION_BASE = 'https://api.minimax.io/anthropic/v1';
const XIAOMI_MIMO_BASE = 'https://api.xiaomimimo.com';
const XIAOMI_TOKEN_PLAN_BASE = getXiaomiTokenPlanBaseUrl();
const QWEN_TOKEN_PLAN_BASE = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode';
const ZAI_SUBSCRIPTION_BASE = getZaiCodingPlanBaseUrl('global');
const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go';
const OPENCODE_ZEN_BASE = 'https://opencode.ai/zen';
const KILO_GATEWAY_BASE = 'https://api.kilo.ai/api/gateway';
const NOUS_PORTAL_BASE = 'https://inference-api.nousresearch.com';
const NVIDIA_NIM_BASE = 'https://integrate.api.nvidia.com';
const FIREWORKS_INFERENCE_BASE = 'https://api.fireworks.ai/inference';
const HUGGING_FACE_INFERENCE_BASE = 'https://router.huggingface.co';
const PIONEER_BASE = 'https://api.pioneer.ai';
const META_BASE = 'https://api.meta.ai';
const chatgptSubscriptionHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  originator: CODEX_CLI_ORIGINATOR,
  'user-agent': CODEX_CLI_USER_AGENT,
});

const MANAGED_FREE_ENDPOINTS: Record<string, ProviderEndpoint> = Object.fromEntries(
  MANAGED_FREE_PROVIDER_CONFIGS.map((config) => [
    config.id,
    {
      get baseUrl() {
        return getManagedFreeLiteLlmBaseUrl();
      },
      buildHeaders: openaiHeaders,
      buildPath: openaiPath,
      format: 'openai',
      ...openaiStreamUsage,
    },
  ]),
);

export const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoint> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'openai-subscription': {
    baseUrl: CHATGPT_SUBSCRIPTION_BASE,
    buildHeaders: chatgptSubscriptionHeaders,
    buildPath: () => '/codex/responses',
    format: 'chatgpt',
  },
  // Standard OpenAI API key against api.openai.com/v1/responses — used for
  // Codex, -pro, o1-pro, and deep-research models that reject /v1/chat/completions.
  'openai-responses': {
    baseUrl: 'https://api.openai.com',
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    buildHeaders: anthropicHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
  },
  bedrock: {
    baseUrl: getBedrockMantleBaseUrl(),
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'bedrock-responses': {
    baseUrl: getBedrockMantleBaseUrl(),
    buildHeaders: openaiHeaders,
    buildPath: bedrockResponsesPath,
    format: 'chatgpt',
    forwardResponsesStream: true,
    acceptsMaxOutputTokens: true,
  },
  'bedrock-anthropic': {
    baseUrl: getBedrockMantleBaseUrl(),
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/anthropic/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  byteplus: {
    baseUrl: BYTEPLUS_CODING_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v3/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  'byteplus-anthropic': {
    baseUrl: BYTEPLUS_CODING_BASE,
    buildHeaders: anthropicBearerHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  commandcode: {
    baseUrl: COMMAND_CODE_PROVIDER_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'cline-pass': {
    baseUrl: 'https://api.cline.bot',
    buildHeaders: openaiHeaders,
    buildPath: () => '/api/v1/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  pioneer: {
    baseUrl: PIONEER_BASE,
    buildHeaders: pioneerHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'commandcode-anthropic': {
    baseUrl: COMMAND_CODE_PROVIDER_BASE,
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  fireworks: {
    baseUrl: FIREWORKS_INFERENCE_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  huggingface: {
    baseUrl: HUGGING_FACE_INFERENCE_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  kilo: {
    baseUrl: KILO_GATEWAY_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  nous: {
    baseUrl: NOUS_PORTAL_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  xai: {
    baseUrl: 'https://api.x.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'xai-responses': {
    baseUrl: 'https://api.x.ai',
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  meta: {
    baseUrl: META_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'minimax-subscription': {
    baseUrl: MINIMAX_SUBSCRIPTION_BASE,
    buildHeaders: anthropicBearerHeaders,
    buildPath: () => '/messages',
    format: 'anthropic',
  },
  xiaomi: {
    baseUrl: XIAOMI_MIMO_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'xiaomi-subscription': {
    baseUrl: XIAOMI_TOKEN_PLAN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'moonshot-subscription': {
    baseUrl: KIMI_CODING_SUBSCRIPTION_BASE,
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  nvidia: {
    baseUrl: NVIDIA_NIM_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  qwen: {
    baseUrl: getQwenCompatibleBaseUrl('beijing'),
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'qwen-subscription': {
    baseUrl: QWEN_TOKEN_PLAN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'qwen-subscription-responses': {
    baseUrl: QWEN_TOKEN_PLAN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
  },
  zai: {
    baseUrl: 'https://api.z.ai',
    buildHeaders: openaiHeaders,
    buildPath: () => '/api/paas/v4/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  'zai-subscription': {
    baseUrl: ZAI_SUBSCRIPTION_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    // Google accepts the API key via the `x-goog-api-key` header as well as
    // the `?key=` query parameter. Header is preferable: query strings show
    // up in upstream proxy / load-balancer access logs, header values do not.
    buildHeaders: (apiKey: string) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }),
    buildPath: (model: string) => `/v1beta/models/${model}:generateContent`,
    format: 'google',
  },
  // Vertex AI: the same Gemini wire format as `google`, on Google Cloud's
  // serving stack. Vertex has two addressing modes and both end in the same
  // `/publishers/google/models/...` suffix, so only the base URL differs:
  //
  //   express  https://aiplatform.googleapis.com/v1beta1
  //   project  https://{loc}-aiplatform.googleapis.com/v1/projects/{p}/locations/{loc}
  //
  // Express is the default because it needs no configuration — the key itself
  // resolves the project. A connection that stores `project/location` in
  // `region` gets the project-scoped base instead (see vertex-deployment.ts),
  // which is how Google Cloud accounts normally address Vertex.
  //
  // Vertex's OpenAI-compatible route is deliberately unused: it rejects
  // express calls with RESOURCE_PROJECT_INVALID, so it would force a project
  // on everyone for no gain.
  vertex: {
    baseUrl: 'https://aiplatform.googleapis.com/v1beta1',
    buildHeaders: (apiKey: string) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }),
    buildPath: (model: string) => `/publishers/google/models/${model}:generateContent`,
    // No `?alt=sse` here: provider-client appends it for every google-format
    // stream, so adding it would produce the query string twice.
    buildStreamPath: (model: string) => `/publishers/google/models/${model}:streamGenerateContent`,
    format: 'google',
  },
  // Gemini OAuth (gemini-cli flow) routes through the CodeAssist API, which
  // wraps the standard Gemini request/response in a small envelope and
  // identifies the user via a Bearer token + their assigned
  // `cloudaicompanionProject` id (stored in the OAuth blob's `u` field).
  // Wrap/unwrap happens in `provider-client` and `proxy-response-handler`
  // when `endpointKey === 'gemini-subscription'`.
  'gemini-subscription': {
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    buildHeaders: (apiKey: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
    buildPath: () => '/v1internal:generateContent',
    buildStreamPath: () => '/v1internal:streamGenerateContent',
    format: 'google',
    codeAssistEnvelope: true,
  },
  copilot: {
    baseUrl: 'https://api.githubcopilot.com',
    buildHeaders: (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
    }),
    buildPath: () => '/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  // Codex variants (e.g. gpt-5-codex, gpt-5.2-codex, gpt-5.3-codex) only accept
  // /responses on Copilot — /chat/completions returns "Unsupported API for model".
  'copilot-responses': {
    baseUrl: 'https://api.githubcopilot.com',
    buildHeaders: (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
    }),
    buildPath: () => '/responses',
    format: 'chatgpt',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai',
    buildHeaders: (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://manifest.build',
      'X-Title': 'Manifest',
    }),
    buildPath: () => '/api/v1/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  ...MANAGED_FREE_ENDPOINTS,
  ollama: {
    baseUrl: OLLAMA_HOST,
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'ollama-cloud': {
    baseUrl: OLLAMA_CLOUD_HOST,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  kiro: {
    baseUrl: KIRO_BASE_URL,
    buildHeaders: (apiKey: string) => buildKiroHeaders(apiKey, KIRO_CHAT_TARGET),
    buildPath: () => '/',
    format: 'kiro',
  },
  'opencode-go': {
    baseUrl: OPENCODE_GO_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'opencode-go-anthropic': {
    baseUrl: OPENCODE_GO_BASE,
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
  },
  // OpenCode Go's Responses-only models (Grok 4.5, GPT 5.6 Luna, Muse Spark)
  // reject /v1/chat/completions — the docs Endpoints table sends them to
  // /v1/responses instead.
  'opencode-go-responses': {
    baseUrl: OPENCODE_GO_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
    forwardResponsesStream: true,
    acceptsMaxOutputTokens: true,
  },
  // OpenCode Zen's /v1/chat/completions is a unified OpenAI-compatible
  // endpoint that handles Claude, GPT, and the long tail of OpenAI-compatible
  // models (Qwen, GLM, Kimi, MiniMax, …) on a single Bearer-auth route.
  //
  // Gemini models on Zen are currently broken upstream — Zen forwards our
  // `Authorization: Bearer` header to Vertex AI verbatim, which rejects the
  // request with OVERLOADED_CREDENTIALS because Zen also attaches its own
  // GCP credentials. This is a Zen-side gateway bug; switching to `x-api-key`
  // only makes Zen reject with "Missing API key" before the request even
  // reaches GCP. There is no client-side workaround until Zen stops
  // tunneling our auth header through.
  'opencode-zen': {
    baseUrl: OPENCODE_ZEN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  // TODO(opencode-zen): collapse this back into the single `opencode-zen`
  // entry once Zen's gateway stops tunneling the client Authorization header
  // through to Vertex AI on /v1/chat/completions. The unified path already
  // works for Claude, GPT, and the OpenAI-compatible long tail; Gemini is
  // the only family that still needs the Google-native combo today.
  'opencode-zen-google': {
    baseUrl: OPENCODE_ZEN_BASE,
    buildHeaders: (apiKey: string) => ({
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    }),
    buildPath: (model: string) => `/v1/models/${model}:generateContent`,
    format: 'google',
  },
};

/** Build a ProviderEndpoint for a custom provider with the given base URL. */
export function buildCustomEndpoint(
  baseUrl: string,
  apiKind: 'openai' | 'anthropic' = 'openai',
): ProviderEndpoint {
  // Strip trailing /v1 (or /v1/) since both buildPath callbacks include /v1.
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (apiKind === 'anthropic') {
    return {
      baseUrl: normalized,
      buildHeaders: anthropicHeaders,
      buildPath: () => '/v1/messages',
      format: 'anthropic',
      requiresSsrfRevalidation: true,
    };
  }
  return {
    baseUrl: normalized,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
    requiresSsrfRevalidation: true,
  };
}

export function buildEndpointOverride(baseUrl: string, templateKey: string): ProviderEndpoint {
  const template = PROVIDER_ENDPOINTS[templateKey];
  if (!template) {
    throw new Error(`No provider endpoint template configured for: ${templateKey}`);
  }
  return {
    ...template,
    baseUrl:
      templateKey === 'minimax-subscription'
        ? baseUrl.replace(/\/+$/, '')
        : normalizeProviderBaseUrl(baseUrl),
    // The base URL came from a user-supplied source (Qwen region selector,
    // MiniMax OAuth resource URL). Treat it as an SSRF candidate and
    // re-validate before each forward.
    requiresSsrfRevalidation: true,
  };
}

/** Resolve a pricing-DB provider name to a provider endpoint key. */
export function resolveEndpointKey(provider: string): string | null {
  const lower = provider.toLowerCase();
  if (PROVIDER_ENDPOINTS[lower]) return lower;

  // Custom providers use their own dynamic endpoint
  if (lower.startsWith('custom:')) return lower;

  // Look up via SST alias map — check id and all aliases against endpoints
  const entry = PROVIDER_BY_ID_OR_ALIAS.get(lower);
  if (entry) {
    if (PROVIDER_ENDPOINTS[entry.id]) return entry.id;
    for (const alias of entry.aliases) {
      if (PROVIDER_ENDPOINTS[alias]) return alias;
    }
  }

  return null;
}
