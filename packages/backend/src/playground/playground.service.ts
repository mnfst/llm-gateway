import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import type { Response as ExpressResponse } from 'express';
import type { AuthType, PlaygroundStreamEvent } from 'manifest-shared';
import { AgentMessage } from '../entities/agent-message.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { ProviderClient } from '../routing/proxy/provider-client';
import { resolveForwardEndpoint } from '../routing/proxy/forward-endpoint-resolver';
import { CustomProviderService } from '../routing/custom-provider/custom-provider.service';
import {
  isRefreshableOAuthCredential,
  refreshRejectedOAuthCredential,
  resolveApiKey,
} from '../routing/proxy/oauth-credentials';
import { ProviderKeyService } from '../routing/routing-core/provider-key.service';
import { isLocalOnlyProvider } from '../common/utils/provider-availability';
import { OpencodeGoCatalogService } from '../model-discovery/opencode-go-catalog.service';
import { PROVIDER_BY_ID_OR_ALIAS } from '../common/constants/providers';
import { PlaygroundAgentService } from './playground-agent.service';
import { OpenaiOauthService } from '../routing/oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../routing/oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../routing/oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../routing/oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../routing/oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../routing/oauth/xai/xai-oauth.service';
import { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import { computeTokenCost } from '../common/utils/cost-calculator';
import { scrubSecrets } from '../common/utils/secret-scrub';
import { IngestEventBusService } from '../common/services/ingest-event-bus.service';
import { TenantContext } from '../common/decorators/tenant-context.decorator';
import { initSseHeaders } from '../routing/proxy/stream-writer';
import { whitelistResponseHeaders } from './playground-response-headers';
import { sanitizeRequestHeaders } from './request-header-sanitizer';
import { PlaygroundHistoryService } from './playground-history.service';
import { buildForwardBody, derivePromptForHistory } from './playground-payload';
import { consumeProviderStream } from './playground-stream';
import type { RunPlaygroundDto } from './dto/run-playground.dto';
import { ManifestRequest } from '../entities/request.entity';

@Injectable()
export class PlaygroundService {
  private readonly logger = new Logger(PlaygroundService.name);

  constructor(
    private readonly playgroundAgent: PlaygroundAgentService,
    private readonly providerKeyService: ProviderKeyService,
    private readonly providerClient: ProviderClient,
    private readonly openaiOauth: OpenaiOauthService,
    private readonly minimaxOauth: MinimaxOauthService,
    private readonly anthropicOauth: AnthropicOauthService,
    private readonly geminiOauth: GeminiOauthService,
    private readonly kiroOauth: KiroOauthService,
    private readonly xaiOauth: XaiOauthService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly eventBus: IngestEventBusService,
    private readonly history: PlaygroundHistoryService,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    @InjectRepository(CustomProvider)
    private readonly customProviderRepo: Repository<CustomProvider>,
    private readonly customProviders: CustomProviderService,
    private readonly opencodeGoCatalog: OpencodeGoCatalogService,
  ) {}

  /**
   * Streams one model's response over SSE. Failures *before* the stream opens
   * (bad agent/provider/key, upstream non-2xx) are returned as a plain JSON
   * HTTP error — the client hasn't committed to an event stream yet. Failures
   * *after* the stream opens are delivered as a terminal `error` event.
   */
  async runStream(ctx: TenantContext, dto: RunPlaygroundDto, res: ExpressResponse): Promise<void> {
    let agent: { id: string; tenant_id: string; name: string };
    let resolvedAgent: { id: string; tenant_id: string; name: string } | null = null;
    let authType: AuthType;
    let apiKey: string;
    let rawApiKey: string;
    let providerKeyLabel: string | undefined;
    let providerResource: string | undefined;
    // Region/resource inputs for the shared endpoint resolver, so Playground
    // forwarding (region overrides + vendor-prefix stripping) stays in lock-step
    // with the proxy for minimax/qwen/zai/copilot/custom.
    let oauthResourceUrl: string | undefined;
    let providerRegion: string | null | undefined;
    try {
      // The Playground always runs under the reserved per-tenant "Playground"
      // agent (created on first use), so runs record under it in global Messages
      // and route against the whole global provider pool — regardless of any
      // agentName the client sends.
      agent = await this.playgroundAgent.resolve(ctx);
      resolvedAgent = agent;
      const hasProvider = await this.providerKeyService.hasActiveProvider(
        agent.tenant_id,
        dto.provider,
        agent.id,
      );
      if (!hasProvider) {
        const message = `Provider "${dto.provider}" is not connected for this agent`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }
      authType =
        dto.authType ??
        (await this.providerKeyService.getAuthType(
          agent.tenant_id,
          dto.provider,
          undefined,
          agent.id,
        ));
      const keys = await this.providerKeyService.getProviderKeys(
        agent.tenant_id,
        dto.provider,
        authType,
        agent.id,
      );
      const key = keys[0];
      if (!key || key.apiKey === null) {
        const message = `No usable API key found for provider "${dto.provider}"`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }
      rawApiKey = key.apiKey;
      providerKeyLabel = key.label;
      providerRegion = key.region;
      const resolved = await resolveApiKey(
        dto.provider,
        rawApiKey,
        authType,
        agent.id,
        agent.tenant_id,
        this.openaiOauth,
        this.minimaxOauth,
        this.anthropicOauth,
        this.geminiOauth,
        this.kiroOauth,
        this.xaiOauth,
        providerKeyLabel,
      );
      if (resolved.apiKey === null) {
        const message = `No usable API key found for provider "${dto.provider}"`;
        await this.recordRequestRejection(ctx.userId, agent, dto, 404, message, 'config');
        return this.sendPreStreamError(res, 404, message);
      }
      apiKey = resolved.apiKey;
      if (authType === 'subscription' && isRefreshableOAuthCredential(rawApiKey)) {
        rawApiKey =
          (await this.providerKeyService.getProviderApiKey(
            agent.tenant_id,
            dto.provider,
            authType,
            providerKeyLabel,
            agent.id,
          )) ?? rawApiKey;
      }
      oauthResourceUrl = authType === 'subscription' ? resolved.resourceUrl : undefined;
      // Gemini OAuth stores the CodeAssist project id (not a URL) in the same
      // field; it is forwarded as providerResource. MiniMax's resource URL is
      // applied as a base-URL override below, not here.
      providerResource =
        authType === 'subscription' && dto.provider.toLowerCase() === 'gemini'
          ? resolved.resourceUrl
          : undefined;
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (resolvedAgent) {
        await this.recordRequestRejection(
          ctx.userId,
          resolvedAgent,
          dto,
          status,
          message,
          status >= 500 ? 'internal' : 'config',
        );
      }
      return this.sendPreStreamError(res, status, message);
    }

    const extraHeaders = sanitizeRequestHeaders(dto.requestHeaders);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    // Resolve the upstream endpoint + forwarded model id through the SAME helper
    // the proxy uses, so region overrides (minimax/qwen/zai) and vendor-prefix
    // stripping (copilot/minimax/zai/custom) match. Custom providers store their
    // endpoint on a DB row, fetched here and passed in.
    const customProvider = CustomProviderService.isCustom(dto.provider)
      ? await this.customProviderRepo.findOne({
          where: { id: CustomProviderService.extractId(dto.provider), tenant_id: agent.tenant_id },
        })
      : null;
    const { customEndpoint, forwardModel } = resolveForwardEndpoint({
      provider: dto.provider,
      authType,
      model: dto.model,
      providerRegion,
      resourceUrl: oauthResourceUrl,
      customProvider,
      logger: this.logger,
    });

    const startedAt = Date.now();
    let forward;
    try {
      const forwardOptions = {
        provider: dto.provider,
        apiKey,
        model: forwardModel,
        body: buildForwardBody(dto),
        stream: true,
        authType,
        extraHeaders,
        customEndpoint,
        signal: abort.signal,
        providerResource,
      };
      forward = await this.providerClient.forward(forwardOptions);
      if (forward.response.status === 401 && authType === 'subscription') {
        const refreshed = await refreshRejectedOAuthCredential(
          dto.provider,
          rawApiKey,
          agent.id,
          agent.tenant_id,
          providerKeyLabel,
          {
            openaiOauth: this.openaiOauth,
            minimaxOauth: this.minimaxOauth,
            anthropicOauth: this.anthropicOauth,
            geminiOauth: this.geminiOauth,
            kiroOauth: this.kiroOauth,
            xaiOauth: this.xaiOauth,
          },
        );
        if (refreshed?.apiKey && refreshed.apiKey !== apiKey) {
          this.logger.log(
            `OAuth token rejected upstream in Playground; refreshed provider=${dto.provider} agent=${agent.id}`,
          );
          apiKey = refreshed.apiKey;
          providerResource =
            authType === 'subscription' && dto.provider.toLowerCase() === 'gemini'
              ? (refreshed.resourceUrl ?? providerResource)
              : providerResource;
          forward = await this.providerClient.forward({
            ...forwardOptions,
            apiKey,
            providerResource,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!abort.signal.aborted) {
        await this.recordError(
          ctx.userId,
          agent,
          dto,
          authType,
          502,
          message,
          Date.now() - startedAt,
          'transport',
        );
      }
      return this.sendPreStreamError(res, 502, `Provider request failed: ${message}`);
    }

    const headers = whitelistResponseHeaders(forward.response.headers);

    if (!forward.response.ok) {
      let bodyText = '';
      try {
        bodyText = await forward.response.text();
      } catch {
        // A failed error-body read must not bypass provider-error handling —
        // fall through with an empty body so we still record + respond.
      }
      const durationMs = Date.now() - startedAt;
      const errorSummary = this.truncateError(bodyText, forward.response.status);
      await this.recordError(
        ctx.userId,
        agent,
        dto,
        authType,
        forward.response.status,
        bodyText,
        durationMs,
      );
      await this.history.saveColumn(
        this.errorColumn(ctx.userId, agent, dto, authType, headers, errorSummary),
      );
      return this.sendPreStreamError(res, 502, errorSummary);
    }

    // Committed to SSE from here — every further failure is an in-band event.
    initSseHeaders(res, {});
    const send = (event: PlaygroundStreamEvent): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    if (!forward.response.body) {
      const message = 'Provider returned an empty stream';
      await this.recordError(
        ctx.userId,
        agent,
        dto,
        authType,
        502,
        message,
        Date.now() - startedAt,
      );
      await this.history.saveColumn(
        this.errorColumn(ctx.userId, agent, dto, authType, headers, message),
      );
      send({ type: 'error', message });
      res.end();
      return;
    }

    try {
      const { content, usage, ttftMs, totalMs } = await consumeProviderStream(
        forward.response.body,
        forward,
        dto.model,
        this.providerClient,
        (text) => send({ type: 'delta', text }),
        startedAt,
      );

      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;
      const cacheReadTokens = usage?.cache_read_tokens ?? 0;
      const cacheCreationTokens = usage?.cache_creation_tokens ?? 0;
      // Tile-connected local runtimes arrive as `custom:<uuid>`; only the
      // canonical provider says whether one is local. A tenant-less context
      // has no custom providers to resolve, so it degrades to the raw name.
      //
      // Best-effort by design: the answer has already been streamed to the
      // client, so a metadata lookup that fails must not turn a delivered run
      // into an error one. It only refines the cost inputs below, and the raw
      // name is where the lookup starts from anyway.
      const canonicalProvider = await this.customProviders
        .canonicalizeAgentMessageKeys(ctx.tenantId ?? '', dto.provider, dto.model)
        .then(({ provider }) => provider ?? dto.provider)
        .catch(() => dto.provider);
      const cost = computeTokenCost({
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        model: dto.model,
        pricing: this.pricingCache.getByModel(dto.model, dto.provider),
        isSubscription: authType === 'subscription',
        // Same source order as the proxy recorder: a playground run against
        // the same provider must not report a different cost. That parity is
        // the whole point, so each input is resolved the way the recorder
        // resolves it — the local check on the canonical provider, because a
        // tile-connected llama.cpp arrives as `custom:<uuid>`, and the
        // per-request rate from the OpenCode Go catalogue.
        isLocalProvider: isLocalOnlyProvider(canonicalProvider),
        perRequestCostUsd:
          authType === 'subscription' &&
          PROVIDER_BY_ID_OR_ALIAS.get(canonicalProvider.toLowerCase())?.id === 'opencode-go'
            ? await this.opencodeGoCatalog.resolveCostPerRequest(dto.model)
            : null,
        reportedCostUsd: usage?.reported_cost_usd,
        // The request start, not the completion time. A stream that opens at
        // 09:59 UTC and closes at 10:01 crossed out of a DeepSeek peak window
        // mid-answer; the proxy recorder bills such a run from `startedAt`, so
        // billing the playground from `Date.now()` would price the same run
        // two different ways.
        at: new Date(startedAt),
      });
      const tokensPerSec = outputTokens > 0 ? outputTokens / (Math.max(totalMs, 1) / 1000) : null;

      await this.recordSuccess(ctx.userId, agent, dto, authType, {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cost,
        durationMs: totalMs,
      });

      const columnId = await this.history.saveColumn({
        createdByUserId: ctx.userId,
        agent,
        runId: dto.runId,
        prompt: derivePromptForHistory(dto),
        model: dto.model,
        provider: dto.provider,
        authType,
        displayName: null,
        position: dto.position ?? 0,
        status: 'success',
        content,
        headers,
        errorMessage: null,
        metrics: { inputTokens, outputTokens, cost, durationMs: totalMs },
      });

      send({
        type: 'done',
        columnId,
        content,
        metrics: { cost, inputTokens, outputTokens, durationMs: totalMs, ttftMs, tokensPerSec },
        headers,
      });
      res.end();
    } catch (err) {
      // Client navigated away / removed the column — the request was aborted.
      // Nothing to report and the row would just be noise.
      if (abort.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      await this.recordError(ctx.userId, agent, dto, authType, 502, message, durationMs);
      await this.history.saveColumn(
        this.errorColumn(ctx.userId, agent, dto, authType, headers, message),
      );
      send({ type: 'error', message });
      if (!res.writableEnded) res.end();
    }
  }

  private sendPreStreamError(res: ExpressResponse, status: number, message: string): void {
    if (res.headersSent || res.writableEnded) return;
    res.status(status).json({ statusCode: status, message });
  }

  private errorColumn(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    authType: AuthType,
    headers: Record<string, string>,
    errorMessage: string,
  ): Parameters<PlaygroundHistoryService['saveColumn']>[0] {
    return {
      createdByUserId,
      agent,
      runId: dto.runId,
      prompt: derivePromptForHistory(dto),
      model: dto.model,
      provider: dto.provider,
      authType,
      displayName: null,
      position: dto.position ?? 0,
      status: 'error',
      content: null,
      headers,
      errorMessage,
      metrics: null,
    };
  }

  private async recordSuccess(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    authType: AuthType,
    metrics: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      cost: number | null;
      durationMs: number;
    },
  ): Promise<void> {
    // Guarded: the model already produced (and was billed for) a completion we
    // just streamed to the user. A telemetry-insert blip must not turn that
    // into a user-visible failure.
    try {
      // No tenant_provider_id: Playground runs use the reserved is_playground agent,
      // which excludePlaygroundAgents() filters out of every per-connection view,
      // so stamping the connection here would have no analytic effect.
      const requestId = uuid();
      const timestamp = new Date().toISOString();
      await this.insertPlaygroundRequest(
        {
          id: uuid(),
          request_id: requestId,
          attempt_number: 1,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          agent_name: agent.name,
          // Informational attribution only — never used for scoping.
          user_id: createdByUserId,
          timestamp,
          status: 'success',
          model: dto.model,
          provider: dto.provider,
          routing_tier: 'playground',
          routing_reason: null,
          auth_type: authType,
          input_tokens: metrics.inputTokens,
          output_tokens: metrics.outputTokens,
          cache_read_tokens: metrics.cacheReadTokens,
          cache_creation_tokens: metrics.cacheCreationTokens,
          cost_usd: metrics.cost,
          duration_ms: metrics.durationMs,
        },
        {
          id: requestId,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          user_id: createdByUserId,
          agent_name: agent.name,
          trace_id: null,
          session_key: null,
          session_id: null,
          timestamp,
          duration_ms: metrics.durationMs,
          status: 'success',
          autofix_status: null,
          error_message: null,
          error_http_status: null,
          error_code: null,
          error_origin: null,
          error_class: null,
          requested_model: dto.model,
          // The Playground calls a provider directly; it never enters through
          // one of the proxy's public API surfaces.
          api_mode: null,
          caller_attribution: null,
          request_headers: null,
          request_params: null,
          feedback_rating: null,
          feedback_tags: null,
          feedback_details: null,
        },
      );
      this.eventBus.emit(agent.tenant_id);
    } catch (err) {
      this.logger.warn(
        `Failed to record playground success: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async recordError(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    authType: AuthType,
    status: number,
    errorBody: string,
    durationMs: number,
    errorOrigin: 'provider' | 'transport' = 'provider',
  ): Promise<void> {
    try {
      // No tenant_provider_id — see recordSuccess: Playground is a system agent,
      // excluded from per-connection analytics.
      const requestId = uuid();
      const timestamp = new Date().toISOString();
      const errorMessage = scrubSecrets(errorBody).slice(0, 2000);
      await this.insertPlaygroundRequest(
        {
          id: uuid(),
          request_id: requestId,
          attempt_number: 1,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          agent_name: agent.name,
          // Informational attribution only — never used for scoping.
          user_id: createdByUserId,
          timestamp,
          status: 'failed',
          // Some providers echo the submitted key back in their error body, so
          // scrub before persisting — mirrors the proxy recorder's hardening.
          error_message: errorMessage,
          error_http_status: status,
          error_origin: errorOrigin,
          model: dto.model,
          provider: dto.provider,
          routing_tier: 'playground',
          routing_reason: null,
          auth_type: authType,
          duration_ms: durationMs,
        },
        {
          id: requestId,
          tenant_id: agent.tenant_id,
          agent_id: agent.id,
          user_id: createdByUserId,
          agent_name: agent.name,
          trace_id: null,
          session_key: null,
          session_id: null,
          timestamp,
          duration_ms: durationMs,
          status: 'failed',
          autofix_status: null,
          error_message: errorMessage,
          error_http_status: status,
          error_code: null,
          error_origin: errorOrigin,
          error_class: null,
          requested_model: dto.model,
          // The Playground calls a provider directly; it never enters through
          // one of the proxy's public API surfaces.
          api_mode: null,
          caller_attribution: null,
          request_headers: null,
          request_params: null,
          feedback_rating: null,
          feedback_tags: null,
          feedback_details: null,
        },
      );
      this.eventBus.emit(agent.tenant_id);
    } catch (err) {
      this.logger.warn(
        `Failed to record playground error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async recordRequestRejection(
    createdByUserId: string | null,
    agent: { id: string; tenant_id: string; name: string },
    dto: RunPlaygroundDto,
    status: number,
    errorBody: string,
    errorOrigin: 'config' | 'request' | 'internal',
  ): Promise<void> {
    try {
      const getRepository = this.messageRepo.manager?.getRepository?.bind(this.messageRepo.manager);
      if (!getRepository) return;
      const errorMessage = scrubSecrets(errorBody).slice(0, 2000);
      await getRepository(ManifestRequest).insert({
        id: uuid(),
        tenant_id: agent.tenant_id,
        agent_id: agent.id,
        user_id: createdByUserId,
        agent_name: agent.name,
        trace_id: null,
        session_key: null,
        session_id: null,
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        status: 'failed',
        autofix_status: null,
        error_message: errorMessage,
        error_http_status: status,
        error_code: null,
        error_origin: errorOrigin,
        error_class: null,
        requested_model: dto.model,
        caller_attribution: null,
        request_headers: null,
        request_params: null,
        feedback_rating: null,
        feedback_tags: null,
        feedback_details: null,
      });
      this.eventBus.emit(agent.tenant_id);
    } catch (err) {
      this.logger.warn(
        `Failed to record playground rejection: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async insertPlaygroundRequest(
    attempt: Partial<AgentMessage>,
    request: ManifestRequest,
  ): Promise<void> {
    const getRepository = this.messageRepo.manager?.getRepository?.bind(this.messageRepo.manager);
    if (!getRepository) {
      await this.messageRepo.insert(attempt);
      return;
    }
    await getRepository(ManifestRequest).insert(request);
    await this.messageRepo.insert(attempt);
  }

  private truncateError(bodyText: string, status: number): string {
    // Scrub before truncating: this snippet is both streamed back to the client
    // and stored on the history column, so a key-echoing upstream error must not
    // leak through either sink.
    const snippet = scrubSecrets(bodyText).slice(0, 500).trim();
    return snippet ? `Provider returned ${status}: ${snippet}` : `Provider returned ${status}`;
  }
}
