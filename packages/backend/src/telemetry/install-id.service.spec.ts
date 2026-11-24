import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InstallMetadata } from '../entities/install-metadata.entity';
import { InstallIdService, SINGLETON_ID } from './install-id.service';

describe('InstallIdService', () => {
  let service: InstallIdService;
  let findOne: jest.Mock;
  let update: jest.Mock;
  let execute: jest.Mock;
  let values: jest.Mock;

  const rowTemplate: InstallMetadata = {
    id: SINGLETON_ID,
    install_id: '00000000-0000-0000-0000-000000000000',
    created_at: '2026-04-20T00:00:00',
    first_send_at: null,
    last_sent_at: null,
    autofix_consented_at: null,
  };

  beforeEach(async () => {
    findOne = jest.fn();
    update = jest.fn().mockResolvedValue({ affected: 1 });
    execute = jest.fn().mockResolvedValue({ raw: [] });

    values = jest.fn().mockReturnThis();
    const qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values,
      orIgnore: jest.fn().mockReturnThis(),
      execute,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstallIdService,
        {
          provide: getRepositoryToken(InstallMetadata),
          useValue: {
            findOne,
            update,
            createQueryBuilder: () => qb,
          },
        },
      ],
    }).compile();

    service = module.get(InstallIdService);
  });

  describe('getOrCreate', () => {
    it('returns the existing singleton row without inserting', async () => {
      findOne.mockResolvedValueOnce(rowTemplate);

      const result = await service.getOrCreate();

      expect(result).toBe(rowTemplate);
      expect(execute).not.toHaveBeenCalled();
    });

    it('inserts a new singleton row when none exists and returns it', async () => {
      findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...rowTemplate, install_id: 'freshly-created-uuid' });

      const result = await service.getOrCreate();

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.install_id).toBe('freshly-created-uuid');
    });

    it('throws if the row is still missing after the upsert (should never happen)', async () => {
      findOne.mockResolvedValue(null);

      await expect(service.getOrCreate()).rejects.toThrow(/missing after upsert/);
    });

    it('inserts first_send_at within the next 24h (jitter)', async () => {
      findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(rowTemplate);
      const before = Date.now();

      await service.getOrCreate();

      const inserted = values.mock.calls[0]?.[0] as { first_send_at: string };
      expect(inserted.first_send_at).toBeDefined();
      const fsa = new Date(inserted.first_send_at).getTime();
      expect(fsa).toBeGreaterThanOrEqual(before);
      expect(fsa).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    });

    it('picks a different first_send_at on successive calls (jitter is random)', async () => {
      // Two fresh services that each insert — the first_send_at values
      // should differ because Math.random is seeded per-call. A regression
      // that always returned `Date.now()` would make them equal.
      findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(rowTemplate);
      await service.getOrCreate();
      const first = (values.mock.calls[0]?.[0] as { first_send_at: string }).first_send_at;

      values.mockClear();
      findOne.mockReset();
      findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(rowTemplate);
      // Force a different Math.random bucket so the test is deterministic.
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0.999);
      await service.getOrCreate();
      const second = (values.mock.calls[0]?.[0] as { first_send_at: string }).first_send_at;
      spy.mockRestore();

      expect(second).not.toBe(first);
    });
  });

  describe('markSent', () => {
    it('updates last_sent_at on the singleton row', async () => {
      const now = new Date('2026-04-20T12:00:00Z');

      await service.markSent(now);

      expect(update).toHaveBeenCalledWith(SINGLETON_ID, { last_sent_at: now.toISOString() });
    });
  });
});
