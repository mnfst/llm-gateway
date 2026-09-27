import { DataSource, Repository } from 'typeorm';
import type { Cache } from 'cache-manager';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { Agent } from '../entities/agent.entity';
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
import { RouteModelParamsService } from '../routing/model-params/route-model-params.service';
import { ModelDiscoveryService } from '../model-discovery/model-discovery.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelPricesService } from '../model-prices/model-prices.service';

/**
 * The Manifest services the MCP tools call. Injected once and closed over by the
 * per-request server, so a tool reaches the exact behaviour the dashboard and
 * CLI do — this is the mutualization seam, and it is why no tool speaks HTTP.
 */
export interface McpToolDeps {
  dataSource: DataSource;
  tenantCache: TenantCacheService;
  cacheManager: Cache;
  agentListCache: AgentListCacheService;
  eventBus: IngestEventBusService;
  recording: AgentRecordingConfigService;
  timeseries: TimeseriesQueriesService;
  lifecycle: AgentLifecycleService;
  apiKeys: ApiKeyGeneratorService;
  autofixStats: AutofixStatsService;
  messages: MessagesQueryService;
  providers: ProviderService;
  tiers: TierService;
  specificity: SpecificityService;
  resolveAgent: ResolveAgentService;
  headerTiers: HeaderTierService;
  customProviders: CustomProviderService;
  autofix: AutofixService;
  routeModelParams: RouteModelParamsService;
  modelDiscovery: ModelDiscoveryService;
  pricingSync: PricingSyncService;
  modelPrices: ModelPricesService;
  tenantProviderRepo: Repository<TenantProvider>;
  agentEnabledProviderRepo: Repository<AgentEnabledProvider>;
  agentRepo: Repository<Agent>;
}
