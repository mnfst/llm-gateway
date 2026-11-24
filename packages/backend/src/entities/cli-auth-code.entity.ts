import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

/**
 * One-time authorization codes for the CLI browser login. Rows are created by
 * POST /api/v1/cli/authorize (session-only), consumed (deleted) by
 * POST /api/v1/cli/token, and expire after minutes. DB-backed — not in-memory —
 * because the browser and the CLI may hit different regional replicas.
 */
@Entity('cli_auth_codes')
export class CliAuthCode {
  @PrimaryColumn('varchar')
  id!: string;

  /** SHA-256 hex of the raw code; the raw code never touches the database. */
  @Index({ unique: true })
  @Column('varchar', { length: 64 })
  code_hash!: string;

  @Column('varchar', { length: 128 })
  state!: string;

  /**
   * PKCE (RFC 7636) challenge bound to the CLI that started the flow. The raw
   * code is useless without the matching `code_verifier`, which never leaves
   * the CLI — so a code intercepted from the browser redirect cannot be
   * exchanged. Only S256 is accepted.
   */
  @Column('varchar', { length: 128, nullable: true })
  code_challenge!: string | null;

  @Column('varchar', { length: 10, nullable: true })
  code_challenge_method!: string | null;

  @Column('varchar')
  tenant_id!: string;

  @Column('varchar', { nullable: true })
  user_id!: string | null;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;

  @Index()
  @Column(timestampType())
  expires_at!: string;
}
