const initialize = jest.fn();
const destroy = jest.fn();
const dsQuery = jest.fn();
const managerQuery = jest.fn();
const dsTransaction = jest.fn(async (work: (manager: { query: jest.Mock }) => Promise<unknown>) =>
  work({ query: managerQuery }),
);
const DataSourceMock = jest.fn().mockImplementation(() => ({
  initialize,
  destroy,
  query: dsQuery,
  transaction: dsTransaction,
}));
jest.mock('typeorm', () => ({ DataSource: DataSourceMock }));

import { main, resolveDatabaseUrl } from './stripe-account-migration.cli';

function fakeDb(planRows: unknown[][]) {
  const query = jest.fn();
  for (const rows of planRows) query.mockResolvedValueOnce(rows);
  const txQuery = jest.fn().mockResolvedValue([]);
  const transaction = jest.fn(async (work: (r: { query: jest.Mock }) => Promise<unknown>) =>
    work({ query: txQuery }),
  );
  const close = jest.fn().mockResolvedValue(undefined);
  return {
    query,
    txQuery,
    transaction,
    close,
    connect: async () => ({ query, transaction, close }) as never,
  };
}

const PAID = [
  {
    id: 's1',
    referenceId: 'u1',
    email: 'a@example.com',
    status: 'active',
    plan: 'pro',
    periodEnd: '2099-01-01',
  },
];

describe('stripe-account-migration CLI', () => {
  beforeEach(() => jest.clearAllMocks());

  it('prefers MIGRATION_DATABASE_URL and fails without any URL', () => {
    expect(resolveDatabaseUrl({ MIGRATION_DATABASE_URL: ' m ', DATABASE_URL: 'd' })).toBe('m');
    expect(resolveDatabaseUrl({ DATABASE_URL: 'd' })).toBe('d');
    expect(() => resolveDatabaseUrl({})).toThrow('Set MIGRATION_DATABASE_URL or DATABASE_URL');
  });

  it('only prints in dry-run mode', async () => {
    const db = fakeDb([PAID, [{ n: 1 }], [{ n: 2 }]]);
    const log = jest.fn();
    await main({
      argv: [],
      env: { DATABASE_URL: 'postgres://x' },
      logger: { log },
      connect: db.connect,
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Stripe account migration (DRY RUN)');
    expect(log).toHaveBeenCalledWith('  - a@example.com (pro, active): Pro until 2099-01-01');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Dry run: nothing was written'));
    expect(db.close).toHaveBeenCalled();
  });

  it('writes with --apply and reports what is left', async () => {
    const db = fakeDb([PAID, [{ n: 1 }], [{ n: 2 }], [], [{ n: 0 }], [{ n: 0 }]]);
    const log = jest.fn();
    await main({
      argv: ['--apply'],
      env: { DATABASE_URL: 'postgres://x' },
      logger: { log },
      connect: db.connect,
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.txQuery).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith('Stripe account migration (APPLY)');
    expect(log).toHaveBeenLastCalledWith(
      'Done. Left with Stripe ids: 0 paid subscriptions, 0 other rows, 0 users.',
    );
  });

  it('connects through TypeORM by default and closes the connection', async () => {
    dsQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ n: 0 }]);
    dsQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ n: 0 }]);
    const log = jest.fn();

    await main({ argv: ['--apply'], env: { DATABASE_URL: 'postgres://x' }, logger: { log } });

    expect(DataSourceMock).toHaveBeenCalledWith({
      type: 'postgres',
      url: 'postgres://x',
      extra: { max: 1 },
    });
    expect(initialize).toHaveBeenCalled();
    expect(managerQuery).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalled();
  });

  it('falls back to process argv, env and console', async () => {
    const db = fakeDb([[], [{ n: 0 }], [{ n: 0 }]]);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const prev = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgres://env';
    try {
      await main({ connect: db.connect });
      expect(logSpy).toHaveBeenCalledWith('Stripe account migration (DRY RUN)');
    } finally {
      process.env['DATABASE_URL'] = prev;
      logSpy.mockRestore();
    }
  });
});
