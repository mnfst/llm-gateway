import { Module } from '@nestjs/common';
import { RouteModelParamsModule } from './model-params/route-model-params.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelPricesModule } from '../model-prices/model-prices.module';
import { ModelDiscoveryModule } from '../model-discovery/model-discovery.module';
import { OtlpModule } from '../otlp/otlp.module';
import { RoutingCoreModule } from './routing-core/routing-core.module';
import { ProxyModule } from './proxy/proxy.module';
import { OAuthModule } from './oauth/oauth.module';
import { CustomProviderModule } from './custom-provider/custom-provider.module';
import { ResolveModule } from './resolve/resolve.module';
import { HeaderTiersModule } from './header-tiers/header-tiers.module';
import { AutofixModule } from './autofix/autofix.module';
import { ProviderController } from './provider.controller';
import { TierController } from './tier.controller';
import { ModelController } from './model.controller';
import { CopilotController } from './oauth/copilot/copilot.controller';
import { SpecificityController } from './specificity.controller';
import { ModelParamsController } from './model-params.controller';
import { TenantProvidersController } from './tenant-providers.controller';
import { AgentEnabledProvidersController } from './agent-enabled-providers.controller';
import { ManagedFreeProviderController } from './managed-free-provider/managed-free-provider.controller';
import { ManagedFreeProviderService } from './managed-free-provider/managed-free-provider.service';
import { OllamaSyncService } from '../database/ollama-sync.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { Agent } from '../entities/agent.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { Tenant } from '../entities/tenant.entity';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';
import { HeaderTier } from '../entities/header-tier.entity';
import { InstallMetadata } from '../entities/install-metadata.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantProvider,
      AgentEnabledProvider,
      Agent,
      AgentMessage,
      Tenant,
      TierAssignment,
      SpecificityAssignment,
      HeaderTier,
      InstallMetadata,
    ]),
    RoutingCoreModule,
    ModelPricesModule,
    ModelDiscoveryModule,
    NotificationsModule,
    OtlpModule,
    ProxyModule,
    OAuthModule,
    CustomProviderModule,
    ResolveModule,
    HeaderTiersModule,
    AutofixModule,
    RouteModelParamsModule,
  ],
  controllers: [
    ProviderController,
    TierController,
    ModelController,
    CopilotController,
    SpecificityController,
    ModelParamsController,
    TenantProvidersController,
    AgentEnabledProvidersController,
    ManagedFreeProviderController,
  ],
  providers: [OllamaSyncService, ManagedFreeProviderService],
  exports: [RoutingCoreModule, CustomProviderModule, OAuthModule],
})
export class RoutingModule {}
