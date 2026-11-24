import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../entities/agent.entity';
import { ApiKey } from '../entities/api-key.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { ManifestRequest } from '../entities/request.entity';
import { InstallIdService } from './install-id.service';
import { PayloadBuilderService } from './payload-builder.service';
import { TelemetryService } from './telemetry.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InstallMetadata, AgentMessage, Agent, ManifestRequest, ApiKey]),
  ],
  providers: [InstallIdService, PayloadBuilderService, TelemetryService],
  // Autofix announces the same anonymous install id to Phoenix, so the id
  // service is shared rather than duplicated. Telemetry sending stays gated on
  // its own opt-out: exporting the id does not send anything.
  exports: [InstallIdService],
})
export class TelemetryModule {}
