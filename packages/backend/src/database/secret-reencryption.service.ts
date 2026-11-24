import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import {
  decryptWithAny,
  encrypt,
  getDecryptionSecrets,
  getEncryptionSecret,
  isEncrypted,
} from '../common/utils/crypto.util';

/**
 * Advisory-lock key for the boot-time re-encryption pass. Distinct from the
 * migration lock (4011985) and the recording-retention lock (4011986) so the
 * three never block each other.
 */
export const REENCRYPTION_ADVISORY_LOCK_KEY = 4011987;

const TRY_LOCK_SQL = `SELECT pg_try_advisory_lock(${REENCRYPTION_ADVISORY_LOCK_KEY}::bigint) AS acquired`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(${REENCRYPTION_ADVISORY_LOCK_KEY}::bigint)`;

/** Rows read per round-trip. Keyset-paginated on the primary key. */
export const BATCH_SIZE = 500;

interface EncryptedColumn {
  table: string;
  idColumn: string;
  column: string;
}

/**
 * Every column holding a value produced by `encrypt()`.
 *
 * - `tenant_providers.api_key_encrypted` covers provider API keys, OAuth /
 *   subscription token blobs, and custom-provider credentials (custom
 *   providers are stored as `provider = 'custom:<id>'` rows on this table).
 * - `agent_api_keys.key` is the recoverable copy of an agent's `mnfst_*`
 *   ingest key (`key_hash` is the auth path and is not encrypted).
 * - `email_provider_configs.api_key_encrypted` is the tenant's transactional
 *   email provider key.
 *
 * `api_keys.key` is deliberately absent: the HashApiKeys migration NULLs it,
 * so it never holds ciphertext.
 */
export const ENCRYPTED_COLUMNS: ReadonlyArray<EncryptedColumn> = [
  { table: 'tenant_providers', idColumn: 'id', column: 'api_key_encrypted' },
  { table: 'agent_api_keys', idColumn: 'id', column: 'key' },
  { table: 'email_provider_configs', idColumn: 'id', column: 'api_key_encrypted' },
];

interface EncryptedRow {
  id: string;
  value: string;
}

interface TableResult {
  scanned: number;
  rewritten: number;
  skipped: number;
}

/**
 * Rewrites at-rest ciphertext onto the current encryption secret at boot.
 *
 * Manifest derives its AES-256-GCM key from `MANIFEST_ENCRYPTION_KEY`, falling
 * back to `BETTER_AUTH_SECRET`. Changing that secret used to brick every stored
 * provider key and OAuth token: the ciphertext carries no key id, and the read
 * paths swallow a decrypt failure as "provider not connected", so the damage
 * was silent. `MANIFEST_ENCRYPTION_KEY_PREVIOUS` makes the old secret readable
 * for one deploy, and this pass moves every row onto the new one so the
 * operator can drop it again.
 *
 * The pass only runs while `MANIFEST_ENCRYPTION_KEY_PREVIOUS` is set, so a
 * normal boot never touches the tables: the session secret is always a decrypt
 * candidate, and a dedicated key alone would otherwise trigger a full scan
 * (one scrypt per row) on every restart. It runs after bootstrap rather than
 * during it, yields between rows, and never throws: a failure here must not
 * stop the app from serving, and the old secret keeps working while listed.
 */
@Injectable()
export class SecretReencryptionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SecretReencryptionService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onApplicationBootstrap(): void {
    // Not awaited: a large rotation must not hold the health check hostage.
    // run() swallows its own errors, but a throw before its try (for example
    // createQueryRunner on a dead pool) must not become an unhandled rejection.
    this.run().catch((err) => {
      this.logger.error(`Secret re-encryption crashed: ${describe(err)}`);
    });
  }

  async run(): Promise<void> {
    const previous = process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'];
    if (!previous || previous.length < 32) return;

    let secrets: string[];
    let currentSecret: string;
    try {
      secrets = getDecryptionSecrets();
      currentSecret = getEncryptionSecret();
    } catch (err) {
      this.logger.warn(`Skipping secret re-encryption: ${describe(err)}`);
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    let acquired = false;
    try {
      await queryRunner.connect();
      // Only one replica does the rewrite; the others move on immediately
      // rather than blocking boot behind a lock they don't need.
      const lockRows = (await queryRunner.query(TRY_LOCK_SQL)) as Array<{ acquired?: boolean }>;
      acquired = lockRows[0]?.acquired === true;
      if (!acquired) return;

      const summary: string[] = [];
      let totalRewritten = 0;
      let totalSkipped = 0;
      let failed = false;
      for (const target of ENCRYPTED_COLUMNS) {
        // Per-table so a missing table or a permission error on one column
        // still lets the remaining columns move onto the current secret.
        try {
          const result = await this.reencryptTable(queryRunner, target, secrets, currentSecret);
          totalRewritten += result.rewritten;
          totalSkipped += result.skipped;
          summary.push(
            `${target.table}.${target.column} ${result.scanned} scanned / ${result.rewritten} rewritten / ${result.skipped} undecryptable`,
          );
        } catch (err) {
          failed = true;
          summary.push(`${target.table}.${target.column} failed (${describe(err)})`);
        }
      }
      this.logger.log(
        `Secret re-encryption complete (${secrets.length} secrets configured): ${summary.join(', ')}`,
      );
      // Only say PREVIOUS is safe to drop when every row is provably under the
      // current secret: a skipped row may still be under PREVIOUS's predecessor.
      if (totalRewritten === 0 && totalSkipped === 0 && !failed) {
        this.logger.log(
          'Nothing left under an older secret — MANIFEST_ENCRYPTION_KEY_PREVIOUS can be removed.',
        );
      }
    } catch (err) {
      this.logger.error(`Secret re-encryption failed: ${describe(err)}`);
    } finally {
      if (acquired) await queryRunner.query(UNLOCK_SQL).catch(() => undefined);
      await queryRunner.release().catch(() => undefined);
    }
  }

  private async reencryptTable(
    queryRunner: QueryRunner,
    target: EncryptedColumn,
    secrets: string[],
    currentSecret: string,
  ): Promise<TableResult> {
    // Table and column names come from the ENCRYPTED_COLUMNS constant above,
    // never from user input — Postgres cannot parameterize identifiers. Every
    // value is bound.
    const selectSql =
      `SELECT "${target.idColumn}" AS id, "${target.column}" AS value ` +
      `FROM "${target.table}" ` +
      `WHERE "${target.column}" IS NOT NULL AND "${target.column}" <> '' ` +
      `AND "${target.idColumn}" > $1 ` +
      `ORDER BY "${target.idColumn}" ASC LIMIT ${BATCH_SIZE}`;
    // The `= $3` guard makes the write a no-op if another process rewrote the
    // row between the read and the update.
    const updateSql =
      `UPDATE "${target.table}" SET "${target.column}" = $1 ` +
      `WHERE "${target.idColumn}" = $2 AND "${target.column}" = $3`;

    let cursor = '';
    let scanned = 0;
    let rewritten = 0;
    let skipped = 0;

    for (;;) {
      const rows = (await queryRunner.query(selectSql, [cursor])) as EncryptedRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.id;
        scanned++;
        // Each decrypt is a synchronous scrypt; give the event loop a turn so
        // a large rotation does not stall request handling on this replica.
        await yieldToEventLoop();
        // Legacy plaintext rows predate encryption; leave them to the
        // EncryptApiKeys migration rather than guessing at their format.
        if (!isEncrypted(row.value)) continue;
        let decrypted: { plaintext: string; secretIndex: number };
        try {
          decrypted = decryptWithAny(row.value, secrets);
        } catch {
          // Under none of the configured secrets — a rewrite would destroy it.
          skipped++;
          this.logger.warn(
            `Could not decrypt ${target.table}.${target.column} for row ${row.id} with any configured secret; leaving it untouched`,
          );
          continue;
        }
        if (decrypted.secretIndex === 0) continue;
        const result = (await queryRunner.query(
          updateSql,
          [encrypt(decrypted.plaintext, currentSecret), row.id, row.value],
          true,
        )) as { affected?: number };
        // affected === 0 means another process rewrote the row first.
        if (result.affected === 1) rewritten++;
      }
      if (rows.length < BATCH_SIZE) break;
    }

    return { scanned, rewritten, skipped };
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
