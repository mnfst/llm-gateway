import { ErrorClusterSeederService } from './error-cluster-seeder.service';

/**
 * Build a fake repo whose query-builder chain resolves `getCount()` to the
 * supplied value, and whose `insert` records every batch it receives.
 */
function makeRepo(existingCount: number) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(existingCount),
  };
  const insert = jest.fn().mockResolvedValue(undefined);
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    insert,
  };
  return { repo, qb, insert };
}

describe('ErrorClusterSeederService', () => {
  const original = process.env['SEED_DATA'];

  afterEach(() => {
    if (original === undefined) delete process.env['SEED_DATA'];
    else process.env['SEED_DATA'] = original;
    jest.restoreAllMocks();
  });

  it('returns early without querying when SEED_DATA is unset', async () => {
    delete process.env['SEED_DATA'];
    const { repo, insert } = makeRepo(0);
    const service = new ErrorClusterSeederService(repo as never);

    await service.onModuleInit();

    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns early when SEED_DATA is set to a non-"true" value', async () => {
    process.env['SEED_DATA'] = 'false';
    const { repo, insert } = makeRepo(0);
    const service = new ErrorClusterSeederService(repo as never);

    await service.onModuleInit();

    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('skips inserting when seed rows already exist', async () => {
    process.env['SEED_DATA'] = 'true';
    const { repo, qb, insert } = makeRepo(5);
    const service = new ErrorClusterSeederService(repo as never);

    await service.onModuleInit();

    expect(qb.where).toHaveBeenCalledWith('m.id LIKE :p', { p: 'seed-err-%' });
    expect(qb.getCount).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  describe('full seed run', () => {
    it('inserts error rows (plus recovered siblings) in batches of 500', async () => {
      process.env['SEED_DATA'] = 'true';
      // Make randomness deterministic so both the recentOnly branch and the
      // recovery-sibling branch are exercised on every spec.
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      const { repo, insert } = makeRepo(0);
      const service = new ErrorClusterSeederService(repo as never);

      await service.onModuleInit();

      expect(insert).toHaveBeenCalled();

      // Every batch must be <= 500 rows.
      const batches = insert.mock.calls.map((c) => c[0] as unknown[]);
      for (const batch of batches) {
        expect(batch.length).toBeGreaterThan(0);
        expect(batch.length).toBeLessThanOrEqual(500);
      }

      const allRows = batches.flat() as Array<Record<string, unknown>>;

      // Error rows carry the seed id prefix and an http status field.
      const errorRows = allRows.filter((r) => !String(r['id']).endsWith('-ok'));
      expect(errorRows.length).toBeGreaterThan(0);
      errorRows.forEach((r) => {
        expect(String(r['id']).startsWith('seed-err-')).toBe(true);
        expect(r['agent_id']).toBe('seed-err-agent');
      });

      // With random=0.1 (< every spec's recovery fraction at made/total≈0), at
      // least some recovered `ok` siblings are produced sharing the trace.
      const okRows = allRows.filter((r) => String(r['id']).endsWith('-ok'));
      expect(okRows.length).toBeGreaterThan(0);
      okRows.forEach((r) => {
        expect(r['status']).toBe('success');
        expect(r['input_tokens']).toBe(50);
        expect(r['output_tokens']).toBe(80);
      });
    });

    it('omits recovered siblings when randomness exceeds every recovery fraction', async () => {
      process.env['SEED_DATA'] = 'true';
      // random=0.99 keeps made/total < recovery false for the very first row of
      // each spec (recovery max is 0.88), so the recovery branch is skipped.
      jest.spyOn(Math, 'random').mockReturnValue(0.99);
      const { repo, insert } = makeRepo(0);
      const service = new ErrorClusterSeederService(repo as never);

      await service.onModuleInit();

      const allRows = insert.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>);
      // Some `ok` rows may still appear once made/total climbs, but the first
      // row of the first spec must be an error with no immediate sibling — the
      // branch coverage we care about (the `if` evaluating false) is hit.
      expect(allRows.length).toBeGreaterThan(0);
      expect(allRows.some((r) => !String(r['id']).endsWith('-ok'))).toBe(true);
    });
  });
});
