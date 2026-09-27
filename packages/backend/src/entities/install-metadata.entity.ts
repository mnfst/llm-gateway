import { Entity, Column, PrimaryColumn } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

/**
 * Singleton row holding the anonymous install identity used by the telemetry
 * sender. Only one row exists per installation — the PK is the literal string
 * `'singleton'` so `INSERT ... ON CONFLICT DO NOTHING` is idempotent across
 * parallel boots.
 */
@Entity('install_metadata')
export class InstallMetadata {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  install_id!: string;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Column(timestampType(), { nullable: true })
  first_send_at!: string | null;

  @Column(timestampType(), { nullable: true })
  last_sent_at!: string | null;

  /** When the self-hosted install consented to Autofix (null = never). */
  @Column(timestampType(), { nullable: true })
  autofix_consented_at!: string | null;
}
