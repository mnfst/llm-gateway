import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { toLocalSqlTimestamp } from '../src/common/utils/postgres-sql';
import { deriveCodeChallenge } from '../src/auth/cli-auth.service';
import { createTestApp, TEST_API_KEY } from './helpers';

const STATE = 'e2e-state-abcdef1234567890';
const VERIFIER = 'e2e-verifier-abcdefghijklmnopqrstuvwxyz0123456789';

describe('CLI browser login (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const challenge = deriveCodeChallenge(VERIFIER);

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  async function authorize(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cli/authorize')
      .set('x-api-key', TEST_API_KEY)
      .send({ state: STATE, code_challenge: challenge })
      .expect(201);
    expect(typeof res.body.code).toBe('string');
    return res.body.code as string;
  }

  async function countCliKeys(): Promise<number> {
    const rows: Array<{ n: string }> = await ds.query(
      `SELECT count(*)::text AS n FROM api_keys WHERE name = 'cli'`,
    );
    return Number(rows[0].n);
  }

  it('authorize → exchange mints an expiring cli PAT', async () => {
    const before = await countCliKeys();
    const code = await authorize();
    const res = await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(200);
    expect(res.body.token).toMatch(/^mnfst_pat_/);

    // Exactly one key, not two: a `LIMIT 1` row-shape check would pass a
    // double-mint just as happily.
    expect(await countCliKeys()).toBe(before + 1);

    // Pin the wire contract: ISO-8601 UTC (round-trips byte-for-byte through
    // Date), ttlDays out — the CLI must never have to guess the server's TZ.
    expect(new Date(res.body.expiresAt).toISOString()).toBe(res.body.expiresAt);
    const ttlDays = app.get(ConfigService).get<number>('app.cliTokenTtlDays', 30);
    const daysOut = (new Date(res.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(ttlDays - 1);
    expect(daysOut).toBeLessThanOrEqual(ttlDays);

    const rows = await ds.query(
      `SELECT name, expires_at, absolute_expires_at, key FROM api_keys WHERE name = 'cli' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0].key).toBeNull();
    expect(rows[0].expires_at).not.toBeNull();
    // The hard ceiling is persisted and outlives the sliding window.
    expect(rows[0].absolute_expires_at).not.toBeNull();
    expect(new Date(rows[0].absolute_expires_at).getTime()).toBeGreaterThan(
      new Date(rows[0].expires_at).getTime(),
    );
  });

  it('a wrong PKCE verifier is rejected and does not consume the code', async () => {
    const code = await authorize();
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: 'wrong-verifier-0123456789abcdefghijklmnopq' })
      .expect(400);
    // The code survives the failed attempt, so the real CLI can still redeem it.
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(200);
  });

  it('a code is single-use', async () => {
    const code = await authorize();
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(400);
  });

  it('a wrong state is rejected and does not consume the code', async () => {
    const code = await authorize();
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: 'wrong-state-1234567890', code_verifier: VERIFIER })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(200);
  });

  it('an expired code is rejected', async () => {
    const code = await authorize();
    // Age out the code on the *Node* clock, scoped to the row just minted.
    // `expires_at` is a naive `timestamp` column whose invariant is the
    // process's local wall time (toLocalSqlTimestamp), so SQL `now()` — the DB
    // container's UTC — would land in the future on any host west of UTC and
    // silently flip this test to expecting 400 and getting 200.
    const [row] = await ds.query(`SELECT id FROM cli_auth_codes ORDER BY created_at DESC LIMIT 1`);
    await ds.query(`UPDATE cli_auth_codes SET expires_at = $1 WHERE id = $2`, [
      toLocalSqlTimestamp(new Date(Date.now() - 60_000)),
      row.id,
    ]);
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(400);
  });

  it('API-key auth cannot mint a code', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cli/authorize')
      .set('x-api-key', TEST_API_KEY)
      .set('x-test-auth-method', 'api_key')
      .send({ state: STATE, code_challenge: challenge })
      .expect(403);
  });

  it('malformed state/code/challenge are rejected by validation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/cli/authorize')
      .set('x-api-key', TEST_API_KEY)
      .send({ state: 'no spaces allowed!', code_challenge: challenge })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/cli/authorize')
      .set('x-api-key', TEST_API_KEY)
      .send({ state: STATE })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code: 'short', state: STATE, code_verifier: VERIFIER })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code: 'rawcode-abcdefghijklmnop', state: STATE, code_verifier: 'short' })
      .expect(400);
  });

  it('DELETE /cli/token revokes the minted PAT', async () => {
    const code = await authorize();
    const res = await request(app.getHttpServer())
      .post('/api/v1/cli/token')
      .send({ code, state: STATE, code_verifier: VERIFIER })
      .expect(200);
    const token = res.body.token as string;
    const before = await countCliKeys();

    const del = await request(app.getHttpServer())
      .delete('/api/v1/cli/token')
      .set('x-api-key', token)
      .expect(200);
    expect(del.body).toEqual({ revoked: true });

    // Exactly the PAT we just revoked disappeared — earlier tests' PATs stay.
    expect(await countCliKeys()).toBe(before - 1);
  });
});
