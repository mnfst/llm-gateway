import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ShutdownService } from './shutdown.service';

@Module({
  controllers: [HealthController],
  providers: [ShutdownService],
})
export class HealthModule {}
