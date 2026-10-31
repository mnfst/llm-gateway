import { Controller, Get, Optional } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { QuotaAccountingSnapshot } from './quota-accounting';
import { QuotaAccountingService } from './quota-accounting.service';

/**
 * Public read model of attempted-vs-consumed quota accounting (RET-480-B2)
 * for the day-deck. Telemetry only: the service is optional-injected so a
 * missing accounting module can never 500 the endpoint.
 */
@Controller('api/v1/quota-accounting')
export class QuotaAccountingController {
  constructor(
    @Optional()
    private readonly quotaAccounting?: QuotaAccountingService,
  ) {}

  @Public()
  @Get()
  getQuotaAccounting(): QuotaAccountingSnapshot {
    return this.quotaAccounting?.snapshot() ?? { providers: {} };
  }
}
