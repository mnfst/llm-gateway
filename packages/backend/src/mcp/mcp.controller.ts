import { Controller, Delete, Get, Post, Req, Res, Inject, Logger } from '@nestjs/common';
import { createMcpProtectedRequestHandler } from '@better-auth/mcp';
import { createDpopReplayStore } from 'better-auth/oauth2';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { fromNodeHeaders } from 'better-auth/node';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import type { Request, Response } from 'express';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { auth, authIssuerForHost, mcpResourceForHost, MCP_READ_SCOPE } from '../auth/auth.instance';
import { Public } from '../common/decorators/public.decorator';
import { TenantCacheService } from '../common/services/tenant-cache.service';
import { AgentListCacheService } from '../common/services/agent-list-cache.service';
import { IngestEventBusService } from '../common/services/ingest-event-bus.service';
import { AgentRecordingConfigService } from '../common/services/agent-recording-config.service';
import { TimeseriesQueriesService } from '../analytics/services/timeseries-queries.service';
import { AgentLifecycleService } from '../analytics/services/agent-lifecycle.service';
import { MessagesQueryService } from '../analytics/services/messages-query.service';
import { AutofixStatsService } from '../analytics/services/autofix-stats.service';
import { ApiKeyGeneratorService } from '../otlp/services/api-key.service';
import { ProviderService } from '../routing/routing-core/provider.service';
import { TierService } from '../routing/routing-core/tier.service';
import { SpecificityService } from '../routing/routing-core/specificity.service';
import { ResolveAgentService } from '../routing/routing-core/resolve-agent.service';
import { HeaderTierService } from '../routing/header-tiers/header-tier.service';
import { CustomProviderService } from '../routing/custom-provider/custom-provider.service';
import { AutofixService } from '../routing/autofix/autofix.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelPricesService } from '../model-prices/model-prices.service';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { Agent } from '../entities/agent.entity';
import { resolveMcpOperator } from './mcp-auth';
import { buildMcpServer } from './mcp-server.factory';
import { McpToolDeps } from './tool-deps';
import { RouteModelParamsService } from '../routing/model-params/route-model-params.service';

/**
 * The remote MCP endpoint.
 *
 * `@Public()` bypasses the session/API-key guards because MCP carries its own
 * credential: an OAuth 2.1 bearer token minted by the Better Auth MCP plugin.
 * The protected-request handler below verifies that credential — the route is not open.
 *
 * A missing or dead token answers 401 with `WWW-Authenticate`
 * `resource_metadata=…`, which is how an MCP client discovers it must run the
 * OAuth flow at all.
 *
 * The transport is stateless: a fresh server per POST, closed when the request
 * ends. Nothing is kept between calls, so no session affinity is needed.
 */
@Controller('api/v1/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantCache: TenantCacheService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly agentListCache: AgentListCacheService,
    private readonly eventBus: IngestEventBusService,
    private readonly recording: AgentRecordingConfigService,
    private readonly timeseries: TimeseriesQueriesService,
    private readonly lifecycle: AgentLifecycleService,
    private readonly apiKeys: ApiKeyGeneratorService,
    private readonly messages: MessagesQueryService,
    private readonly autofixStats: AutofixStatsService,
    private readonly providers: ProviderService,
    private readonly tiers: TierService,
    private readonly specificity: SpecificityService,
    private readonly resolveAgentService: ResolveAgentService,
    private readonly headerTiers: HeaderTierService,
    private readonly customProviders: CustomProviderService,
    private readonly autofix: AutofixService,
    private readonly routeModelParams: RouteModelParamsService,
    private readonly modelDiscovery: ModelDiscoveryService,
    private readonly pricingSync: PricingSyncService,
    private readonly modelPrices: ModelPricesService,
    @InjectRepository(TenantProvider)
    private readonly tenantProviderRepo: Repository<TenantProvider>,
    @InjectRepository(AgentEnabledProvider)
    private readonly agentEnabledProviderRepo: Repository<AgentEnabledProvider>,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
  ) {}

  private deps(): McpToolDeps {
    return {
      dataSource: this.dataSource,
      tenantCache: this.tenantCache,
      cacheManager: this.cacheManager,
      agentListCache: this.agentListCache,
      eventBus: this.eventBus,
      recording: this.recording,
      timeseries: this.timeseries,
      lifecycle: this.lifecycle,
      apiKeys: this.apiKeys,
      autofixStats: this.autofixStats,
      messages: this.messages,
      providers: this.providers,
      tiers: this.tiers,
      specificity: this.specificity,
      resolveAgent: this.resolveAgentService,
      headerTiers: this.headerTiers,
      customProviders: this.customProviders,
      autofix: this.autofix,
      routeModelParams: this.routeModelParams,
      modelDiscovery: this.modelDiscovery,
      pricingSync: this.pricingSync,
      modelPrices: this.modelPrices,
      tenantProviderRepo: this.tenantProviderRepo,
      agentEnabledProviderRepo: this.agentEnabledProviderRepo,
      agentRepo: this.agentRepo,
    };
  }

  /**
   * Streamable HTTP clients open a GET for the optional server-push stream
   * right after `initialize`, and send DELETE to end a session. This transport
   * is stateless JSON-only and offers neither, and the spec says such a server
   * MUST answer 405 — the JSON 404 the `/api/` prefix otherwise produces reads
   * to clients as a broken endpoint and is logged on every connect.
   */
  @Get()
  @Public()
  async rejectGet(@Res() res: Response): Promise<void> {
    await sendWebResponse(methodNotAllowedResponse(), res, this.logger);
  }

  @Delete()
  @Public()
  async rejectDelete(@Res() res: Response): Promise<void> {
    await sendWebResponse(methodNotAllowedResponse(), res, this.logger);
  }

  @Post()
  @Public()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const deps = this.deps();
    const resource = mcpResourceForHost(req.headers.host);
    const issuer = authIssuerForHost(req.headers.host);
    const webRequest = new globalThis.Request(resource, {
      method: req.method,
      headers: fromNodeHeaders(req.headers),
    });
    try {
      // Dynamic auth base URLs leave the global context's baseURL empty, so
      // requireMcpAuth cannot infer verification settings from that context.
      const { internalAdapter } = await auth.$context;
      const verify = createMcpProtectedRequestHandler(
        {
          issuer,
          audience: resource,
          jwksUrl: `${issuer}/jwks`,
          requiredScopes: [MCP_READ_SCOPE],
          dpop: { replayStore: createDpopReplayStore(internalAdapter) },
        },
        async (request, claims) => {
          const operator = await resolveMcpOperator(this.tenantCache, claims);
          if (!operator) return unauthorizedResponse(resource);
          // A fresh handler per request keeps the operator closure un-forgeable:
          // no caller-supplied field can change whose tenant a tool acts on.
          const handler = createMcpHandler(() => buildMcpServer(deps, operator), {
            responseMode: 'json',
          });
          return handler.fetch(request, { parsedBody: req.body });
        },
      );
      const response = await verify(webRequest);
      await sendWebResponse(response, res, this.logger);
    } catch (error) {
      // Log the detail server-side; the OAuth caller gets a constant message so
      // database or infrastructure errors cannot leak through the response.
      this.logger.error(
        `MCP request failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      await sendWebResponse(internalErrorResponse(), res, this.logger);
    }
  }
}

function internalErrorResponse(): globalThis.Response {
  return new globalThis.Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null,
    }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );
}

function methodNotAllowedResponse(): globalThis.Response {
  return new globalThis.Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    }),
    { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } },
  );
}

function unauthorizedResponse(resource: string): globalThis.Response {
  const url = new URL(resource);
  const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  return new globalThis.Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: operator no longer exists' },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${metadata}"`,
      },
    },
  );
}

/** Does this response carry an SSE stream rather than one buffered body? */
function isEventStream(response: globalThis.Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/** Pipe failures that only mean the client went away mid-stream. */
const CLIENT_HANGUP_CODES = new Set([
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ECONNRESET',
  'EPIPE',
]);

function isClientHangUp(error: unknown): boolean {
  // `pipeline` always rejects with a value, so reading the property is safe
  // even when a stream errored with something that is not an Error.
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && CLIENT_HANGUP_CODES.has(code);
}

/**
 * Write a web Response onto the Express response.
 *
 * Nearly every MCP exchange here is a single JSON body, which is buffered.
 * `subscriptions/listen` is the exception: the MCP server serves listen-class
 * streams over SSE *regardless* of `responseMode: 'json'`, and the first frame
 * it writes is the `notifications/subscriptions/acknowledged` the client blocks
 * on before it considers the connection healthy. Buffering that body with
 * `response.text()` never resolves — the stream is meant to stay open — so the
 * ack never reached the client: every listen attempt hung until the client's
 * ~30s ack timeout, the connect handshake stalled ~25s behind the first one,
 * and the client retried the listen forever. Stream those responses through
 * chunk by chunk instead, and let a client hang-up end the pipe quietly.
 */
async function sendWebResponse(
  response: globalThis.Response,
  res: Response,
  logger: Logger,
): Promise<void> {
  response.headers.forEach((value, key) => res.set(key, value));
  res.status(response.status);
  if (!isEventStream(response) || !response.body) {
    res.send(await response.text());
    return;
  }
  res.flushHeaders();
  try {
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res);
  } catch (error) {
    // A client closing a listen stream is how one normally ends, so that is not
    // worth a line. Anything else is a real failure, and the status and headers
    // are already committed, so the log is the only place it can surface.
    if (!isClientHangUp(error)) {
      logger.error(`MCP stream failed: ${error instanceof Error ? error.stack : String(error)}`);
    }
  }
}
