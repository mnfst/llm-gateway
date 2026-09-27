import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublicErrorPage } from '../entities/public-error-page.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { ErrorPagesService } from './error-pages.service';
import { ErrorDiscoveryService } from './error-discovery.service';
import { ErrorClusterSeederService } from './error-cluster-seeder.service';
import { ErrorPageSeederService } from './error-page-seeder.service';
import { PublicErrorPagesController } from './public-error-pages.controller';
import { InternalErrorPagesController } from './internal-error-pages.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PublicErrorPage, AgentMessage])],
  controllers: [PublicErrorPagesController, InternalErrorPagesController],
  providers: [
    ErrorPagesService,
    ErrorDiscoveryService,
    ErrorClusterSeederService,
    ErrorPageSeederService,
  ],
})
export class ErrorPagesModule {}
