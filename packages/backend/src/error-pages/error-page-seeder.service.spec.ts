import { ErrorPageSeederService } from './error-page-seeder.service';
import { ErrorPagesService } from './error-pages.service';
import { ERROR_PAGE_SEEDS } from './error-page-seed-data';

describe('ErrorPageSeederService', () => {
  let pages: { getBySlug: jest.Mock; upsert: jest.Mock };
  let service: ErrorPageSeederService;
  const prev = process.env['SEED_DATA'];

  beforeEach(() => {
    pages = {
      getBySlug: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ ok: true }),
    };
    service = new ErrorPageSeederService(pages as unknown as ErrorPagesService);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['SEED_DATA'];
    else process.env['SEED_DATA'] = prev;
  });

  it('does nothing unless SEED_DATA=true', async () => {
    delete process.env['SEED_DATA'];
    await service.onModuleInit();
    expect(pages.getBySlug).not.toHaveBeenCalled();
    expect(pages.upsert).not.toHaveBeenCalled();
  });

  it('skips when the demo pages are already published', async () => {
    process.env['SEED_DATA'] = 'true';
    pages.getBySlug.mockResolvedValue({ slug: ERROR_PAGE_SEEDS[0].slug });
    await service.onModuleInit();
    expect(pages.upsert).not.toHaveBeenCalled();
  });

  it('publishes every demo page with a populated 14-day trend when not yet seeded', async () => {
    process.env['SEED_DATA'] = 'true';
    await service.onModuleInit();
    expect(pages.upsert).toHaveBeenCalledTimes(ERROR_PAGE_SEEDS.length);
    const first = pages.upsert.mock.calls[0][0];
    expect(first.slug).toBe(ERROR_PAGE_SEEDS[0].slug);
    expect(first.stats.tenants).toBe(ERROR_PAGE_SEEDS[0].tenants);
    expect(first.stats.trend).toHaveLength(14);
    expect(first.stats.variants).toEqual(ERROR_PAGE_SEEDS[0].variants ?? []);
    expect(first.stats.last_seen).toBeTruthy();
    // an entry without explicit variants still publishes a [] variants array
    const noVariant = pages.upsert.mock.calls
      .map((c) => c[0])
      .find((d) => d.slug === 'gemini-400-missing-thought-signature');
    expect(noVariant.stats.variants).toEqual([]);
  });
});
