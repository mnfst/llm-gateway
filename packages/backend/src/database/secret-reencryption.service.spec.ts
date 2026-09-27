import { Logger } from '@nestjs/common';
import { decrypt, encrypt } from '../common/utils/crypto.util';
import {
  BATCH_SIZE,
  ENCRYPTED_COLUMNS,
  SecretReencryptionService,
} from './secret-reencryption.service';

const CURRENT = 'current-secret-'.padEnd(40, 'c');
const PREVIOUS = 'previous-secret-'.padEnd(40, 'p');
const UNKNOWN = 'unknown-secret-'.padEnd(40, 'u');

interface Row {
  id: string;
  value: string;
}

/**
 * Minimal DataSource stand-in. `pages` maps a table name to the pages its
 * keyset SELECT returns in order; every other SQL shape is recorded.
 */
function buildDataSource(opts: {
  acquired?: boolean;
  pages?: Record<string, Row[][]>;
  failSelectFor?: string;
  connectError?: Error;
  unlockError?: Error;
  releaseError?: Error;
  updateAffected?: number;
}) {
  const updates: Array<{ table: string; params: unknown[] }> = [];
  const pageCursor: Record<string, number> = {};
  const connect = jest.fn(async () => {
    if (opts.connectError) throw opts.connectError;
  });
  const release = jest.fn(async () => {
    if (opts.releaseError) throw opts.releaseError;
  });
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ acquired: opts.acquired ?? true }];
    if (sql.includes('pg_advisory_unlock')) {
      if (opts.unlockError) throw opts.unlockError;
      return [];
    }
    const table = /FROM "([^"]+)"|UPDATE "([^"]+)"/.exec(sql);
    const name = table?.[1] ?? table?.[2] ?? '';
    if (sql.startsWith('SELECT')) {
      if (opts.failSelectFor === name) throw new Error(`relation "${name}" does not exist`);
      const pages = opts.pages?.[name] ?? [];
      const index = pageCursor[name] ?? 0;
      pageCursor[name] = index + 1;
      return pages[index] ?? [];
    }
    updates.push({ table: name, params });
    return { affected: opts.updateAffected ?? 1 };
  });
  const queryRunner = { connect, query, release };
  const createQueryRunner = jest.fn(() => queryRunner);
  return {
    dataSource: { createQueryRunner } as never,
    createQueryRunner,
    connect,
    query,
    release,
    updates,
  };
}

describe('SecretReencryptionService', () => {
  const originalEnv = process.env;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['MANIFEST_ENCRYPTION_KEY'];
    delete process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'];
    delete process.env['BETTER_AUTH_SECRET'];
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('covers every column that encrypt() writes to', () => {
    expect(ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual([
      'tenant_providers.api_key_encrypted',
      'agent_api_keys.key',
      'email_provider_configs.api_key_encrypted',
    ]);
  });

  it('skips with a warning when PREVIOUS is set but no current secret is configured', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({});
    await new SecretReencryptionService(ds.dataSource).onApplicationBootstrap();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipping secret re-encryption'));
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it('is a no-op on a normal boot, even though the session secret is a decrypt candidate', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['BETTER_AUTH_SECRET'] = PREVIOUS;
    const ds = buildDataSource({});
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('ignores a PREVIOUS shorter than 32 chars', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = 'short';
    const ds = buildDataSource({});
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it('kicks the pass off from bootstrap without awaiting it', () => {
    const ds = buildDataSource({});
    const service = new SecretReencryptionService(ds.dataSource);
    const run = jest.spyOn(service, 'run').mockResolvedValue(undefined);
    service.onApplicationBootstrap();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs instead of leaking an unhandled rejection when the detached pass throws', async () => {
    const ds = buildDataSource({});
    const service = new SecretReencryptionService(ds.dataSource);
    jest.spyOn(service, 'run').mockRejectedValue(new Error('pool closed'));
    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pool closed'));
  });

  it('moves on without scanning when another replica holds the lock', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({ acquired: false });
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(ds.query.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(ds.release).toHaveBeenCalled();
  });

  it('rewrites rows under an older secret and leaves the rest alone', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const underPrevious = encrypt('sk-old', PREVIOUS);
    const underCurrent = encrypt('sk-new', CURRENT);
    const underUnknown = encrypt('sk-lost', UNKNOWN);
    const ds = buildDataSource({
      pages: {
        tenant_providers: [
          [
            { id: 'a', value: underPrevious },
            { id: 'b', value: underCurrent },
            { id: 'c', value: 'plaintext-legacy' },
            { id: 'd', value: underUnknown },
          ],
        ],
        agent_api_keys: [[{ id: 'k1', value: encrypt('mnfst_x', PREVIOUS) }]],
      },
    });

    await new SecretReencryptionService(ds.dataSource).run();

    expect(ds.updates).toHaveLength(2);
    const [first, second] = ds.updates;
    expect(first.table).toBe('tenant_providers');
    expect(first.params[1]).toBe('a');
    expect(first.params[2]).toBe(underPrevious);
    expect(decrypt(first.params[0] as string, CURRENT)).toBe('sk-old');
    expect(second.table).toBe('agent_api_keys');
    expect(decrypt(second.params[0] as string, CURRENT)).toBe('mnfst_x');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('row d'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'tenant_providers.api_key_encrypted 4 scanned / 1 rewritten / 1 undecryptable',
      ),
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('can be removed'));
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'));
    expect(ds.release).toHaveBeenCalled();
  });

  it('moves rows off the session secret when PREVIOUS names it', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['BETTER_AUTH_SECRET'] = PREVIOUS;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({
      pages: { email_provider_configs: [[{ id: 'e', value: encrypt('re_123', PREVIOUS) }]] },
    });
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.updates).toHaveLength(1);
    expect(decrypt(ds.updates[0].params[0] as string, CURRENT)).toBe('re_123');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 rewritten'));
  });

  it('does not count a rewrite another process won', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({
      updateAffected: 0,
      pages: { agent_api_keys: [[{ id: 'k', value: encrypt('mnfst_z', PREVIOUS) }]] },
    });
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.updates).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 scanned / 0 rewritten'));
  });

  it('withholds the removal hint while any row is undecryptable', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({
      pages: { tenant_providers: [[{ id: 'u', value: encrypt('sk-lost', UNKNOWN) }]] },
    });
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.updates).toHaveLength(0);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('can be removed'));
  });

  it('pages through full batches with the last id as the cursor', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const full = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      id: `id-${String(i).padStart(4, '0')}`,
      value: 'plain',
    }));
    const ds = buildDataSource({ pages: { tenant_providers: [full, []] } });
    await new SecretReencryptionService(ds.dataSource).run();
    const selects = ds.query.mock.calls.filter(([sql]) => String(sql).startsWith('SELECT'));
    const providerSelects = selects.filter(([sql]) => String(sql).includes('"tenant_providers"'));
    expect(providerSelects).toHaveLength(2);
    expect(providerSelects[1][1]).toEqual([`id-${String(BATCH_SIZE - 1).padStart(4, '0')}`]);
    expect(ds.updates).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('can be removed'));
  });

  it('keeps going when one table fails and reports it in the summary', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({
      failSelectFor: 'tenant_providers',
      pages: { agent_api_keys: [[{ id: 'k', value: encrypt('mnfst_y', PREVIOUS) }]] },
    });
    await new SecretReencryptionService(ds.dataSource).run();
    expect(ds.updates).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('tenant_providers.api_key_encrypted failed (relation'),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('logs and swallows a failure to connect, then still releases the runner', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({
      connectError: new Error('db down'),
      releaseError: new Error('x'),
    });
    await expect(new SecretReencryptionService(ds.dataSource).run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect(ds.query).not.toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'));
    expect(ds.release).toHaveBeenCalled();
  });

  it('ignores an unlock failure', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({ unlockError: new Error('unlock'), pages: {} });
    await expect(new SecretReencryptionService(ds.dataSource).run()).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('reports non-Error throwables by their string form', async () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = CURRENT;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    const ds = buildDataSource({});
    ds.connect.mockRejectedValueOnce('plain string');
    await new SecretReencryptionService(ds.dataSource).run();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('plain string'));
  });
});
