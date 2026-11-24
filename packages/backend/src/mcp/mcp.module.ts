import { Module } from '@nestjs/common';
import { RouteModelParamsModule } from '../routing/model-params/route-model-params.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CommonModule } from '../common/common.module';
import { AutofixModule } from '../routing/autofix/autofix.module';
import { CustomProviderModule } from '../routing/custom-provider/custom-provider.module';
import { HeaderTiersModule } from '../routing/header-tiers/header-tiers.module';
import { RoutingCoreModule } from '../routing/routing-core/routing-core.module';
import { ModelDiscoveryModule } from '../model-discovery/model-discovery.module';
import { ModelPricesModule } from '../model-prices/model-prices.module';
import { OtlpModule } from '../otlp/otlp.module';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { Agent } from '../entities/agent.entity';
import { McpController } from './mcp.controller';

/**
 * The remote MCP server. It owns no data of its own — every tool calls the same
 * services the HTTP controllers do, so behaviour cannot drift between the
 * dashboard, the CLI, and an AI client.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TenantProvider, AgentEnabledProvider, Agent]),
    CommonModule,
    AnalyticsModule,
    RoutingCoreModule,
    HeaderTiersModule,
    CustomProviderModule,
    AutofixModule,
    ModelDiscoveryModule,
    ModelPricesModule,
    OtlpModule,
    RouteModelParamsModule,
  ],
  controllers: [McpController],
})
export class McpModule {}
