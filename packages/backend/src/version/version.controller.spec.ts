import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { VersionController } from './version.controller';
import type { VersionCheckService, VersionInfo } from './version-check.service';

describe('VersionController', () => {
  const info: VersionInfo = {
    current: '6.21.1',
    latest: '6.22.0',
    update_available: true,
    releases_behind: 1,
    release_url: 'https://manifest.build/changelog/#v6-22-0',
    github_release_url: 'https://github.com/mnfst/llm-gateway/releases/tag/manifest%406.22.0',
    upgrade_docs_url: 'https://manifest.build/llm-gateway/docs/self-hosted/#upgrading',
    upgrade_command: 'docker compose pull && docker compose up -d',
    check_enabled: true,
    checked_at: '2026-09-04T09:00:00.000Z',
  };

  it('returns the version info from the service', async () => {
    const service = { getVersionInfo: jest.fn().mockResolvedValue(info) };
    const controller = new VersionController(service as unknown as VersionCheckService);

    await expect(controller.getVersion()).resolves.toEqual(info);
  });

  it('is served at GET /api/v1/version behind the normal session/API-key guards', () => {
    const prefix = Reflect.getMetadata('path', VersionController);
    const route = Reflect.getMetadata('path', VersionController.prototype.getVersion);
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, VersionController.prototype.getVersion);

    expect(`${prefix}/${route}`).toBe('api/v1/version');
    expect(isPublic).toBeUndefined();
  });
});
