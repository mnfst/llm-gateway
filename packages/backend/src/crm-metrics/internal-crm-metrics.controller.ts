import {
  Controller,
  Get,
  Headers,
  Ip,
  Logger,
  NotFoundException,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../common/decorators/public.decorator';
import { timingSafeCompare } from '../common/utils/crypto.util';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { CrmMetricsService } from './crm-metrics.service';
import { CrmMetricsQueryDto } from './dto/crm-metrics-query.dto';
import type { CrmCorporateSignup, CrmHealedUser, CrmWaitlistClaim } from './crm-metrics.types';

/**
 * Internal read API for the CRM outreach pipeline.
 *
 * `@Public()` to skip the session/api-key guards, then gated by a shared secret
 * in the `x-internal-secret` header. Lives under /api/* so the SPA static
 * fallback never shadows it.
 *
 * This is the first Manifest endpoint that exports user email addresses across
 * tenants, so it is deliberately stricter than the error-pages sibling it is
 * modelled on: the comparison is constant-time, and a secret too short to be
 * worth anything counts as unconfigured rather than as a weak guard on a full
 * user list. Nothing here logs the payload.
 *
 * Cloud only. app.module.ts already leaves the module unregistered on
 * self-hosted, but that check runs at import time, before ConfigModule reads
 * `.env` — so a bare-metal install carrying `MANIFEST_MODE` only in its `.env`
 * would look like Cloud there. Containers are unaffected (`/.dockerenv` is
 * detected without any env), but this second check closes the gap: it resolves
 * at construction, after configuration is loaded.
 */
@Controller('api/v1/internal/crm-metrics')
export class InternalCrmMetricsController {
  /** Below this, a configured value is treated as absent. */
  private static readonly MIN_SECRET_LENGTH = 32;
  private static readonly DEFAULT_COHORT_DAYS = 7;
  private static readonly DEFAULT_CLAIM_DAYS = 90;
  /**
   * The widest window `CrmMetricsQueryDto` allows, which today is every signup
   * ever (the first one is from February 2026).
   *
   * Wide on purpose: the signup campaign emails each person once ever and
   * remembers who in the CRM rather than via a window, so a narrow default
   * would strand anyone a late or failed run skipped. Once Manifest is more
   * than a year old this stops being the full history, and someone who was
   * never successfully contacted before ageing out would be missed. Raise the
   * DTO cap then rather than assuming this number still means "everyone".
   */
  private static readonly DEFAULT_SIGNUP_DAYS = 365;

  private readonly logger = new Logger(InternalCrmMetricsController.name);

  /** Resolved once at construction, which is after ConfigModule loads `.env`. */
  private readonly selfHosted = isSelfHosted();

  constructor(
    private readonly service: CrmMetricsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Answer exactly as an unmounted route would. Checked before the secret so a
   * self-hosted install never reveals whether one is configured.
   */
  private assertCloud(): void {
    if (this.selfHosted) throw new NotFoundException();
  }

  private assertSecret(provided: string | undefined, ip: string): void {
    const expected = this.config.get<string>('app.crmMetricsSecret') ?? '';
    const configured = expected.length >= InternalCrmMetricsController.MIN_SECRET_LENGTH;
    if (!configured || !timingSafeCompare(provided ?? '', expected)) {
      this.logger.warn(`Rejected CRM metrics request from ${ip}`);
      throw new UnauthorizedException('Invalid or missing internal secret');
    }
  }

  /** Users whose failing requests Autofix repaired inside the window. */
  @Public()
  @Get()
  async cohort(
    @Headers('x-internal-secret') secret: string,
    @Ip() ip: string,
    @Query() query: CrmMetricsQueryDto,
  ): Promise<CrmHealedUser[]> {
    this.assertCloud();
    this.assertSecret(secret, ip);
    return this.service.getHealedCohort(
      query.days ?? InternalCrmMetricsController.DEFAULT_COHORT_DAYS,
    );
  }

  /**
   * Verified signups on organisation domains — the Autofix outreach cohort.
   *
   * A corporate address implies a team, and a team calling third-party APIs is
   * the product's audience whether or not they ever routed an LLM request
   * through the gateway. `has_traffic` is what the copy branches on.
   *
   * Excludes anyone who claimed the pivot waiting list: that cohort is worked
   * by hand and lives on the `conversions` route.
   */
  @Public()
  @Get('signups')
  async signups(
    @Headers('x-internal-secret') secret: string,
    @Ip() ip: string,
    @Query() query: CrmMetricsQueryDto,
  ): Promise<CrmCorporateSignup[]> {
    this.assertCloud();
    this.assertSecret(secret, ip);
    return this.service.getCorporateSignups(
      query.days ?? InternalCrmMetricsController.DEFAULT_SIGNUP_DAYS,
    );
  }

  /** Pivot waiting-list claims — the campaign's conversion signal. */
  @Public()
  @Get('conversions')
  async conversions(
    @Headers('x-internal-secret') secret: string,
    @Ip() ip: string,
    @Query() query: CrmMetricsQueryDto,
  ): Promise<CrmWaitlistClaim[]> {
    this.assertCloud();
    this.assertSecret(secret, ip);
    return this.service.getConversions(
      query.days ?? InternalCrmMetricsController.DEFAULT_CLAIM_DAYS,
    );
  }
}
