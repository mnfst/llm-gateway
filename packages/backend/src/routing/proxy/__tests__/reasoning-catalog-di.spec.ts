import { Test } from '@nestjs/testing';
import { ModelsDevSyncService } from '../../../database/models-dev-sync.service';
import { ProviderClient } from '../provider-client';
import { ReasoningContentCache } from '../reasoning-content-cache';
import { ModelsDevReasoningCatalog } from '../reasoning-model-catalog';
import { ProxyModule } from '../proxy.module';
import { ModelPricesModule } from '../../../model-prices/model-prices.module';

describe('reasoning catalog dependency injection', () => {
  it('hands the models.dev catalog to the cache and the provider client', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReasoningContentCache,
        ProviderClient,
        ModelsDevReasoningCatalog,
        {
          provide: ModelsDevSyncService,
          useValue: { lookupModel: () => null, lookupModelCapabilities: () => null },
        },
      ],
    }).compile();

    const catalog = moduleRef.get(ModelsDevReasoningCatalog);
    expect(moduleRef.get(ReasoningContentCache).modelCatalog).toBe(catalog);
    expect(
      (moduleRef.get(ProviderClient) as unknown as { reasoningCatalog?: unknown }).reasoningCatalog,
    ).toBe(catalog);
  });
});

describe('ProxyModule wiring', () => {
  it('registers the catalog and imports the module that supplies its dependency', () => {
    // The synthetic module above proves the injection tokens line up. This one
    // guards the real graph: drop the provider from ProxyModule, or stop
    // ModelPricesModule exporting ModelsDevSyncService, and every gateway
    // request silently reverts to the family-regex fallback with no test
    // failing anywhere else.
    const providers = Reflect.getMetadata('providers', ProxyModule) as unknown[];
    expect(providers).toContain(ModelsDevReasoningCatalog);

    const imports = Reflect.getMetadata('imports', ProxyModule) as unknown[];
    expect(imports).toContain(ModelPricesModule);

    const exported = Reflect.getMetadata('exports', ModelPricesModule) as unknown[];
    expect(exported).toContain(ModelsDevSyncService);
  });
});
