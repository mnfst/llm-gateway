import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AuthType, ModelRoute } from 'manifest-shared';
import { applyRequestParamDefaults } from 'manifest-shared';
import { AgentModelParamsService } from '../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';
import { AutofixService, type AutofixAttempt } from '../autofix/autofix.service';
import { getAutofixRetry, type AutofixRecord } from '../autofix/autofix.types';

/**
 * Context for the per-attempt param-defaults merge. Carries the agentId so
 * `applyParamMerge` can ask the model-params service for the configuration
 * that belongs to this attempt's (provider, auth_type, model) tuple — not
 * the primary route's. Storage is model-scoped on the new
 * `agent_model_params` table, so cross-provider leak is structurally
 * impossible; we no longer need a provider-keyed filter, and Manifest's
 * old tier-aware opinion layer is gone too (only the user's explicit
 * config and the provider's natural default participate).
 */
export interface ParamMergeContext {
  agentId: string;
  scopeKey: string;
}

interface ForwardProviderOptions {
  provider: string;
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  resolveChatBody?: ResolveChatBody;
  stream: boolean;
  sessionKey: string;
  /**
   * Scoped replay-cache key (`sessionScope.cacheKey`). The reasoning cache must
   * read with the same key the response handler wrote with.
   */
  reasoningCacheKey?: string;
  providerCacheKey?: string;
  signal?: AbortSignal;
  authType?: string;
  rawApiKey?: string;
  providerKeyLabel?: string;
  agentId?: string;
  tenantId?: string;
  resourceUrl?: string;
  providerRegion?: string | null;
  apiMode?: ProxyApiMode;
  signatureLookup?: SignatureLookup;
  thinkingLookup?: ThinkingBlockLookup;
  /** The caller's raw `anthropic-beta` header, merged in when the endpoint is Anthropic. */
  clientAnthropicBeta?: string | string[];
  paramMergeContext?: ParamMergeContext;
  tenantProviderId?: string | null;
  startProviderAttempt?: StartProviderAttempt;
}

import { ProviderKeyService } from '../routing-core/provider-key.service';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { CustomProviderService } from '../custom-provider/custom-provider.service';
import { resolveForwardEndpoint } from './forward-endpoint-resolver';
import { OpenaiOauthService } from '../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../oauth/xai/xai-oauth.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { ProviderClient, ForwardResult } from './provider-client';
import { resolveEndpointKey } from './provider-endpoints';
import { CopilotTokenService } from './copilot-token.service';
import { ReasoningContentCache } from './reasoning-content-cache';
import { buildProviderExtraHeaders } from './provider-hooks';
import { shouldTriggerFallback } from './fallback-status-codes';
import { peekStream, STREAM_WARMUP_MS } from './stream-warmup';
import { inferProviderFromModelName } from '../../common/utils/provider-aliases';
import { normalizeProviderModel } from '../../common/utils/anthropic-model-id';
import {
  isTransportError,
  buildTransportErrorResponse,
  describeTransportError,
} from './proxy-transport';
import type {
  SignatureLookup,
  ThinkingBlockLookup,
  ResolveChatBody,
  ProviderAttemptRef,
  StartProviderAttempt,
} from './proxy-types';
import type { ProxyApiMode } from './proxy-types';
import { refreshRejectedOAuthCredential } from './oauth-credentials';
import {
  buildCredentialFailureFallback,
  presentCredentialFailure,
  resolveRouteCredentials,
  type RouteCredentialDeps,
} from './route-credentials';
import { recordingResponseFromText } from './attempt-recording-capture';
import {
  CredentialRejectionCooldown,
  type RejectedCredentialRef,
} from './credential-rejection-cooldown';

// Fallback cooldown applied when an upstream 429 carries no usable Retry-After.
// Kept short (15s) on purpose: many providers rate-limit on brief RPM/burst
// windows and omit Retry-After entirely, so a long blackout would sideline a
// route that recovered seconds later. Explicit Retry-After values are always
// honored (capped at MAX) regardless of this default.
const RATE_LIMIT_COOLDOWN_DEFAULT_MS = 15_000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWNS = 2_000;
const PROVIDER_ATTEMPT_REF = Symbol('providerAttemptRef');

type AttemptTaggedError = Error & { [PROVIDER_ATTEMPT_REF]?: ProviderAttemptRef };

function attemptFromError(error: unknown): ProviderAttemptRef | undefined {
  return error instanceof Error ? (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] : undefined;
}

export interface FailedFallback {
  model: string;
  provider: string;
  fallbackIndex: number;
  status: number;
  errorBody: string;
  // Auth used for this specific attempt. When the caller passes structured
  // routes the value is taken from the route; otherwise it falls back to the
  // legacy inference path. Either way the recorder can attribute the error
  // to the actual credential that failed instead of inheriting the primary's.
  authType?: AuthType;
  // The tenant_providers row that served this failed attempt, so the recorded
  // error row is scoped to the right connection. NULL for local/Ollama.
  tenantProviderId?: string | null;
  // Label of that same connection, so a failed hop records the key it used
  // instead of inheriting the primary's label.
  keyLabel?: string;
  attempt?: ProviderAttemptRef;
  /** False when the route was rejected locally (for example by a cooldown). */
  providerCallStarted?: boolean;
  /**
   * Autofix audit for this hop when Phoenix was consulted. Stamped onto the
   * failed hop's row so a recovered fallback keeps its Phoenix decision.
   */
  autofix?: AutofixRecord;
  /** Which side of the Autofix retry pair this row is. Defaults to `original`. */
  autofixRole?: 'original' | 'retry';
}

@Injectable()
export class ProxyFallbackService {
  private readonly logger = new Logger(ProxyFallbackService.name);
  private readonly rateLimitCooldowns = new Map<string, number>();
  private readonly credentialRejections = new CredentialRejectionCooldown();

  constructor(
    private readonly providerKeyService: ProviderKeyService,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
    private readonly providerClient: ProviderClient,
    private readonly copilotToken: CopilotTokenService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly modelParamsService: AgentModelParamsService,
    private readonly providerParamSpecs: ProviderParamSpecService,
    private readonly reasoningCache: ReasoningContentCache,
    private readonly autofixService: AutofixService,
  ) {}

  /**
   * Per-attempt merge: look up the user's saved params for this
   * (agent, provider, auth_type, model) tuple and fold them into the
   * outbound body. Returns the original body unchanged when no config
   * exists — the provider's natural default applies in that case.
   *
   * Async because saved values still live in the route-scoped params table;
   * the service caches the agent's full row set, so steady-state cost is a
   * Map lookup, not a query. The MPS catalog itself is static/fetched metadata.
   */
  private async applyParamMerge(
    body: Record<string, unknown>,
    ctx: ParamMergeContext | undefined,
    provider: string,
    authType: AuthType | string | undefined,
    model: string,
  ): Promise<Record<string, unknown>> {
    if (!ctx || !authType) return body;
    const modelParams = await this.modelParamsService.get(
      ctx.agentId,
      ctx.scopeKey,
      provider,
      authType as AuthType,
      model,
    );
    const specs = await this.providerParamSpecs.getSpecs(provider, authType as AuthType, model);
    return applyRequestParamDefaults(body, modelParams, specs);
  }

  async tryFallbacks(
    agentId: string,
    tenantId: string,
    fallbackModels: string[],
    body: Record<string, unknown>,
    stream: boolean,
    sessionKey: string,
    primaryModel: string,
    signal?: AbortSignal,
    primaryProvider?: string,
    primaryAuthType?: string,
    signatureLookup?: SignatureLookup,
    thinkingLookup?: ThinkingBlockLookup,
    apiMode?: ProxyApiMode,
    resolveChatBody?: ResolveChatBody,
    fallbackRoutes?: ModelRoute[] | null,
    paramMergeContext?: ParamMergeContext,
    startProviderAttempt?: StartProviderAttempt,
    /** Dashboard URL embedded in mid-chain M100/M102 credential failure bodies. */
    credentialDashboardUrl?: string,
    providerCacheKey?: string,
    reasoningCacheKey?: string,
    /** The caller's raw `anthropic-beta` header; a fallback hop onto Anthropic needs it too. */
    clientAnthropicBeta?: string | string[],
  ): Promise<{
    success: {
      forward: ForwardResult;
      model: string;
      provider: string;
      fallbackIndex: number;
      authType?: AuthType;
      keyLabel?: string;
      tenantProviderId: string | null;
      /** Phoenix audit when this hop was recovered by Autofix. */
      autofix?: AutofixRecord;
    } | null;
    failures: FailedFallback[];
  }> {
    const failures: FailedFallback[] = [];

    // Track auth types that already failed per provider so fallbacks for the
    // same provider try a different credential (fixes #1272). Only used on
    // the legacy inference path — when fallbackRoutes is present, the route's
    // explicit auth wins.
    const failedAuthByProvider = new Map<string, Set<string>>();
    if (primaryProvider && primaryAuthType) {
      failedAuthByProvider.set(primaryProvider.toLowerCase(), new Set([primaryAuthType]));
    }

    const useStructuredRoutes =
      Array.isArray(fallbackRoutes) && fallbackRoutes.length === fallbackModels.length;

    for (let i = 0; i < fallbackModels.length; i++) {
      const requestedModel = fallbackModels[i];
      const route = useStructuredRoutes ? fallbackRoutes![i] : null;
      let provider: string | undefined;
      let authType: AuthType;
      // Pinned key label: prefer the structured route's keyLabel. Each
      // fallback can be pinned to a specific provider key (e.g. "Work" vs
      // "Personal" Anthropic Console). When no label is supplied for a
      // subscription fallback, resolve the priority-0 key's label so OAuth
      // refresh persistence updates the same key getProviderApiKey selected.
      let providerKeyLabel = route?.keyLabel ?? undefined;

      if (route) {
        provider = route.provider;
        authType = route.authType;
      } else {
        const pricing = this.pricingCache.getByModel(requestedModel);
        if (CustomProviderService.isCustom(requestedModel)) {
          const slashIdx = requestedModel.indexOf('/');
          provider = slashIdx > 0 ? requestedModel.substring(0, slashIdx) : requestedModel;
        } else {
          const prefix = inferProviderFromModelName(requestedModel);
          provider =
            (prefix && (await this.providerKeyService.hasActiveProvider(tenantId, prefix, agentId))
              ? prefix
              : undefined) ??
            pricing?.provider ??
            (await this.providerKeyService.findProviderForModel(tenantId, requestedModel, agentId));
        }
        if (!provider) {
          this.logger.debug(`Fallback ${i}: skipping model=${requestedModel} (no provider data)`);
          continue;
        }
        const excludeAuth = failedAuthByProvider.get(provider.toLowerCase());
        authType = (await this.providerKeyService.getAuthType(
          tenantId,
          provider,
          excludeAuth,
          agentId,
        )) as AuthType;
      }
      const model = normalizeProviderModel(provider, requestedModel);
      // Same credential resolution as primary (select key + OAuth unwrap).
      const credentials = await resolveRouteCredentials(this.routeCredentialDeps(), {
        agentId,
        tenantId,
        provider,
        authType,
        providerKeyLabel,
      });
      if (!credentials.ok) {
        this.logger.debug(
          `Fallback ${i}: credential failure model=${model} provider=${provider} reason=${credentials.reason}`,
        );
        failures.push(
          buildCredentialFailureFallback({
            model,
            provider,
            fallbackIndex: i,
            authType,
            tenantProviderId: credentials.tenantProviderId,
            keyLabel: providerKeyLabel,
            presentation: presentCredentialFailure(
              credentials.reason,
              provider,
              credentialDashboardUrl ?? 'the dashboard',
            ),
            startProviderAttempt,
          }),
        );
        continue;
      }
      // resolveRouteCredentials always reports the row it selected, which may
      // differ from the pin when the pin matched nothing.
      providerKeyLabel = credentials.keyLabel;
      const tenantProviderId = credentials.tenantProviderId;

      this.logger.log(
        `Fallback ${i}: trying model=${model} provider=${provider} auth_type=${authType} (primary=${primaryModel})`,
      );

      // A hop's stream is warmed up exactly like the primary's: a 200 that
      // never sends a byte becomes a failed hop, so the next route still gets
      // its turn instead of the client receiving a dead stream.
      const forward = await this.warmUpStreamBody(
        await this.tryForwardToProvider({
          provider,
          apiKey: credentials.apiKey,
          model,
          body,
          resolveChatBody,
          stream,
          sessionKey,
          reasoningCacheKey,
          providerCacheKey,
          signal,
          agentId,
          tenantId,
          rawApiKey: credentials.rawApiKey,
          providerKeyLabel,
          authType,
          apiMode,
          resourceUrl: credentials.resourceUrl,
          providerRegion: credentials.providerRegion,
          signatureLookup,
          thinkingLookup,
          clientAnthropicBeta,
          paramMergeContext,
          tenantProviderId,
          startProviderAttempt,
        }),
        { stream, provider, model },
      );

      // Autofix runs on a failed fallback hop too, not just the primary: a
      // fallback that rejects a request-side param (e.g. an unsupported
      // response_format) can carry its own Phoenix patch, and retrying it on
      // this same transport recovers the request instead of recording a dead
      // hop. Consent is enforced inside maybeHeal, exactly like the primary.
      let autofixAttempt: AutofixAttempt | null = null;
      let preHealErrorBody: string | null = null;
      const fallbackApiMode = forward.wireApiMode ?? apiMode;
      if (
        !forward.response.ok &&
        this.autofixService.isRepairable(forward.response.status) &&
        forward.wireRequestBody &&
        forward.retryWireBody &&
        fallbackApiMode
      ) {
        // Keep the failed body readable for the audit row if the patch heals —
        // maybeHeal consumes the live response.
        preHealErrorBody = await forward.response.clone().text();
        autofixAttempt = await this.maybeHealFallback({
          forward,
          requestBody: forward.wireRequestBody,
          apiMode: fallbackApiMode,
          agentId,
          tenantId,
          provider,
          model,
          authType,
          tenantProviderId,
          providerKeyLabel,
          signal,
          startProviderAttempt,
          stream,
        });
      }
      const finalForward = autofixAttempt?.forward ?? forward;
      // A retry is sent only when Phoenix handed back a patch. When one was
      // sent, the original hop is a distinct provider attempt that needs its own
      // terminal row; otherwise finalForward IS the original.
      const retrySent = autofixAttempt
        ? getAutofixRetry(autofixAttempt.record) !== undefined
        : false;
      const originalFailure = (): FailedFallback => ({
        model,
        provider,
        fallbackIndex: i,
        status: forward.response.status,
        errorBody: preHealErrorBody!,
        authType,
        tenantProviderId,
        // Selected-row label (credentials.keyLabel already folded in above),
        // so this row's label and tenant_provider_id name the same connection.
        keyLabel: providerKeyLabel,
        attempt: forward.attempt,
        providerCallStarted: forward.providerCallStarted,
        autofix: autofixAttempt?.record,
        autofixRole: 'original',
      });

      if (finalForward.response.ok) {
        // The hop that failed first is still recorded when Autofix recovers it,
        // so a healed fallback keeps the same audit trail as a healed primary.
        if (retrySent) failures.push(originalFailure());
        return {
          success: {
            forward: finalForward,
            model,
            provider,
            fallbackIndex: i,
            authType,
            // Label of the connection row that served the attempt — stamped
            // alongside its tenant_provider_id so the pair always matches.
            keyLabel: providerKeyLabel,
            tenantProviderId,
            // Fallback's own Phoenix audit, threaded to the recorder so a healed
            // fallback hop carries the same metadata as a healed primary.
            autofix: retrySent ? autofixAttempt?.record : undefined,
          },
          failures,
        };
      }

      const errorBody = await finalForward.response.text();
      await finalForward.attempt?.finishRecording?.(recordingResponseFromText(errorBody));
      // A failed patched retry is a second provider attempt: record the original
      // hop too, so Autofix never leaves it dangling `pending`.
      if (retrySent) failures.push(originalFailure());
      failures.push({
        model,
        provider,
        fallbackIndex: i,
        status: finalForward.response.status,
        errorBody,
        authType,
        tenantProviderId,
        // Selected-row label (credentials.keyLabel already folded in above),
        // so this row's label and tenant_provider_id name the same connection.
        keyLabel: providerKeyLabel,
        attempt: finalForward.attempt,
        providerCallStarted: finalForward.providerCallStarted,
        ...(autofixAttempt
          ? { autofix: autofixAttempt.record, autofixRole: retrySent ? 'retry' : 'original' }
          : {}),
      });

      const existing = failedAuthByProvider.get(provider.toLowerCase());
      const updated = new Set(existing);
      updated.add(authType);
      failedAuthByProvider.set(provider.toLowerCase(), updated);

      if (!shouldTriggerFallback(forward.response.status)) break;
    }
    return { success: null, failures };
  }

  /**
   * Heal a failed fallback hop before giving up on it. Phoenix patches are
   * scoped per provider/model, so a fallback model with its own known issue can
   * be recovered even when the primary could not. The patched body is resent
   * through the SAME fallback transport (`retryWireBody`) rather than
   * re-resolved against the full routing chain: the fallback is already the
   * deliberate alternative route, and hopping back to the primary here would
   * undo that.
   *
   * Returns null when Autofix declines (off for the agent, non-repairable status,
   * no patch) — callers then keep the original failure. The caller has already
   * established that the forward carries a wire body and a retry hook.
   */
  private async maybeHealFallback(input: {
    forward: ForwardResult;
    requestBody: Record<string, unknown>;
    apiMode: ProxyApiMode;
    agentId: string;
    tenantId: string;
    provider: string;
    model: string;
    authType: AuthType;
    tenantProviderId: string | null;
    providerKeyLabel?: string;
    signal?: AbortSignal;
    startProviderAttempt?: StartProviderAttempt;
    stream: boolean;
  }): Promise<AutofixAttempt | null> {
    return this.autofixService.maybeHeal({
      forward: input.forward,
      agentId: input.agentId,
      tenantId: input.tenantId,
      provider: input.provider,
      model: input.model,
      authType: input.authType,
      apiMode: input.apiMode,
      requestBody: input.requestBody,
      // Warm up the patched retry before Autofix sees it, so a retry whose
      // stream stalls counts as a failed patch rather than a healed request.
      reforward: async (healedBody) =>
        this.warmUpStreamBody(
          await this.retryWireBody(input.forward, healedBody, {
            provider: input.provider,
            model: input.model,
            authType: input.authType,
            agentId: input.agentId,
            tenantProviderId: input.tenantProviderId,
            providerKeyLabel: input.providerKeyLabel,
            startProviderAttempt: input.startProviderAttempt,
            signal: input.signal,
            stream: input.stream,
          }),
          input,
        ),
    });
  }

  /**
   * Streaming counterpart of {@link bufferNonStreamBody} for fallback hops.
   * Peek at the first chunk before the hop is committed; on a stall, error or
   * empty stream, return a synthetic 502 so the chain treats it as a failed
   * hop. The primary gets the same warm-up in ProxyService.proxyRequest.
   */
  private async warmUpStreamBody(
    forward: ForwardResult,
    opts: { stream: boolean; provider: string; model: string },
  ): Promise<ForwardResult> {
    const { response, attempt } = forward;
    if (!opts.stream || !response.ok || !response.body) return forward;
    const warmup = await peekStream(response.body, STREAM_WARMUP_MS);
    if (warmup.ok) {
      return {
        ...forward,
        response: new Response(warmup.stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      };
    }
    if (attempt) attempt.completedAtMs = Date.now();
    this.logger.warn(
      `Fallback stream warmup failed: provider=${opts.provider} model=${opts.model} reason=${warmup.reason} message=${warmup.message}`,
    );
    return {
      ...forward,
      response: new Response(
        JSON.stringify({ error: { message: `Stream warmup failed: ${warmup.message}` } }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ),
    };
  }

  private routeCredentialDeps(): RouteCredentialDeps {
    return {
      providerKeyService: this.providerKeyService,
      oauth: {
        openaiOauth: this.openaiOauth,
        minimaxOauth: this.minimaxOauth,
        anthropicOauth: this.anthropicOauth,
        geminiOauth: this.geminiOauth,
        kiroOauth: this.kiroOauth,
        xaiOauth: this.xaiOauth,
      },
    };
  }

  async tryForwardToProvider(opts: ForwardProviderOptions): Promise<ForwardResult> {
    const cooldown = this.getActiveRateLimitCooldown(opts);
    if (cooldown) {
      return this.buildRateLimitCooldownForward(opts, cooldown);
    }
    const rejectedUntil = this.credentialRejections.rejectedUntil(
      this.credentialRef(opts, opts.apiKey),
    );
    if (rejectedUntil) {
      return this.buildCredentialRejectedForward(opts, rejectedUntil);
    }

    try {
      const forward = await this.forwardToProvider(opts);
      const { forward: result, apiKey } = await this.retryOAuthSubscriptionAfterRejectedToken(
        opts,
        forward,
      );
      this.recordRateLimitCooldown(opts, result.response);
      // Still 401 after any OAuth refresh: the credential is stale (refresh
      // rejected, or the account itself is refused). Skip it until it changes.
      if (result.response.status === 401) {
        this.credentialRejections.reject(this.credentialRef(opts, apiKey));
      }
      return await this.bufferNonStreamBody(result, opts);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (!isTransportError(error)) throw error;

      const failureResponse = buildTransportErrorResponse(error);
      const message = describeTransportError(error);
      this.logger.warn(
        `Provider transport failure: provider=${opts.provider} model=${opts.model} status=${failureResponse.status} message=${message}`,
      );

      return {
        response: failureResponse,
        attempt: attemptFromError(error),
        providerCallStarted: true,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  /**
   * Read a successful non-streaming body before the route is committed. The
   * fallback decision only sees the status line, so a provider that sends 200
   * headers and then times out or drops the socket mid-body used to fail later
   * in the response handler, as an M500 with no fallback. Reading it here turns
   * that failure into the same synthetic 503/504 as a pre-response transport
   * error, which the fallback chain already handles. Only buffers when the
   * caller is known to be non-streaming: nothing has reached the client yet, so
   * another route can still answer.
   */
  private async bufferNonStreamBody(
    forward: ForwardResult,
    opts: { stream?: boolean; signal?: AbortSignal; provider: string; model: string },
  ): Promise<ForwardResult> {
    const { response, attempt } = forward;
    if (opts.stream !== false || !response.ok || !response.body) return forward;
    try {
      const body = await response.arrayBuffer();
      // The attempt ends when its body does, not when headers arrived.
      if (attempt) attempt.completedAtMs = Date.now();
      return {
        ...forward,
        response: new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      };
    } catch (error) {
      if (attempt) attempt.completedAtMs = Date.now();
      if (opts.signal?.aborted || !isTransportError(error)) {
        if (attempt && error instanceof Error) {
          (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] = attempt;
        }
        throw error;
      }
      const failureResponse = buildTransportErrorResponse(error);
      this.logger.warn(
        `Provider body read failure: provider=${opts.provider} model=${opts.model} status=${failureResponse.status} message=${describeTransportError(error)}`,
      );
      return { ...forward, response: failureResponse, providerCallStarted: true };
    }
  }

  /** Re-send a healed body without rebuilding the already-resolved provider request. */
  async retryWireBody(
    forward: ForwardResult,
    healedBody: Record<string, unknown>,
    opts?: Pick<
      ForwardProviderOptions,
      | 'provider'
      | 'model'
      | 'authType'
      | 'agentId'
      | 'tenantProviderId'
      | 'providerKeyLabel'
      | 'startProviderAttempt'
      | 'signal'
    > & { stream?: boolean },
  ): Promise<ForwardResult> {
    if (!forward.retryWireBody) {
      throw new Error('Provider forward does not support wire-body retry');
    }
    if (!opts) return forward.retryWireBody(healedBody);
    const attempt = opts.startProviderAttempt?.({
      provider: opts.provider,
      model: opts.model,
      authType: opts.authType,
      tenantProviderId: opts.tenantProviderId,
      keyLabel: opts.providerKeyLabel,
    });
    try {
      const retried = await forward.retryWireBody(healedBody, attempt);
      if (attempt) attempt.completedAtMs = Date.now();
      // A healed retry can itself be rate-limited. Record the cooldown so the
      // next attempt on this route skips it, exactly as tryForwardToProvider
      // does for a first attempt.
      this.recordRateLimitCooldownForKey(
        this.rateLimitCooldownKey({
          agentId: opts.agentId,
          authType: opts.authType,
          provider: opts.provider,
          providerKeyLabel: opts.providerKeyLabel,
          model: opts.model,
        }),
        retried.response,
      );
      return await this.bufferNonStreamBody(
        { ...retried, attempt, providerCallStarted: true },
        opts,
      );
    } catch (error) {
      if (attempt) attempt.completedAtMs = Date.now();
      if (attempt && error instanceof Error) {
        (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] = attempt;
      }
      if (opts.signal?.aborted || !isTransportError(error)) throw error;

      const failureResponse = buildTransportErrorResponse(error);
      const message = describeTransportError(error);
      this.logger.warn(
        `Provider transport failure: provider=${opts.provider} model=${opts.model} status=${failureResponse.status} message=${message}`,
      );
      return {
        response: failureResponse,
        attempt,
        providerCallStarted: true,
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      };
    }
  }

  private getActiveRateLimitCooldown(opts: ForwardProviderOptions): number | null {
    const key = this.rateLimitCooldownKey(opts);
    if (!key) return null;
    const expiresAt = this.rateLimitCooldowns.get(key);
    if (!expiresAt) return null;
    if (expiresAt <= Date.now()) {
      this.rateLimitCooldowns.delete(key);
      return null;
    }
    return expiresAt;
  }

  private buildRateLimitCooldownForward(
    opts: ForwardProviderOptions,
    expiresAt: number,
  ): ForwardResult {
    const message =
      `Provider route temporarily cooling down after an upstream 429: ` +
      `${opts.provider}/${opts.model}`;
    return this.buildLocalSkipForward(opts, 429, message, expiresAt);
  }

  private buildCredentialRejectedForward(
    opts: ForwardProviderOptions,
    expiresAt: number,
  ): ForwardResult {
    const credential = opts.providerKeyLabel ? `"${opts.providerKeyLabel}" ` : '';
    const message =
      `${opts.provider} rejected the ${credential}credential with a 401 and it is skipped ` +
      `for now. Reconnect or replace it if this continues.`;
    return this.buildLocalSkipForward(opts, 401, message, expiresAt);
  }

  /**
   * A route skipped locally, without calling the provider. The status keeps
   * the fallback chain moving; the attempt is not persisted as a provider call.
   */
  private buildLocalSkipForward(
    opts: ForwardProviderOptions,
    status: number,
    message: string,
    expiresAt: number,
  ): ForwardResult {
    const attempt = opts.startProviderAttempt?.({
      provider: opts.provider,
      model: opts.model,
      authType: opts.authType,
      tenantProviderId: opts.tenantProviderId,
      keyLabel: opts.providerKeyLabel,
      providerCallStarted: false,
    });
    if (attempt) attempt.completedAtMs = Date.now();
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    return {
      response: new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(retryAfterSeconds),
        },
      }),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
      providerCallStarted: false,
      attempt,
    };
  }

  private credentialRef(opts: ForwardProviderOptions, secret: string): RejectedCredentialRef {
    return {
      tenantId: opts.tenantId,
      connectionId: opts.tenantProviderId,
      provider: opts.provider,
      authType: opts.authType,
      keyLabel: opts.providerKeyLabel,
      model: opts.model,
      secret,
    };
  }

  private recordRateLimitCooldown(opts: ForwardProviderOptions, response: Response): void {
    this.recordRateLimitCooldownForKey(this.rateLimitCooldownKey(opts), response);
  }

  private recordRateLimitCooldownForKey(key: string | null, response: Response): void {
    if (response.status !== 429 || !key) return;
    if (this.rateLimitCooldowns.size >= MAX_RATE_LIMIT_COOLDOWNS) {
      this.evictExpiredRateLimitCooldowns();
      if (this.rateLimitCooldowns.size >= MAX_RATE_LIMIT_COOLDOWNS) {
        this.evictOldestRateLimitCooldown();
      }
    }
    const ttlMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
    this.rateLimitCooldowns.set(key, Date.now() + ttlMs);
  }

  private evictExpiredRateLimitCooldowns(now = Date.now()): void {
    for (const [key, expiresAt] of this.rateLimitCooldowns) {
      if (expiresAt <= now) this.rateLimitCooldowns.delete(key);
    }
  }

  private evictOldestRateLimitCooldown(): void {
    let oldestKey: string | null = null;
    let oldestExpiresAt = Number.POSITIVE_INFINITY;
    for (const [key, expiresAt] of this.rateLimitCooldowns) {
      if (expiresAt >= oldestExpiresAt) continue;
      oldestKey = key;
      oldestExpiresAt = expiresAt;
    }
    if (oldestKey) this.rateLimitCooldowns.delete(oldestKey);
  }

  private parseRetryAfterMs(retryAfter: string | null): number {
    if (!retryAfter) return RATE_LIMIT_COOLDOWN_DEFAULT_MS;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, RATE_LIMIT_COOLDOWN_MAX_MS);
    }
    // HTTP-date form (RFC 9110): honor the provider's stated instant the same
    // way as the numeric-seconds form — respect the actual delta, capped at
    // MAX, with no artificial floor. A past or nonsensical date carries no
    // usable duration, so fall back to the short default.
    const retryAt = Date.parse(retryAfter);
    if (Number.isNaN(retryAt)) return RATE_LIMIT_COOLDOWN_DEFAULT_MS;
    const deltaMs = retryAt - Date.now();
    if (deltaMs <= 0) return RATE_LIMIT_COOLDOWN_DEFAULT_MS;
    return Math.min(deltaMs, RATE_LIMIT_COOLDOWN_MAX_MS);
  }

  private rateLimitCooldownKey(opts: {
    agentId?: string;
    authType?: string;
    provider: string;
    providerKeyLabel?: string;
    model: string;
  }): string | null {
    if (!opts.agentId || !opts.authType) return null;
    return [
      opts.agentId,
      opts.provider.toLowerCase(),
      opts.authType,
      opts.providerKeyLabel ?? '',
      opts.model.toLowerCase(),
    ].join('\u0000');
  }

  /**
   * Refresh an OAuth token the provider rejected with a 401 and resend once.
   * Returns the secret the final attempt used, so a still-rejected credential
   * is remembered under the token the next request will actually send.
   */
  private async retryOAuthSubscriptionAfterRejectedToken(
    opts: ForwardProviderOptions,
    forward: ForwardResult,
  ): Promise<{ forward: ForwardResult; apiKey: string }> {
    const unchanged = { forward, apiKey: opts.apiKey };
    if (
      opts.authType !== 'subscription' ||
      forward.response.status !== 401 ||
      !opts.rawApiKey ||
      !opts.agentId ||
      !opts.tenantId
    ) {
      return unchanged;
    }

    const refreshed = await refreshRejectedOAuthCredential(
      opts.provider,
      opts.rawApiKey,
      opts.agentId,
      opts.tenantId,
      opts.providerKeyLabel,
      {
        openaiOauth: this.openaiOauth,
        minimaxOauth: this.minimaxOauth,
        anthropicOauth: this.anthropicOauth,
        geminiOauth: this.geminiOauth,
        kiroOauth: this.kiroOauth,
        xaiOauth: this.xaiOauth,
      },
    );
    if (!refreshed?.apiKey || refreshed.apiKey === opts.apiKey) {
      this.logger.warn(
        `OAuth token rejected upstream and could not be refreshed: provider=${opts.provider} ` +
          `keyLabel=${opts.providerKeyLabel ?? 'default'} agent=${opts.agentId}`,
      );
      return unchanged;
    }

    this.logger.log(
      `OAuth token rejected upstream; refreshed provider=${opts.provider} agent=${opts.agentId}`,
    );
    const rejectedBody = await forward.response
      .clone()
      .text()
      .catch(() => 'OAuth token rejected');
    await forward.attempt?.finishRecording?.(recordingResponseFromText(rejectedBody));
    await forward.attempt?.completeFailure?.({
      status: forward.response.status,
      errorBody: rejectedBody,
      superseded: true,
    });
    const retryOpts = {
      ...opts,
      apiKey: refreshed.apiKey,
      resourceUrl: refreshed.resourceUrl ?? opts.resourceUrl,
    };
    try {
      return { forward: await this.forwardToProvider(retryOpts), apiKey: refreshed.apiKey };
    } catch (error) {
      if (opts.signal?.aborted || !isTransportError(error)) throw error;
      return {
        forward: {
          response: buildTransportErrorResponse(error),
          attempt: attemptFromError(error),
          providerCallStarted: true,
          isGoogle: false,
          isAnthropic: false,
          isChatGpt: false,
        },
        apiKey: refreshed.apiKey,
      };
    }
  }

  private async forwardToProvider(opts: ForwardProviderOptions): Promise<ForwardResult> {
    const {
      provider,
      stream,
      signal,
      authType,
      resourceUrl,
      providerRegion,
      signatureLookup,
      thinkingLookup,
    } = opts;
    // Per-attempt merge: ask the model-params service for this iteration's
    // (provider, auth_type, model) config. Storage is model-scoped on the
    // new agent_model_params table, so a primary OpenAI route with a
    // DeepSeek fallback no longer needs the old per-provider filter —
    // OpenAI's lookup returns null, DeepSeek's returns its own row.
    let body = await this.applyParamMerge(
      opts.body,
      opts.paramMergeContext,
      provider,
      authType,
      opts.model,
    );
    // Agent-scope fallback for providers (OpenCode) that need a session id on
    // every request even when the caller sent no x-session-key. NUL-joined so
    // distinct (tenant, agent) pairs can never collide before hashing.
    const agentScopeKey =
      opts.tenantId && opts.agentId ? `${opts.tenantId}\u0000${opts.agentId}` : undefined;
    const extraHeaders = buildProviderExtraHeaders(provider, opts.providerCacheKey, agentScopeKey);

    // Copilot: exchange the stored GitHub OAuth token for a short-lived API token
    let effectiveKey = opts.apiKey;
    if (provider.toLowerCase() === 'copilot') {
      effectiveKey = await this.copilotToken.getCopilotToken(opts.apiKey);
    }

    // Custom providers store their endpoint on a DB row; fetch it so the shared
    // resolver can build the override. (Kept in the caller to keep the resolver
    // synchronous + DB-free.)
    // Fail closed: TypeORM strips an `undefined` where-value, so without the
    // explicit tenantId guard a missing tenantId would silently degrade to an
    // unscoped lookup by id alone. A real custom-provider forward always carries
    // the caller's tenantId; if it's absent we skip the lookup rather than read a
    // row that could belong to another tenant.
    const customProvider =
      CustomProviderService.isCustom(provider) && opts.tenantId
        ? await this.customProviderRepo.findOne({
            where: { id: CustomProviderService.extractId(provider), tenant_id: opts.tenantId },
          })
        : null;
    const { customEndpoint, forwardModel } = resolveForwardEndpoint({
      provider,
      authType,
      model: opts.model,
      providerRegion,
      resourceUrl,
      customProvider,
      logger: this.logger,
    });

    const reasoningEndpointKey =
      customEndpoint && customEndpoint.format !== 'openai'
        ? null
        : customEndpoint
          ? 'custom'
          : resolveEndpointKey(provider);
    let resolvedChatBody: Promise<Record<string, unknown>> | undefined;
    const resolveChatBody = opts.resolveChatBody
      ? () => {
          resolvedChatBody ??= (async () => {
            let resolved = await opts.resolveChatBody!();
            resolved = await this.applyParamMerge(
              resolved,
              opts.paramMergeContext,
              provider,
              authType,
              opts.model,
            );
            resolved = await this.reasoningCache.prepareRequest(
              resolved,
              opts.reasoningCacheKey ?? opts.sessionKey,
              reasoningEndpointKey,
              forwardModel,
            );
            return resolved;
          })();
          return resolvedChatBody;
        }
      : undefined;
    body = await this.reasoningCache.prepareRequest(
      body,
      opts.reasoningCacheKey ?? opts.sessionKey,
      reasoningEndpointKey,
      forwardModel,
    );

    // For Gemini OAuth, the OAuth blob's `u` field is the
    // CodeAssist project id (not a URL). It must be forwarded so the
    // CodeAssist envelope wrap can include it.
    const providerResource =
      authType === 'subscription' && provider.toLowerCase() === 'gemini' ? resourceUrl : undefined;

    const attempt = opts.startProviderAttempt?.({
      provider,
      model: opts.model,
      authType,
      tenantProviderId: opts.tenantProviderId,
      keyLabel: opts.providerKeyLabel,
    });
    try {
      const forward = await this.providerClient.forward({
        provider,
        apiKey: effectiveKey,
        model: forwardModel,
        body,
        resolveChatBody,
        stream,
        signal,
        extraHeaders,
        customEndpoint,
        authType,
        apiMode: opts.apiMode,
        sessionKey: opts.sessionKey,
        providerCacheKey: opts.providerCacheKey,
        signatureLookup,
        thinkingLookup,
        ...(thinkingLookup
          ? {
              thinkingRouteContext: {
                provider,
                authType,
                model: opts.model,
              },
            }
          : {}),
        clientAnthropicBeta: opts.clientAnthropicBeta,
        providerResource,
        attempt,
      });
      if (attempt) attempt.completedAtMs = Date.now();
      return { ...forward, attempt, providerCallStarted: true };
    } catch (error) {
      if (attempt) attempt.completedAtMs = Date.now();
      if (attempt && error instanceof Error) {
        (error as AttemptTaggedError)[PROVIDER_ATTEMPT_REF] = attempt;
      }
      throw error;
    }
  }
}

export { normalizeProviderModel };
