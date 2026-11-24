import { Injectable, Logger } from '@nestjs/common';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationEmailService } from './notification-email.service';
import { EmailProviderConfigService } from './email-provider-config.service';
import { NotificationLogService, formatNotificationTimestamp } from './notification-log.service';
import { ManifestRuntimeService } from '../../common/services/manifest-runtime.service';
import { computePeriodBoundaries, computePeriodResetDate } from '../../common/utils/period.util';

interface BlockRule {
  id: string;
  tenant_id: string;
  agent_name: string;
  metric_type: 'tokens' | 'cost';
  threshold: number;
  period: 'hour' | 'day' | 'week' | 'month';
}

export interface LimitExceeded {
  ruleId: string;
  metricType: 'tokens' | 'cost';
  threshold: number;
  actual: number;
  period: string;
}

@Injectable()
export class LimitCheckService {
  private readonly logger = new Logger(LimitCheckService.name);

  constructor(
    private readonly rulesService: NotificationRulesService,
    private readonly emailService: NotificationEmailService,
    private readonly emailProviderConfig: EmailProviderConfigService,
    private readonly runtime: ManifestRuntimeService,
    private readonly notificationLog: NotificationLogService,
  ) {}

  async checkLimits(tenantId: string, agentName: string): Promise<LimitExceeded | null> {
    // Hard limits are an enforcement boundary. Read both the rules and their
    // current consumption for every provider request so changes made through a
    // different backend replica take effect on the next request.
    const rules = await this.rulesService.getActiveBlockRules(tenantId, agentName);
    if (rules.length === 0) return null;

    const consumptionByMetricAndPeriod = new Map<string, number>();
    for (const rule of rules) {
      const { periodStart, periodEnd } = computePeriodBoundaries(rule.period);
      const consumptionKey = `${rule.metric_type}:${periodStart}:${periodEnd}`;
      let actual = consumptionByMetricAndPeriod.get(consumptionKey);
      if (actual === undefined) {
        actual = await this.rulesService.getConsumption(
          tenantId,
          agentName,
          rule.metric_type,
          periodStart,
          periodEnd,
        );
        consumptionByMetricAndPeriod.set(consumptionKey, actual);
      }

      if (actual >= rule.threshold) {
        this.notifyLimitExceeded(rule, actual, periodStart, periodEnd).catch((err) => {
          this.logger.error(`Failed to send block notification for rule ${rule.id}: ${err}`);
        });

        return {
          ruleId: rule.id,
          metricType: rule.metric_type,
          threshold: rule.threshold,
          actual,
          period: rule.period,
        };
      }
    }

    return null;
  }

  private async notifyLimitExceeded(
    rule: BlockRule,
    actual: number,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    if (await this.notificationLog.hasAlreadySent(rule.id, periodStart)) return;

    const now = formatNotificationTimestamp();
    const providerConfig = await this.emailProviderConfig.getFullConfig(rule.tenant_id);
    const email = await this.notificationLog.resolveRecipientEmail(
      rule.tenant_id,
      providerConfig?.notificationEmail,
    );
    await this.notificationLog.insertLog({
      ruleId: rule.id,
      periodStart,
      periodEnd,
      actualValue: actual,
      thresholdValue: rule.threshold,
      metricType: rule.metric_type,
      agentName: rule.agent_name,
      sentAt: now,
    });

    if (email) {
      await this.emailService.sendThresholdAlert(
        email,
        {
          agentName: rule.agent_name,
          metricType: rule.metric_type,
          threshold: rule.threshold,
          actualValue: actual,
          period: rule.period,
          timestamp: now,
          agentUrl: `${this.runtime.getAuthBaseUrl()}/agents/${encodeURIComponent(rule.agent_name)}`,
          alertType: 'hard',
          periodResetDate: computePeriodResetDate(rule.period),
        },
        providerConfig ?? undefined,
      );
    }
  }
}
