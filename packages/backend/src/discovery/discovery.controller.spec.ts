import { DiscoveryController } from './discovery.controller';
import type { DiscoverySyncService } from './discovery-sync.service';

describe('DiscoveryController', () => {
  it('starts a best-effort Peacock sync and returns success immediately', () => {
    const submit = jest.fn().mockResolvedValue(undefined);
    const controller = new DiscoveryController({ submit } as unknown as DiscoverySyncService);
    const submission = { name: 'Jane', projectType: 'ai_agent' };

    expect(controller.complete(submission)).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledWith(submission);
  });
});
