import { ProviderService } from '../provider.service';
import { TenantProvider } from '../../../entities/tenant-provider.entity';
import { TierAssignment } from '../../../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../../../entities/specificity-assignment.entity';
import { Agent } from '../../../entities/agent.entity';
import { HeaderTier } from '../../../entities/header-tier.entity';
import type { Repository } from 'typeorm';
import type { RoutingCacheService } from '../routing-cache.service';
import type { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { encrypt, getEncryptionSecret } from '../../../common/utils/crypto.util';

jest.mock('../../qwen-region', () => {
  const actual = jest.requireActual('../../qwen-region');
  return { ...actual, detectQwenRegion: jest.fn() };
});

const { detectQwenRegion } = jest.requireMock('../../qwen-region') as {
  detectQwenRegion: jest.Mock;
};

const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn().mockImplementation(async (rows) => rows),
  remove: jest.fn().mockResolvedValue(undefined),
  manager: { transaction: jest.fn() },
  createQueryBuilder: jest.fn().mockReturnValue({
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([{ id: 'agent-1' }]),
  }),
});

describe('ProviderService — Qwen region resolution', () => {
  let svc: ProviderService;
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'a'.repeat(48);
    detectQwenRegion.mockReset();
    svc = new ProviderService(
      makeRepo() as unknown as Repository<TenantProvider>,
      makeRepo() as unknown as Repository<TierAssignment>,
      makeRepo() as unknown as Repository<SpecificityAssignment>,
      makeRepo() as unknown as Repository<Agent>,
      makeRepo() as unknown as Repository<HeaderTier>,
      { getByModel: jest.fn() } as unknown as ModelPricingCacheService,
      {
        invalidateAgent: jest.fn(),
        invalidateTenant: jest.fn(),
      } as unknown as RoutingCacheService,
    );
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  const resolve = (
    region: string | undefined,
    apiKey: string | undefined,
    existing: Partial<TenantProvider> | null = null,
  ): Promise<string | null> =>
    (
      svc as unknown as {
        resolveProviderRegion: (
          p: string,
          a: string,
          r: string | undefined,
          k: string | undefined,
          e: TenantProvider | null,
        ) => Promise<string | null>;
      }
    ).resolveProviderRegion('qwen', 'api_key', region, apiKey, existing as TenantProvider | null);

  it('detects the region from a supplied api key when no region is requested', async () => {
    detectQwenRegion.mockResolvedValue('singapore');
    expect(await resolve(undefined, 'sk-xxx')).toBe('singapore');
  });

  it('keeps an existing resolved region when neither region nor key is given', async () => {
    expect(await resolve(undefined, undefined, { region: 'us' })).toBe('us');
    expect(
      await resolve(undefined, undefined, {
        region: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
      }),
    ).toBe('https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode');
    expect(await resolve(undefined, undefined, null)).toBeNull();
  });

  it('rejects an invalid requested region', async () => {
    await expect(resolve('mars', undefined)).rejects.toThrow('Qwen region must be one of');
  });

  it('returns a concrete requested region unchanged', async () => {
    expect(await resolve('singapore', undefined)).toBe('singapore');
  });

  it('normalizes a valid Alibaba Model Studio base URL', async () => {
    await expect(
      resolve('https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1', undefined),
    ).resolves.toBe('https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode');
  });

  it('auto-detects using a decrypted stored key', async () => {
    detectQwenRegion.mockResolvedValue('beijing');
    const encrypted = encrypt('stored-key', getEncryptionSecret());
    expect(await resolve('auto', undefined, { api_key_encrypted: encrypted })).toBe('beijing');
  });

  it('auto-detect falls back to the existing region when the stored key cannot be decrypted', async () => {
    expect(await resolve('auto', undefined, { region: 'us', api_key_encrypted: 'garbage' })).toBe(
      'us',
    );
  });

  it('throws when auto-detection yields no region', async () => {
    detectQwenRegion.mockResolvedValue(null);
    await expect(resolve('auto', 'sk-xxx')).rejects.toThrow('Could not auto-detect');
  });
});
