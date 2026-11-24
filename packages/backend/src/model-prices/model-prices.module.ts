import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelPricesController } from './model-prices.controller';
import { ModelPricesService } from './model-prices.service';
import { ModelPricingCacheService } from './model-pricing-cache.service';
import { PricingSyncService } from '../database/pricing-sync.service';
import { ModelsDevSyncService } from '../database/models-dev-sync.service';
import { ProviderModelRegistryService } from '../model-discovery/provider-model-registry.service';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { CustomProvider } from '../entities/custom-provider.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TenantProvider, CustomProvider])],
  controllers: [ModelPricesController],
  providers: [
    ModelPricesService,
    ModelPricingCacheService,
    PricingSyncService,
    ModelsDevSyncService,
    ProviderModelRegistryService,
  ],
  exports: [
    ModelPricesService,
    ModelPricingCacheService,
    PricingSyncService,
    ModelsDevSyncService,
    ProviderModelRegistryService,
  ],
})
export class ModelPricesModule {}
