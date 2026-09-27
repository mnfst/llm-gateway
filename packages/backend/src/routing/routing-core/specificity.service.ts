import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { DEFAULT_RESPONSE_MODE, DEFAULT_OUTPUT_MODALITY } from 'manifest-shared';
import type { AuthType, ModelRoute, ResponseMode } from 'manifest-shared';
import { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { RoutingCacheService } from './routing-cache.service';
import { explicitRoute, readFallbackRoutes, unambiguousRoute, routeMatches } from './route-helpers';
import { assertStreamableResponseMode } from './response-mode-guard';

@Injectable()
export class SpecificityService {
  constructor(
    @InjectRepository(SpecificityAssignment)
    private readonly repo: Repository<SpecificityAssignment>,
    private readonly routingCache: RoutingCacheService,
    private readonly discoveryService: ModelDiscoveryService,
  ) {}

  async getAssignments(agentId: string): Promise<SpecificityAssignment[]> {
    const cached = this.routingCache.getSpecificity(agentId);
    if (cached) return cached;

    const rows = await this.repo.find({ where: { agent_id: agentId } });
    this.routingCache.setSpecificity(agentId, rows);
    return rows;
  }

  async getActiveAssignments(agentId: string): Promise<SpecificityAssignment[]> {
    const all = await this.getAssignments(agentId);
    return all.filter((a) => a.is_active);
  }

  async toggleCategory(
    agentId: string,
    category: string,
    active: boolean,
  ): Promise<SpecificityAssignment> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });

    if (existing) {
      existing.is_active = active;
      existing.updated_at = new Date().toISOString();
      await this.repo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record = Object.assign(new SpecificityAssignment(), {
      id: randomUUID(),
      agent_id: agentId,
      category,
      is_active: active,
      override_route: null,
      auto_assigned_route: null,
      fallback_routes: null,
      output_modality: DEFAULT_OUTPUT_MODALITY,
      response_mode: DEFAULT_RESPONSE_MODE,
    });

    try {
      await this.repo.insert(record);
    } catch (err) {
      // A concurrent request may have inserted the same (agent_id, category)
      // first, hitting the unique index. Re-read and adopt its row if present;
      // otherwise the failure is something else (FK violation, connection
      // error, …) and we rethrow rather than reporting a phantom success for a
      // row that was never persisted.
      const retry = await this.repo.findOne({ where: { agent_id: agentId, category } });
      if (retry) return this.toggleCategory(agentId, category, active);
      throw err;
    }
    this.routingCache.invalidateAgent(agentId);
    return record;
  }

  async setOverride(
    agentId: string,
    tenantId: string,
    category: string,
    model: string,
    provider?: string,
    authType?: AuthType,
    providerKeyLabel?: string,
  ): Promise<SpecificityAssignment> {
    const explicit = explicitRoute(model, provider, authType, providerKeyLabel);
    const route =
      explicit ??
      unambiguousRoute(
        model,
        await this.discoveryService.getModelsForAgent(tenantId, agentId),
        providerKeyLabel,
      );
    if (!route) {
      throw new BadRequestException(
        `Model "${model}" is offered by multiple providers — pass an explicit ` +
          `provider + authType so the route is unambiguous.`,
      );
    }
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });

    if (existing) {
      assertStreamableResponseMode(
        existing.response_mode,
        `task-specific tier "${category}"`,
        route,
        existing.fallback_routes,
      );
      existing.override_route = route;
      existing.is_active = true;
      existing.updated_at = new Date().toISOString();
      await this.repo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record = Object.assign(new SpecificityAssignment(), {
      id: randomUUID(),
      agent_id: agentId,
      category,
      is_active: true,
      override_route: route,
      auto_assigned_route: null,
      fallback_routes: null,
      output_modality: DEFAULT_OUTPUT_MODALITY,
      response_mode: DEFAULT_RESPONSE_MODE,
    });

    try {
      await this.repo.insert(record);
    } catch (err) {
      // A concurrent request may have inserted the same (agent_id, category)
      // first, hitting the unique index. Re-read and adopt its row if present;
      // otherwise the failure is something else (FK violation, connection
      // error, …) and we rethrow rather than reporting a phantom success for a
      // row that was never persisted.
      const retry = await this.repo.findOne({ where: { agent_id: agentId, category } });
      if (retry) {
        return this.setOverride(
          agentId,
          tenantId,
          category,
          model,
          provider,
          authType,
          providerKeyLabel,
        );
      }
      throw err;
    }
    this.routingCache.invalidateAgent(agentId);
    return record;
  }

  async setResponseMode(
    agentId: string,
    category: string,
    responseMode: ResponseMode,
  ): Promise<SpecificityAssignment> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (existing) {
      assertStreamableResponseMode(
        responseMode,
        `task-specific tier "${category}"`,
        existing.override_route,
        existing.fallback_routes,
      );
      existing.response_mode = responseMode;
      existing.updated_at = new Date().toISOString();
      await this.repo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record = Object.assign(new SpecificityAssignment(), {
      id: randomUUID(),
      agent_id: agentId,
      category,
      is_active: false,
      override_route: null,
      auto_assigned_route: null,
      fallback_routes: null,
      output_modality: DEFAULT_OUTPUT_MODALITY,
      response_mode: responseMode,
    });
    assertStreamableResponseMode(responseMode, `task-specific tier "${category}"`, null, null);
    await this.repo.insert(record);
    this.routingCache.invalidateAgent(agentId);
    return record;
  }

  async clearOverride(agentId: string, category: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (!existing) return;

    existing.override_route = null;
    existing.fallback_routes = null;
    assertStreamableResponseMode(
      existing.response_mode,
      `task-specific tier "${category}"`,
      null,
      null,
    );
    existing.updated_at = new Date().toISOString();
    await this.repo.save(existing);
    this.routingCache.invalidateAgent(agentId);
  }

  async setFallbacks(
    agentId: string,
    tenantId: string,
    category: string,
    models: string[],
    routes?: ModelRoute[],
  ): Promise<ModelRoute[]> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (!existing) return [];
    const fallbackRoutes = await this.buildFallbackRoutes(
      agentId,
      tenantId,
      models,
      routes,
      readFallbackRoutes(existing),
    );
    assertStreamableResponseMode(
      existing.response_mode,
      `task-specific tier "${category}"`,
      existing.override_route,
      fallbackRoutes,
    );
    existing.fallback_routes = fallbackRoutes;
    existing.updated_at = new Date().toISOString();
    await this.repo.save(existing);
    this.routingCache.invalidateAgent(agentId);
    return existing.fallback_routes ?? [];
  }

  async clearFallbacks(agentId: string, category: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (!existing) return;
    assertStreamableResponseMode(
      existing.response_mode,
      `task-specific tier "${category}"`,
      existing.override_route,
      null,
    );
    existing.fallback_routes = null;
    existing.updated_at = new Date().toISOString();
    await this.repo.save(existing);
    this.routingCache.invalidateAgent(agentId);
  }

  async resetAll(agentId: string): Promise<void> {
    await this.repo.update(
      { agent_id: agentId },
      {
        is_active: false,
        override_route: null,
        fallback_routes: null,
        updated_at: new Date().toISOString(),
      },
    );
    this.routingCache.invalidateAgent(agentId);
  }

  /**
   * Mirror of {@link TierService.buildFallbackRoutes} — see that docblock for
   * the issue #1790 rationale on why this throws instead of returning null.
   */
  private async buildFallbackRoutes(
    agentId: string,
    tenantId: string,
    models: string[],
    routes?: ModelRoute[],
    storedRoutes?: ModelRoute[] | null,
  ): Promise<ModelRoute[] | null> {
    if (models.length === 0) return null;
    const available = await this.discoveryService.getModelsForAgent(tenantId, agentId);
    if (routes && routes.length === models.length) {
      const aligned = routes.every((r, i) => r.model === models[i]);
      const pool = [...(storedRoutes ?? [])];
      const validated =
        aligned &&
        routes.every((r) => {
          const kept = pool.findIndex((s) => routeMatches(s, r));
          if (kept >= 0) {
            pool.splice(kept, 1);
            return true;
          }
          return available.some(
            (m) =>
              m.id === r.model &&
              m.provider.toLowerCase() === r.provider.toLowerCase() &&
              m.authType === r.authType,
          );
        });
      if (validated) return routes;
    }
    const pool = [...(storedRoutes ?? [])];
    const resolved: ModelRoute[] = [];
    for (const m of models) {
      const kept = pool.findIndex((s) => s.model === m);
      if (kept >= 0) {
        resolved.push(pool[kept]);
        pool.splice(kept, 1);
        continue;
      }
      const route = unambiguousRoute(m, available);
      if (!route) {
        throw new BadRequestException(
          `Cannot resolve fallback model "${m}" to a single connected provider. ` +
            `Pass an explicit (provider, authType, model) route, or connect exactly one provider that offers this model.`,
        );
      }
      resolved.push(route);
    }
    return resolved;
  }
}
