import { Module } from '@nestjs/common';
import { buildVersionCheckConfig } from './version-check.config';
import { VERSION_CHECK_CONFIG, VersionCheckService } from './version-check.service';
import { VersionController } from './version.controller';

@Module({
  controllers: [VersionController],
  providers: [
    { provide: VERSION_CHECK_CONFIG, useFactory: buildVersionCheckConfig },
    VersionCheckService,
  ],
})
export class VersionModule {}
