import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { ApiKey } from '../entities/api-key.entity';
import { CliAuthCode } from '../entities/cli-auth-code.entity';
import { TenantContext } from '../common/decorators/tenant-context.decorator';
import { hashKey, keyPrefix, verifyKey } from '../common/utils/hash.util';
import { toLocalSqlTimestamp } from '../common/utils/postgres-sql';

export const CLI_KEY_NAME = 'cli';
export const CODE_TTL_MS = 5 * 60 * 1000;
const PAT_PREFIX = 'mnfst_pat_';

const INVALID_CODE = 'Invalid or expired authorization code';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** PKCE S256: base64url(SHA-256(verifier)) — RFC 7636 §4.2. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** Constant-time compare that never throws on a length mismatch. */
function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * One-time-code handshake for the CLI browser login. The PAT is minted at
 * exchange time so no raw secret is ever at rest; codes are stored hashed and
 * deleted before minting, which makes double-use lose the race even across
 * concurrent regional replicas.
 */
@Injectable()
export class CliAuthService {
  constructor(
    @InjectRepository(CliAuthCode)
    private readonly codeRepo: Repository<CliAuthCode>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async createAuthorization(
    ctx: TenantContext,
    state: string,
    codeChallenge: string,
    codeChallengeMethod = 'S256',
  ): Promise<{ code: string }> {
    if (codeChallengeMethod !== 'S256') {
      throw new BadRequestException('Unsupported code_challenge_method');
    }
    // Sweep against a JS-computed cutoff, not CURRENT_TIMESTAMP: expiries are
    // written with toLocalSqlTimestamp(), so the sweep must read the same clock.
    await this.codeRepo
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now', { now: toLocalSqlTimestamp() })
      .execute();

    const code = randomBytes(32).toString('base64url');
    await this.codeRepo.insert({
      id: randomUUID(),
      code_hash: sha256Hex(code),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      tenant_id: ctx.tenantId as string,
      user_id: ctx.userId,
      expires_at: toLocalSqlTimestamp(new Date(Date.now() + CODE_TTL_MS)),
    });
    return { code };
  }

  async exchange(
    code: string,
    state: string,
    codeVerifier: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const row = await this.codeRepo.findOne({ where: { code_hash: sha256Hex(code) } });
    if (!row || row.state !== state) throw new BadRequestException(INVALID_CODE);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new BadRequestException(INVALID_CODE);
    }
    // PKCE: the code is only redeemable by whoever holds the verifier, so a
    // code captured from the browser redirect is inert on its own. Fail closed
    // on a row with no challenge (a legacy code minted before PKCE shipped).
    if (!row.code_challenge || row.code_challenge_method !== 'S256') {
      throw new BadRequestException(INVALID_CODE);
    }
    if (!secureEquals(deriveCodeChallenge(codeVerifier), row.code_challenge)) {
      throw new BadRequestException(INVALID_CODE);
    }
    const ttlDays = this.configService.get<number>('app.cliTokenTtlDays', 30);
    const absoluteDays = this.configService.get<number>('app.cliTokenAbsoluteTtlDays', 90);
    const token = PAT_PREFIX + randomBytes(32).toString('base64url');
    // One instant, two renderings: naive-local for the DB column (the format
    // every other writer of expires_at uses), ISO-UTC on the wire so the CLI
    // never has to guess the server's timezone. The sliding window can never
    // start out beyond the absolute ceiling.
    const slidingDate = new Date(Date.now() + ttlDays * 86_400_000);
    const absoluteDate = new Date(Date.now() + absoluteDays * 86_400_000);
    const expiresDate = absoluteDate < slidingDate ? absoluteDate : slidingDate;
    // Consume the code and mint the PAT in one transaction. Deleting first
    // still makes a concurrent double-use lose the race, and a failed insert
    // now rolls the delete back so the code stays redeemable.
    await this.dataSource.transaction(async (manager) => {
      const deleted = await manager.delete(CliAuthCode, { id: row.id });
      if (!deleted.affected) throw new BadRequestException(INVALID_CODE);
      await manager.insert(ApiKey, {
        id: randomUUID(),
        key: null,
        key_hash: hashKey(token),
        key_prefix: keyPrefix(token),
        tenant_id: row.tenant_id,
        created_by_user_id: row.user_id,
        name: CLI_KEY_NAME,
        expires_at: toLocalSqlTimestamp(expiresDate),
        absolute_expires_at: toLocalSqlTimestamp(absoluteDate),
      });
    });
    return { token, expiresAt: expiresDate.toISOString() };
  }

  async revokeByRawKey(rawKey: string): Promise<{ revoked: boolean }> {
    const candidates = await this.apiKeyRepo.find({
      where: { key_prefix: keyPrefix(rawKey), name: CLI_KEY_NAME },
    });
    const found = candidates.find((c) => verifyKey(rawKey, c.key_hash));
    if (!found) return { revoked: false };
    await this.apiKeyRepo.delete({ id: found.id });
    return { revoked: true };
  }
}
