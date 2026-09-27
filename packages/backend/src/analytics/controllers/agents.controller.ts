import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { CACHE_MANAGER, CacheTTL } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { TimeseriesQueriesService } from '../services/timeseries-queries.service';
import { AgentLifecycleService } from '../services/agent-lifecycle.service';
import { AgentDuplicationService } from '../services/agent-duplication.service';
import { ApiKeyGeneratorService } from '../../otlp/services/api-key.service';
import { IngestEventBusService } from '../../common/services/ingest-event-bus.service';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { CreateAgentDto } from '../../common/dto/create-agent.dto';
import { DuplicateAgentDto } from '../../common/dto/duplicate-agent.dto';
import { RenameAgentDto } from '../../common/dto/rename-agent.dto';
import { AgentListCacheInterceptor } from '../../common/interceptors/agent-list-cache.interceptor';
import { AGENT_LIST_CACHE_TTL_MS } from '../../common/constants/cache.constants';
import { AgentListCacheService } from '../../common/services/agent-list-cache.service';
import { slugify } from '../../common/utils/slugify';
import { PLAYGROUND_AGENT_SLUG } from '../../common/constants/playground.constants';
import { ProviderService } from '../../routing/routing-core/provider.service';
import { AutofixStatsService } from '../services/autofix-stats.service';

@Controller('api/v1')
export class AgentsController {
  private readonly logger = new Logger(AgentsController.name);

  constructor(
    private readonly timeseries: TimeseriesQueriesService,
    private readonly lifecycle: AgentLifecycleService,
    private readonly duplication: AgentDuplicationService,
    private readonly apiKeyGenerator: ApiKeyGeneratorService,
    private readonly eventBus: IngestEventBusService,
    private readonly providerService: ProviderService,
    private readonly autofixStats: AutofixStatsService,
    private readonly agentListCache: AgentListCacheService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private async invalidateAgentListCache(tenantId: string | null): Promise<void> {
    // GET /agents has exactly two canonical cache entries per tenant (playground
    // agents included or not — see AgentListCacheService). Retire both so
    // neither the Workspace list nor the Messages filter goes stale after a
    // mutation. No tenant → nothing was ever cached.
    if (!tenantId) return;
    await this.agentListCache.invalidate(tenantId);
  }

  private async invalidateAutofixStatusCache(tenantId: string | null): Promise<void> {
    if (!tenantId) return;
    await this.cacheManager.del(`${tenantId}:/api/v1/autofix/status`);
  }

  private emitAgentEvent(tenantId: string | null, userId: string | null): void {
    // The event bus is tenant-keyed; the user id rides along as attribution
    // only. No tenant → nobody can be subscribed to the change.
    if (tenantId) this.eventBus.emit(tenantId, 'agent', userId);
  }

  @Get('agents')
  @UseInterceptors(AgentListCacheInterceptor)
  @CacheTTL(AGENT_LIST_CACHE_TTL_MS)
  async getAgents(
    @TenantCtx() ctx: TenantContext,
    @Query('includePlayground') includePlayground?: string,
  ) {
    const agents = await this.timeseries.getAgentList(ctx.tenantId, includePlayground === 'true');
    return { agents };
  }

  @Post('agents')
  async createAgent(@TenantCtx() ctx: TenantContext, @Body() body: CreateAgentDto) {
    const slug = slugify(body.name);
    if (!slug) {
      throw new BadRequestException('Agent name produces an empty slug');
    }
    if (slug === PLAYGROUND_AGENT_SLUG) {
      throw new BadRequestException('"Playground" is a reserved agent name');
    }
    const displayName = body.name.trim();
    let result: Awaited<ReturnType<ApiKeyGeneratorService['onboardAgent']>>;
    try {
      // The create dialog presents the hosted Autofix disclosure and legal
      // links whenever this explicit opt-in is on. Persist that install-level
      // consent before creating an enabled agent so failures stay fail-closed.
      if (body.autofix_enabled === true) {
        await this.autofixStats.recordAutofixConsent();
        await this.invalidateAutofixStatusCache(ctx.tenantId);
      }
      result = await this.apiKeyGenerator.onboardAgent({
        tenantId: ctx.tenantId,
        ownerUserId: ctx.userId,
        agentName: slug,
        displayName,
        agentCategory: body.agent_category,
        agentPlatform: body.agent_platform,
        autofixEnabled: body.autofix_enabled,
        recordMessages: body.record_messages,
      });
    } catch (error) {
      if (error instanceof QueryFailedError && /unique|duplicate/i.test(error.message)) {
        throw new ConflictException(`Agent "${slug}" already exists`);
      }
      throw error;
    }
    // Providers are tenant-global + ON by default: a brand-new agent immediately
    // inherits access to every usable provider the tenant already connected.
    //
    // This runs OUTSIDE the onboarding transaction (onboardAgent commits before
    // returning and does not expose its EntityManager), so a failure here would
    // otherwise leave a routable agent with zero enabled providers. Compensate
    // by rolling the agent back (soft-delete + key deactivation) and surface
    // the original error so the client can retry cleanly.
    try {
      await this.providerService.enableAllProvidersForAgent(result.agentId, result.tenantId);
    } catch (error) {
      this.logger.error(
        `Failed to enable providers for new agent "${slug}" (${result.agentId}); rolling back agent creation`,
        error instanceof Error ? error.stack : String(error),
      );
      try {
        await this.lifecycle.deleteAgent(result.tenantId, slug);
      } catch (cleanupError) {
        this.logger.error(
          `Compensating cleanup failed for agent "${slug}" (${result.agentId}); it may be left without providers`,
          cleanupError instanceof Error ? cleanupError.stack : String(cleanupError),
        );
      }
      // The agent was committed (briefly visible) then rolled back, so drop the
      // cache entries that captured it — deleteAgent only clears the resolve +
      // routing caches. The Autofix status key matters as much as the agent
      // list: without it, /autofix/status keeps reporting the rolled-back agent
      // as enabled for the dashboard TTL, so the sidebar disagrees with the
      // workspace about an agent that no longer exists.
      await Promise.all([
        this.invalidateAgentListCache(result.tenantId),
        this.invalidateAutofixStatusCache(result.tenantId),
      ]);
      throw error;
    }
    await Promise.all([
      this.invalidateAgentListCache(result.tenantId),
      this.invalidateAutofixStatusCache(result.tenantId),
    ]);
    this.emitAgentEvent(result.tenantId, ctx.userId);
    return {
      agent: {
        id: result.agentId,
        name: slug,
        display_name: displayName,
        agent_category: body.agent_category ?? null,
        agent_platform: body.agent_platform ?? null,
      },
      apiKey: result.apiKey,
    };
  }

  @Get('agents/:agentName/duplicate-preview')
  async getDuplicatePreview(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
  ) {
    const [copied, suggested_name] = await Promise.all([
      this.duplication.getCopySummary(ctx.tenantId, agentName),
      this.duplication.suggestName(ctx.tenantId, agentName),
    ]);
    return { copied, suggested_name };
  }

  @Post('agents/:agentName/duplicate')
  async duplicateAgent(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') sourceName: string,
    @Body() body: DuplicateAgentDto,
  ) {
    const slug = slugify(body.name);
    if (!slug) throw new BadRequestException('Agent name produces an empty slug');
    if (slug === PLAYGROUND_AGENT_SLUG) {
      throw new BadRequestException('"Playground" is a reserved agent name');
    }
    const displayName = body.name.trim();
    let result: Awaited<ReturnType<AgentDuplicationService['duplicate']>>;
    try {
      result = await this.duplication.duplicate(ctx.tenantId, sourceName, {
        name: slug,
        displayName,
      });
    } catch (error) {
      if (error instanceof QueryFailedError && /unique|duplicate/i.test(error.message)) {
        throw new ConflictException(`Agent "${slug}" already exists`);
      }
      throw error;
    }
    await this.invalidateAgentListCache(ctx.tenantId);
    this.emitAgentEvent(ctx.tenantId, ctx.userId);
    return {
      agent: {
        id: result.agentId,
        name: result.agentName,
        display_name: result.displayName,
      },
      apiKey: result.apiKey,
      copied: result.copied,
    };
  }

  @Get('agents/:agentName')
  async getAgentInfo(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    const info = await this.lifecycle.findAgentInfo(ctx.tenantId, agentName);
    if (!info) return { agent: null };
    return { agent: info };
  }

  @Get('agents/:agentName/key')
  async getAgentKey(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    // Guard: playground agents cannot expose their API key through the user-facing
    // key endpoint (findAgentInfo filters is_playground = false and returns null for
    // the reserved "Playground" agent, same as for any missing agent).
    const info = await this.lifecycle.findAgentInfo(ctx.tenantId, agentName);
    if (!info || !ctx.tenantId) throw new NotFoundException(`Agent "${agentName}" not found`);
    const keyData = await this.apiKeyGenerator.getKeyForAgent(ctx.tenantId, agentName);
    const apiKey = keyData.fullKey ?? undefined;
    return {
      keyPrefix: keyData.keyPrefix,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  @Post('agents/:agentName/rotate-key')
  async rotateAgentKey(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    // Guard: playground agents cannot have their key rotated through the user-facing
    // endpoint (findAgentInfo filters is_playground = false and returns null for the
    // reserved "Playground" agent, same as for any missing agent).
    const info = await this.lifecycle.findAgentInfo(ctx.tenantId, agentName);
    if (!info || !ctx.tenantId) throw new NotFoundException(`Agent "${agentName}" not found`);
    const result = await this.apiKeyGenerator.rotateKey(ctx.tenantId, agentName);
    return { apiKey: result.apiKey };
  }

  @Patch('agents/:agentName')
  async updateAgent(
    @TenantCtx() ctx: TenantContext,
    @Param('agentName') agentName: string,
    @Body() body: RenameAgentDto,
  ) {
    const result: Record<string, unknown> = {};

    if (body.name) {
      const slug = slugify(body.name);
      if (!slug) throw new BadRequestException('Agent name produces an empty slug');
      if (slug === PLAYGROUND_AGENT_SLUG) {
        throw new BadRequestException('"Playground" is a reserved agent name');
      }
      const displayName = body.name.trim();
      await this.lifecycle.renameAgent(ctx.tenantId, agentName, slug, displayName);
      result['renamed'] = true;
      result['name'] = slug;
      result['display_name'] = displayName;
    }

    if (body.agent_category !== undefined || body.agent_platform !== undefined) {
      await this.lifecycle.updateAgentType(
        ctx.tenantId,
        body.name ? slugify(body.name)! : agentName,
        {
          agent_category: body.agent_category,
          agent_platform: body.agent_platform,
        },
      );
      if (body.agent_category !== undefined) result['agent_category'] = body.agent_category;
      if (body.agent_platform !== undefined) result['agent_platform'] = body.agent_platform;
    }

    await this.invalidateAgentListCache(ctx.tenantId);
    this.emitAgentEvent(ctx.tenantId, ctx.userId);
    return result;
  }

  @Delete('agents/:agentName')
  async deleteAgent(@TenantCtx() ctx: TenantContext, @Param('agentName') agentName: string) {
    await this.lifecycle.deleteAgent(ctx.tenantId, agentName);
    await this.invalidateAgentListCache(ctx.tenantId);
    this.emitAgentEvent(ctx.tenantId, ctx.userId);
    return { deleted: true };
  }
}
