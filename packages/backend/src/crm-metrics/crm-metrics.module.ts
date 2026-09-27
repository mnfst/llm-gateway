import { Module } from '@nestjs/common';
import { CrmMetricsService } from './crm-metrics.service';
import { InternalCrmMetricsController } from './internal-crm-metrics.controller';

/**
 * Internal feed the CRM polls to drive Autofix product outreach. Queries run
 * through the injected DataSource, so no `TypeOrmModule.forFeature` is needed.
 */
@Module({
  controllers: [InternalCrmMetricsController],
  providers: [CrmMetricsService],
})
export class CrmMetricsModule {}
