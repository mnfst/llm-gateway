import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PublicErrorPagesController } from './public-error-pages.controller';
import type { ErrorPagesService } from './error-pages.service';
import type { PublicErrorPage } from '../entities/public-error-page.entity';

function makeConfig(enabled: boolean): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'app.publicErrorPagesEnabled' ? enabled : undefined)),
  } as unknown as ConfigService;
}

function makePage(overrides: Partial<PublicErrorPage> = {}): PublicErrorPage {
  return {
    slug: 'gemini-429-rate-limit',
    cluster_key: 'gemini|429',
    provider: 'gemini',
    provider_label: 'Google Gemini',
    http_status: 429,
    category: 'rate_limit',
    category_label: 'Rate limit',
    title: 'Gemini 429',
    meta_description: 'desc',
    h1: 'Gemini rate limit',
    body_what: 'what',
    body_fix: 'fix',
    body_manifest: 'manifest',
    sample_message: 'sample',
    faq: [],
    stats: {
      tenants: 42,
      volume_7d: 100,
      volume_30d: 400,
      recovery_rate: 0.74,
      last_seen: '2026-06-01T00:00:00.000Z',
      trend: [],
    },
    related: [],
    noindex: false,
    published_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PublicErrorPagesController', () => {
  let mockService: { listPublished: jest.Mock; getBySlug: jest.Mock };

  beforeEach(() => {
    mockService = {
      listPublished: jest.fn(),
      getBySlug: jest.fn(),
    };
  });

  function makeController(enabled: boolean): PublicErrorPagesController {
    return new PublicErrorPagesController(
      mockService as unknown as ErrorPagesService,
      makeConfig(enabled),
    );
  }

  describe('when public stats are disabled', () => {
    it('throws NotFoundException from list without calling the service', async () => {
      const controller = makeController(false);

      await expect(controller.list()).rejects.toBeInstanceOf(NotFoundException);
      expect(mockService.listPublished).not.toHaveBeenCalled();
    });

    it('throws NotFoundException from detail without calling the service', async () => {
      const controller = makeController(false);

      await expect(controller.detail('gemini-429')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockService.getBySlug).not.toHaveBeenCalled();
    });
  });

  describe('list (enabled)', () => {
    it('projects only the public summary fields plus cached_at', async () => {
      mockService.listPublished.mockResolvedValue([makePage()]);
      const controller = makeController(true);

      const result = await controller.list();

      expect(mockService.listPublished).toHaveBeenCalledTimes(1);
      expect(result.cached_at).toBeDefined();
      expect(typeof result.cached_at).toBe('string');
      expect(result.pages).toHaveLength(1);

      const page = result.pages[0];
      expect(page).toEqual({
        slug: 'gemini-429-rate-limit',
        title: 'Gemini 429',
        h1: 'Gemini rate limit',
        meta_description: 'desc',
        provider: 'gemini',
        provider_label: 'Google Gemini',
        http_status: 429,
        category: 'rate_limit',
        category_label: 'Rate limit',
        stats: makePage().stats,
        noindex: false,
        published_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      });
    });

    it('does not leak internal/body fields in the projection', async () => {
      mockService.listPublished.mockResolvedValue([makePage()]);
      const controller = makeController(true);

      const page = (await controller.list()).pages[0] as Record<string, unknown>;

      expect(page).not.toHaveProperty('cluster_key');
      expect(page).not.toHaveProperty('body_what');
      expect(page).not.toHaveProperty('body_fix');
      expect(page).not.toHaveProperty('body_manifest');
      expect(page).not.toHaveProperty('sample_message');
      expect(page).not.toHaveProperty('faq');
      expect(page).not.toHaveProperty('related');
    });

    it('returns an empty pages array when nothing is published', async () => {
      mockService.listPublished.mockResolvedValue([]);
      const controller = makeController(true);

      const result = await controller.list();

      expect(result.pages).toEqual([]);
    });
  });

  describe('detail (enabled)', () => {
    it('returns the full page when found', async () => {
      const page = makePage();
      mockService.getBySlug.mockResolvedValue(page);
      const controller = makeController(true);

      const result = await controller.detail('gemini-429-rate-limit');

      expect(result).toBe(page);
      expect(mockService.getBySlug).toHaveBeenCalledWith('gemini-429-rate-limit');
    });

    it('throws NotFoundException when the page is missing', async () => {
      mockService.getBySlug.mockResolvedValue(null);
      const controller = makeController(true);

      await expect(controller.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
