import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CompleteDiscoveryDto } from './dto/complete-discovery.dto';
import { DiscoverySyncService } from './discovery-sync.service';

@Controller('api/v1/discovery')
export class DiscoveryController {
  constructor(private readonly discoverySync: DiscoverySyncService) {}

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(@Body() submission: CompleteDiscoveryDto): { ok: true } {
    void this.discoverySync.submit(submission);
    return { ok: true };
  }
}
