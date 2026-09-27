import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';
import { Agent } from '../entities/agent.entity';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { Tenant } from '../entities/tenant.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';
import { HeaderTier } from '../entities/header-tier.entity';
import { AgentModelParams } from '../entities/agent-model-params.entity';
import { OtlpModule } from '../otlp/otlp.module';
import { RoutingCoreModule } from '../routing/routing-core/routing-core.module';
import { ModelPricesModule } from '../model-prices/model-prices.module';
import { AggregationService } from './services/aggregation.service';
import { AgentDuplicationService } from './services/agent-duplication.service';
import { AgentLifecycleService } from './services/agent-lifecycle.service';
import { TimeseriesQueriesService } from './services/timeseries-queries.service';
import { MessagesQueryService } from './services/messages-query.service';
import { MessageDetailsService } from './services/message-details.service';
import { ErrorBreakdownService } from './services/error-breakdown.service';
import { MessageFeedbackService } from './services/message-feedback.service';
import { SpecificityFeedbackService } from './services/specificity-feedback.service';
import { AgentAnalyticsService } from './services/agent-analytics.service';
import { ProviderUsageService } from './services/provider-usage.service';
import { OverviewController } from './controllers/overview.controller';
import { ProviderUsageController } from './controllers/provider-usage.controller';
import { TokensController } from './controllers/tokens.controller';
import { CostsController } from './controllers/costs.controller';
import { MessagesController } from './controllers/messages.controller';
import { AgentsController } from './controllers/agents.controller';
import { AgentAnalyticsController } from './controllers/agent-analytics.controller';
import { ProviderAnalyticsController } from './controllers/provider-analytics.controller';
import { ErrorsController } from './controllers/errors.controller';
import { AttemptAnalyticsController } from './controllers/attempt-analytics.controller';
import { AttemptStatsService } from './services/attempt-stats.service';
import { AutofixAnalyticsController } from './controllers/autofix-analytics.controller';
import { AutofixStatsService } from './services/autofix-stats.service';
import { RequestVolumeService } from './services/request-volume.service';
import { BillingModule } from '../billing/billing.module';
import { AutofixModule } from '../routing/autofix/autofix.module';
import { AgentUsageDailyService } from './services/agent-usage-daily.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentMessage,
      ManifestRequest,
      Agent,
      InstallMetadata,
      Tenant,
      CustomProvider,
      TenantProvider,
      AgentEnabledProvider,
      TierAssignment,
      SpecificityAssignment,
      HeaderTier,
      AgentModelParams,
    ]),
    OtlpModule,
    RoutingCoreModule,
    ModelPricesModule,
    BillingModule,
    AutofixModule,
  ],
  controllers: [
    OverviewController,
    TokensController,
    CostsController,
    MessagesController,
    AgentsController,
    AgentAnalyticsController,
    ProviderAnalyticsController,
    ProviderUsageController,
    ErrorsController,
    AttemptAnalyticsController,
    AutofixAnalyticsController,
  ],
  providers: [
    AggregationService,
    AgentDuplicationService,
    AgentLifecycleService,
    TimeseriesQueriesService,
    MessagesQueryService,
    MessageDetailsService,
    ErrorBreakdownService,
    MessageFeedbackService,
    SpecificityFeedbackService,
    AgentAnalyticsService,
    ProviderUsageService,
    AttemptStatsService,
    AutofixStatsService,
    RequestVolumeService,
    AgentUsageDailyService,
  ],
  exports: [
    SpecificityFeedbackService,
    ProviderUsageService,
    AgentLifecycleService,
    TimeseriesQueriesService,
    MessagesQueryService,
    AutofixStatsService,
  ],
})
export class AnalyticsModule {}
