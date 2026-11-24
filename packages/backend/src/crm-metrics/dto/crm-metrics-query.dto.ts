import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Window selector for both CRM metrics routes.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so
 * anything not declared here makes the request 400. `@Type` is what coerces the
 * query string into a number.
 *
 * A day count rather than an ISO `since`: this backend has no `@IsDateString`
 * precedent, and the payload already carries `first_heal_at` / `last_heal_at`
 * per user, so a consumer that wants a delta can compute one itself.
 */
export class CrmMetricsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  @Type(() => Number)
  days?: number;
}
