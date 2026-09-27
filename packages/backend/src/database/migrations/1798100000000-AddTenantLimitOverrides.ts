import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a nullable `limit_overrides` jsonb column to the `tenants` table.
 * Per-tenant plan-limit override escape hatch (support / enterprise). When
 * null, plan defaults apply; when set, an object of the shape
 * `{ requestsPerMonth?: number }` overrides the matching plan-limit fields.
 * Read by PlanService.getLimits().
 */
export class AddTenantLimitOverrides1798100000000 implements MigrationInterface {
  name = 'AddTenantLimitOverrides1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "limit_overrides" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN IF EXISTS "limit_overrides"`);
  }
}
