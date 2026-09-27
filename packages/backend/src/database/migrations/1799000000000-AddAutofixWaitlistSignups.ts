import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `autofix_waitlist_signups` table to store emails from
 * self-hosted instances that join the Autofix waitlist. The cloud
 * instance receives these signups via a public endpoint.
 */
export class AddAutofixWaitlistSignups1799000000000 implements MigrationInterface {
  name = 'AddAutofixWaitlistSignups1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "autofix_waitlist_signups" (
        "id" uuid DEFAULT gen_random_uuid() NOT NULL,
        "email" varchar NOT NULL,
        "source" varchar NOT NULL DEFAULT 'self-hosted',
        "signed_up_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_autofix_waitlist_signups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_autofix_waitlist_signups_email" UNIQUE ("email")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "autofix_waitlist_signups"`);
  }
}
