import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops IDX_agent_messages_tenant_agent_name_ts (tenant_id, agent_name, timestamp).
 *
 * Production index-usage stats showed this 590MB index served only ~131 scans
 * versus ~53k for the equivalent (tenant_id, agent_id, timestamp) index. Every
 * per-agent analytics path resolves the agent slug to agent_id and filters on
 * agent_id (see addTenantFilter), so the agent_name-keyed index is redundant —
 * it just adds write amplification to the hot ingest path and ~590MB of bloat.
 *
 * The down() recreates it for reversibility.
 *
 * Dropped CONCURRENTLY (so `transaction = false`): a plain DROP INDEX takes
 * ACCESS EXCLUSIVE on agent_messages and deadlocked against live INSERTs during
 * the deploy (this is the migration that failed in production). The CONCURRENTLY
 * form takes SHARE UPDATE EXCLUSIVE and does not conflict with writes.
 */
export class DropRedundantTenantAgentNameIndex1793100000000 implements MigrationInterface {
  name = 'DropRedundantTenantAgentNameIndex1793100000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_agent_messages_tenant_agent_name_ts"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_agent_messages_tenant_agent_name_ts" ON "agent_messages" ("tenant_id", "agent_name", "timestamp")`,
    );
  }
}
