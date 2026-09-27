import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlanUsageEmailProps, SubscriptionPlanEmailProps } from './emails/billing-plan-email';
import {
  getBillingAppUrl,
  sendPlanUsageEmail,
  sendSubscriptionPlanEmail,
} from './billing-email-sender';

@Injectable()
export class BillingEmailService {
  private readonly logger = new Logger(BillingEmailService.name);
  private readonly fromEmail: string;

  constructor(private readonly configService: ConfigService) {
    this.fromEmail =
      this.configService.get<string>('app.emailFrom') ||
      this.configService.get<string>('app.notificationFromEmail', 'noreply@manifest.build');
  }

  getAppUrl(): string {
    return getBillingAppUrl(this.configService.get<string>('app.betterAuthUrl', ''));
  }

  async sendSubscriptionPlanEmail(
    to: string,
    props: Omit<SubscriptionPlanEmailProps, 'appUrl' | 'manageBillingUrl'>,
  ): Promise<boolean> {
    const appUrl = this.getAppUrl();
    const sent = await sendSubscriptionPlanEmail(
      to,
      {
        ...props,
        appUrl,
        manageBillingUrl: `${appUrl}/account`,
      },
      this.fromEmail,
    );
    if (!sent) this.logger.warn(`Failed to send billing lifecycle email to ${to}`);
    return sent;
  }

  async sendPlanUsageEmail(
    to: string,
    props: Omit<PlanUsageEmailProps, 'appUrl'>,
  ): Promise<boolean> {
    const sent = await sendPlanUsageEmail(
      to,
      {
        ...props,
        appUrl: this.getAppUrl(),
      },
      this.fromEmail,
    );
    if (!sent) this.logger.warn(`Failed to send billing usage email to ${to}`);
    return sent;
  }
}
