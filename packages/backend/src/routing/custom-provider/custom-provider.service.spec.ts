jest.mock('../../common/utils/url-validation', () => ({
  validatePublicUrl: jest.fn(),
}));
jest.mock('../../common/utils/detect-self-hosted', () => ({
  isSelfHosted: jest.fn().mockReturnValue(false),
}));

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CustomProviderService } from './custom-provider.service';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { ProviderService } from '../routing-core/provider.service';
import { RoutingCacheService } from '../routing-core/routing-cache.service';
import { ModelPricingCacheService } from '../../model-prices/model-pricing-cache.service';
import { IngestEventBusService } from '../../common/services/ingest-event-bus.service';
import { ModelsDevSyncService } from '../../database/models-dev-sync.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validatePublicUrl } = require('../../common/utils/url-validation');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isSelfHosted } = require('../../common/utils/detect-self-hosted');

function makeDeps(overrides: {
  findOneResults?: (CustomProvider | null)[];
  findResult?: CustomProvider[];
  cached?: CustomProvider[] | null;
  modelsDevSync?: Pick<ModelsDevSyncService, 'lookupCustomProviderModel'> &
    Partial<Pick<ModelsDevSyncService, 'lookupModelAcrossProviders'>>;
}) {
  const findOne = jest.fn();
  const find = jest.fn().mockResolvedValue(overrides.findResult ?? []);
  const insert = jest.fn().mockResolvedValue(undefined);
  const save = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);

  const results = overrides.findOneResults ?? [];
  findOne.mockImplementation(() => Promise.resolve(results.shift() ?? null));

  // create()/remove() run their two-row dance inside repo.manager.transaction;
  // the fake manager resolves getRepository() back to the same mock repo so
  // existing insert/remove assertions keep observing the writes.
  const txManager = { getRepository: jest.fn(() => repo) };
  const transaction = jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(txManager));
  const repo = {
    findOne,
    find,
    insert,
    save,
    remove,
    manager: { transaction },
  } as unknown as Repository<CustomProvider>;

  const upsertProvider = jest.fn().mockResolvedValue({ provider: {} });
  const removeProvider = jest.fn().mockResolvedValue(undefined);
  const retagAuthType = jest.fn().mockResolvedValue(undefined);
  const recalculateTiersForTenant = jest.fn().mockResolvedValue(undefined);
  const getProviders = jest.fn().mockResolvedValue([]);
  const providerService = {
    upsertProvider,
    removeProvider,
    retagAuthType,
    recalculateTiersForTenant,
    getProviders,
  } as unknown as ProviderService;

  const getCustomProviders = jest.fn().mockReturnValue(overrides.cached ?? null);
  const setCustomProviders = jest.fn();
  const invalidateTenant = jest.fn();
  const routingCache = {
    getCustomProviders,
    setCustomProviders,
    invalidateTenant,
  } as unknown as RoutingCacheService;

  const reloadPricing = jest.fn().mockResolvedValue(undefined);
  const pricingCache = { reload: reloadPricing } as unknown as ModelPricingCacheService;

  const emit = jest.fn();
  const eventBus = { emit } as unknown as IngestEventBusService;

  const svc = new CustomProviderService(
    repo,
    providerService,
    routingCache,
    pricingCache,
    eventBus,
    overrides.modelsDevSync as ModelsDevSyncService | undefined,
  );

  return {
    emit,
    svc,
    findOne,
    find,
    insert,
    save,
    remove,
    upsertProvider,
    removeProvider,
    retagAuthType,
    recalculateTiersForTenant,
    getProviders,
    getCustomProviders,
    setCustomProviders,
    invalidateTenant,
    reloadPricing,
    txManager,
    transaction,
  };
}

describe('CustomProviderService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (validatePublicUrl as jest.Mock).mockReset();
    (validatePublicUrl as jest.Mock).mockResolvedValue(undefined);
    (isSelfHosted as jest.Mock).mockReset();
    (isSelfHosted as jest.Mock).mockReturnValue(false);
  });

  describe('static helpers', () => {
    it('composes and parses provider keys and model keys', () => {
      expect(CustomProviderService.providerKey('abc')).toBe('custom:abc');
      expect(CustomProviderService.modelKey('abc', 'model')).toBe('custom:abc/model');
      // rawModelName strips through the first "/" so the proxy sends just the upstream name.
      expect(CustomProviderService.rawModelName('custom:abc/model')).toBe('model');
      expect(CustomProviderService.rawModelName('plain-model')).toBe('plain-model');
    });

    it('detects custom provider keys and extracts their id', () => {
      expect(CustomProviderService.isCustom('custom:abc')).toBe(true);
      expect(CustomProviderService.isCustom('anthropic')).toBe(false);
      expect(CustomProviderService.extractId('custom:abc')).toBe('abc');
    });

    it('maps tile-connected canonical names to their registry id', () => {
      expect(CustomProviderService.canonicalTileIdForName('llama.cpp')).toBe('llamacpp');
      expect(CustomProviderService.canonicalTileIdForName('llama-cpp')).toBe('llamacpp');
      expect(CustomProviderService.canonicalTileIdForName('LM Studio')).toBe('lmstudio');
      expect(CustomProviderService.canonicalTileIdForName('Groq')).toBeNull();
      expect(CustomProviderService.canonicalTileIdForName('My Custom LLM')).toBeNull();
    });
  });

  describe('canonicalizeAgentMessageKeys', () => {
    it('rewrites provider + model when the custom provider is a tile-only canonical (llama.cpp)', async () => {
      const row = {
        id: 'cp-llamacpp',
        name: 'llama.cpp',
      } as CustomProvider;
      const { svc } = makeDeps({ cached: [row] });

      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        'custom:cp-llamacpp',
        'custom:cp-llamacpp/qwen2.5-0.5b-q4.gguf',
      );
      expect(out).toEqual({ provider: 'llamacpp', model: 'llamacpp/qwen2.5-0.5b-q4.gguf' });
    });

    it('passes through user-defined custom providers that do not match a tile-only canonical', async () => {
      const row = {
        id: 'cp-mine',
        name: 'My Groq',
      } as CustomProvider;
      const { svc } = makeDeps({ cached: [row] });

      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        'custom:cp-mine',
        'custom:cp-mine/llama-3.1-70b',
      );
      expect(out).toEqual({ provider: 'custom:cp-mine', model: 'custom:cp-mine/llama-3.1-70b' });
    });

    it('passes through cloud providers (no custom: prefix)', async () => {
      const { svc } = makeDeps({ cached: [] });
      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        'anthropic',
        'anthropic/claude-opus-4-6',
      );
      expect(out).toEqual({ provider: 'anthropic', model: 'anthropic/claude-opus-4-6' });
    });

    it('rewrites a custom-prefixed model string even when provider is null (fallback_from_model)', async () => {
      const row = {
        id: 'cp-llamacpp',
        name: 'llama.cpp',
      } as CustomProvider;
      const { svc } = makeDeps({ cached: [row] });
      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        null,
        'custom:cp-llamacpp/qwen2.5-0.5b-q4.gguf',
      );
      expect(out).toEqual({ provider: null, model: 'llamacpp/qwen2.5-0.5b-q4.gguf' });
    });

    it('returns nulls when both provider and model are empty', async () => {
      const { svc } = makeDeps({ cached: [] });
      const out = await svc.canonicalizeAgentMessageKeys('tenant-1', null, null);
      expect(out).toEqual({ provider: null, model: null });
    });

    it('returns provider unchanged when the referenced custom provider no longer exists', async () => {
      const { svc } = makeDeps({ cached: [] });
      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        'custom:deleted',
        'custom:deleted/foo',
      );
      expect(out).toEqual({ provider: 'custom:deleted', model: 'custom:deleted/foo' });
    });

    it('returns the model unchanged when the fallback_from_model path references a deleted custom provider', async () => {
      // fallback_from_model can carry a `custom:<uuid>/model` suffix after the
      // backing provider row was removed — the canonicalizer must pass it
      // through rather than silently dropping the reference.
      const { svc } = makeDeps({ cached: [] });
      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        null,
        'custom:missing-uuid/my-model',
      );
      expect(out).toEqual({ provider: null, model: 'custom:missing-uuid/my-model' });
    });

    it('rewrites only the provider when the model does not share the same custom prefix', async () => {
      // On cross-provider fallback, `model` can reference a *different*
      // upstream (e.g. the fallback landed on anthropic) while `provider`
      // is still the custom tile — the provider column must canonicalize
      // but the model must pass through untouched.
      const row = {
        id: 'cp-llamacpp',
        name: 'llama.cpp',
      } as CustomProvider;
      const { svc } = makeDeps({ cached: [row] });
      const out = await svc.canonicalizeAgentMessageKeys(
        'tenant-1',
        'custom:cp-llamacpp',
        'anthropic/claude-opus-4-6',
      );
      expect(out).toEqual({ provider: 'llamacpp', model: 'anthropic/claude-opus-4-6' });
    });

    it('returns null model unchanged when the referenced provider row is missing', async () => {
      // Combines the "row not found" branch with a null model — the
      // canonicalizer must not invent a model string when none was supplied.
      const { svc } = makeDeps({ cached: [] });
      const out = await svc.canonicalizeAgentMessageKeys('tenant-1', 'custom:deleted', null);
      expect(out).toEqual({ provider: 'custom:deleted', model: null });
    });

    it('returns null model unchanged for a user-defined (non-tileOnly) custom provider', async () => {
      // User-defined providers don't get canonicalized, and a missing model
      // must stay missing — no accidental "my-groq/null" strings in the DB.
      const row = {
        id: 'cp-mine',
        name: 'My Groq',
      } as CustomProvider;
      const { svc } = makeDeps({ cached: [row] });
      const out = await svc.canonicalizeAgentMessageKeys('tenant-1', 'custom:cp-mine', null);
      expect(out).toEqual({ provider: 'custom:cp-mine', model: null });
    });

    it('rewrites provider and leaves model null when model is unset for a tile-only custom provider', async () => {
      // Some error paths record a provider without a model (e.g. pre-resolve
      // failures). The provider still canonicalizes, and the model column
      // must remain null rather than accidentally adopting a canonical prefix.
      const row = {
        id: 'cp-llamacpp',
        name: 'llama.cpp',
      } as CustomProvider;
      const { svc } = makeDeps({ cached: [row] });
      const out = await svc.canonicalizeAgentMessageKeys('tenant-1', 'custom:cp-llamacpp', null);
      expect(out).toEqual({ provider: 'llamacpp', model: null });
    });
  });

  describe('list', () => {
    it('returns the cached result when present', async () => {
      const cached = [{ id: 'cp1' } as CustomProvider];
      const { svc, find, setCustomProviders } = makeDeps({ cached });
      const result = await svc.list('tenant-1');
      expect(result).toBe(cached);
      expect(find).not.toHaveBeenCalled();
      expect(setCustomProviders).not.toHaveBeenCalled();
    });

    it('falls back to the DB and populates the cache on a miss', async () => {
      const rows = [{ id: 'cp1' } as CustomProvider];
      const { svc, find, setCustomProviders } = makeDeps({
        cached: null,
        findResult: rows,
      });
      const result = await svc.list('tenant-1');
      expect(result).toBe(rows);
      expect(find).toHaveBeenCalledWith({ where: { tenant_id: 'tenant-1' } });
      expect(setCustomProviders).toHaveBeenCalledWith('tenant-1', rows);
    });
  });

  describe('create', () => {
    const dto = {
      name: 'my-openai',
      base_url: 'https://openai.example.com',
      apiKey: 'sk-x',
      models: [
        {
          model_name: 'gpt-custom',
          input_price_per_million_tokens: 1,
          output_price_per_million_tokens: 2,
          // context_window omitted → default 128_000
        },
      ],
    };

    it('throws Conflict when an agent already has a provider with the same name', async () => {
      const { svc } = makeDeps({
        findResult: [{ id: 'existing', name: dto.name } as CustomProvider],
      });
      await expect(svc.create('tenant-1', dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws Conflict when a case-variant of the same name already exists (e.g. "my-openai" vs "MY-OPENAI")', async () => {
      const { svc } = makeDeps({
        findResult: [{ id: 'existing', name: 'MY-OPENAI' } as CustomProvider],
      });
      // dto.name is 'my-openai' — differs only in case, must still conflict.
      await expect(svc.create('tenant-1', dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws BadRequest when the base URL fails validation', async () => {
      (validatePublicUrl as jest.Mock).mockRejectedValue(new Error('not public'));
      const { svc } = makeDeps({ findOneResults: [null] });
      await expect(svc.create('tenant-1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inserts the row, upserts a TenantProvider, and defaults context_window to 128k', async () => {
      const { svc, insert, upsertProvider, reloadPricing, emit, txManager, transaction } = makeDeps(
        {
          findOneResults: [null],
        },
      );
      const cp = await svc.create('tenant-1', dto);

      // Custom providers are tenant-global: notify open clients to refresh.
      expect(emit).toHaveBeenCalledWith('tenant-1', 'routing', undefined);

      // Both rows are written inside one transaction so a failed companion
      // insert can't strand a custom_providers row.
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(cp.tenant_id).toBe('tenant-1');
      expect(cp.name).toBe('my-openai');
      expect(cp.models[0].context_window).toBe(128_000);
      expect(upsertProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        `custom:${cp.id}`,
        'sk-x',
        'api_key',
        undefined,
        undefined,
        undefined,
        txManager,
      );
      expect(validatePublicUrl).toHaveBeenCalledWith(dto.base_url, { allowPrivate: false });
      // Price lookup cache must be refreshed so the proxy can compute cost
      // for messages routed to this provider's models immediately.
      expect(reloadPricing).toHaveBeenCalledTimes(1);
    });

    describe('alias', () => {
      it('derives a default alias from the name when none is sent', async () => {
        const { svc } = makeDeps({ findOneResults: [null] });
        const cp = await svc.create('tenant-1', { ...dto, name: 'Vercel AI Gateway' });
        expect(cp.alias).toBe('vercel-ai-gateway');
      });

      it('leaves the default alias empty when the name yields a reserved one', async () => {
        const { svc } = makeDeps({ findOneResults: [null] });
        const cp = await svc.create('tenant-1', { ...dto, name: 'OpenAI' });
        expect(cp.alias).toBeNull();
      });

      it('leaves the default alias empty when another provider already took it', async () => {
        const { svc } = makeDeps({
          findResult: [{ id: 'other', name: 'Other', alias: 'My-Provider' } as CustomProvider],
        });
        const cp = await svc.create('tenant-1', { ...dto, name: 'My Provider' });
        expect(cp.alias).toBeNull();
      });

      it('stores an explicit alias, normalised', async () => {
        const { svc } = makeDeps({ findOneResults: [null] });
        const cp = await svc.create('tenant-1', { ...dto, alias: ' Vercel ' });
        expect(cp.alias).toBe('vercel');
      });

      it('honours an explicit null as "no alias" instead of deriving one', async () => {
        const { svc } = makeDeps({ findOneResults: [null] });
        const cp = await svc.create('tenant-1', { ...dto, alias: null });
        expect(cp.alias).toBeNull();
      });

      it('rejects an explicit alias that shadows a built-in provider', async () => {
        const { svc } = makeDeps({ findOneResults: [null] });
        await expect(svc.create('tenant-1', { ...dto, alias: 'openai' })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('rejects an explicit alias another provider of the tenant already uses', async () => {
        const { svc } = makeDeps({
          findResult: [{ id: 'other', name: 'Other', alias: 'Vercel' } as CustomProvider],
        });
        await expect(svc.create('tenant-1', { ...dto, alias: 'vercel' })).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      it('turns a lost race on the alias unique index into a 409', async () => {
        const { svc, insert } = makeDeps({ findOneResults: [null] });
        insert.mockRejectedValueOnce(
          Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'IDX_custom_providers_tenant_alias',
          }),
        );
        await expect(svc.create('tenant-1', { ...dto, alias: 'vercel' })).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      it('rethrows other insert failures untouched', async () => {
        const { svc, insert } = makeDeps({ findOneResults: [null] });
        const boom = Object.assign(new Error('other index'), {
          code: '23505',
          constraint: 'some_other_index',
        });
        insert.mockRejectedValueOnce(boom);
        await expect(svc.create('tenant-1', dto)).rejects.toBe(boom);
      });
    });

    it('tags the companion tenant_providers row as local when the name is LM Studio', async () => {
      const { svc, upsertProvider, txManager } = makeDeps({ findOneResults: [null] });
      await svc.create('tenant-1', { ...dto, name: 'LM Studio' });
      expect(upsertProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        expect.stringMatching(/^custom:/),
        'sk-x',
        'local',
        undefined,
        undefined,
        undefined,
        txManager,
      );
    });

    it('normalizes the name for detection (lm-studio / LMSTUDIO both resolve to local)', async () => {
      const { svc, upsertProvider, txManager } = makeDeps({ findOneResults: [null] });
      await svc.create('tenant-1', { ...dto, name: 'lm-studio' });
      expect(upsertProvider).toHaveBeenLastCalledWith(
        null,
        'tenant-1',
        expect.stringMatching(/^custom:/),
        'sk-x',
        'local',
        undefined,
        undefined,
        undefined,
        txManager,
      );
    });

    it('keeps api_key tagging for freeform custom provider names', async () => {
      const { svc, upsertProvider, txManager } = makeDeps({ findOneResults: [null] });
      await svc.create('tenant-1', { ...dto, name: 'My Home Server' });
      expect(upsertProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        expect.stringMatching(/^custom:/),
        'sk-x',
        'api_key',
        undefined,
        undefined,
        undefined,
        txManager,
      );
    });

    it('passes allowPrivate=true in the self-hosted version so private URLs are accepted', async () => {
      (isSelfHosted as jest.Mock).mockReturnValue(true);
      const selfHostedDto = { ...dto, base_url: 'http://host.docker.internal:11434/v1' };
      const { svc } = makeDeps({ findOneResults: [null] });
      await svc.create('tenant-1', selfHostedDto);
      expect(validatePublicUrl).toHaveBeenCalledWith(selfHostedDto.base_url, {
        allowPrivate: true,
      });
    });

    it('defaults api_kind to "openai" when the DTO omits it', async () => {
      const { svc } = makeDeps({ findOneResults: [null] });
      const cp = await svc.create('tenant-1', dto);
      expect(cp.api_kind).toBe('openai');
    });

    it('persists api_kind="anthropic" when requested', async () => {
      const { svc } = makeDeps({ findOneResults: [null] });
      const cp = await svc.create('tenant-1', {
        ...dto,
        api_kind: 'anthropic',
      });
      expect(cp.api_kind).toBe('anthropic');
    });

    it('fills missing prices and context from models.dev when provider and model match', async () => {
      const modelsDevSync = {
        lookupCustomProviderModel: jest.fn().mockReturnValue({
          inputPricePerToken: 0.15 / 1_000_000,
          outputPricePerToken: 0.6 / 1_000_000,
          contextWindow: 128000,
        }),
      };
      const { svc } = makeDeps({ findOneResults: [null], modelsDevSync });

      const cp = await svc.create('tenant-1', {
        ...dto,
        name: 'Kilo Gateway',
        models: [{ model_name: 'openai/gpt-4o-mini' }],
      });

      expect(modelsDevSync.lookupCustomProviderModel).toHaveBeenCalledWith(
        'Kilo Gateway',
        'openai/gpt-4o-mini',
      );
      expect(cp.models[0]).toEqual({
        model_name: 'openai/gpt-4o-mini',
        input_price_per_million_tokens: 0.15,
        output_price_per_million_tokens: 0.6,
        context_window: 128000,
      });
    });

    it('marks model-only price fallbacks as estimated when provider is not on models.dev', async () => {
      const modelsDevSync = {
        lookupCustomProviderModel: jest.fn().mockReturnValue(null),
        lookupModelAcrossProviders: jest.fn().mockReturnValue({
          inputPricePerToken: 0.15 / 1_000_000,
          outputPricePerToken: 0.6 / 1_000_000,
          contextWindow: 128000,
        }),
      };
      const { svc } = makeDeps({ findOneResults: [null], modelsDevSync });

      const cp = await svc.create('tenant-1', {
        ...dto,
        name: 'Mammouth AI',
        models: [{ model_name: 'openai/gpt-4o-mini' }],
      });

      expect(modelsDevSync.lookupCustomProviderModel).toHaveBeenCalledWith(
        'Mammouth AI',
        'openai/gpt-4o-mini',
      );
      expect(modelsDevSync.lookupModelAcrossProviders).toHaveBeenCalledWith('openai/gpt-4o-mini');
      expect(cp.models[0]).toEqual({
        model_name: 'openai/gpt-4o-mini',
        input_price_per_million_tokens: 0.15,
        output_price_per_million_tokens: 0.6,
        context_window: 128000,
        price_estimated: true,
      });
    });

    it('preserves user-entered prices over models.dev matches', async () => {
      const modelsDevSync = {
        lookupCustomProviderModel: jest.fn().mockReturnValue({
          inputPricePerToken: 0.15 / 1_000_000,
          outputPricePerToken: 0.6 / 1_000_000,
          contextWindow: 128000,
        }),
      };
      const { svc } = makeDeps({ findOneResults: [null], modelsDevSync });

      const cp = await svc.create('tenant-1', {
        ...dto,
        name: 'Kilo Gateway',
        models: [
          {
            model_name: 'openai/gpt-4o-mini',
            input_price_per_million_tokens: 9,
            output_price_per_million_tokens: 10,
            context_window: 64000,
          },
        ],
      });

      expect(cp.models[0]).toMatchObject({
        input_price_per_million_tokens: 9,
        output_price_per_million_tokens: 10,
        context_window: 64000,
      });
    });
  });

  describe('update', () => {
    it('throws NotFound when the provider does not exist for the agent', async () => {
      const { svc } = makeDeps({ findOneResults: [null] });
      await expect(svc.update('missing', 'tenant-1', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws Conflict when renaming collides with an existing provider', async () => {
      const existing = { id: 'cp1', name: 'old' } as CustomProvider;
      const { svc } = makeDeps({
        findOneResults: [existing],
        findResult: [
          { id: 'cp1', name: 'old' } as CustomProvider,
          { id: 'other', name: 'new' } as CustomProvider,
        ],
      });
      await expect(svc.update('cp1', 'tenant-1', { name: 'new' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws Conflict when renaming to a case-variant of an existing provider name', async () => {
      const existing = { id: 'cp1', name: 'old' } as CustomProvider;
      const { svc } = makeDeps({
        findOneResults: [existing],
        // 'OTHER' is a different provider (id: 'other2') whose lowercase name is 'new'
        findResult: [
          { id: 'cp1', name: 'old' } as CustomProvider,
          { id: 'other2', name: 'NEW' } as CustomProvider,
        ],
      });
      // Renaming cp1 to 'new' must conflict with existing 'NEW' (case-insensitive)
      await expect(svc.update('cp1', 'tenant-1', { name: 'new' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('renames and persists when no collision', async () => {
      const existing = { id: 'cp1', name: 'old' } as CustomProvider;
      const { svc, save, invalidateTenant, reloadPricing, emit } = makeDeps({
        findOneResults: [existing, null],
      });
      await svc.update('cp1', 'tenant-1', { name: 'new' });
      expect(existing.name).toBe('new');
      expect(save).toHaveBeenCalledWith(existing);
      expect(invalidateTenant).toHaveBeenCalledWith('tenant-1');
      expect(emit).toHaveBeenCalledWith('tenant-1', 'routing', undefined);
      // A rename-only update cannot affect prices, so the shared pricing
      // cache should be left alone (reload is expensive for large installs).
      expect(reloadPricing).not.toHaveBeenCalled();
    });

    describe('alias', () => {
      it('leaves the alias alone on a rename so client configs survive', async () => {
        const existing = { id: 'cp1', name: 'old', alias: 'old' } as CustomProvider;
        const { svc, find } = makeDeps({ findOneResults: [existing] });
        await svc.update('cp1', 'tenant-1', { name: 'new' });
        expect(existing.alias).toBe('old');
        // The rename fetched the tenant list once; no second lookup for an alias.
        expect(find).toHaveBeenCalledTimes(1);
      });

      it('sets a new alias after checking the tenant for collisions', async () => {
        const existing = { id: 'cp1', name: 'old', alias: null } as CustomProvider;
        const { svc, save, find } = makeDeps({
          findOneResults: [existing],
          findResult: [existing, { id: 'other', name: 'Other', alias: 'taken' } as CustomProvider],
        });
        await svc.update('cp1', 'tenant-1', { alias: 'Fresh' });
        expect(existing.alias).toBe('fresh');
        expect(save).toHaveBeenCalledWith(existing);
        expect(find).toHaveBeenCalledTimes(1);
      });

      it('clears the alias on null or an empty string', async () => {
        const existing = { id: 'cp1', name: 'old', alias: 'old' } as CustomProvider;
        const { svc, find } = makeDeps({ findOneResults: [existing, existing] });
        await svc.update('cp1', 'tenant-1', { alias: '' });
        expect(existing.alias).toBeNull();
        existing.alias = 'old';
        await svc.update('cp1', 'tenant-1', { alias: null });
        expect(existing.alias).toBeNull();
        expect(find).not.toHaveBeenCalled();
      });

      it('skips the collision lookup when the alias is unchanged', async () => {
        const existing = { id: 'cp1', name: 'old', alias: 'same' } as CustomProvider;
        const { svc, find } = makeDeps({ findOneResults: [existing] });
        await svc.update('cp1', 'tenant-1', { alias: 'SAME' });
        expect(existing.alias).toBe('same');
        expect(find).not.toHaveBeenCalled();
      });

      it('rejects an alias that shadows a built-in provider', async () => {
        const existing = { id: 'cp1', name: 'old', alias: null } as CustomProvider;
        const { svc } = makeDeps({ findOneResults: [existing] });
        await expect(svc.update('cp1', 'tenant-1', { alias: 'gemini' })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('turns a lost race on the alias unique index into a 409', async () => {
        const existing = { id: 'cp1', name: 'old', alias: null } as CustomProvider;
        const { svc, save } = makeDeps({ findOneResults: [existing] });
        save.mockRejectedValueOnce(
          Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'IDX_custom_providers_tenant_alias',
          }),
        );
        await expect(svc.update('cp1', 'tenant-1', { alias: 'fresh' })).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      it('rethrows other save failures untouched', async () => {
        const existing = { id: 'cp1', name: 'old', alias: null } as CustomProvider;
        const { svc, save } = makeDeps({ findOneResults: [existing] });
        const boom = new Error('connection reset');
        save.mockRejectedValueOnce(boom);
        await expect(svc.update('cp1', 'tenant-1', { alias: 'fresh' })).rejects.toBe(boom);
      });

      it('rejects an alias another provider of the tenant already uses, case-insensitively', async () => {
        const existing = { id: 'cp1', name: 'old', alias: null } as CustomProvider;
        const { svc } = makeDeps({
          findOneResults: [existing],
          findResult: [existing, { id: 'other', name: 'Other', alias: 'Taken' } as CustomProvider],
        });
        await expect(svc.update('cp1', 'tenant-1', { alias: 'taken' })).rejects.toBeInstanceOf(
          ConflictException,
        );
      });
    });

    it('validates and updates base_url when provided', async () => {
      const existing = {
        id: 'cp1',
        name: 'n',
        base_url: 'a',
      } as CustomProvider;
      const { svc } = makeDeps({ findOneResults: [existing] });
      await svc.update('cp1', 'tenant-1', { base_url: 'https://b.example' });
      expect(validatePublicUrl).toHaveBeenCalledWith('https://b.example', { allowPrivate: false });
      expect(existing.base_url).toBe('https://b.example');
    });

    it('passes allowPrivate=true to validatePublicUrl in the self-hosted version', async () => {
      (isSelfHosted as jest.Mock).mockReturnValue(true);
      const existing = { id: 'cp1', name: 'n' } as CustomProvider;
      const { svc } = makeDeps({ findOneResults: [existing] });
      await svc.update('cp1', 'tenant-1', {
        base_url: 'http://host.docker.internal:8000/v1',
      });
      expect(validatePublicUrl).toHaveBeenCalledWith('http://host.docker.internal:8000/v1', {
        allowPrivate: true,
      });
    });

    it('throws BadRequest when the new base_url fails validation', async () => {
      const existing = { id: 'cp1', name: 'n' } as CustomProvider;
      const { svc } = makeDeps({ findOneResults: [existing] });
      (validatePublicUrl as jest.Mock).mockRejectedValue(new Error('bad url'));
      await expect(
        svc.update('cp1', 'tenant-1', { base_url: 'http://bad' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rewrites models without recalculating routes when the api key is not touched', async () => {
      const existing = { id: 'cp1', name: 'n' } as CustomProvider;
      const { svc, recalculateTiersForTenant, upsertProvider, reloadPricing } = makeDeps({
        findOneResults: [existing],
      });
      await svc.update('cp1', 'tenant-1', {
        models: [
          {
            model_name: 'm1',
            input_price_per_million_tokens: 1,
            output_price_per_million_tokens: 1,
          },
        ],
      });
      expect(existing.models[0].context_window).toBe(128_000);
      expect(recalculateTiersForTenant).not.toHaveBeenCalled();
      expect(upsertProvider).not.toHaveBeenCalled();
      // Edited prices must flow into the shared pricing cache so the next
      // proxied message picks up the new per-token cost.
      expect(reloadPricing).toHaveBeenCalledTimes(1);
    });

    it('persists the custom provider row before reloading pricing in update()', async () => {
      // Regression guard: pricing reload must see the NEW model list, not the
      // stale one. The only way to guarantee that is for repo.save to be called
      // before reloadPricing.
      const existing = { id: 'cp1', name: 'n' } as CustomProvider;
      const callOrder: string[] = [];
      const { svc, save, reloadPricing } = makeDeps({ findOneResults: [existing] });
      save.mockImplementation(() => {
        callOrder.push('save');
        return Promise.resolve(undefined);
      });
      reloadPricing.mockImplementation(() => {
        callOrder.push('reload');
        return Promise.resolve(undefined);
      });

      await svc.update('cp1', 'tenant-1', {
        models: [
          {
            model_name: 'm1',
            input_price_per_million_tokens: 1,
            output_price_per_million_tokens: 1,
          },
        ],
      });

      expect(callOrder.indexOf('save')).toBeLessThan(callOrder.indexOf('reload'));
    });

    it('fills missing model update prices from models.dev using the current provider name', async () => {
      const existing = { id: 'cp1', name: 'Kilo Gateway' } as CustomProvider;
      const modelsDevSync = {
        lookupCustomProviderModel: jest.fn().mockReturnValue({
          inputPricePerToken: 0.15 / 1_000_000,
          outputPricePerToken: 0.6 / 1_000_000,
          contextWindow: 128000,
        }),
      };
      const { svc } = makeDeps({ findOneResults: [existing], modelsDevSync });

      await svc.update('cp1', 'tenant-1', {
        models: [{ model_name: 'openai/gpt-4o-mini' }],
      });

      expect(existing.models[0]).toEqual({
        model_name: 'openai/gpt-4o-mini',
        input_price_per_million_tokens: 0.15,
        output_price_per_million_tokens: 0.6,
        context_window: 128000,
      });
    });

    it('updates api_kind when provided', async () => {
      const existing = {
        id: 'cp1',
        name: 'n',
        api_kind: 'openai',
      } as CustomProvider;
      const { svc } = makeDeps({ findOneResults: [existing] });
      await svc.update('cp1', 'tenant-1', { api_kind: 'anthropic' });
      expect(existing.api_kind).toBe('anthropic');
    });

    it('retags auth_type via ProviderService.retagAuthType when a rename crosses the local ↔ api_key boundary', async () => {
      const existing = { id: 'cp1', name: 'LM Studio' } as CustomProvider;
      const { svc, retagAuthType, upsertProvider, recalculateTiersForTenant } = makeDeps({
        findOneResults: [existing, null],
      });
      await svc.update('cp1', 'tenant-1', { name: 'My Home Server' });
      expect(retagAuthType).toHaveBeenCalledWith(null, 'tenant-1', 'custom:cp1', 'api_key');
      // No apiKey in the DTO, so upsertProvider must not fire.
      expect(upsertProvider).not.toHaveBeenCalled();
      // retagAuthType owns the cache invalidation; rename should not double-recalculate tiers.
      expect(recalculateTiersForTenant).not.toHaveBeenCalled();
    });

    it('retags local → api_key when renaming away from a canonical local name (LM Studio → Home Server)', async () => {
      const existing = { id: 'cp1', name: 'LM Studio' } as CustomProvider;
      const { svc, retagAuthType } = makeDeps({ findOneResults: [existing, null] });
      await svc.update('cp1', 'tenant-1', { name: 'Home Server' });
      expect(retagAuthType).toHaveBeenLastCalledWith(null, 'tenant-1', 'custom:cp1', 'api_key');
    });

    it('retags api_key → local when renaming into a canonical local name', async () => {
      const existing = { id: 'cp1', name: 'Home Server' } as CustomProvider;
      const { svc, retagAuthType } = makeDeps({ findOneResults: [existing, null] });
      await svc.update('cp1', 'tenant-1', { name: 'LM Studio' });
      expect(retagAuthType).toHaveBeenLastCalledWith(null, 'tenant-1', 'custom:cp1', 'local');
    });

    it('does not retag when a rename stays within the same category', async () => {
      const existing = { id: 'cp1', name: 'Foo' } as CustomProvider;
      const { svc, retagAuthType } = makeDeps({ findOneResults: [existing, null] });
      await svc.update('cp1', 'tenant-1', { name: 'Bar' });
      expect(retagAuthType).not.toHaveBeenCalled();
    });

    it('delegates tier recalculation to provider upsert when the api key is also updated', async () => {
      const existing = { id: 'cp1', name: 'n' } as CustomProvider;
      const { svc, recalculateTiersForTenant, upsertProvider, reloadPricing } = makeDeps({
        findOneResults: [existing],
      });
      await svc.update('cp1', 'tenant-1', {
        apiKey: 'sk-new',
        models: [
          {
            model_name: 'm1',
            input_price_per_million_tokens: 1,
            output_price_per_million_tokens: 1,
            context_window: 64_000,
          },
        ],
      });
      expect(upsertProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        'custom:cp1',
        'sk-new',
        'api_key',
        undefined,
        undefined,
        undefined,
      );
      // When api key is updated, the upsert triggers its own recalc — service should not double-call.
      expect(recalculateTiersForTenant).not.toHaveBeenCalled();
      expect(existing.models[0].context_window).toBe(64_000);
      // Prices still changed → pricing cache must still be refreshed.
      expect(reloadPricing).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove', () => {
    it('throws NotFound when the provider is missing', async () => {
      const { svc } = makeDeps({ findOneResults: [null] });
      await expect(svc.remove('tenant-1', 'cp1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes the row and attempts provider removal', async () => {
      const cp = { id: 'cp1' } as CustomProvider;
      const { svc, removeProvider, remove, reloadPricing, emit, invalidateTenant, txManager } =
        makeDeps({
          findOneResults: [cp],
        });
      await svc.remove('tenant-1', 'cp1');
      // Both deletions run inside one transaction; the provider teardown
      // receives the tx manager so its writes commit or roll back together.
      expect(removeProvider).toHaveBeenCalledWith(
        null,
        'tenant-1',
        'custom:cp1',
        undefined,
        undefined,
        txManager,
      );
      expect(remove).toHaveBeenCalledWith(cp);
      // The user-scoped custom-provider cache must be dropped so a later list()
      // doesn't serve the deleted provider from a warm cache.
      expect(invalidateTenant).toHaveBeenCalledWith('tenant-1');
      expect(emit).toHaveBeenCalledWith('tenant-1', 'routing', undefined);
      // Stale pricing entries for this provider must be dropped from the
      // cache so getAll() stops returning them.
      expect(reloadPricing).toHaveBeenCalledTimes(1);
    });

    it('swallows NotFound from provider removal when it is already unlinked', async () => {
      const cp = { id: 'cp1' } as CustomProvider;
      const { svc, removeProvider, remove } = makeDeps({ findOneResults: [cp] });
      removeProvider.mockRejectedValue(new NotFoundException('not linked'));
      await expect(svc.remove('tenant-1', 'cp1')).resolves.toBeUndefined();
      expect(remove).toHaveBeenCalledWith(cp);
    });

    it('rethrows provider removal conflicts so routed providers stay protected', async () => {
      const cp = { id: 'cp1' } as CustomProvider;
      const { svc, removeProvider, remove } = makeDeps({ findOneResults: [cp] });
      removeProvider.mockRejectedValue(new Error('provider is routed'));
      await expect(svc.remove('tenant-1', 'cp1')).rejects.toThrow('provider is routed');
      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('returns the provider scoped to the tenant', async () => {
      const cp = { id: 'cp1' } as CustomProvider;
      const { svc, findOne } = makeDeps({ findOneResults: [cp] });
      await expect(svc.getById('cp1', 'tenant-1')).resolves.toBe(cp);
      // Tenant-scoped lookup mirrors list/update/remove — the where-clause must
      // include tenant_id so one tenant cannot read another's custom provider.
      expect(findOne).toHaveBeenCalledWith({ where: { id: 'cp1', tenant_id: 'tenant-1' } });
    });

    it('returns null when the id belongs to a different tenant', async () => {
      // findOneResults is empty → the mock resolves null, modelling a row that
      // exists under another tenant_id and is therefore filtered out.
      const { svc, findOne } = makeDeps({ findOneResults: [] });
      await expect(svc.getById('cp1', 'tenant-other')).resolves.toBeNull();
      expect(findOne).toHaveBeenCalledWith({ where: { id: 'cp1', tenant_id: 'tenant-other' } });
    });
  });

  describe('probeModels', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    const jsonResponse = (payload: unknown) =>
      ({
        ok: true,
        headers: {
          get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        json: async () => payload,
      }) as unknown as Response;

    it('returns the parsed model list on success', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }),
        ) as unknown as typeof fetch;

      const result = await svc.probeModels('http://host.docker.internal:8000/v1', 'sk-x');
      expect(result).toEqual([{ model_name: 'm1' }, { model_name: 'm2' }]);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
        'http://host.docker.internal:8000/v1/models',
      );
      const init = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(init.headers.Authorization).toBe('Bearer sk-x');
      // Defense in depth: redirects must be rejected outright — otherwise
      // a hostile endpoint could 3xx the probe to a cloud-metadata URL
      // that would bypass the pre-fetch validator.
      expect(init.redirect).toBe('error');
    });

    it('enriches probed models with models.dev pricing when provider name matches', async () => {
      const modelsDevSync = {
        lookupCustomProviderModel: jest.fn().mockReturnValue({
          inputPricePerToken: 0.15 / 1_000_000,
          outputPricePerToken: 0.6 / 1_000_000,
          contextWindow: 128000,
        }),
      };
      const { svc } = makeDeps({ modelsDevSync });
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: 'openai/gpt-4o-mini' }],
        }),
      ) as unknown as typeof fetch;

      const result = await svc.probeModels(
        'http://host.docker.internal:8000/v1',
        'sk-x',
        'openai',
        'Kilo Gateway',
      );

      expect(result).toEqual([
        {
          model_name: 'openai/gpt-4o-mini',
          input_price_per_million_tokens: 0.15,
          output_price_per_million_tokens: 0.6,
          context_window: 128000,
        },
      ]);
    });

    it('marks probed model-only price fallbacks as estimated', async () => {
      const modelsDevSync = {
        lookupCustomProviderModel: jest.fn().mockReturnValue(null),
        lookupModelAcrossProviders: jest.fn().mockReturnValue({
          inputPricePerToken: 0.15 / 1_000_000,
          outputPricePerToken: 0.6 / 1_000_000,
          contextWindow: 128000,
        }),
      };
      const { svc } = makeDeps({ modelsDevSync });
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: 'openai/gpt-4o-mini' }],
        }),
      ) as unknown as typeof fetch;

      const result = await svc.probeModels(
        'http://host.docker.internal:8000/v1',
        'sk-x',
        'openai',
        'Mammouth AI',
      );

      expect(result).toEqual([
        {
          model_name: 'openai/gpt-4o-mini',
          input_price_per_million_tokens: 0.15,
          output_price_per_million_tokens: 0.6,
          context_window: 128000,
          price_estimated: true,
        },
      ]);
    });

    it('strips trailing slashes from the base URL before appending /models', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockResolvedValue(jsonResponse({ data: [{ id: 'm1' }] })) as unknown as typeof fetch;

      await svc.probeModels('http://host.docker.internal:8000/v1///');
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
        'http://host.docker.internal:8000/v1/models',
      );
    });

    it('omits Authorization header when no apiKey is given', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockResolvedValue(jsonResponse({ data: [{ id: 'm1' }] })) as unknown as typeof fetch;

      await svc.probeModels('http://host.docker.internal:8000/v1');
      const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });

    it('hits /v1/models with Anthropic headers when apiKind is "anthropic"', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }),
        ) as unknown as typeof fetch;

      const result = await svc.probeModels('https://api.anthropic.com', 'sk-ant-x', 'anthropic');
      expect(result).toEqual([
        { model_name: 'claude-sonnet-4-5' },
        { model_name: 'claude-haiku-4-5' },
      ]);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
        'https://api.anthropic.com/v1/models',
      );
      const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBe('sk-ant-x');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      // Bearer is OpenAI's scheme — must not leak into an Anthropic probe.
      expect(headers.Authorization).toBeUndefined();
    });

    it('omits x-api-key when probing Anthropic without a key (still sends version header)', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockResolvedValue(jsonResponse({ data: [] })) as unknown as typeof fetch;
      await svc.probeModels('https://api.anthropic.com', undefined, 'anthropic');
      const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('returns an empty array when the server returns no models', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof fetch;

      const result = await svc.probeModels('http://host.docker.internal:8000/v1');
      expect(result).toEqual([]);
    });

    it('drops entries without a string id', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ id: 'm1' }, { id: null }, {}, { id: '' }] }),
        ) as unknown as typeof fetch;

      const result = await svc.probeModels('http://host.docker.internal:8000/v1');
      expect(result).toEqual([{ model_name: 'm1' }]);
    });

    it('filters out embedding / reranker / moderation models (they cannot serve chat)', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: 'google/gemma-4-e4b' },
            { id: 'text-embedding-nomic-embed-text-v1.5' },
            { id: 'bge-reranker-base' },
            { id: 'openai/text-embedding-3-small' },
            { id: 'text-moderation-007' },
            { id: 'nomic-embed-text' },
          ],
        }),
      ) as unknown as typeof fetch;

      const result = await svc.probeModels('http://localhost:1234/v1');
      // Only the LLM survives; all embedders / rerankers / moderation models
      // are filtered out at probe time so they never reach the routing UI.
      expect(result).toEqual([{ model_name: 'google/gemma-4-e4b' }]);
    });

    it('returns an empty array when every returned model is an embedder (nothing routable)', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: 'text-embedding-3-small' }, { id: 'nomic-embed-text-v1.5' }],
        }),
      ) as unknown as typeof fetch;

      const result = await svc.probeModels('http://localhost:1234/v1');
      expect(result).toEqual([]);
    });

    it('rejects non-JSON responses (HTML, binary, no content-type)', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        json: async () => ({ data: [] }),
      }) as unknown as typeof fetch;

      await expect(svc.probeModels('http://host.docker.internal:8000/v1')).rejects.toThrow(
        /instead of JSON/,
      );
    });

    it('rejects when the server omits the content-type header', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ data: [] }),
      }) as unknown as typeof fetch;

      await expect(svc.probeModels('http://host.docker.internal:8000/v1')).rejects.toThrow(
        /no content-type/,
      );
    });

    it('throws BadRequest when the URL fails validation', async () => {
      (validatePublicUrl as jest.Mock).mockRejectedValue(new Error('private or internal'));
      const { svc } = makeDeps({});
      await expect(svc.probeModels('http://127.0.0.1:11434/v1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws BadRequest when the server responds with a non-2xx status', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }) as unknown as typeof fetch;

      await expect(svc.probeModels('http://host.docker.internal:8000/v1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws BadRequest when the fetch itself fails (e.g. ECONNREFUSED)', async () => {
      const { svc } = makeDeps({});
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      await expect(svc.probeModels('http://host.docker.internal:8000/v1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('surfaces AbortError as a timeout-specific error message', async () => {
      const { svc } = makeDeps({});
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      global.fetch = jest.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;

      await expect(svc.probeModels('http://host.docker.internal:8000/v1')).rejects.toThrow(
        /No response from|loading a model/,
      );
    });

    it('aborts the request when the 5s timeout fires', async () => {
      const { svc } = makeDeps({});
      // Use a fake setTimeout that we can manually trigger. We can't rely
      // on jest.useFakeTimers() here because it doesn't cooperate cleanly
      // with the service's AbortController signal in async flows.
      const realSetTimeout = global.setTimeout;
      let fired: (() => void) | null = null;
      global.setTimeout = ((cb: () => void) => {
        fired = cb;
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout;

      try {
        // Hang the fetch until the abort signal fires so the service's
        // own timeout callback drives the failure path.
        global.fetch = jest.fn().mockImplementation((_url, init) => {
          return new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        }) as unknown as typeof fetch;

        const pending = svc.probeModels('http://host.docker.internal:8000/v1');
        // probeModels first awaits validatePublicUrl and only then calls
        // setTimeout — let the async prologue run before asserting our
        // fake setTimeout captured the callback.
        await new Promise((resolve) => realSetTimeout(resolve, 0));
        expect(fired).not.toBeNull();
        // Manually drive the AbortController.abort() callback registered
        // in probeModels so the timeout path is exercised end-to-end.
        fired!();
        await expect(pending).rejects.toThrow(/No response from|loading a model/);
      } finally {
        global.setTimeout = realSetTimeout;
      }
    });

    // Edit-page bug repro: opening an existing API-key custom provider and
    // clicking "Fetch models" without re-typing the key sent an unauth'd
    // probe (the form never has the plaintext key — list() only returns
    // has_api_key:bool). Server then 401'd from the upstream. Fix: the
    // controller now decrypts the stored key via loadStoredApiKey() when
    // the caller forwards a provider_id, before calling probeModels().
    describe('loadStoredApiKey', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { encrypt, getEncryptionSecret } = require('../../common/utils/crypto.util');

      const ORIGINAL_ENV = process.env['MANIFEST_ENCRYPTION_KEY'];
      beforeAll(() => {
        process.env['MANIFEST_ENCRYPTION_KEY'] = 'test-encryption-secret-min-32-chars-long-padding';
      });
      afterAll(() => {
        if (ORIGINAL_ENV === undefined) {
          delete process.env['MANIFEST_ENCRYPTION_KEY'];
        } else {
          process.env['MANIFEST_ENCRYPTION_KEY'] = ORIGINAL_ENV;
        }
      });

      it('decrypts the stored key for the matching tenant + provider', async () => {
        const stored = 'sk-stored-secret-value';
        const enc = encrypt(stored, getEncryptionSecret());
        const { svc, getProviders } = makeDeps({});
        getProviders.mockResolvedValueOnce([
          { provider: 'custom:cp-edit-id', api_key_encrypted: enc },
        ]);

        await expect(svc.loadStoredApiKey('tenant-1', 'cp-edit-id')).resolves.toBe(stored);
        expect(getProviders).toHaveBeenCalledWith('tenant-1');
      });

      it('returns undefined when the provider row has no ciphertext (unauth local server)', async () => {
        const { svc, getProviders } = makeDeps({});
        getProviders.mockResolvedValueOnce([
          { provider: 'custom:cp-local', api_key_encrypted: null },
        ]);
        await expect(svc.loadStoredApiKey('tenant-1', 'cp-local')).resolves.toBeUndefined();
      });

      it('returns undefined when no row exists for the given provider_id', async () => {
        const { svc, getProviders } = makeDeps({});
        getProviders.mockResolvedValueOnce([]);
        await expect(svc.loadStoredApiKey('tenant-1', 'missing')).resolves.toBeUndefined();
      });

      it('cross-tenant safety: a provider_id from another tenant resolves to undefined', async () => {
        // The lookup only sees rows for the resolved tenantId, so a forged
        // provider_id can never surface another tenant's encrypted key.
        const { svc, getProviders } = makeDeps({});
        getProviders.mockResolvedValueOnce([]); // tenant-attacker owns nothing
        await expect(svc.loadStoredApiKey('tenant-attacker', 'cp-victim')).resolves.toBeUndefined();
        expect(getProviders).toHaveBeenCalledWith('tenant-attacker');
      });

      it('swallows decrypt errors (corrupt ciphertext) and returns undefined', async () => {
        const { svc, getProviders } = makeDeps({});
        getProviders.mockResolvedValueOnce([
          { provider: 'custom:cp-broken', api_key_encrypted: 'not-a-valid-ciphertext' },
        ]);
        await expect(svc.loadStoredApiKey('tenant-1', 'cp-broken')).resolves.toBeUndefined();
      });
    });
  });
});
