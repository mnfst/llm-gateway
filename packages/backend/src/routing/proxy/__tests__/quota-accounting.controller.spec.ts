import 'reflect-metadata';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { QuotaAccountingSnapshot } from '../quota-accounting';
import { QuotaAccountingController } from '../quota-accounting.controller';

describe('QuotaAccountingController — GET /api/v1/quota-accounting', () => {
  const snapshot: QuotaAccountingSnapshot = {
    providers: {
      openai: {
        window_start: '2026-10-30T10:00:00.000Z',
        window_flush_at: '2026-10-30T11:00:00.000Z',
        attempted_requests: 12,
        attempted_est_tokens: 3456,
        consumed_requests: 9,
        consumed_tokens: 2100,
        updated_at: '2026-10-30T10:30:00.000Z',
      },
    },
  };

  it('serves the accounting service snapshot verbatim', () => {
    const controller = new QuotaAccountingController({ snapshot: () => snapshot } as never);
    expect(controller.getQuotaAccounting()).toEqual(snapshot);
    expect(controller.getQuotaAccounting().providers['openai'].attempted_requests).toBe(12);
  });

  it('returns an empty provider map when accounting is absent (optional-injected)', () => {
    const controller = new QuotaAccountingController();
    expect(controller.getQuotaAccounting()).toEqual({ providers: {} });
  });

  it('is @Public — the day-deck reads it without an agent key', () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, QuotaAccountingController.prototype.getQuotaAccounting),
    ).toBe(true);
  });
});
