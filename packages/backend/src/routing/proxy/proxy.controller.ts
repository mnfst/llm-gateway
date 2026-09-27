import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseFilters,
  Logger,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { Request, Response as ExpressResponse } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { v4 as uuid } from 'uuid';
import { Public } from '../../common/decorators/public.decorator';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';
import { IngestionContext } from '../../otlp/interfaces/ingestion-context.interface';
import { ProxyService, type RoutingMeta } from './proxy.service';
import { ProxyRateLimiter } from './proxy-rate-limiter';
import { ProviderClient } from './provider-client';
import { ProxyMessageRecorder, type ManifestBlockedRequestReason } from './proxy-message-recorder';
import { ThoughtSignatureCache } from './thought-signature-cache';
import { ThinkingBlockCache } from './thinking-block-cache';
import { ReasoningContentCache } from './reasoning-content-cache';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { ModelsDevSyncService } from '../../database/models-dev-sync.service';
import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';
import { resolveModelCapabilityMetadata } from '../../model-discovery/model-capabilities';
import { classifyCaller } from './caller-classifier';
import { ObservationReporter } from '../autofix/observation-reporter';
import type { AutofixRecord } from '../autofix/autofix.types';
import { sanitizeRequestHeaders } from './request-headers';
import { buildProxySessionScope } from './proxy-session-scope';
import {
  buildMetaHeaders,
  buildOpenAiCompatibleError,
  currentPrimaryAttemptNumber,
  handleProviderError,
  recordFallbackFailures,
  handleStreamResponse,
  handleNonStreamResponse,
  nextResponsesSequenceNumber,
  recordSuccess,
} from './proxy-response-handler';
import { ProxyExceptionFilter, isChatRenderingClient } from './proxy-exception.filter';
import { sendFriendlyResponse } from './proxy-friendly-response';
import { formatManifestError, type ManifestErrorCode } from '../../common/errors/error-codes';
import {
  MANIFEST_CODE_TO_REASON,
  ManifestError,
  isRecordableManifestCode,
} from '../../common/errors/manifest-error';
import type {
  ProviderAttemptRef,
  ProviderAttemptStart,
  ProxyApiMode,
  StartProviderAttempt,
} from './proxy-types';
import { ResponsesSseError } from './chatgpt-adapter';
import { redactInlineImageDataUrls } from './inline-image-redaction';
import { scrubSecrets } from '../../common/utils/secret-scrub';
import { openAiModelId, subscriptionOpenAiModelId } from './openai-model-id';
import { openAiModelCapabilities, type OpenAiModelCapabilities } from './openai-model-capabilities';
import { PlanService } from '../../billing/plan.service';
import { StreamFailure } from './stream-writer';
import { AgentRecordingConfigService } from '../../common/services/agent-recording-config.service';
import { AttemptRecordingService } from './attempt-recording.service';
import {
  createAttemptRecordingCapture,
  recordingResponseFromText,
} from './attempt-recording-capture';

const MAX_SEEN_TENANTS = 10_000;
const SEEN_TENANT_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CREATED_UNKNOWN = 0;

interface OpenAiModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  provider_model_id?: string;
  auth_type?: string;
  capabilities?: OpenAiModelCapabilities;
  cost?: OpenAiModelCost;
}

interface OpenAiModelCost {
  /** USD per million input tokens. */
  input?: number;
  /** USD per million output tokens. */
  output?: number;
}

interface OpenAiModelList {
  object: 'list';
  data: OpenAiModelObject[];
}

function openAiModelCost(
  inputPricePerToken: number | null,
  outputPricePerToken: number | null,
): OpenAiModelCost | undefined {
  const input =
    inputPricePerToken != null && Number.isFinite(inputPricePerToken) && inputPricePerToken >= 0
      ? inputPricePerToken * 1_000_000
      : undefined;
  const output =
    outputPricePerToken != null && Number.isFinite(outputPricePerToken) && outputPricePerToken >= 0
      ? outputPricePerToken * 1_000_000
      : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

@Controller('v1')
@Public()
@UseGuards(AgentKeyAuthGuard)
@UseFilters(ProxyExceptionFilter)
@SkipThrottle()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);
  private readonly seenTenants = new Map<string, number>();

  constructor(
    private readonly proxyService: ProxyService,
    private readonly rateLimiter: ProxyRateLimiter,
    private readonly providerClient: ProviderClient,
    private readonly recorder: ProxyMessageRecorder,
    private readonly signatureCache: ThoughtSignatureCache,
    private readonly thinkingCache: ThinkingBlockCache,
    private readonly reasoningCache: ReasoningContentCache,
    private readonly modelDiscovery: ModelDiscoveryService,
    private readonly planService: PlanService,
    private readonly observationReporter: ObservationReporter,
    private readonly providerParamSpecs: ProviderParamSpecService,
    private readonly modelsDevSync: ModelsDevSyncService,
    @Optional()
    private readonly recordingConfig?: AgentRecordingConfigService,
    @Optional()
    private readonly attemptRecording?: AttemptRecordingService,
  ) {}

  @Get('models')
  async models(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Query('capabilities') capabilities?: string,
    @Query('cost') cost?: string,
    @Query('route_metadata') routeMetadata?: string,
  ): Promise<OpenAiModelList> {
    const includeCapabilities = capabilities === 'true';
    const includeCost = cost === 'true';
    const includeRouteMetadata = routeMetadata === 'true';
    const models = await this.modelDiscovery.getModelsForAgent(
      req.ingestionContext.tenantId,
      req.ingestionContext.agentId,
    );
    // The synthetic `auto` route never carries metadata — it resolves to a
    // different concrete model per request, so any claim would be wrong.
    const data: OpenAiModelObject[] = [
      {
        id: 'auto',
        object: 'model',
        created: MODEL_CREATED_UNKNOWN,
        owned_by: 'manifest',
      },
    ];
    const seen = new Set(data.map((model) => model.id));

    for (const model of models) {
      const id = openAiModelId(model);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry: OpenAiModelObject = {
        id,
        object: 'model',
        created: MODEL_CREATED_UNKNOWN,
        // Custom providers own their models under the name the user gave
        // them, not the internal `custom:<uuid>` key.
        owned_by: model.providerName ?? model.provider,
      };
      if (includeRouteMetadata) {
        entry.provider_model_id = model.id;
        entry.auth_type = model.authType;
      }
      if (includeCapabilities) {
        // Same resolution as the dashboard's model picker, so agents and the
        // routing UI report identical capability facts.
        const resolved = await resolveModelCapabilityMetadata(
          model,
          this.providerParamSpecs,
          this.modelsDevSync,
        );
        const modelCapabilities = openAiModelCapabilities({ ...model, ...resolved });
        if (modelCapabilities) entry.capabilities = modelCapabilities;
      }
      if (includeCost) {
        const modelCost = openAiModelCost(model.inputPricePerToken, model.outputPricePerToken);
        if (modelCost) entry.cost = modelCost;
      }
      data.push(entry);
    }

    return {
      object: 'list',
      data,
    };
  }

  @Post('chat/completions')
  async chatCompletions(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.handleProxyRequest(req, res, 'chat_completions');
  }

  @Post('responses')
  async responses(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.handleProxyRequest(req, res, 'responses');
  }

  @Post('messages')
  async messages(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.handleProxyRequest(req, res, 'messages');
  }

  private async handleProxyRequest(
    req: Request & { ingestionContext: IngestionContext },
    res: ExpressResponse,
    apiMode: ProxyApiMode,
  ): Promise<void> {
    const { agentId, tenantId } = req.ingestionContext;
    const body = req.body as Record<string, unknown>;
    const sessionScope = buildProxySessionScope(tenantId, agentId, req.headers['x-session-key']);
    const { sessionKey } = sessionScope;
    const traceId = this.extractTraceId(req);
    const requestId = uuid();
    const callerAttribution = classifyCaller(req.headers);
    const requestHeaders = sanitizeRequestHeaders(req.headers);
    const isStream = body.stream === true;
    let routingBody = body;
    let headersSent = false;
    let slotAcquired = false;
    let currentMeta: RoutingMeta | undefined;
    let recordingEnabled = false;
    let currentAttempt: ProviderAttemptRef | undefined;
    let currentAttemptStart: ProviderAttemptStart | undefined;

    const clientAbort = new AbortController();
    res.once('close', () => clientAbort.abort());
    const startTime = Date.now();

    // The Request exists as pending from ingress, before Manifest routes it or
    // starts any provider call. A recording failure must not reject user traffic.
    await this.recorder
      .recordPendingRequest(req.ingestionContext, {
        requestId,
        timestamp: new Date(startTime).toISOString(),
        traceId,
        sessionKey,
        requestedModel: this.extractRequestedModel(body),
        callerAttribution,
        requestHeaders,
        apiMode,
      })
      .catch((e) => this.logger.warn(`Failed to record pending Request: ${e}`));

    if (this.recordingConfig && this.attemptRecording) {
      try {
        recordingEnabled =
          this.attemptRecording.available &&
          (await this.recordingConfig.isRecording(req.ingestionContext.agentId));
      } catch (e) {
        recordingEnabled = false;
        this.logger.warn(`Failed to resolve attempt recording config: ${e}`);
      }
    }

    let attemptSequence = 0;
    // Every attempt that inserted a pending row, so a caller disconnect can
    // finish the ones no terminal writer will reach.
    const startedAttempts: ProviderAttemptRef[] = [];
    const startProviderAttempt: StartProviderAttempt = (start) => {
      const startedAtMs = Date.now();
      const attempt: ProviderAttemptRef = {
        id: uuid(),
        attemptNumber: ++attemptSequence,
        startedAtMs,
        startedAt: new Date(startedAtMs).toISOString(),
        pendingWrite: Promise.resolve(false),
      };
      currentAttempt = attempt;
      currentAttemptStart = start;
      // Cooldown skips still need a unique position in the routing chain, but
      // must not look like an in-flight provider call or trigger provider-call
      // accounting before their terminal policy row is written.
      if (start.providerCallStarted === false) return attempt;

      let recordingFinished = false;
      attempt.startRecording = ({ requestBody, wireFormat }) => {
        if (!recordingEnabled || !this.attemptRecording || attempt.recordingCapture) {
          return;
        }
        attempt.recordingCapture = createAttemptRecordingCapture(requestBody, wireFormat);
      };
      attempt.finishRecording = async (response) => {
        if (recordingFinished) return;
        const capture = attempt.recordingCapture;
        if (!capture || !this.attemptRecording) return;
        if (response?.type === 'stream') {
          capture.setRaw(response.raw_sse ?? '');
        } else if (response?.type === 'json') {
          capture.setJson(response.body);
        }
        recordingFinished = true;
        if (!(await attempt.pendingWrite.catch(() => false))) return;
        await this.attemptRecording
          .save(tenantId, requestId, attempt.id, capture.buildRecording())
          .catch((e) => this.logger.warn(`Failed to finish Provider Attempt recording: ${e}`));
      };
      attempt.pendingWrite = this.recorder
        .recordPendingProviderAttempt(req.ingestionContext, requestId, attempt, start)
        .catch((e) => {
          this.logger.warn(`Failed to record pending Provider Attempt: ${e}`);
          return false;
        });
      startedAttempts.push(attempt);
      attempt.completeFailure = ({ status, errorBody, superseded }) =>
        this.recorder
          .completePendingProviderFailure(attempt, status, errorBody, superseded)
          .catch((e) => this.logger.warn(`Failed to complete Provider Attempt: ${e}`));
      return attempt;
    };

    // Plan request-limit gate. A 402 must reach ProxyExceptionFilter (friendly
    // upgrade message / real 402), but still gets a Manifest-policy row in
    // agent_messages so the Messages tab explains why the request never routed.
    // Billing counters exclude Manifest-origin rows, so this does not consume
    // quota or push the tenant further over the limit.
    try {
      await this.planService.assertWithinRequestLimit(req.ingestionContext);
    } catch (err: unknown) {
      if (err instanceof HttpException && err.getStatus() === HttpStatus.PAYMENT_REQUIRED) {
        this.recordManifestBlockedRequest(
          err,
          req,
          requestId,
          traceId,
          callerAttribution,
          requestHeaders,
          'plan_request_limit_exceeded',
          apiMode,
          HttpStatus.PAYMENT_REQUIRED,
          'M204',
          Date.now() - startTime,
        );
        throw err;
      }
      await this.handleProxyError(
        err,
        req,
        res,
        clientAbort,
        headersSent,
        requestId,
        traceId,
        callerAttribution,
        requestHeaders,
        apiMode,
        undefined,
        undefined,
      );
      return;
    }

    try {
      // Each of these throws its own ManifestError (M201 per-user, M202 per-IP,
      // M203 concurrency), so handleProxyError records which limit actually
      // fired instead of collapsing all three into one reason.
      this.rateLimiter.checkLimit(tenantId);
      this.rateLimiter.checkIpLimit(req.ip ?? '');
      this.rateLimiter.acquireSlot(tenantId);
      slotAcquired = true;
      routingBody = redactInlineImageDataUrls(this.routingBody(body, req));
      const specificityOverride = req.headers['x-manifest-specificity'] as string | undefined;
      const { forward, meta, failedFallbacks, autofix, fallbackAutofix } =
        await this.proxyService.proxyRequest({
          agentId: req.ingestionContext.agentId,
          tenantId,
          // Attribution only — the recorder writes it to agent_messages.user_id.
          userId: req.ingestionContext.userId,
          body,
          routingBody,
          sessionKey,
          sessionCacheKey: sessionScope.cacheKey,
          providerCacheKey: sessionScope.providerCacheKey,
          sessionMomentumKey: sessionScope.momentumKey,
          agentName: req.ingestionContext.agentName,
          signal: clientAbort.signal,
          specificityOverride,
          headers: req.headers,
          apiMode,
          startProviderAttempt,
        });
      currentMeta = meta;

      this.trackFirstProxyRequest(tenantId);

      const metaHeaders = buildMetaHeaders(meta);
      const providerResponse = forward.response;
      const responseCapture = forward.attempt?.recordingCapture;

      if (!providerResponse.ok) {
        const errorBody = await providerResponse.text();
        await forward.attempt?.finishRecording?.(recordingResponseFromText(errorBody));
        // Evidence feed (AUTOFIX_REPORT_ALL_4XX). Autofix already hands Phoenix
        // the full body for the requests it heals; every other request-side 4xx
        // reaches Phoenix only via Peacock's hourly scrape, which carries the
        // model-parameter snapshot and not the messages. Report it live instead —
        // but only for agents that turned Autofix on (the reporter's own gate).
        //
        // `traceId` is the `traceparent` id Peacock's scrape reports for the same
        // row, so a scraped duplicate collapses onto this one in Phoenix's ledger.
        // Callers that send no `traceparent` get a fresh id, which the scrape
        // cannot match — those failures are recorded twice until the scrape is
        // retired for live traffic.
        //
        // Autofix reports the PRIMARY attempt itself. The fallback chain runs
        // after it, so when the response we're about to return came from a
        // fallback model it is a different provider/model failing and Phoenix has
        // never seen it — skipping on `autofix` alone would hide it.
        const alreadyReportedByAutofix = Boolean(autofix) && !meta.fallbackFromModel;
        const wireRequestBody = forward.wireRequestBody;
        const wireApiMode = forward.wireApiMode;
        const wireFormat = forward.wireFormat;
        if (!alreadyReportedByAutofix && meta.auth_type && wireRequestBody && wireFormat) {
          this.observationReporter.report({
            traceId: traceId ?? uuid(),
            tenantId,
            agentId: req.ingestionContext.agentId,
            provider: meta.provider,
            model: meta.model,
            authType: meta.auth_type,
            apiMode: wireApiMode ?? apiMode,
            requestBody: wireRequestBody,
            providerWire: {
              format: wireFormat,
              ...(forward.wireRequestUrl ? { url: forward.wireRequestUrl } : {}),
              body: wireRequestBody,
            },
            status: providerResponse.status,
            errorBody,
            responseTimeMs: Date.now() - startTime,
          });
        }
        await handleProviderError(
          res,
          req.ingestionContext,
          meta,
          metaHeaders,
          providerResponse.status,
          errorBody,
          failedFallbacks,
          this.recorder,
          traceId,
          callerAttribution,
          requestHeaders,
          autofix,
          requestId,
          Date.now() - startTime,
          apiMode,
        );
        return;
      }

      const fallbackSuccessTs = recordFallbackFailures(
        req.ingestionContext,
        meta,
        failedFallbacks,
        this.recorder,
        callerAttribution,
        requestHeaders,
        autofix,
        requestId,
      );

      let streamUsage = null;

      const shouldStreamResponse = isStream || meta.response_mode === 'stream';

      if (shouldStreamResponse && providerResponse.body) {
        headersSent = true;
        streamUsage = await handleStreamResponse(
          res,
          forward,
          meta,
          metaHeaders,
          this.providerClient,
          this.signatureCache,
          sessionScope.cacheKey,
          this.thinkingCache,
          apiMode,
          this.reasoningCache,
          responseCapture,
        );
      } else {
        streamUsage = await handleNonStreamResponse(
          res,
          forward,
          meta,
          metaHeaders,
          this.providerClient,
          this.signatureCache,
          sessionScope.cacheKey,
          this.thinkingCache,
          apiMode,
          this.reasoningCache,
          responseCapture,
        );
      }

      await forward.attempt?.finishRecording?.();

      // A friendly stub (no provider key, no providers, usage limit) leaves the
      // proxy as an HTTP 200 assistant message, so it lands here — but it is a
      // Manifest failure, not a completion. Record it as one.
      if (meta.manifest_error_code) {
        this.recordManifestStub(
          req,
          meta,
          requestId,
          traceId,
          sessionKey,
          callerAttribution,
          requestHeaders,
          autofix,
          Date.now() - startTime,
          apiMode,
        );
      } else {
        recordSuccess(
          req.ingestionContext,
          meta,
          streamUsage,
          fallbackSuccessTs,
          this.recorder,
          traceId,
          sessionKey,
          startTime,
          callerAttribution,
          requestHeaders,
          autofix,
          requestId,
          currentPrimaryAttemptNumber(autofix) +
            (meta.fallbackFromModel ? (failedFallbacks?.length ?? 0) + 1 : 0),
          apiMode,
          fallbackAutofix,
        );
      }
    } catch (err: unknown) {
      await this.handleProxyError(
        err,
        req,
        res,
        clientAbort,
        headersSent,
        requestId,
        traceId,
        callerAttribution,
        requestHeaders,
        apiMode,
        currentMeta,
        startTime,
        currentAttempt,
        currentAttemptStart,
      );
      await (currentMeta?.attempt ?? currentAttempt)?.finishRecording?.();
      if (clientAbort.signal.aborted) {
        // recordCancelledRequest completes only the last attempt. Earlier ones
        // (a failed primary, failed fallback hops, an Autofix retry) were
        // carried in the chain's local state, which the abort threw away. The
        // last one is included too: the pending guard makes it a no-op unless
        // recordCancelledRequest failed to write it.
        await this.recorder.cancelPendingProviderAttempts(startedAttempts);
      }
    } finally {
      if (slotAcquired) this.rateLimiter.releaseSlot(tenantId);
    }
  }

  /**
   * Phoenix replays a provider-native model while naming the original route in
   * headers. Keep Manifest's public `-subscription` syntax inside Manifest: the
   * original body remains provider-native and only the routing view is encoded.
   */
  private routingBody(
    body: Record<string, unknown>,
    req: Request & { ingestionContext: IngestionContext },
  ): Record<string, unknown> {
    const provider = req.headers['x-manifest-provider'];
    const authType = req.headers['x-manifest-auth-type'];
    const model = body.model;
    if (typeof provider !== 'string' || authType !== 'subscription' || typeof model !== 'string') {
      return body;
    }
    return { ...body, model: subscriptionOpenAiModelId(provider, model) };
  }

  /**
   * Record the HTTP-200 friendly stub Manifest returned in place of a completion.
   * `meta.manifest_error_message` is the rendered `[🦚 Manifest M100] …` text the
   * caller actually saw — persisting it verbatim (rather than a generic
   * "Provider API key missing") is what makes the row debuggable.
   */
  private recordManifestStub(
    req: Request & { ingestionContext: IngestionContext },
    meta: RoutingMeta,
    requestId: string,
    traceId: string | undefined,
    sessionKey: string | undefined,
    callerAttribution: ReturnType<typeof classifyCaller>,
    requestHeaders: ReturnType<typeof sanitizeRequestHeaders>,
    autofix: AutofixRecord | undefined,
    durationMs: number,
    apiMode: ProxyApiMode,
  ): void {
    const code = meta.manifest_error_code;
    if (!code || !isRecordableManifestCode(code)) return;
    this.recorder
      .recordManifestBlockedRequest(req.ingestionContext, {
        requestId,
        errorMessage: meta.manifest_error_message ?? formatManifestError(code),
        errorCode: code,
        reason: MANIFEST_CODE_TO_REASON[code],
        model: this.extractRequestedModel(req.body as Record<string, unknown> | undefined),
        traceId,
        sessionKey,
        callerAttribution,
        requestHeaders,
        // A failed heal attempt still stamps its Phoenix audit on the M row.
        autofix,
        attempt: meta.attempt,
        durationMs,
        apiMode,
      })
      .catch((e) => this.logger.warn(`Failed to record Manifest stub: ${e}`));
  }

  private async handleProxyError(
    err: unknown,
    req: Request & { ingestionContext: IngestionContext },
    res: ExpressResponse,
    clientAbort: AbortController,
    headersSent: boolean,
    requestId: string,
    traceId: string | undefined,
    callerAttribution: ReturnType<typeof classifyCaller>,
    requestHeaders: ReturnType<typeof sanitizeRequestHeaders>,
    apiMode: ProxyApiMode,
    meta?: RoutingMeta,
    startTime?: number,
    currentAttempt?: ProviderAttemptRef,
    currentAttemptStart?: ProviderAttemptStart,
  ): Promise<void> {
    const capture = (meta?.attempt ?? currentAttempt)?.recordingCapture;
    if (clientAbort.signal.aborted) {
      await this.recorder
        .recordCancelledRequest(req.ingestionContext, {
          requestId,
          attempt: meta?.attempt ?? currentAttempt,
          attemptStart: currentAttemptStart,
          requestDurationMs: startTime == null ? undefined : Date.now() - startTime,
          traceId,
          apiMode,
        })
        .catch((e) => this.logger.warn(`Failed to record cancelled Request: ${e}`));
      if (!res.writableEnded) res.end();
      return;
    }

    const message = this.extractErrorMessage(err);
    const status =
      err instanceof StreamFailure
        ? err.status
        : err instanceof ResponsesSseError
          ? err.status
          : err instanceof HttpException
            ? err.getStatus()
            : 500;
    const providerErrorBody = err instanceof ResponsesSseError ? err.body : message;
    // `message` is the raw upstream body for a ResponsesSseError, so scrub it
    // before it reaches stdout (the recorded/returned copies already are).
    this.logger.error(`Proxy error: ${scrubSecrets(message)}`);

    // Who failed? A ManifestError says so explicitly. Pre-response dead sockets
    // and timeouts become synthetic 503/504 responses in proxy-transport. A
    // socket that dies after streaming starts is thrown as StreamFailure.
    // Other non-HTTP throws are Manifest's own bugs (M500).
    //
    // An unrecordable ManifestError (M001–M003, M005) writes NOTHING: it has no
    // tenant to attribute, and falling through to recordProviderError would blame
    // the provider for someone presenting a bad key.
    if (err instanceof ManifestError) {
      if (isRecordableManifestCode(err.code)) {
        this.recordManifestBlockedRequest(
          err,
          req,
          requestId,
          traceId,
          callerAttribution,
          requestHeaders,
          MANIFEST_CODE_TO_REASON[err.code],
          apiMode,
          status,
          err.code,
          startTime == null ? undefined : Date.now() - startTime,
          meta,
        );
      }
    } else if (
      !(err instanceof StreamFailure) &&
      !(err instanceof ResponsesSseError) &&
      !(err instanceof HttpException)
    ) {
      // A non-HTTP throw is Manifest's own bug, never a provider fault.
      this.recordManifestBlockedRequest(
        err,
        req,
        requestId,
        traceId,
        callerAttribution,
        requestHeaders,
        MANIFEST_CODE_TO_REASON.M500,
        apiMode,
        status,
        'M500',
        startTime == null ? undefined : Date.now() - startTime,
        meta,
      );
    } else {
      this.recorder
        .recordProviderError(req.ingestionContext, status, providerErrorBody, {
          requestId,
          ...(meta
            ? {
                attempt: meta.attempt,
                attemptNumber: meta.attempt?.attemptNumber,
                skipAttempt: meta.providerCallStarted === false,
                model: meta.model,
                provider: meta.provider,
                tier: meta.tier,
                fallbackFromModel: meta.fallbackFromModel,
                fallbackIndex: meta.fallbackIndex,
                authType: meta.auth_type,
                reason: meta.reason,
                specificityCategory: meta.specificity_category,
                providerKeyLabel: meta.provider_key_label,
                tenantProviderId: meta.tenantProviderId,
                requestParams: meta.request_params,
                headerTierId: meta.header_tier_id,
                headerTierName: meta.header_tier_name,
                headerTierColor: meta.header_tier_color,
              }
            : {}),
          traceId,
          callerAttribution,
          requestHeaders,
          requestDurationMs: startTime == null ? undefined : Date.now() - startTime,
          apiMode,
        })
        .catch((e) => this.logger.warn(`Failed to record provider error: ${e}`));
    }

    if (headersSent) {
      if (!res.writableEnded) {
        if (err instanceof StreamFailure) {
          this.writeStreamError(res, apiMode, err, meta);
        } else {
          res.end();
        }
      }
      return;
    }

    if (err instanceof ResponsesSseError) {
      const responseBody = {
        error: buildOpenAiCompatibleError(
          err.status,
          err.body,
          meta ? { provider: meta.provider, model: meta.model } : {},
        ),
      };
      capture?.setJson(responseBody);
      res.status(err.status).json(responseBody);
      return;
    }

    // Rate limit errors stay as HTTP 429 so clients can backoff
    if (status === 429) {
      // Never return the exception response object itself: framework and
      // provider exceptions can carry stack traces or markup. Manifest's
      // rate-limit messages come from our static catalogue; provider failures
      // use a stable public message.
      const rateLimitMessage =
        err instanceof ManifestError
          ? formatManifestError(err.code)
          : 'Rate limited by upstream provider';
      const responseBody = {
        error: { message: rateLimitMessage, type: 'rate_limit_error' },
      };
      capture?.setJson(responseBody);
      res.status(429).json(responseBody);
      return;
    }

    const isStream = (req.body as Record<string, unknown>)?.stream === true;
    if (isChatRenderingClient(req)) {
      const clientMessage = status >= 500 ? formatManifestError('M500') : message;
      sendFriendlyResponse(res, clientMessage, isStream);
      return;
    }

    // Tool/monitor caller — surface the real HTTP status with a structured
    // envelope so CI pipelines can detect failures instead of treating the
    // friendly stub as success.
    const errorMessage =
      status >= 500 ? 'Manifest encountered an internal error. Try again shortly.' : message;
    const responseBody = {
      error: {
        message: errorMessage,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    };
    capture?.setJson(responseBody);
    res.status(status).json(responseBody);
  }

  private writeStreamError(
    res: ExpressResponse,
    apiMode: ProxyApiMode,
    streamError: StreamFailure,
    meta: RoutingMeta | undefined,
  ): void {
    const error = buildOpenAiCompatibleError(streamError.status, streamError.message, {
      source: 'provider',
      code: streamError.reason,
      provider: meta?.provider,
      model: meta?.model,
    });
    error.message = streamError.message;

    if (apiMode === 'messages') {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: streamError.message },
        })}\n\n`,
      );
    } else if (apiMode === 'responses') {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          code: error.code ?? 'server_error',
          message: streamError.message,
          param: null,
          sequence_number: nextResponsesSequenceNumber(res),
        })}\n\n`,
      );
    } else {
      res.write(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`);
    }
    res.end();
  }

  private extractTraceId(req: Request): string | undefined {
    const header = req.headers['traceparent'] as string | undefined;
    if (!header) return undefined;
    const parts = header.split('-');
    return parts.length >= 2 ? parts[1] : undefined;
  }

  private extractSessionKey(req: Request & { ingestionContext: IngestionContext }): string {
    return buildProxySessionScope(
      req.ingestionContext.tenantId,
      req.ingestionContext.agentId,
      req.headers['x-session-key'],
    ).sessionKey;
  }

  private extractRequestedModel(body: Record<string, unknown> | undefined): string | undefined {
    const model = body?.model;
    return typeof model === 'string' && model.length > 0 ? model : undefined;
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof ResponsesSseError) return err.body;
    if (err instanceof HttpException) {
      const response = err.getResponse();
      if (typeof response === 'string') return response;
      if (response && typeof response === 'object') {
        const record = response as Record<string, unknown>;
        const message = record.message;
        if (typeof message === 'string') return message;
        if (Array.isArray(message)) return message.filter((m) => typeof m === 'string').join(', ');
        const error = record.error;
        if (typeof error === 'string') return error;
        if (error && typeof error === 'object') {
          const nested = (error as Record<string, unknown>).message;
          if (typeof nested === 'string') return nested;
        }
        const code = record.code;
        if (code === 'PLAN_LIMIT_REQUESTS') return 'Free plan monthly request limit reached';
        if (typeof code === 'string') return code;
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  private recordManifestBlockedRequest(
    err: unknown,
    req: Request & { ingestionContext: IngestionContext },
    requestId: string,
    traceId: string | undefined,
    callerAttribution: ReturnType<typeof classifyCaller>,
    requestHeaders: ReturnType<typeof sanitizeRequestHeaders>,
    reason: ManifestBlockedRequestReason,
    apiMode: ProxyApiMode,
    httpStatus?: number,
    errorCode?: ManifestErrorCode,
    durationMs?: number,
    meta?: RoutingMeta,
  ): void {
    const body = req.body as Record<string, unknown> | undefined;
    this.recorder
      .recordManifestBlockedRequest(req.ingestionContext, {
        requestId,
        httpStatus: httpStatus ?? (err instanceof HttpException ? err.getStatus() : 500),
        // The raw internal message, not the friendly M500 text the caller saw —
        // the dashboard row is where you go to find out what actually broke.
        errorMessage: this.extractErrorMessage(err),
        errorCode,
        reason,
        model: this.extractRequestedModel(body),
        traceId,
        sessionKey: this.extractSessionKey(req),
        callerAttribution,
        requestHeaders,
        durationMs,
        apiMode,
        // A friendly stub's meta is a placeholder (provider 'manifest', tier
        // 'simple'), not a routing decision, so only a real route stamps tiers.
        ...(meta && meta.provider !== 'manifest'
          ? {
              routing: {
                tier: meta.tier,
                specificityCategory: meta.specificity_category,
                headerTierId: meta.header_tier_id,
                headerTierName: meta.header_tier_name,
                headerTierColor: meta.header_tier_color,
              },
            }
          : {}),
      })
      .catch((e) => this.logger.warn(`Failed to record Manifest-blocked request: ${e}`));
  }

  private trackFirstProxyRequest(tenantId: string): void {
    const now = Date.now();
    if (this.seenTenants.has(tenantId)) return;
    this.evictExpiredTenants(now);
    if (this.seenTenants.size >= MAX_SEEN_TENANTS) {
      const oldest = this.seenTenants.keys().next().value as string;
      this.seenTenants.delete(oldest);
    }
    this.seenTenants.set(tenantId, now);
  }

  private evictExpiredTenants(now: number): void {
    for (const [key, timestamp] of this.seenTenants) {
      if (now - timestamp > SEEN_TENANT_TTL_MS) {
        this.seenTenants.delete(key);
      } else {
        break;
      }
    }
  }
}
