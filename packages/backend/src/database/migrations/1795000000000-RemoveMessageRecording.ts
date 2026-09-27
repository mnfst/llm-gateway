import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the message-recording feature and the never-written dead detail
 * tables. Drops `message_recordings`, `llm_calls`, `tool_executions`,
 * `agent_logs`, the `agent_messages.recorded` flag, and the per-agent
 * `agents.record_messages` toggle.
 *
 * `agent_messages.request_headers` and `agent_messages.request_params` are
 * intentionally left untouched — the trimmed message-details endpoint still
 * surfaces them.
 *
 * `down()` recreates the dropped tables and columns (schema only — recorded
 * payloads are not restorable) by mirroring their original definitions in
 * `1771464895790-InitialSchema`, `1786100000000-AddAgentRecordMessages`, and
 * `1786200000000-AddMessageRecordings` (including the post-default state from
 * `1786300000000-DefaultRecordMessagesTrue`).
 */
export class RemoveMessageRecording1795000000000 implements MigrationInterface {
  name = 'RemoveMessageRecording1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "message_recordings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_calls"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_executions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_logs"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_messages_recorded"`);
    await queryRunner.query(`ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "recorded"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "record_messages"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // agents.record_messages — final pre-drop state had DEFAULT true.
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "record_messages" boolean NOT NULL DEFAULT true`,
    );

    // agent_messages.recorded + its partial index.
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "recorded" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_messages_recorded" ON "agent_messages" ("tenant_id", "timestamp") WHERE "recorded" = true`,
    );

    // message_recordings table.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_recordings" (
        "message_id" varchar PRIMARY KEY REFERENCES "agent_messages"("id") ON DELETE CASCADE,
        "request_body" jsonb,
        "response_body" jsonb,
        "response_headers" jsonb,
        "size_bytes" integer,
        "created_at" timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    // tool_executions table + indexes.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "tool_executions" ("id" character varying NOT NULL, "tenant_id" character varying, "agent_id" character varying, "llm_call_id" character varying, "tool_name" character varying NOT NULL, "duration_ms" integer, "status" character varying NOT NULL DEFAULT 'ok', "error_message" character varying, CONSTRAINT "PK_bdd7e5fafce34f8647fde510aff" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_7fc8d9c06936a673fd5c404706" ON "tool_executions" ("tenant_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_a24432cde19440451cc7b5d15f" ON "tool_executions" ("agent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_4d007c4a559001d501d06fb6f4" ON "tool_executions" ("tenant_id", "agent_id") `,
    );

    // llm_calls table + indexes.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "llm_calls" ("id" character varying NOT NULL, "tenant_id" character varying, "agent_id" character varying, "turn_id" character varying, "call_index" integer, "gen_ai_system" character varying, "request_model" character varying, "response_model" character varying, "input_tokens" integer NOT NULL DEFAULT '0', "output_tokens" integer NOT NULL DEFAULT '0', "cache_read_tokens" integer NOT NULL DEFAULT '0', "cache_creation_tokens" integer NOT NULL DEFAULT '0', "duration_ms" integer, "ttft_ms" integer, "temperature" numeric(3,2), "max_output_tokens" integer, "timestamp" TIMESTAMP NOT NULL, CONSTRAINT "PK_927dd9d5a428274e38a05706af8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ff92361a95863b8f0de3a371e5" ON "llm_calls" ("tenant_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e3e44ae5bdb48ceeb10d7880cf" ON "llm_calls" ("agent_id") `,
    );

    // agent_logs table + indexes.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "agent_logs" ("id" character varying NOT NULL, "tenant_id" character varying, "agent_id" character varying, "timestamp" TIMESTAMP NOT NULL, "agent_name" character varying, "severity" character varying NOT NULL DEFAULT 'info', "body" text, "trace_id" character varying, "span_id" character varying, "attributes" text, CONSTRAINT "PK_2cc52efab0f963454d7006a6981" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e981397068db115bcd95a39396" ON "agent_logs" ("tenant_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_039a398c03e68e46a0fc0bc998" ON "agent_logs" ("agent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e9678de7cf6f122f3286bb4075" ON "agent_logs" ("tenant_id", "agent_id", "timestamp") `,
    );
  }
}
