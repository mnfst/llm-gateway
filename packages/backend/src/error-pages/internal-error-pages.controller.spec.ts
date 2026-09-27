import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalErrorPagesController } from './internal-error-pages.controller';
import type { ErrorPagesService } from './error-pages.service';
import type { ErrorDiscoveryService } from './error-discovery.service';
import type { UpsertErrorPageDto } from './dto/upsert-error-page.dto';

const SECRET = 'super-secret-push-token';

function makeConfig(secret: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'app.errorPagePushSecret' ? secret : undefined)),
  } as unknown as ConfigService;
}

describe('InternalErrorPagesController', () => {
  let mockService: { upsert: jest.Mock; remove: jest.Mock };
  let mockDiscovery: { discover: jest.Mock };

  beforeEach(() => {
    mockService = { upsert: jest.fn(), remove: jest.fn() };
    mockDiscovery = { discover: jest.fn() };
  });

  function makeController(secret: string | undefined): InternalErrorPagesController {
    return new InternalErrorPagesController(
      mockService as unknown as ErrorPagesService,
      mockDiscovery as unknown as ErrorDiscoveryService,
      makeConfig(secret),
    );
  }

  const dto = { slug: 'gemini-429' } as UpsertErrorPageDto;

  describe('secret rejection', () => {
    it('rejects clusters when the header is missing', async () => {
      const controller = makeController(SECRET);

      await expect(controller.clusters(undefined as unknown as string)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockDiscovery.discover).not.toHaveBeenCalled();
    });

    it('rejects clusters when the header is wrong', async () => {
      const controller = makeController(SECRET);

      await expect(controller.clusters('nope')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockDiscovery.discover).not.toHaveBeenCalled();
    });

    it('rejects when the configured secret is empty even if header matches it', async () => {
      const controller = makeController('');

      // Both provided and expected would be '' — but an empty configured secret
      // must never authorize, so this still rejects.
      await expect(controller.clusters('')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockDiscovery.discover).not.toHaveBeenCalled();
    });

    it('rejects when the configured secret is unset (undefined → "")', async () => {
      const controller = makeController(undefined);

      await expect(controller.clusters('anything')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects upsert with a bad secret without touching the service', async () => {
      const controller = makeController(SECRET);

      await expect(controller.upsert('wrong', dto)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockService.upsert).not.toHaveBeenCalled();
    });

    it('rejects remove with a bad secret without touching the service', async () => {
      const controller = makeController(SECRET);

      await expect(controller.remove('wrong', 'gemini-429')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockService.remove).not.toHaveBeenCalled();
    });
  });

  describe('with the correct secret', () => {
    it('clusters delegates to the discovery service', async () => {
      const clusters = [{ cluster_key: 'gemini|429' }];
      mockDiscovery.discover.mockResolvedValue(clusters);
      const controller = makeController(SECRET);

      const result = await controller.clusters(SECRET);

      expect(result).toBe(clusters);
      expect(mockDiscovery.discover).toHaveBeenCalledTimes(1);
    });

    it('upsert delegates to the pages service', async () => {
      const response = { ok: true as const, slug: 'gemini-429' };
      mockService.upsert.mockResolvedValue(response);
      const controller = makeController(SECRET);

      const result = await controller.upsert(SECRET, dto);

      expect(result).toBe(response);
      expect(mockService.upsert).toHaveBeenCalledWith(dto);
    });

    it('remove delegates to the pages service', async () => {
      const response = { ok: true as const, slug: 'gemini-429' };
      mockService.remove.mockResolvedValue(response);
      const controller = makeController(SECRET);

      const result = await controller.remove(SECRET, 'gemini-429');

      expect(result).toBe(response);
      expect(mockService.remove).toHaveBeenCalledWith('gemini-429');
    });
  });
});
