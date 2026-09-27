import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

@Controller('api/v1')
export class DebugSentryController {
  @Public()
  @Get('debug-sentry')
  getError(): never {
    throw new Error('My first Sentry error!');
  }
}
