import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supports the recursive "skip scan" that lists a tenant's distinct providers
 * for the message-log filter dropdown (see MessagesQueryService.getDistinctModels).
 *
 * Distinct models already skip-scan via IDX_agent_messages_tenant_model
 * (tenant_id, model); providers had no (tenant_id, provider) index, so the only
 * way to enumerate them was a full per-tenant scan + sort. This partial index
 * (NULL/empty providers excluded — they're legacy rows the dropdown ignores)
 * lets the skip scan jump provider-to-provider with one index seek per distinct
 * value. It's small: provider is a short, low-cardinality string.
 *
 * Built CONCURRENTLY (so `transaction = false`): the blocking form takes a lock
 * on agent_messages that deadlocks against live INSERTs during a deploy.
 * CONCURRENTLY uses SHARE UPDATE EXCLUSIVE, which does not conflict with writes.
 */
export class AddTenantProviderValueIndex1793000000000 implements MigrationInterface {
  name = 'AddTenantProviderValueIndex1793000000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Clear any invalid leftover from an interrupted CONCURRENTLY build, since
    // CREATE ... IF NOT EXISTS would otherwise skip over an invalid index.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_provider_value"`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_tenant_provider_value" ON "agent_messages" ("tenant_id", "provider") WHERE "provider" IS NOT NULL AND "provider" <> ''`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_provider_value"`,
    );
  }
}
