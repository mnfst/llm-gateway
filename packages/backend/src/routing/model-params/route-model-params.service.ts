import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  deleteProviderParamValue,
  getProviderParamValue,
  isProviderParamPath,
  modelParamsScopeForHeaderTier,
  modelParamsScopeForTier,
  setProviderParamValue,
  type AuthType,
  type JsonValue,
  type ModelParamDefinition,
  type ModelRoute,
  type ProviderParamSpec,
  type RequestParamDefaults,
} from 'manifest-shared';
import { TierService } from '../routing-core/tier.service';
import { HeaderTierService } from '../header-tiers/header-tier.service';
import { AgentModelParamsService } from '../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../routing-core/provider-param-spec.service';
import {
  effectiveRoute,
  readFallbackRoutes,
  readOverrideRoute,
} from '../routing-core/route-helpers';
import { normalizeProviderModel } from '../../common/utils/anthropic-model-id';
import { sanitizeModelParams } from './sanitize-model-params';

export const DEFAULT_TIER_NAME = 'default';

export interface RouteModelParamsChange {
  set?: Record<string, JsonValue>;
  unset?: string[];
}

export interface RouteModelParamView extends ModelParamDefinition {
  /** Saved value, or null when the provider's own default applies. */
  current: JsonValue | null;
}

export interface RouteModelParamsView {
  tier: string;
  route: { provider: string; authType: AuthType; model: string };
  /** Every model the tier routes to, primary first — the valid `model` inputs. */
  models: string[];
  params: RouteModelParamView[];
}

interface ResolvedRoute {
  tierName: string;
  scope: string;
  route: ModelRoute;
  /** The id the proxy forwards; specs are catalogued under it (see normalizeProviderModel). */
  paramsModel: string;
  models: string[];
}

/**
 * Model params addressed the way people name a route: a tier (`default` or a
 * custom tier's name) plus one of the models it routes to. Resolves that to
 * the stored (scope, provider, authType, model) identity, so the CLI and MCP
 * never handle scope keys or header-tier ids. The dashboard keeps using the
 * scope-keyed endpoints; both write the same rows.
 */
@Injectable()
export class RouteModelParamsService {
  constructor(
    private readonly tiers: TierService,
    private readonly headerTiers: HeaderTierService,
    private readonly modelParams: AgentModelParamsService,
    private readonly specs: ProviderParamSpecService,
  ) {}

  async get(agentId: string, tier = DEFAULT_TIER_NAME, model?: string) {
    const resolved = await this.resolve(agentId, tier, model);
    const specs = await this.specsFor(resolved);
    return this.view(agentId, resolved, specs);
  }

  async update(
    agentId: string,
    tier: string | undefined,
    model: string | undefined,
    change: RouteModelParamsChange,
  ): Promise<RouteModelParamsView> {
    const setEntries = Object.entries(change.set ?? {});
    const unset = change.unset ?? [];
    if (setEntries.length === 0 && unset.length === 0) {
      throw new BadRequestException('Nothing to change: pass at least one param to set or unset');
    }

    for (const path of [...unset, ...setEntries.map(([p]) => p)]) {
      if (!isProviderParamPath(path)) throw new BadRequestException(`Invalid param path "${path}"`);
    }

    const resolved = await this.resolve(agentId, tier ?? DEFAULT_TIER_NAME, model);
    const { route, scope } = resolved;
    const specs = await this.specsFor(resolved);
    const saved = (await this.savedParams(agentId, resolved)) ?? {};

    for (const path of unset) {
      if (!specs.some((s) => s.path === path) && getProviderParamValue(saved, path) === undefined) {
        throw this.unknownParam(path, route.model, specs);
      }
    }
    for (const [path] of setEntries) {
      if (!specs.some((s) => s.path === path)) throw this.unknownParam(path, route.model, specs);
    }

    let next: RequestParamDefaults = saved;
    for (const path of unset) next = deleteProviderParamValue(next, path);
    for (const [path, value] of setEntries) next = setProviderParamValue(next, path, value);

    if (Object.keys(next).length === 0) {
      await this.modelParams.delete(agentId, scope, route.provider, route.authType, route.model);
    } else {
      const sanitized = sanitizeModelParams(route.provider, next, specs);
      for (const [path] of setEntries) {
        if (getProviderParamValue(sanitized, path) === undefined) {
          throw new BadRequestException(
            `Param "${path}" does not apply with the current settings of ${route.model}`,
          );
        }
      }
      await this.modelParams.set(
        agentId,
        scope,
        route.provider,
        route.authType,
        route.model,
        sanitized,
      );
    }
    return this.view(agentId, resolved, specs);
  }

  private async resolve(agentId: string, tier: string, model?: string): Promise<ResolvedRoute> {
    const { tierName, scope, primary, fallbacks } = await this.findTier(agentId, tier);
    const routes = [primary, ...fallbacks].filter((r): r is ModelRoute => r !== null);
    const models = [...new Set(routes.map((r) => r.model))];

    if (model === undefined) {
      if (!primary) throw new BadRequestException(`Tier "${tierName}" has no model yet`);
      return this.resolved(tierName, scope, primary, models);
    }

    const wanted = (r: ModelRoute) => normalizeProviderModel(r.provider, model);
    const matches = routes.filter(
      (r) => r.model === model || normalizeProviderModel(r.provider, r.model) === wanted(r),
    );
    if (matches.length === 0) {
      throw new BadRequestException(
        `Model "${model}" is not routed by tier "${tierName}". Models: ${models.join(', ')}`,
      );
    }
    const connections = new Set(matches.map((r) => `${r.provider.toLowerCase()}|${r.authType}`));
    if (connections.size > 1) {
      throw new BadRequestException(
        `Model "${model}" is routed through more than one connection in tier "${tierName}"; set its params from the dashboard`,
      );
    }
    return this.resolved(tierName, scope, matches[0], models);
  }

  private resolved(tierName: string, scope: string, route: ModelRoute, models: string[]) {
    const paramsModel = normalizeProviderModel(route.provider, route.model);
    return { tierName, scope, route, paramsModel, models };
  }

  private async findTier(agentId: string, tier: string) {
    if (tier.toLowerCase() === DEFAULT_TIER_NAME) {
      const row = (await this.tiers.getTiers(agentId)).find((t) => t.tier === DEFAULT_TIER_NAME);
      if (row) {
        return {
          tierName: DEFAULT_TIER_NAME,
          scope: modelParamsScopeForTier(DEFAULT_TIER_NAME),
          primary: effectiveRoute(row),
          fallbacks: readFallbackRoutes(row) ?? [],
        };
      }
    }
    const custom = await this.headerTiers.list(agentId);
    const match = custom.find((t) => t.name.toLowerCase() === tier.toLowerCase());
    if (!match || tier.toLowerCase() === DEFAULT_TIER_NAME) {
      const names = [DEFAULT_TIER_NAME, ...custom.map((t) => t.name)];
      throw new NotFoundException(`Tier "${tier}" not found. Available tiers: ${names.join(', ')}`);
    }
    return {
      tierName: match.name,
      scope: modelParamsScopeForHeaderTier(match.id),
      primary: readOverrideRoute(match),
      fallbacks: readFallbackRoutes(match) ?? [],
    };
  }

  private specsFor({ route, paramsModel }: ResolvedRoute): Promise<readonly ProviderParamSpec[]> {
    return this.specs.getSpecs(route.provider, route.authType, paramsModel);
  }

  // Saved under the route's model id as configured, the key the dashboard uses too.
  private savedParams(agentId: string, { scope, route }: ResolvedRoute) {
    return this.modelParams.get(agentId, scope, route.provider, route.authType, route.model);
  }

  private async view(
    agentId: string,
    resolved: ResolvedRoute,
    specs: readonly ProviderParamSpec[],
  ): Promise<RouteModelParamsView> {
    const saved = await this.savedParams(agentId, resolved);
    const { provider, authType, model } = resolved.route;
    return {
      tier: resolved.tierName,
      route: { provider, authType, model },
      models: resolved.models,
      params: specs.map(
        ({ provider: _p, authType: _a, model: _m, ...definition }): RouteModelParamView => ({
          ...definition,
          current: (getProviderParamValue(saved, definition.path) as JsonValue | undefined) ?? null,
        }),
      ),
    };
  }

  private unknownParam(path: string, model: string, specs: readonly ProviderParamSpec[]) {
    if (specs.length === 0) {
      return new BadRequestException(`${model} has no configurable params`);
    }
    return new BadRequestException(
      `Unknown param "${path}" for ${model}. Available: ${specs.map((s) => s.path).join(', ')}`,
    );
  }
}
