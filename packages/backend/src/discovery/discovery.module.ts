import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { DiscoverySyncService } from './discovery-sync.service';

@Module({
  controllers: [DiscoveryController],
  providers: [DiscoverySyncService],
})
export class DiscoveryModule {}
