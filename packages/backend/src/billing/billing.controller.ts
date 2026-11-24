import { Body, Controller, Get, Patch } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../common/decorators/tenant-context.decorator';
import { PlanService } from './plan.service';
import { UpdateBillingEmailPreferencesDto } from './dto/update-billing-email-preferences.dto';

@Controller('api/v1')
export class BillingController {
  constructor(private readonly planService: PlanService) {}

  @Get('billing/status')
  async status(@TenantCtx() ctx: TenantContext) {
    return this.planService.getBillingStatus(ctx);
  }

  @Get('billing/plan')
  async plan(@TenantCtx() ctx: TenantContext) {
    return this.planService.getPlanStatus(ctx);
  }

  @Patch('billing/email-preferences')
  async updateEmailPreferences(
    @TenantCtx() ctx: TenantContext,
    @Body() body: UpdateBillingEmailPreferencesDto,
  ) {
    return this.planService.updateBillingEmailPreferences(ctx, body);
  }
}
