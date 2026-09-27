import { createHash } from 'crypto';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { OPENAI_RESPONSES_ONLY_RE, stripVendorPrefix } from '../../common/constants/openai-models';
import { XAI_RESPONSES_ONLY_RE } from '../../common/constants/xai-models';
import {
  PROVIDER_ENDPOINTS,
  ProviderEndpoint,
  resolveBedrockEndpointKey,
  resolveEndpointKey,
} from './provider-endpoints';
import { validatePublicUrl } from '../../common/utils/url-validation';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import { resolveSubscriptionEndpointKey } from './provider-hooks';
import { isAnthropicHost, mergeAnthropicBeta } from './anthropic-beta';
import { injectOpenAiMessageCacheControl, injectOpenRouterCacheControl } from './cache-injection';
import {
  applyAnthropicAutomaticCacheControl,
  applyAnthropicMessagesMutations,
  toGoogleRequest,
  toAnthropicRequest,
  toResponsesRequest,
  sanitizeOpenAiBody,
  collectChatGptSseResponse as chatGptSseCollector,
  convertChatGptResponse as chatGptResponseConverter,
  createChatGptStreamTransformer as chatGptStreamTransformerFactory,
  convertGoogleResponse as googleResponseConverter,
  convertGoogleStreamChunk as googleStreamChunkConverter,
  convertAnthropicResponse as anthropicResponseConverter,
  convertAnthropicStreamChunk as anthropicStreamChunkConverter,
  createAnthropicTransformer,
  createReasoningContentStreamTransformer as reasoningContentStreamTransformer,
} from './provider-client-converters';
import {
  ForwardOptions,
  ProxyApiMode,
  ProviderWireFormat,
  type ProviderAttemptRef,
} from './proxy-types';
import { CodexSessionAffinity } from './codex-session-affinity';
import { ModelsDevReasoningCatalog } from './reasoning-model-catalog';
import { toNativeResponsesRequest } from './responses-adapter';
import { responsesToolNames, ResponsesToolNames } from './responses-tools';
import { forwardKiroChat } from './kiro-adapter';
import { OpencodeGoCatalogService } from '../../model-discovery/opencode-go-catalog.service';
import { ProviderModelRegistryService } from '../../model-discovery/provider-model-registry.service';
import { qualifyChatGptResponse } from './chatgpt-response-qualifier';
import { isProviderAvailableForDeployment } from '../../common/utils/provider-availability';
import { ManifestError } from '../../common/errors/manifest-error';
import { MANAGED_FREE_PROVIDER_BY_ID } from '../../common/constants/managed-free-providers';

export interface ForwardResult {
  response: Response;
  /** Exact JSON body sent to the resolved provider transport. */
  wireRequestBody?: Record<string, unknown>;
  /** Exact URL used by the resolved provider transport. */
  wireRequestUrl?: string;
  /** Provider-native protocol emitted at the transport boundary. */
  wireFormat?: ProviderWireFormat;
  /** Provider-facing API shape of {@link wireRequestBody}. */
  wireApiMode?: ProxyApiMode;
  /** Re-send a healed wire body through the already-resolved transport. */
  retryWireBody?: (
    body: Record<string, unknown>,
    attempt?: ProviderAttemptRef,
  ) => Promise<ForwardResult>;
  /** False only when Manifest produced a response without invoking provider transport. */
  providerCallStarted?: boolean;
  /** Persisted provider-call identity, when request tracking is available. */
  attempt?: ProviderAttemptRef;
  /** True when we converted from Google format (needs SSE transform). */
  isGoogle: boolean;
  /** True when we converted from Anthropic format (needs SSE transform). */
  isAnthropic: boolean;
  /** True when we converted from ChatGPT Responses API format (needs SSE transform). */
  isChatGpt: boolean;
  /** True when the upstream already speaks the public Responses API format. */
  isResponses?: boolean;
  /**
   * True when the upstream is the CodeAssist API (Gemini OAuth flow). The
   * response handler unwraps the `{ response: ... }` envelope before
   * passing the inner body to the standard Google converters.
   */
  isCodeAssist?: boolean;
  /** Internal: Anthropic synthetic tool used to emulate Responses structured output. */
  structuredOutputToolName?: string;
  /** Internal: original Responses text.format metadata for synthesized Responses bodies. */
  responsesTextFormat?: Record<string, unknown>;
  responsesToolNames?: ResponsesToolNames;
}

function wireApiMode(endpoint: ProviderEndpoint): ProxyApiMode | undefined {
  if (endpoint.format === 'openai') return 'chat_completions';
  if (endpoint.format === 'anthropic') return 'messages';
  if (endpoint.format === 'chatgpt') return 'responses';
  return undefined;
}

function wireFormat(endpoint: ProviderEndpoint): ProviderWireFormat | undefined {
  if (endpoint.format === 'openai') return 'openai_chat_completions';
  if (endpoint.format === 'anthropic') return 'anthropic_messages';
  if (endpoint.format === 'chatgpt') return 'openai_responses';
  if (endpoint.format === 'google') {
    return endpoint.codeAssistEnvelope ? 'google_code_assist' : 'google_generate_content';
  }
  return undefined;
}

const INPUT_WIRE_FORMATS: Record<ProxyApiMode, ProviderWireFormat> = {
  chat_completions: 'openai_chat_completions',
  messages: 'anthropic_messages',
  responses: 'openai_responses',
};

interface BuiltProviderRequest {
  url: string;
  headers: Record<string, string>;
  requestBody: Record<string, unknown>;
  structuredOutputToolName?: string;
}

/**
 * Anthropic-format headers with the caller's beta flags folded in. Manifest's
 * own flags always win their slot; the caller's are appended, so a request that
 * sent none is byte-identical to before.
 */
function withClientAnthropicBeta(
  headers: Record<string, string>,
  clientAnthropicBeta: string | string[] | undefined,
): Record<string, string> {
  const merged = mergeAnthropicBeta(headers['anthropic-beta'], clientAnthropicBeta);
  if (merged === undefined || merged === headers['anthropic-beta']) return headers;
  return { ...headers, 'anthropic-beta': merged };
}

const parsedProviderTimeout = Number.parseInt(process.env.PROVIDER_TIMEOUT_MS ?? '', 10);
const PROVIDER_TIMEOUT_MS =
  Number.isFinite(parsedProviderTimeout) && parsedProviderTimeout > 0
    ? parsedProviderTimeout
    : 180_000;
const QWEN_TOKEN_PLAN_RESPONSES_RE = /^qwen3\.7-max$/i;
const COPILOT_CHAT_COMPLETIONS_ENDPOINT = '/chat/completions';
const COPILOT_RESPONSES_ENDPOINTS = new Set(['/responses', 'ws:/responses']);

/**
 * Narrower than `isAnthropicHost` on purpose, and the two are meant to
 * disagree for a custom provider row pointed at Anthropic.
 *
 * Forwarding a beta header the caller already chose is additive: the request
 * either keeps working or starts working. Injecting a cache breakpoint edits
 * the body, changes prompt-caching behaviour and moves what the tenant is
 * billed. Extending that to custom-Anthropic endpoints is a real behaviour
 * change for people who do not get it today, so it belongs in its own change
 * with its own evidence, not folded into header forwarding.
 */
function shouldApplyAnthropicAutomaticCacheControl(endpointKey: string): boolean {
  return endpointKey === 'anthropic';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasChatCompletionOutput(message: Record<string, unknown>): boolean {
  return Object.entries(message).some(([key, value]) => {
    if (key === 'role' || value == null) return false;
    if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
    return true;
  });
}

function isEmptyChatCompletion(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.choices)) return false;
  return body.choices.every(
    (choice) =>
      isRecord(choice) &&
      choice.finish_reason === 'stop' &&
      isRecord(choice.message) &&
      !hasChatCompletionOutput(choice.message),
  );
}

async function qualifyEmptyChatCompletion(
  response: Response,
  attempt?: ProviderAttemptRef,
): Promise<Response> {
  if (response.status !== HttpStatus.OK) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!isEmptyChatCompletion(body)) return response;
  await attempt?.finishRecording?.({ type: 'json', body });

  return new Response(
    JSON.stringify({
      error: {
        message: 'Upstream provider returned an empty Chat Completions response',
        type: 'server_error',
        code: 'empty_response',
      },
    }),
    { status: HttpStatus.BAD_GATEWAY, headers: { 'content-type': 'application/json' } },
  );
}

function responsesTextFormat(
  body: Record<string, unknown>,
  apiMode: ForwardOptions['apiMode'],
): Record<string, unknown> | undefined {
  if (apiMode !== 'responses' || !isRecord(body.text) || !isRecord(body.text.format)) {
    return undefined;
  }

  const format = body.text.format;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type !== 'json_schema') return undefined;

  const out: Record<string, unknown> = { type: 'json_schema' };
  if (format.name !== undefined) out.name = format.name;
  if (format.schema !== undefined) out.schema = format.schema;
  if (format.strict !== undefined) out.strict = format.strict;
  if (typeof format.description === 'string' && format.description) {
    out.description = format.description;
  }
  return out;
}

function isStructuredResponseFormat(responseFormat: unknown): boolean {
  return (
    isRecord(responseFormat) &&
    (responseFormat.type === 'json_object' || responseFormat.type === 'json_schema')
  );
}

function structuredOutputToolName(
  requestSource: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): string | undefined {
  if (!isStructuredResponseFormat(requestSource.response_format)) return undefined;
  const toolChoice = requestBody.tool_choice;
  if (!isRecord(toolChoice) || toolChoice.type !== 'tool') return undefined;
  return typeof toolChoice.name === 'string' ? toolChoice.name : undefined;
}

function buildPromptCacheKey(sessionKey: string): string {
  const digest = createHash('sha256').update(sessionKey).digest('hex').slice(0, 32);
  return `manifest-${digest}`;
}

function applyHashedPromptCacheKey(
  body: Record<string, unknown>,
  providerCacheKey: string | undefined,
): void {
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key) return;
  const trimmedCacheKey = providerCacheKey?.trim();
  if (!trimmedCacheKey) return;
  body.prompt_cache_key = buildPromptCacheKey(trimmedCacheKey);
}

// Anthropic metadata.user_id identifies the caller. OpenAI metadata instead
// annotates stored completions, so the equivalent OpenAI field is safety_identifier.
function applyAnthropicUserIdForOpenAi(
  body: Record<string, unknown>,
  source: Record<string, unknown> = body,
): void {
  const metadata = isRecord(source.metadata) ? source.metadata : undefined;
  delete body.metadata;

  const userId = metadata?.user_id;
  if (typeof userId !== 'string' || !userId) return;

  body.safety_identifier =
    userId.length <= 64 ? userId : createHash('sha256').update(userId).digest('hex');
}

// Anthropic thinking configures extended reasoning. OpenAI rejects the field
// as an unknown parameter and expresses the same control as an effort tier, so
// translate instead of forwarding. Only `disabled` has a lossless equivalent
// (`reasoning_effort: none`); adaptive/enabled budgets map to no single effort
// tier and fall back to the provider's default reasoning.
//
// The effort tier is emitted only for models that actually reason: a
// non-reasoning model rejects `reasoning_effort` outright, so for it dropping
// `thinking` is the whole fix.
function anthropicThinkingEffort(
  body: Record<string, unknown>,
  supportsReasoning: boolean,
): 'none' | undefined {
  if (!supportsReasoning) return undefined;
  return isRecord(body.thinking) && body.thinking.type === 'disabled' ? 'none' : undefined;
}

function applyAnthropicThinkingForOpenAi(
  body: Record<string, unknown>,
  supportsReasoning: boolean,
): void {
  if (!('thinking' in body)) return;
  const effort = anthropicThinkingEffort(body, supportsReasoning);
  delete body.thinking;

  if (effort !== undefined && body.reasoning_effort === undefined) {
    body.reasoning_effort = effort;
  }
}

function openRouterCacheMode(model: string): 'anthropic' | 'message' | null {
  const normalized = model.toLowerCase().replace(/^~/, '');
  if (normalized.startsWith('anthropic/')) return 'anthropic';
  if (normalized.startsWith('google/') || normalized.startsWith('qwen/')) return 'message';
  return null;
}

/**
 * Strip vendor prefix from model name (e.g. "anthropic/claude-sonnet-4" → "claude-sonnet-4").
 * Models synced from OpenRouter use vendor prefixes, but native APIs expect bare names.
 */
function stripModelPrefix(model: string, endpointKey: string): string {
  // OpenRouter and managed free providers expect vendor prefixes.
  if (endpointKey === 'openrouter' || MANAGED_FREE_PROVIDER_BY_ID.has(endpointKey)) return model;
  if (endpointKey === 'commandcode' || endpointKey === 'commandcode-anthropic') {
    return model.startsWith('commandcode/') ? model.slice('commandcode/'.length) : model;
  }
  // Custom providers, Fireworks, Groq, Hugging Face, Kilo, Nous, NVIDIA NIM, Ollama, Pioneer, and ClinePass: model IDs from these APIs contain
  // legitimate slash segments (e.g. "accounts/fireworks/models/deepseek-v3p1",
  // "MiniMaxAI/MiniMax-2.7", "meta-llama/llama-guard-4-12b", "anthropic/claude-sonnet-4.5",
  // "cline-pass/deepseek-v4-flash"). Stripping would mangle the name the upstream API expects.
  if (
    endpointKey === 'custom' ||
    endpointKey === 'fireworks' ||
    endpointKey === 'groq' ||
    endpointKey === 'huggingface' ||
    endpointKey === 'kilo' ||
    endpointKey === 'nous' ||
    endpointKey === 'nvidia' ||
    endpointKey === 'cline-pass' ||
    endpointKey === 'ollama' ||
    endpointKey === 'ollama-cloud' ||
    endpointKey === 'pioneer'
  )
    return model;
  return stripVendorPrefix(model);
}

@Injectable()
export class ProviderClient {
  private readonly logger = new Logger(ProviderClient.name);
  private readonly codexAffinity: CodexSessionAffinity;

  constructor(
    @Optional()
    private readonly opencodeGoCatalog?: OpencodeGoCatalogService,
    @Optional()
    private readonly modelRegistry?: ProviderModelRegistryService,
    @Optional()
    codexAffinity?: CodexSessionAffinity,
    @Optional()
    private readonly reasoningCatalog?: ModelsDevReasoningCatalog,
  ) {
    this.codexAffinity = codexAffinity ?? new CodexSessionAffinity();
  }

  /** Whether the target model reasons, so an OpenAI effort tier is meaningful. */
  private modelSupportsReasoning(endpointKey: string, model: string): boolean {
    return this.reasoningCatalog?.isReasoningModel(endpointKey, model) === true;
  }

  async forward(opts: ForwardOptions): Promise<ForwardResult> {
    const {
      provider,
      apiKey,
      model,
      body,
      stream,
      signal,
      extraHeaders,
      customEndpoint,
      authType,
    } = opts;

    if (!customEndpoint && !isProviderAvailableForDeployment(provider)) {
      throw new ManifestError('M303', HttpStatus.BAD_REQUEST);
    }

    const { endpoint, endpointKey } = await this.resolveEndpoint(
      customEndpoint,
      provider,
      authType,
      model,
      opts.apiMode,
    );
    const isGoogle = endpoint.format === 'google';
    const isAnthropic = endpoint.format === 'anthropic';
    const isResponses = opts.apiMode === 'responses' && endpoint.format === 'chatgpt';
    const isChatGpt = endpoint.format === 'chatgpt' && !isResponses;
    const isCodeAssist = !!endpoint.codeAssistEnvelope;
    const textFormat = responsesTextFormat(body, opts.apiMode);
    const resolvedWireApiMode = wireApiMode(endpoint);
    const resolvedWireFormat = wireFormat(endpoint);
    const needsChatBody =
      opts.apiMode !== undefined &&
      opts.apiMode !== 'chat_completions' &&
      INPUT_WIRE_FORMATS[opts.apiMode] !== resolvedWireFormat;
    const chatBody = needsChatBody ? await opts.resolveChatBody?.() : undefined;

    const bareModel = stripModelPrefix(model, endpointKey);
    if (endpoint.format === 'kiro') {
      const requestSource = chatBody ?? body;
      opts.attempt?.startRecording?.({
        requestBody: requestSource,
        wireFormat: 'kiro_chat',
      });
      const response = await forwardKiroChat({
        apiKey,
        model: bareModel,
        body: requestSource,
        stream,
        signal,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        extraHeaders,
      });
      return {
        response,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
        wireRequestBody: requestSource,
        wireFormat: 'kiro_chat',
        wireApiMode: opts.apiMode,
        responsesTextFormat: textFormat,
        responsesToolNames:
          opts.apiMode === 'responses' ? responsesToolNames(body.tools) : undefined,
      };
    }
    const { url, headers, requestBody, structuredOutputToolName } = this.buildRequest({
      endpoint,
      endpointKey,
      provider,
      bareModel,
      model,
      apiKey,
      authType,
      body,
      chatBody,
      apiMode: opts.apiMode,
      stream,
      signatureLookup: opts.signatureLookup,
      thinkingLookup: opts.thinkingLookup,
      thinkingRouteContext: opts.thinkingRouteContext,
      clientAnthropicBeta: opts.clientAnthropicBeta,
      providerResource: opts.providerResource,
      sessionKey: opts.sessionKey,
      providerCacheKey: opts.providerCacheKey,
    });

    // The Codex backend only serves prompt-cache hits with session affinity
    // headers the real Codex CLI sends — see CodexSessionAffinity.
    const affinity =
      endpointKey === 'openai-subscription'
        ? this.codexAffinity.prepare(apiKey, requestBody)
        : undefined;
    // Affinity headers are routing-critical and must win over caller-supplied
    // extraHeaders (provider-side observability hints), so they spread last.
    const finalHeaders =
      affinity || extraHeaders ? { ...headers, ...extraHeaders, ...affinity?.headers } : headers;

    const retryWireBody = async (
      wireRequestBody: Record<string, unknown>,
      attempt: ProviderAttemptRef | undefined = opts.attempt,
    ): Promise<ForwardResult> => {
      if (resolvedWireFormat) {
        attempt?.startRecording?.({
          requestBody: wireRequestBody,
          wireFormat: resolvedWireFormat,
        });
      }
      this.logger.debug(`Forwarding to ${endpointKey}: ${url.replace(/key=[^&]+/, 'key=***')}`);

      // SSRF defense in depth for user-supplied endpoint URLs (custom providers,
      // subscription resource URLs). Re-check every actual forward, including
      // an immediate Autofix retry, because DNS may have rebound in between.
      if (endpoint.requiresSsrfRevalidation) {
        try {
          await validatePublicUrl(url, { allowPrivate: isSelfHosted() });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Refusing to forward to disallowed URL: ${message}`);
        }
      }

      const result = await this.executeFetch(url, finalHeaders, wireRequestBody, signal, stream, {
        isGoogle,
        isAnthropic,
        isChatGpt,
        isResponses,
        isCodeAssist,
        structuredOutputToolName,
        responsesTextFormat: textFormat,
        responsesToolNames:
          opts.apiMode === 'responses' ? responsesToolNames(body.tools) : undefined,
      });
      const response =
        !stream &&
        endpoint.format === 'openai' &&
        (opts.apiMode === undefined || opts.apiMode === 'chat_completions')
          ? await qualifyEmptyChatCompletion(result.response, attempt)
          : result.response;
      const qualifiedResult =
        endpointKey === 'openai-subscription'
          ? {
              ...result,
              response: await qualifyChatGptResponse(response, {
                downstreamFormat: isResponses ? 'responses' : 'chat-completions',
              }),
            }
          : { ...result, response };
      if (affinity) {
        this.codexAffinity.capture(
          affinity.storeKey,
          qualifiedResult.response,
          affinity.incarnation,
        );
      }
      return {
        ...qualifiedResult,
        wireRequestBody,
        wireRequestUrl: url,
        wireFormat: resolvedWireFormat,
        wireApiMode: resolvedWireApiMode,
        retryWireBody,
      };
    };

    return retryWireBody(requestBody);
  }

  private async resolveEndpoint(
    customEndpoint: ProviderEndpoint | undefined,
    provider: string,
    authType: string | undefined,
    model: string,
    apiMode: ForwardOptions['apiMode'],
  ): Promise<{ endpoint: ProviderEndpoint; endpointKey: string }> {
    if (customEndpoint) {
      return { endpoint: customEndpoint, endpointKey: 'custom' };
    }
    let resolved = resolveEndpointKey(provider);
    if (!resolved) {
      throw new Error(`No endpoint configured for provider: ${provider}`);
    }
    if (authType === 'subscription') {
      const override = resolveSubscriptionEndpointKey(resolved);
      if (override) resolved = override;
    }
    if (resolved === 'bedrock') {
      resolved = resolveBedrockEndpointKey(model);
    }
    if (resolved === 'qwen-subscription') {
      const bareQwenModel = stripVendorPrefix(model);
      if (apiMode === 'responses' || QWEN_TOKEN_PLAN_RESPONSES_RE.test(bareQwenModel)) {
        resolved = 'qwen-subscription-responses';
      }
    }
    if (apiMode === 'responses' && resolved === 'openai') {
      resolved = 'openai-responses';
    }
    if (apiMode === 'responses' && resolved === 'xai') {
      resolved = 'xai-responses';
    }
    // OpenAI rejects these models on /v1/chat/completions; forward to /v1/responses.
    if (resolved === 'openai' && OPENAI_RESPONSES_ONLY_RE.test(stripVendorPrefix(model))) {
      resolved = 'openai-responses';
    }
    // xAI multi-agent models are Responses API-only; route them to /v1/responses
    // while still accepting Chat Completions-shaped client requests.
    if (resolved === 'xai' && XAI_RESPONSES_ONLY_RE.test(stripVendorPrefix(model))) {
      resolved = 'xai-responses';
    }
    if (resolved === 'copilot') {
      const metadataEndpoint = this.resolveCopilotEndpointFromMetadata(model, apiMode);
      if (metadataEndpoint) {
        resolved = metadataEndpoint;
      } else if (OPENAI_RESPONSES_ONLY_RE.test(stripVendorPrefix(model))) {
        // Copilot served the original Codex variants only at /responses before
        // its /models endpoint exposed supported_endpoints.
        resolved = 'copilot-responses';
      }
    }
    if (resolved === 'opencode-go') {
      const bareOpenCodeModel = stripVendorPrefix(model).toLowerCase();
      const catalogFormat = await this.resolveOpencodeGoFormat(bareOpenCodeModel);
      if (catalogFormat === 'responses') {
        resolved = 'opencode-go-responses';
      } else {
        const knownAnthropicFamily = this.isKnownOpencodeGoAnthropicFamily(bareOpenCodeModel);
        if (catalogFormat === 'anthropic' || (!catalogFormat && knownAnthropicFamily)) {
          resolved = 'opencode-go-anthropic';
        }
      }
    }
    if (resolved === 'commandcode') {
      const bareCommandCodeModel = model.startsWith('commandcode/')
        ? model.slice('commandcode/'.length).toLowerCase()
        : model.toLowerCase();
      if (bareCommandCodeModel.startsWith('claude-')) {
        resolved = 'commandcode-anthropic';
      }
    }
    if (
      resolved === 'opencode-zen' &&
      stripVendorPrefix(model).toLowerCase().startsWith('gemini-')
    ) {
      // TODO(opencode-zen): once Zen's gateway stops forwarding the client
      // Authorization header to Vertex AI, drop this branch and let Gemini
      // ride the unified /v1/chat/completions route like every other family.
      // Today, sending `Authorization: Bearer <zen_key>` against the unified
      // path triggers GCP OVERLOADED_CREDENTIALS (Zen also attaches its own
      // GCP creds upstream). The dedicated Gemini route uses Google's
      // `x-goog-api-key` header against `/v1/models/{id}:generateContent`,
      // which Zen documents at https://opencode.ai/docs/zen/ and does not
      // leak through to Vertex AI.
      resolved = 'opencode-zen-google';
    }
    return { endpoint: PROVIDER_ENDPOINTS[resolved], endpointKey: resolved };
  }

  private async resolveOpencodeGoFormat(
    bareModel: string,
  ): Promise<'openai' | 'anthropic' | 'responses' | null> {
    if (!this.opencodeGoCatalog) return null;
    try {
      return await this.opencodeGoCatalog.resolveFormat(bareModel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OpenCode Go catalog format lookup failed: ${message}`);
      return null;
    }
  }

  private isKnownOpencodeGoAnthropicFamily(bareModel: string): boolean {
    return bareModel.startsWith('minimax-') || bareModel.startsWith('qwen3.7');
  }

  private resolveCopilotEndpointFromMetadata(
    model: string,
    apiMode: ForwardOptions['apiMode'],
  ): 'copilot' | 'copilot-responses' | null {
    const endpoints = this.getCopilotSupportedEndpoints(model);
    if (!endpoints) return null;

    const hasChat = endpoints.has(COPILOT_CHAT_COMPLETIONS_ENDPOINT);
    const hasResponses = Array.from(COPILOT_RESPONSES_ENDPOINTS).some((endpoint) =>
      endpoints.has(endpoint),
    );

    if (apiMode === 'responses') {
      if (hasResponses) return 'copilot-responses';
      if (hasChat) return 'copilot';
      return null;
    }

    if (hasChat) return 'copilot';
    if (hasResponses) return 'copilot-responses';
    return null;
  }

  private getCopilotSupportedEndpoints(model: string): Set<string> | null {
    const bareModel = stripVendorPrefix(model);
    const candidates = Array.from(new Set([model, `copilot/${bareModel}`, bareModel]));

    for (const candidate of candidates) {
      const endpoints = this.modelRegistry?.getModelMetadata(
        'copilot',
        candidate,
      )?.supportedEndpoints;
      if (endpoints && endpoints.length > 0) return new Set(endpoints);
    }

    return null;
  }

  private buildRequest(ctx: {
    endpoint: ProviderEndpoint;
    endpointKey: string;
    provider: string;
    bareModel: string;
    model: string;
    apiKey: string;
    authType: string | undefined;
    body: Record<string, unknown>;
    chatBody?: Record<string, unknown>;
    apiMode?: ForwardOptions['apiMode'];
    stream: boolean;
    signatureLookup?: ForwardOptions['signatureLookup'];
    thinkingLookup?: ForwardOptions['thinkingLookup'];
    thinkingRouteContext?: ForwardOptions['thinkingRouteContext'];
    clientAnthropicBeta?: ForwardOptions['clientAnthropicBeta'];
    providerResource?: string;
    sessionKey?: string;
    providerCacheKey?: string;
  }): BuiltProviderRequest {
    const { endpoint, endpointKey, bareModel, apiKey, authType, body, chatBody, stream } = ctx;
    // Native matching targets read `body` directly. Cross-protocol targets
    // receive the lazily resolved Chat Completions view as `chatBody`.
    const requestSource = chatBody ?? body;

    if (endpoint.format === 'google') {
      // Google accepts the API key via header (set by buildHeaders below) so
      // we no longer need to embed it in the URL. Keeping the key out of the
      // URL avoids leaking it into upstream proxy / LB access logs.
      const path =
        stream && endpoint.buildStreamPath
          ? endpoint.buildStreamPath(bareModel)
          : endpoint.buildPath(bareModel);
      let url = `${endpoint.baseUrl}${path}`;
      if (stream) url += '?alt=sse';
      const innerBody = toGoogleRequest(requestSource, bareModel, ctx.signatureLookup);
      const requestBody = endpoint.codeAssistEnvelope
        ? // CodeAssist routes by `cloudaicompanionProject` rather than URL
          // path; the project id was stashed in the OAuth blob's `u` field
          // by GeminiOauthService.enrichBlob and travels through the proxy
          // pipeline as `providerResource`.
          { model: bareModel, project: ctx.providerResource ?? '', request: innerBody }
        : innerBody;
      return {
        url,
        headers: endpoint.buildHeaders(apiKey, authType),
        requestBody,
      };
    }

    if (endpoint.format === 'anthropic') {
      const injectSubscriptionIdentity =
        authType === 'subscription' && !endpoint.skipSubscriptionIdentity;
      const thinkingRouteContext = ctx.thinkingRouteContext ?? {
        provider: ctx.provider,
        authType,
        model: ctx.model,
      };
      // When the inbound request is already Anthropic Messages
      // (`POST /v1/messages`) and the resolved upstream is also Anthropic,
      // skip the OpenAI translation round-trip and apply only the additive
      // mutations cache_control + subscription identity + max_tokens
      // default + thinking-block replay. The wire body bypasses translation.
      // This closes the lossy-roundtrip class of
      // bugs that previously dropped Anthropic-native fields (server tool
      // `type` tags, cache_control placement, etc.) — see #1886.
      const requestBody =
        ctx.apiMode === 'messages'
          ? applyAnthropicMessagesMutations(body, {
              injectSubscriptionIdentity,
              thinkingLookup: ctx.thinkingLookup,
              thinkingRouteContext,
            })
          : toAnthropicRequest(requestSource, bareModel, {
              injectSubscriptionIdentity,
              thinkingLookup: ctx.thinkingLookup,
              thinkingRouteContext,
            });
      const syntheticToolName =
        ctx.apiMode === 'responses'
          ? structuredOutputToolName(requestSource, requestBody)
          : undefined;
      requestBody.model = bareModel;
      if (stream) requestBody.stream = true;
      if (shouldApplyAnthropicAutomaticCacheControl(endpointKey)) {
        applyAnthropicAutomaticCacheControl(requestBody);
      }
      return {
        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,
        headers: withClientAnthropicBeta(
          endpoint.buildHeaders(apiKey, authType),
          // Native Messages traffic to Anthropic itself, and nothing else.
          //
          // Host, not the registry key: a tenant can reach Anthropic through a
          // custom provider row (endpointKey `custom`) and needs the flags just
          // as much, while the Anthropic-compatible third parties stay out.
          //
          // `messages` only: a translated request reaches Anthropic through the
          // OpenAI->Anthropic converters, which understand just the content
          // blocks they were written for. A beta that introduces a new block
          // type would have its output silently dropped on the way back, which
          // is worse than the 400 we are fixing. Native Messages responses pass
          // through byte-for-byte, so unknown blocks survive there.
          ctx.apiMode === 'messages' && isAnthropicHost(endpoint.baseUrl)
            ? ctx.clientAnthropicBeta
            : undefined,
        ),
        requestBody,
        structuredOutputToolName: syntheticToolName,
      };
    }

    if (endpoint.format === 'chatgpt') {
      const requestBody =
        ctx.apiMode === 'responses'
          ? // ChatGPT subscription tokens hit the Codex Responses backend, which
            // requires instruction text, list-shaped input, and upstream SSE even
            // when Manifest returns a non-streaming JSON response to the caller.
            // It also rejects sampling/metadata/cache fields the OpenAI SDK
            // routinely sends, so we drop those before forwarding.
            toNativeResponsesRequest(body, bareModel, {
              defaultInstructions: endpointKey === 'openai-subscription',
              inputList: endpointKey === 'openai-subscription',
              forceStream: endpointKey === 'openai-subscription',
              stripCodexUnsupported: endpointKey === 'openai-subscription',
            })
          : toResponsesRequest(requestSource, bareModel, {
              // The subscription backend only serves SSE. Manifest buffers it
              // for non-streaming callers in handleNonStreamResponse.
              stream:
                endpointKey === 'openai-subscription'
                  ? true
                  : endpointKey === 'openai-responses' ||
                      endpointKey === 'xai-responses' ||
                      endpoint.forwardResponsesStream
                    ? ctx.stream
                    : undefined,
              // The ChatGPT subscription backend rejects max_output_tokens with
              // unsupported_parameter; only opt in for the API-key paths.
              mapMaxOutputTokens:
                endpointKey === 'openai-responses' ||
                endpointKey === 'copilot-responses' ||
                endpointKey === 'xai-responses' ||
                endpoint.acceptsMaxOutputTokens,
              // OpenAI and xAI /responses endpoints accept prompt_cache_key.
              // Other Responses-shaped backends may 400 on unknown params.
              forwardPromptCacheKey:
                endpointKey === 'openai-subscription' ||
                endpointKey === 'openai-responses' ||
                endpointKey === 'xai-responses',
              // Only OpenAI infrastructure is known to accept
              // reasoning.summary; other Responses backends may 400 on it.
              mapReasoningEffort:
                endpointKey === 'openai-subscription' || endpointKey === 'openai-responses',
            });
      if (endpointKey === 'xai-responses') {
        applyHashedPromptCacheKey(requestBody, ctx.providerCacheKey);
      }
      if (endpointKey === 'openai-responses' && ctx.apiMode === 'messages') {
        applyAnthropicUserIdForOpenAi(requestBody, requestSource);
      }
      // Anthropic Messages carry `thinking`, which the Responses shape has no
      // field for. Translate a disabled request to an explicit no-reasoning
      // effort so the caller's intent survives the cross-protocol route. The
      // same reasoning-support and endpoint gates as the chat path apply:
      // only OpenAI infrastructure accepts `reasoning`, and only a reasoning
      // model accepts the effort tier.
      if (
        (endpointKey === 'openai-responses' || endpointKey === 'openai-subscription') &&
        ctx.apiMode === 'messages'
      ) {
        const effort = anthropicThinkingEffort(
          requestSource,
          this.modelSupportsReasoning('openai', ctx.model),
        );
        if (effort !== undefined && requestBody.reasoning === undefined) {
          requestBody.reasoning = { effort };
        }
      }
      if (endpointKey === 'openai-responses' || endpointKey === 'openai-subscription') {
        applyHashedPromptCacheKey(requestBody, ctx.providerCacheKey);
      }
      // Force upstream streaming for copilot-responses so the SSE collector in
      // handleNonStreamResponse stays the single source of truth. Without this,
      // an explicit `stream: false` from the caller could hand us a plain JSON
      // body that our SSE parser would silently drop (mnfst/llm-gateway#1849).
      if (endpointKey === 'copilot-responses') {
        requestBody.stream = true;
      }
      return {
        url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,
        headers: endpoint.buildHeaders(apiKey, authType),
        requestBody,
      };
    }

    // OpenAI-compatible path (default)
    const sanitized = sanitizeOpenAiBody(requestSource, endpointKey, ctx.model);
    if (stream && endpoint.streamUsageReporting === 'openai_stream_options') {
      const existing =
        typeof sanitized.stream_options === 'object' && sanitized.stream_options !== null
          ? (sanitized.stream_options as Record<string, unknown>)
          : {};
      sanitized.stream_options = { ...existing, include_usage: true };
    }
    const requestBody = { ...sanitized, model: bareModel, stream };
    if (endpointKey === 'openai') {
      if (ctx.apiMode === 'messages') {
        applyAnthropicUserIdForOpenAi(requestBody);
        applyAnthropicThinkingForOpenAi(
          requestBody,
          this.modelSupportsReasoning(endpointKey, ctx.model),
        );
      }
      applyHashedPromptCacheKey(requestBody, ctx.providerCacheKey);
    }
    if (endpointKey === 'mistral') {
      applyHashedPromptCacheKey(requestBody, ctx.providerCacheKey);
    }
    if (endpointKey === 'moonshot') {
      applyHashedPromptCacheKey(requestBody, ctx.providerCacheKey);
    }
    if (endpointKey === 'fireworks') {
      applyHashedPromptCacheKey(requestBody, ctx.providerCacheKey);
    }
    if (endpointKey === 'qwen' || endpointKey === 'qwen-subscription') {
      injectOpenAiMessageCacheControl(requestBody);
    }
    if (endpointKey === 'openrouter') {
      const cacheMode = openRouterCacheMode(ctx.model);
      if (cacheMode) {
        injectOpenRouterCacheControl(requestBody, cacheMode);
        if (cacheMode === 'anthropic') {
          applyAnthropicAutomaticCacheControl(requestBody);
        }
      }
    }
    return {
      url: `${endpoint.baseUrl}${endpoint.buildPath(bareModel)}`,
      headers: endpoint.buildHeaders(apiKey, authType),
      requestBody,
    };
  }

  private async executeFetch(
    url: string,
    headers: Record<string, string>,
    requestBody: Record<string, unknown>,
    signal: AbortSignal | undefined,
    stream: boolean,
    formatFlags: {
      isGoogle: boolean;
      isAnthropic: boolean;
      isChatGpt: boolean;
      isResponses?: boolean;
      isCodeAssist?: boolean;
      structuredOutputToolName?: string;
      responsesTextFormat?: Record<string, unknown>;
      responsesToolNames?: ResponsesToolNames;
    },
  ): Promise<ForwardResult> {
    let fetchSignal: AbortSignal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutController: AbortController | undefined;
    if (stream) {
      timeoutController = new AbortController();
      timeout = setTimeout(() => {
        const timeoutError = new Error('Upstream provider request timed out');
        timeoutError.name = 'TimeoutError';
        timeoutController?.abort(timeoutError);
      }, PROVIDER_TIMEOUT_MS);
      fetchSignal = signal
        ? AbortSignal.any([timeoutController.signal, signal])
        : timeoutController.signal;
    } else {
      const timeoutSignal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: fetchSignal,
        // Block redirect-based SSRF escalation: a hostile upstream could 302
        // to a private/metadata endpoint after our pre-fetch validation.
        redirect: 'error',
      });
    } catch (err) {
      const errorLike =
        err !== null && typeof err === 'object'
          ? (err as { message?: unknown; name?: unknown })
          : undefined;
      const message = typeof errorLike?.message === 'string' ? errorLike.message : String(err);
      const sanitizedError = new Error(message.replace(/key=[^&\s]+/gi, 'key=***'));
      if (typeof errorLike?.name === 'string') sanitizedError.name = errorLike.name;
      throw sanitizedError;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    return { response, ...formatFlags };
  }

  /**
   * Response/stream converters are assigned as properties (not methods) so they
   * delegate straight through to `provider-client-converters` without an extra
   * wrapper frame, while remaining mockable via DI in tests.
   */
  readonly convertChatGptResponse = chatGptResponseConverter;
  readonly createChatGptStreamTransformer = chatGptStreamTransformerFactory;
  readonly convertGoogleResponse = googleResponseConverter;
  readonly convertGoogleStreamChunk = googleStreamChunkConverter;
  readonly convertAnthropicResponse = anthropicResponseConverter;
  readonly convertAnthropicStreamChunk = anthropicStreamChunkConverter;
  readonly createAnthropicStreamTransformer = createAnthropicTransformer;
  readonly createReasoningContentStreamTransformer = reasoningContentStreamTransformer;
  readonly collectChatGptSseResponse = chatGptSseCollector;
}
