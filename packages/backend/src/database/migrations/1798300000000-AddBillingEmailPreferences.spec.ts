import { QueryRunner } from 'typeorm';
import { AddBillingEmailPreferences1798300000000 } from './1798300000000-AddBillingEmailPreferences';

describe('AddBillingEmailPreferences1798300000000', () => {
  let migration: AddBillingEmailPreferences1798300000000;
  let queryRunner: jest.Mocked<Pick<QueryRunner, 'query'>>;

  beforeEach(() => {
    migration = new AddBillingEmailPreferences1798300000000();
    queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
  });

  describe('up', () => {
    it('adds the nullable billing_email_preferences jsonb column to tenants', async () => {
      await migration.up(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_email_preferences" jsonb',
        ),
      );
    });
  });

  describe('down', () => {
    it('drops the billing_email_preferences column', async () => {
      await migration.down(queryRunner as unknown as QueryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'ALTER TABLE "tenants" DROP COLUMN IF EXISTS "billing_email_preferences"',
        ),
      );
    });
  });

  it('exposes a stable migration name', () => {
    expect(migration.name).toBe('AddBillingEmailPreferences1798300000000');
  });
});
