import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `public_error_pages` — the read-optimised mirror of operator-approved
 * error-cluster SEO pages. Populated only via the secret-guarded internal push
 * endpoint from the Peacock CMS; never written from raw telemetry.
 */
export class AddPublicErrorPages1797000000000 implements MigrationInterface {
  name = 'AddPublicErrorPages1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "public_error_pages" (
        "slug" varchar PRIMARY KEY,
        "cluster_key" varchar NOT NULL,
        "provider" varchar NOT NULL,
        "provider_label" varchar NOT NULL DEFAULT '',
        "http_status" integer,
        "category" varchar NOT NULL DEFAULT 'unknown',
        "category_label" varchar NOT NULL DEFAULT '',
        "title" varchar NOT NULL,
        "meta_description" varchar NOT NULL,
        "h1" varchar NOT NULL,
        "body_what" text NOT NULL DEFAULT '',
        "body_fix" text NOT NULL DEFAULT '',
        "body_manifest" text NOT NULL DEFAULT '',
        "sample_message" text NOT NULL DEFAULT '',
        "faq" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "stats" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "related" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "noindex" boolean NOT NULL DEFAULT false,
        "published_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "public_error_pages"`);
  }
}
