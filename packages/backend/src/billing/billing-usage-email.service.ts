import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Subscription } from 'rxjs';
import { IngestEventBusService } from '../common/services/ingest-event-bus.service';
import { isBillingEnabled } from './billing.config';
import { PlanService } from './plan.service';
import { BillingEmailLogService } from './billing-email-log.service';
import { BillingEmailService } from './billing-email.service';
import { normalizeBillingEmailPreferences } from './billing-email-preferences';

const REQUEST_WARNING_RATIO = 0.8;

interface BillingRecipient {
  email: string | null;
  name: string | null;
  user_id: string | null;
  billing_email_preferences: unknown;
}

@Injectable()
export class BillingUsageEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingUsageEmailService.name);
  private ingestSub?: Subscription;

  constructor(
    private readonly ingestBus: IngestEventBusService,
    private readonly planService: PlanService,
    private readonly dataSource: DataSource,
    private readonly logs: BillingEmailLogService,
    private readonly emails: BillingEmailService,
  ) {}

  onModuleInit(): void {
    this.ingestSub = this.ingestBus.all().subscribe((event) => {
      if (event.kind !== 'message') return;
      void this.checkTenantUsage(event.tenantId).catch((err) => {
        this.logger.warn(`Billing usage email check failed for tenant ${event.tenantId}: ${err}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.ingestSub?.unsubscribe();
  }

  async checkTenantUsage(tenantId: string): Promise<boolean> {
    if (!isBillingEnabled()) return false;

    const limits = await this.planService.getLimits({ tenantId, userId: null });
    const limit = limits.requestsPerMonth;
    if (limit === null || limit <= 0) return false;

    const now = new Date();
    const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const periodStart = new Date(monthStartMs).toISOString();
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
    const used = await this.planService.countRequestsSince(tenantId, monthStartMs);
    const kind = this.resolveMilestoneKind(used, limit);
    if (!kind) return false;

    const dedupeKey = `billing-usage:${tenantId}:${periodStart}:${kind}`;
    if (await this.logs.hasDedupeKey(dedupeKey)) return false;

    const recipient = await this.resolveRecipient(tenantId);
    if (!recipient?.email) {
      this.logger.warn(`No billing email recipient found for tenant ${tenantId}`);
      return false;
    }
    if (!normalizeBillingEmailPreferences(recipient.billing_email_preferences).usageAlerts) {
      return false;
    }

    const sent = await this.emails.sendPlanUsageEmail(recipient.email, {
      kind,
      userName: recipient.name,
      used,
      limit,
      periodEnd,
    });
    if (!sent) return false;

    await this.logs.tryInsert({
      dedupeKey,
      kind,
      tenantId,
      userId: recipient.user_id,
      periodStart,
      periodEnd,
      metadata: { used, limit },
    });
    return true;
  }

  private resolveMilestoneKind(
    used: number,
    limit: number,
  ): 'requests_warning' | 'requests_limit_reached' | null {
    if (used >= limit) return 'requests_limit_reached';
    if (used >= Math.ceil(limit * REQUEST_WARNING_RATIO)) return 'requests_warning';
    return null;
  }

  private async resolveRecipient(tenantId: string): Promise<BillingRecipient | null> {
    const rows: BillingRecipient[] = await this.dataSource.query(
      `SELECT COALESCE(u.email, t.email) AS email,
              COALESCE(NULLIF(u.name, ''), NULLIF(t.organization_name, '')) AS name,
              t.owner_user_id AS user_id,
              t.billing_email_preferences AS billing_email_preferences
         FROM tenants t
         LEFT JOIN "user" u ON u.id = t.owner_user_id
        WHERE t.id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
  }
}
