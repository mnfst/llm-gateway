import { Module } from '@nestjs/common';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { HeaderTiersModule } from '../header-tiers/header-tiers.module';
import { RouteModelParamsService } from './route-model-params.service';
import { RouteModelParamsController } from './route-model-params.controller';

@Module({
  imports: [RoutingCoreModule, HeaderTiersModule],
  providers: [RouteModelParamsService],
  controllers: [RouteModelParamsController],
  exports: [RouteModelParamsService],
})
export class RouteModelParamsModule {}
