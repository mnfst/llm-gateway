import { MigrationInterface, QueryRunner } from 'typeorm';

/** Cross-instance routing-cache invalidation feed (see cache-invalidation.entity.ts). */
export class CreateCacheInvalidations1803200000000 implements MigrationInterface {
  name = 'CreateCacheInvalidations1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cache_invalidations" (
        "id" BIGSERIAL NOT NULL,
        "scope" character varying(16) NOT NULL,
        "target_id" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cache_invalidations" PRIMARY KEY ("id")
      )
    `);
    // Every instance polls by created_at once a second and prunes by it.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cache_invalidations_created_at" ON "cache_invalidations" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cache_invalidations"`);
  }
}
