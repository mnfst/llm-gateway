import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../../entities/agent-enabled-provider.entity';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import { AgentModelParams } from '../../entities/agent-model-params.entity';
import { Agent } from '../../entities/agent.entity';
import { Tenant } from '../../entities/tenant.entity';
import { AgentMessage } from '../../entities/agent-message.entity';
import { HeaderTier } from '../../entities/header-tier.entity';
import { ModelPricesModule } from '../../model-prices/model-prices.module';
import { ModelDiscoveryModule } from '../../model-discovery/model-discovery.module';
import { ProviderService } from './provider.service';
import { TierService } from './tier.service';
import { ProviderKeyService } from './provider-key.service';
import { RoutingCacheService } from './routing-cache.service';
import { RoutingInvalidationService } from './routing-invalidation.service';
import { RoutingCacheSyncService } from './routing-cache-sync.service';
import { RoutingCacheFlushInterceptor } from './routing-cache-flush.interceptor';
import { ResolveAgentService } from './resolve-agent.service';
import { SpecificityService } from './specificity.service';
import { SpecificityPenaltyService } from './specificity-penalty.service';
import { AgentModelParamsService } from './agent-model-params.service';
import { ProviderParamSpecService } from './provider-param-spec.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantProvider,
      AgentEnabledProvider,
      TierAssignment,
      SpecificityAssignment,
      AgentModelParams,
      Agent,
      Tenant,
      AgentMessage,
      HeaderTier,
    ]),
    ModelPricesModule,
    ModelDiscoveryModule,
  ],
  providers: [
    ProviderService,
    TierService,
    ProviderKeyService,
    RoutingCacheService,
    RoutingCacheSyncService,
    { provide: APP_INTERCEPTOR, useClass: RoutingCacheFlushInterceptor },
    RoutingInvalidationService,
    ResolveAgentService,
    SpecificityService,
    SpecificityPenaltyService,
    AgentModelParamsService,
    ProviderParamSpecService,
  ],
  exports: [
    TypeOrmModule,
    ProviderService,
    TierService,
    ProviderKeyService,
    RoutingCacheService,
    RoutingCacheSyncService,
    RoutingInvalidationService,
    ResolveAgentService,
    SpecificityService,
    SpecificityPenaltyService,
    AgentModelParamsService,
    ProviderParamSpecService,
  ],
})
export class RoutingCoreModule {}
