import { QueryRunner } from 'typeorm';
import { AddTenantLimitOverrides1798100000000 } from './1798100000000-AddTenantLimitOverrides';

describe('AddTenantLimitOverrides1798100000000', () => {
  let migration: AddTenantLimitOverrides1798100000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddTenantLimitOverrides1798100000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds the nullable limit_overrides jsonb column to tenants', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "limit_overrides" jsonb',
        ),
      );
    });
  });

  describe('down', () => {
    it('drops the limit_overrides column', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE "tenants" DROP COLUMN IF EXISTS "limit_overrides"'),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddTenantLimitOverrides1798100000000');
  });
});
