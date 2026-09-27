import { Controller, Get } from '@nestjs/common';
import { VersionCheckService, type VersionInfo } from './version-check.service';

/**
 * Running version + latest release for the self-hosted dashboard's update
 * badge. Session/API-key guarded like the rest of the dashboard API: the
 * version an install runs is not something to hand to anonymous callers.
 */
@Controller('api/v1')
export class VersionController {
  constructor(private readonly versionCheck: VersionCheckService) {}

  @Get('version')
  getVersion(): Promise<VersionInfo> {
    return this.versionCheck.getVersionInfo();
  }
}
