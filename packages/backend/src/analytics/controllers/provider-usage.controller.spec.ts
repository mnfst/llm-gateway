import { CACHE_TTL_METADATA } from '@nestjs/cache-manager';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { ProviderUsageController } from './provider-usage.controller';
import type { TenantContext } from '../../common/decorators/tenant-context.decorator';
import { UserCacheInterceptor } from '../../common/interceptors/user-cache.interceptor';
import { DASHBOARD_CACHE_TTL_MS } from '../../common/constants/cache.constants';
import type { ProviderUsageSummary } from '../services/provider-usage.service';

describe('ProviderUsageController', () => {
  const previousMode = process.env['MANIFEST_MODE'];

  beforeEach(() => {
    process.env['MANIFEST_MODE'] = 'cloud';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  it('caches the expensive 30-day aggregation per tenant', () => {
    expect(Reflect.getMetadata(CACHE_TTL_METADATA, ProviderUsageController)).toBe(
      DASHBOARD_CACHE_TTL_MS,
    );
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, ProviderUsageController)).toContain(
      UserCacheInterceptor,
    );
  });

  it('delegates to ProviderUsageService and wraps the result in { providers }', async () => {
    const summaries: ProviderUsageSummary[] = [
      {
        provider: 'openai',
        auth_type: 'api_key',
        key_label: 'Default',
        consumption_tokens: 100,
        consumption_messages: 4,
        attempts_30d: 10,
        succeeded_30d: 9,
        consumption_cost: 0.25,
        last_used_at: '2026-06-16T10:00:00.000Z',
        sparkline_7d: [0, 0, 0, 0, 0, 0, 100],
      },
    ];
    const service = { getUsage: jest.fn().mockResolvedValue(summaries) };
    const controller = new ProviderUsageController(service as never);
    const ctx: TenantContext = { tenantId: 'tenant-1', userId: 'user-1' };

    const result = await controller.getUsage(ctx);

    expect(service.getUsage).toHaveBeenCalledWith('tenant-1');
    expect(result).toEqual({ providers: summaries });
  });

  it('passes a null tenant through (fresh account → empty usage)', async () => {
    const service = { getUsage: jest.fn().mockResolvedValue([]) };
    const controller = new ProviderUsageController(service as never);

    const result = await controller.getUsage({ tenantId: null, userId: 'user-1' });

    expect(service.getUsage).toHaveBeenCalledWith(null);
    expect(result).toEqual({ providers: [] });
  });

  it('hides built-in local usage in cloud without hiding custom tunnel usage', async () => {
    const base = {
      auth_type: 'local',
      consumption_tokens: 10,
      consumption_messages: 1,
      consumption_cost: 0,
      last_used_at: null,
      sparkline_7d: [0, 0, 0, 0, 0, 0, 10],
    };
    const service = {
      getUsage: jest.fn().mockResolvedValue([
        { ...base, provider: 'ollama' },
        { ...base, provider: 'custom:runtime-id' },
      ]),
    };
    const controller = new ProviderUsageController(service as never);

    const result = await controller.getUsage({ tenantId: 'tenant-1', userId: 'user-1' });

    expect(result.providers.map((provider) => provider.provider)).toEqual(['custom:runtime-id']);
  });
});
