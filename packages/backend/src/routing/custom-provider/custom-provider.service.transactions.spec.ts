// Transactional coupling between the custom_providers row and its companion
// tenant_providers row. create()/remove() must run both writes inside ONE
// repo.manager.transaction so a failure on either side rolls back the other —
// the DB-level FK (tenant_providers.custom_provider_id → custom_providers.id)
// covers the reverse direction. The real rollback/cascade semantics are
// asserted against Postgres in test/custom-provider-fk-migrations.e2e-spec.ts;
// these tests pin the service-level contract.
jest.mock('../../common/utils/url-validation', () => ({
  validatePublicUrl: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../common/utils/detect-self-hosted', () => ({
  isSelfHosted: jest.fn().mockReturnValue(false),
}));

import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CustomProviderService } from './custom-provider.service';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { ProviderService } from '../routing-core/provider.service';
import { RoutingCacheService } from '../routing-core/routing-cache.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { IngestEventBusService } from '../../common/services/ingest-event-bus.service';
import { ModelsDevSyncService } from '../../database/models-dev-sync.service';

function makeDeps(overrides: { findOneResult?: CustomProvider | null } = {}) {
  const insert = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);
  const txManager = { getRepository: jest.fn(() => repo) };
  // Records when the callback has settled, i.e. when the real tx would commit.
  const commit = jest.fn();
  const transaction = jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => {
    const result = await cb(txManager);
    commit();
    return result;
  });
  const repo = {
    findOne: jest.fn().mockResolvedValue(overrides.findOneResult ?? null),
    find: jest.fn().mockResolvedValue([]),
    insert,
    save: jest.fn().mockResolvedValue(undefined),
    remove,
    manager: { transaction },
  } as unknown as Repository<CustomProvider>;

  const upsertProvider = jest.fn().mockResolvedValue({ provider: {} });
  const removeProvider = jest.fn().mockResolvedValue(undefined);
  const reloadPricing = jest.fn().mockResolvedValue(undefined);
  const emit = jest.fn();
  const invalidateTenant = jest.fn();

  const svc = new CustomProviderService(
    repo,
    { upsertProvider, removeProvider } as unknown as ProviderService,
    {
      getCustomProviders: jest.fn().mockReturnValue(null),
      setCustomProviders: jest.fn(),
      invalidateTenant,
    } as unknown as RoutingCacheService,
    { reload: reloadPricing } as unknown as ModelPricingCacheService,
    { emit } as unknown as IngestEventBusService,
    undefined as unknown as ModelsDevSyncService,
  );

  return {
    svc,
    insert,
    remove,
    upsertProvider,
    removeProvider,
    reloadPricing,
    emit,
    txManager,
    transaction,
    commit,
    invalidateTenant,
  };
}

const dto = {
  name: 'my-openai',
  base_url: 'https://api.example.com/v1',
  apiKey: 'sk-x',
  models: [{ model_name: 'm1' }],
};

describe('CustomProviderService — transactional create/remove', () => {
  beforeEach(() => jest.clearAllMocks());

  it('create() inserts the custom_providers row before the companion upsert, inside the tx', async () => {
    const { svc, insert, upsertProvider, txManager } = makeDeps();
    await svc.create('tenant-1', dto);

    expect(txManager.getRepository).toHaveBeenCalledWith(CustomProvider);
    // FK ordering: the companion tenant_providers row references the
    // custom_providers id, so the cp insert must land first.
    expect(insert.mock.invocationCallOrder[0]).toBeLessThan(
      upsertProvider.mock.invocationCallOrder[0],
    );
  });

  it('create() invalidates the tenant routing cache again once the tx has committed', async () => {
    const { svc, commit, invalidateTenant } = makeDeps();
    await svc.create('tenant-1', dto);

    // Invalidations fired inside the transaction ran before commit; a read in
    // between could have re-cached the old provider list.
    expect(invalidateTenant).toHaveBeenCalledWith('tenant-1');
    expect(invalidateTenant.mock.invocationCallOrder[0]).toBeGreaterThan(
      commit.mock.invocationCallOrder[0],
    );
  });

  it('create() propagates a companion-upsert failure so the cp insert rolls back with it', async () => {
    const { svc, insert, upsertProvider, reloadPricing, emit, transaction, invalidateTenant } =
      makeDeps();
    upsertProvider.mockRejectedValue(new Error('encryption secret missing'));

    await expect(svc.create('tenant-1', dto)).rejects.toThrow('encryption secret missing');

    // The insert ran inside the failed transaction (Postgres discards it on
    // rollback) and none of the post-commit side effects fired.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(reloadPricing).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(invalidateTenant).not.toHaveBeenCalled();
  });

  it('remove() deletes the custom_providers row through the tx manager repository', async () => {
    const cp = { id: 'cp1' } as CustomProvider;
    const { svc, remove, removeProvider, txManager, transaction } = makeDeps({
      findOneResult: cp,
    });
    await svc.remove('tenant-1', 'cp1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txManager.getRepository).toHaveBeenCalledWith(CustomProvider);
    expect(remove).toHaveBeenCalledWith(cp);
    expect(removeProvider).toHaveBeenCalledWith(
      null,
      'tenant-1',
      'custom:cp1',
      undefined,
      undefined,
      txManager,
    );
  });

  it('remove() propagates a cp-row delete failure so the companion teardown rolls back with it', async () => {
    const cp = { id: 'cp1' } as CustomProvider;
    const { svc, remove, reloadPricing, emit } = makeDeps({ findOneResult: cp });
    remove.mockRejectedValue(new Error('db down'));

    await expect(svc.remove('tenant-1', 'cp1')).rejects.toThrow('db down');
    expect(reloadPricing).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('remove() swallows a NotFound companion teardown (partial-create) and still deletes the cp row', async () => {
    // Creation may have stranded a custom_providers row with no companion.
    // removeProvider throws NotFoundException; remove() must absorb it and
    // continue to delete the cp row so the orphaned config is cleaned up.
    const cp = { id: 'cp1' } as CustomProvider;
    const { svc, remove, removeProvider, reloadPricing, emit } = makeDeps({ findOneResult: cp });
    removeProvider.mockRejectedValue(new NotFoundException('Provider not found'));

    await expect(svc.remove('tenant-1', 'cp1')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(cp);
    expect(reloadPricing).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('remove() aborts the whole tx when removeProvider fails for a non-NotFound reason — cp row is NOT deleted', async () => {
    // "Provider is still routed" (a BadRequestException) must block deletion.
    // The error escapes the transaction, so the cp remove never runs and no
    // post-commit side effects fire.
    const cp = { id: 'cp1' } as CustomProvider;
    const { svc, remove, removeProvider, reloadPricing, emit } = makeDeps({ findOneResult: cp });
    removeProvider.mockRejectedValue(new Error('provider is still routed'));

    await expect(svc.remove('tenant-1', 'cp1')).rejects.toThrow('provider is still routed');
    expect(remove).not.toHaveBeenCalled();
    expect(reloadPricing).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
