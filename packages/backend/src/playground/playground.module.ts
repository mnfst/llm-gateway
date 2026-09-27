import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';
import { Agent } from '../entities/agent.entity';
import { PlaygroundRun } from '../entities/playground-run.entity';
import { PlaygroundColumn } from '../entities/playground-column.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { CommonModule } from '../common/common.module';
import { ModelPricesModule } from '../model-prices/model-prices.module';
import { RoutingCoreModule } from '../routing/routing-core/routing-core.module';
import { ProxyModule } from '../routing/proxy/proxy.module';
import { OAuthModule } from '../routing/oauth/oauth.module';
import { ModelDiscoveryModule } from '../model-discovery/model-discovery.module';
import { CustomProviderModule } from '../routing/custom-provider/custom-provider.module';
import { PlaygroundController } from './playground.controller';
import { PlaygroundService } from './playground.service';
import { PlaygroundHistoryService } from './playground-history.service';
import { PlaygroundAgentService } from './playground-agent.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentMessage,
      ManifestRequest,
      Agent,
      PlaygroundRun,
      PlaygroundColumn,
      CustomProvider,
    ]),
    CommonModule,
    ModelPricesModule,
    RoutingCoreModule,
    ProxyModule,
    OAuthModule,
    ModelDiscoveryModule,
    CustomProviderModule,
  ],
  controllers: [PlaygroundController],
  providers: [PlaygroundService, PlaygroundHistoryService, PlaygroundAgentService],
})
export class PlaygroundModule {}
