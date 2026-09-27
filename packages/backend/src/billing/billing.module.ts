import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from '../entities/tenant.entity';
import { BillingController } from './billing.controller';
import { PlanService } from './plan.service';
import { BillingEmailLogService } from './billing-email-log.service';
import { BillingEmailService } from './billing-email.service';
import { BillingUsageEmailService } from './billing-usage-email.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tenant])],
  controllers: [BillingController],
  providers: [PlanService, BillingEmailLogService, BillingEmailService, BillingUsageEmailService],
  exports: [PlanService],
})
export class BillingModule {}
