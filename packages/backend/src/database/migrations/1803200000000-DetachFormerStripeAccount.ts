import { MigrationInterface, QueryRunner } from 'typeorm';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';

/**
 * Detaches every subscription from the former Stripe account (MNFST, Inc.).
 *
 * It ships with the deploy that points Cloud Run at the Buddyweb Stripe
 * account, and the `manifest-migrate` job runs it right before that deploy
 * swaps the image. There is no window where the new keys meet old ids: an
 * old `user.stripeCustomerId` sent to the new account makes better-auth's
 * `subscriptions.list` fail with "No such customer", so nobody could upgrade.
 *
 *   1. Each paid row with a Stripe subscription id becomes `legacy_grace`
 *      (see `billing/subscription-status.ts`), with `cancelAtPeriodEnd` set and
 *      its Stripe ids cleared. `PlanService` keeps the tenant on Pro until
 *      `periodEnd`, the end of the period already paid on the old account.
 *   2. Every other subscription row loses its Stripe ids.
 *   3. Every user loses `stripeCustomerId`, so the next upgrade creates a
 *      customer on the new account.
 *
 * The SQL is inlined on purpose: a migration must not change when shared
 * constants do. The same statements live in `billing/stripe-account-migration.ts`,
 * whose CLI previews them (`npm run billing:migrate-stripe-account`).
 *
 * Cloud only, like 1802200000000: billing never runs self-hosted. A database
 * without better-auth's Stripe columns (billing never enabled) is skipped. `down()`
 * is a no-op because the cleared ids are gone and belong to an account the
 * service no longer reaches.
 */
export class DetachFormerStripeAccount1803200000000 implements MigrationInterface {
  name = 'DetachFormerStripeAccount1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (isSelfHosted()) return;
    const columns: Array<{ table_name: string; column_name: string }> = await queryRunner.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'subscription'
                AND column_name IN ('status', 'stripeCustomerId', 'stripeSubscriptionId', 'stripeScheduleId'))
            OR (table_name = 'user' AND column_name = 'stripeCustomerId'))`,
    );
    const has = (table: string, column: string) =>
      columns.some((c) => c.table_name === table && c.column_name === column);

    if (has('subscription', 'stripeSubscriptionId')) {
      const clearSchedule = has('subscription', 'stripeScheduleId')
        ? ',\n              "stripeScheduleId" = NULL'
        : '';
      await queryRunner.query(
        `UPDATE "subscription"
            SET "status" = 'legacy_grace',
                "cancelAtPeriodEnd" = true,
                "stripeCustomerId" = NULL,
                "stripeSubscriptionId" = NULL${clearSchedule}
          WHERE "status" IN ('active', 'trialing', 'past_due')
            AND "stripeSubscriptionId" IS NOT NULL`,
      );
      await queryRunner.query(
        `UPDATE "subscription"
            SET "stripeCustomerId" = NULL,
                "stripeSubscriptionId" = NULL${clearSchedule}
          WHERE "stripeCustomerId" IS NOT NULL OR "stripeSubscriptionId" IS NOT NULL`,
      );
    }
    if (has('user', 'stripeCustomerId')) {
      await queryRunner.query(
        `UPDATE "user" SET "stripeCustomerId" = NULL WHERE "stripeCustomerId" IS NOT NULL`,
      );
    }
  }

  public async down(): Promise<void> {
    // Irreversible: the former account's ids are not kept anywhere.
  }
}
