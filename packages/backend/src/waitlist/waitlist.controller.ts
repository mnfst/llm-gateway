import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';
import { WaitlistClaim } from '../entities/waitlist-claim.entity';
import { DEFAULT_PIVOT_CLAIM_SOURCE, PivotClaimDto } from './dto/pivot-claim.dto';

/**
 * Same-origin check for the sourceless fallback: a stale cloud bundle from
 * before the source field posts same-origin to its own backend, while
 * self-hosted dashboards post cross-origin. Explicit sources bypass this.
 */
export function claimRequestIsSameOrigin(headers: {
  origin?: string | string[];
  host?: string | string[];
}): boolean {
  const origin = headers.origin;
  const host = headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

@Controller('api/v1/waitlist')
export class WaitlistController {
  constructor(
    @InjectRepository(WaitlistClaim)
    private readonly claimRepo: Repository<WaitlistClaim>,
  ) {}

  /**
   * Compatibility endpoint for self-hosted versions that predate Autofix GA.
   * Keep returning 200 during the deprecation window, but do not retain new
   * waitlist claims now that every tenant has access.
   */
  @Public()
  @Post('autofix/claim')
  @HttpCode(HttpStatus.OK)
  receiveClaim(): { ok: boolean } {
    return { ok: true };
  }

  /**
   * Pivot waiting-list claim. Public and CORS-open on purpose: cloud posts
   * same-origin and self-hosted dashboards post here straight from the
   * browser, so any locally-registered user can join with a corrected email.
   * The upsert dedupes by email and the latest claim wins, source included:
   * attribution reflects where the person last joined from, matching the
   * historical phone-home behavior. The global throttler still applies.
   */
  @Public()
  @Post('pivot/claim')
  @HttpCode(HttpStatus.OK)
  async receivePivotClaim(
    @Body() dto: PivotClaimDto,
    @Req() req: Request,
  ): Promise<{ ok: boolean }> {
    // An explicit source always wins; a sourceless same-origin post is the
    // cloud dashboard (a cached pre-source bundle) talking to its own
    // backend, anything else defaults to self-hosted.
    const source =
      dto.source ?? (claimRequestIsSameOrigin(req.headers) ? 'cloud' : DEFAULT_PIVOT_CLAIM_SOURCE);
    await this.claimRepo
      .createQueryBuilder()
      .insert()
      .into(WaitlistClaim)
      .values({
        email: dto.email.trim().toLowerCase(),
        source,
        claimed_at: new Date().toISOString(),
      })
      // Latest claim wins among the sources this route owns; a website row
      // (Peacock's own form) is never overwritten by this public endpoint.
      .orUpdate(['source', 'claimed_at'], ['email'], {
        overwriteCondition: {
          where: '"waitlist_claims"."source" != :websiteSource',
          parameters: { websiteSource: 'website' },
        },
      })
      .execute();
    return { ok: true };
  }
}
