import { BadRequestException } from '@nestjs/common';
import { ErrorPagesService, MIN_TENANTS_FOR_PUBLIC } from './error-pages.service';
import type { PublicErrorPage, ErrorPageStats } from '../entities/public-error-page.entity';
import type { UpsertErrorPageDto } from './dto/upsert-error-page.dto';

function makeStats(overrides: Partial<ErrorPageStats> = {}): ErrorPageStats {
  return {
    tenants: 12,
    volume_7d: 100,
    volume_30d: 400,
    recovery_rate: 0.5,
    last_seen: '2026-06-01T00:00:00.000Z',
    trend: [],
    ...overrides,
  };
}

function makeDto(overrides: Partial<UpsertErrorPageDto> = {}): UpsertErrorPageDto {
  return {
    slug: 'gemini-429-rate-limit',
    cluster_key: 'gemini|429',
    provider: 'gemini',
    title: 'Gemini 429 rate limit',
    meta_description: 'A description',
    h1: 'Gemini rate limit',
    stats: makeStats(),
    ...overrides,
  } as UpsertErrorPageDto;
}

describe('ErrorPagesService', () => {
  let service: ErrorPagesService;
  let mockRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };

  beforeEach(() => {
    mockRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    };
    service = new ErrorPagesService(mockRepo as never);
  });

  it('exposes the k-anonymity floor constant', () => {
    expect(MIN_TENANTS_FOR_PUBLIC).toBe(10);
  });

  describe('listPublished', () => {
    it('returns pages ordered by published_at DESC', async () => {
      const pages = [{ slug: 'a' }, { slug: 'b' }] as PublicErrorPage[];
      mockRepo.find.mockResolvedValue(pages);

      const result = await service.listPublished();

      expect(result).toBe(pages);
      expect(mockRepo.find).toHaveBeenCalledWith({ order: { published_at: 'DESC' } });
    });
  });

  describe('getBySlug', () => {
    it('looks up a single page by slug', async () => {
      const page = { slug: 'gemini-429' } as PublicErrorPage;
      mockRepo.findOne.mockResolvedValue(page);

      const result = await service.getBySlug('gemini-429');

      expect(result).toBe(page);
      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { slug: 'gemini-429' } });
    });

    it('returns null when no page matches', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      expect(await service.getBySlug('missing')).toBeNull();
    });
  });

  describe('upsert', () => {
    it('rejects when tenants is below the k-anonymity floor', async () => {
      const dto = makeDto({ stats: makeStats({ tenants: 9 }) });

      await expect(service.upsert(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.upsert(dto)).rejects.toThrow(
        'cluster affects 9 tenants, below the k-anonymity floor of 10',
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('rejects when stats is missing entirely (defaults tenants to 0)', async () => {
      const dto = { ...makeDto(), stats: undefined } as unknown as UpsertErrorPageDto;

      await expect(service.upsert(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.upsert(dto)).rejects.toThrow('cluster affects 0 tenants');
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('rejects when tenants is non-finite (NaN)', async () => {
      const dto = makeDto({
        stats: makeStats({ tenants: 'oops' as unknown as number }),
      });

      await expect(service.upsert(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a custom: provider even above the floor (never a public page)', async () => {
      const dto = makeDto({ provider: 'custom:1aee1812', stats: makeStats({ tenants: 500 }) });
      await expect(service.upsert(dto)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.upsert(dto)).rejects.toThrow('custom providers are tenant-specific');
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it('accepts exactly the floor (10 tenants)', async () => {
      const dto = makeDto({ stats: makeStats({ tenants: MIN_TENANTS_FOR_PUBLIC }) });
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(undefined);

      const result = await service.upsert(dto);

      expect(result).toEqual({ ok: true, slug: dto.slug });
      expect(mockRepo.save).toHaveBeenCalledTimes(1);
    });

    it('scrubs secrets from sample_message before persisting', async () => {
      const dto = makeDto({
        sample_message: 'token leaked: sk-proj-ABCDEF1234567890 in the body',
      });
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(undefined);

      await service.upsert(dto);

      const saved = mockRepo.save.mock.calls[0][0] as PublicErrorPage;
      expect(saved.sample_message).toBe('token leaked: [REDACTED] in the body');
      expect(saved.sample_message).not.toContain('sk-proj-ABCDEF1234567890');
    });

    it('preserves an existing published_at on re-upsert', async () => {
      const original = '2026-01-01T00:00:00.000Z';
      mockRepo.findOne.mockResolvedValue({ published_at: original } as PublicErrorPage);
      mockRepo.save.mockResolvedValue(undefined);

      await service.upsert(makeDto());

      const saved = mockRepo.save.mock.calls[0][0] as PublicErrorPage;
      expect(saved.published_at).toBe(original);
      // updated_at is always refreshed to "now", distinct from the preserved value.
      expect(saved.updated_at).not.toBe(original);
    });

    it('sets published_at to now for a brand-new page', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(undefined);

      await service.upsert(makeDto());

      const saved = mockRepo.save.mock.calls[0][0] as PublicErrorPage;
      expect(saved.published_at).toBe(saved.updated_at);
      expect(() => new Date(saved.published_at).toISOString()).not.toThrow();
    });

    it('fills defaults for optional fields', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(undefined);

      await service.upsert(makeDto({ provider: 'gemini' }));

      const saved = mockRepo.save.mock.calls[0][0] as PublicErrorPage;
      expect(saved.provider_label).toBe('gemini'); // ← provider
      expect(saved.http_status).toBeNull();
      expect(saved.category).toBe('unknown');
      expect(saved.category_label).toBe('');
      expect(saved.body_what).toBe('');
      expect(saved.body_fix).toBe('');
      expect(saved.body_manifest).toBe('');
      expect(saved.sample_message).toBe('');
      expect(saved.faq).toEqual([]);
      expect(saved.related).toEqual([]);
      expect(saved.noindex).toBe(false);
    });

    it('keeps explicitly provided optional fields', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(undefined);
      const dto = makeDto({
        provider_label: 'Google Gemini',
        http_status: 429,
        category: 'rate_limit',
        category_label: 'Rate limit',
        body_what: 'what',
        body_fix: 'fix',
        body_manifest: 'manifest',
        faq: [{ q: 'why?', a: 'because' }],
        related: [{ slug: 'other', title: 'Other' }],
        noindex: true,
      });

      await service.upsert(dto);

      const saved = mockRepo.save.mock.calls[0][0] as PublicErrorPage;
      expect(saved.provider_label).toBe('Google Gemini');
      expect(saved.http_status).toBe(429);
      expect(saved.category).toBe('rate_limit');
      expect(saved.category_label).toBe('Rate limit');
      expect(saved.body_what).toBe('what');
      expect(saved.body_fix).toBe('fix');
      expect(saved.body_manifest).toBe('manifest');
      expect(saved.faq).toEqual([{ q: 'why?', a: 'because' }]);
      expect(saved.related).toEqual([{ slug: 'other', title: 'Other' }]);
      expect(saved.noindex).toBe(true);
      expect(saved.cluster_key).toBe(dto.cluster_key);
      expect(saved.stats).toBe(dto.stats);
    });

    it('treats an explicit null http_status as null', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.save.mockResolvedValue(undefined);

      await service.upsert(makeDto({ http_status: null }));

      const saved = mockRepo.save.mock.calls[0][0] as PublicErrorPage;
      expect(saved.http_status).toBeNull();
    });
  });

  describe('remove', () => {
    it('deletes by slug and echoes the slug', async () => {
      mockRepo.delete.mockResolvedValue(undefined);

      const result = await service.remove('gemini-429');

      expect(result).toEqual({ ok: true, slug: 'gemini-429' });
      expect(mockRepo.delete).toHaveBeenCalledWith({ slug: 'gemini-429' });
    });
  });
});
