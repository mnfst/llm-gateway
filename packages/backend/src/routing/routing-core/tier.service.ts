import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TierAssignment } from '../../entities/tier-assignment.entity';
import { RoutingCacheService } from './routing-cache.service';
import { ProviderService } from './provider.service';
import { ModelDiscoveryService } from '../../model-discovery/model-discovery.service';
import { randomUUID } from 'crypto';
import type { AuthType, ModelRoute, ResponseMode } from 'manifest-shared';
import {
  DEFAULT_RESPONSE_MODE,
  DEFAULT_OUTPUT_MODALITY,
  TIER_SLOTS,
  TierSlot,
} from 'manifest-shared';
import { effectiveRoute, readFallbackRoutes, routeMatches } from './route-helpers';
import {
  describeUnresolvedFallback,
  describeUnresolvedModel,
  resolveFallbackRoutes,
  resolveModelRoute,
} from './resolve-model-route';
import { assertStreamableResponseMode } from './response-mode-guard';

@Injectable()
export class TierService {
  constructor(
    @InjectRepository(TierAssignment)
    private readonly tierRepo: Repository<TierAssignment>,
    private readonly routingCache: RoutingCacheService,
    private readonly providerService: ProviderService,
    private readonly discoveryService: ModelDiscoveryService,
  ) {}

  async hasRoutableTier(agentId: string): Promise<boolean> {
    const rows = await this.tierRepo.find({ where: { agent_id: agentId } });
    return rows.some((r) => effectiveRoute(r) !== null);
  }

  async getTiers(agentId: string, tenantId?: string): Promise<TierAssignment[]> {
    const cached = this.routingCache.getTiers(agentId);
    if (cached) return cached;

    // Trigger provider cleanup to deactivate unsupported subscription providers
    if (tenantId) await this.providerService.getProviders(tenantId);
    const rows = await this.tierRepo.find({ where: { agent_id: agentId } });

    // Figure out which slots are missing. Every agent should have a row for
    // each slot in TIER_SLOTS (4 scoring tiers + 'default'). If a previous
    // boot or older migration created a subset, fill the gaps instead of
    // throwing on the unique index.
    const present = new Set(rows.map((r) => r.tier));
    const missing = TIER_SLOTS.filter((slot) => !present.has(slot));

    if (missing.length === 0) {
      this.routingCache.setTiers(agentId, rows);
      return rows;
    }

    const created: TierAssignment[] = missing.map((slot: TierSlot) =>
      Object.assign(new TierAssignment(), {
        id: randomUUID(),
        agent_id: agentId,
        tier: slot,
        override_route: null,
        auto_assigned_route: null,
        fallback_routes: null,
        output_modality: DEFAULT_OUTPUT_MODALITY,
        response_mode: DEFAULT_RESPONSE_MODE,
      }),
    );
    try {
      await this.tierRepo.insert(created);
    } catch (err) {
      // A concurrent request may have inserted the same slots first, which
      // hits the unique (agent_id, tier) index. Re-read and adopt its rows
      // if present; otherwise the failure is something else (FK violation,
      // connection error, …) and we rethrow rather than silently proceed.
      const existing = await this.tierRepo.find({ where: { agent_id: agentId } });
      if (existing.length > 0) {
        this.routingCache.setTiers(agentId, existing);
        return existing;
      }
      throw err;
    }

    const merged = [...rows, ...created];
    this.routingCache.setTiers(agentId, merged);
    return merged;
  }

  async setOverride(
    agentId: string,
    tenantId: string,
    tier: string,
    model: string,
    provider?: string,
    authType?: AuthType,
    providerKeyLabel?: string,
  ): Promise<TierAssignment> {
    const available = await this.discoveryService.getModelsForAgent(tenantId, agentId);
    // Accept any name Manifest publishes for the model (the public
    // `/v1/models` id, a custom model's bare name, …) and store the canonical
    // route, so callers never have to know the internal id.
    const resolution = resolveModelRoute(model, available, {
      provider,
      authType,
      keyLabel: providerKeyLabel,
    });
    if (!resolution.ok) {
      throw new BadRequestException(
        describeUnresolvedModel(model, resolution.reason, available, { provider, authType }),
      );
    }
    const route = resolution.route;

    const existing = await this.tierRepo.findOne({
      where: { agent_id: agentId, tier },
    });

    if (existing) {
      existing.override_route = route;
      // If the same model+key tuple was in fallbacks, drop the matching entry
      // — a (model, keyLabel) can't be both the primary and a fallback for
      // the same tier. Other (model, otherKey) fallbacks are kept.
      if (existing.fallback_routes) {
        const filtered = existing.fallback_routes.filter((r) => !routeMatches(r, route));
        existing.fallback_routes = filtered.length > 0 ? filtered : null;
      }
      assertStreamableResponseMode(
        existing.response_mode,
        `tier "${tier}"`,
        route,
        existing.fallback_routes,
      );
      existing.updated_at = new Date().toISOString();
      await this.tierRepo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record: TierAssignment = Object.assign(new TierAssignment(), {
      id: randomUUID(),
      agent_id: agentId,
      tier,
      override_route: route,
      auto_assigned_route: null,
      fallback_routes: null,
      output_modality: DEFAULT_OUTPUT_MODALITY,
      response_mode: DEFAULT_RESPONSE_MODE,
    });

    try {
      await this.tierRepo.insert(record);
    } catch (err) {
      // A concurrent request may have inserted the same (agent_id, tier) first,
      // hitting the unique index. Re-read and adopt its row if present;
      // otherwise the failure is something else (FK violation, connection
      // error, …) and we rethrow rather than reporting a phantom success for a
      // row that was never persisted.
      const retry = await this.tierRepo.findOne({ where: { agent_id: agentId, tier } });
      if (retry) {
        return this.setOverride(
          agentId,
          tenantId,
          tier,
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
    tier: string,
    responseMode: ResponseMode,
  ): Promise<TierAssignment> {
    const existing = await this.tierRepo.findOne({ where: { agent_id: agentId, tier } });
    if (existing) {
      assertStreamableResponseMode(
        responseMode,
        `tier "${tier}"`,
        existing.override_route,
        existing.fallback_routes,
      );
      existing.response_mode = responseMode;
      existing.updated_at = new Date().toISOString();
      await this.tierRepo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record: TierAssignment = Object.assign(new TierAssignment(), {
      id: randomUUID(),
      agent_id: agentId,
      tier,
      override_route: null,
      auto_assigned_route: null,
      fallback_routes: null,
      output_modality: DEFAULT_OUTPUT_MODALITY,
      response_mode: responseMode,
    });
    assertStreamableResponseMode(responseMode, `tier "${tier}"`, null, null);
    await this.tierRepo.insert(record);
    this.routingCache.invalidateAgent(agentId);
    return record;
  }

  async clearOverride(agentId: string, tier: string): Promise<void> {
    const existing = await this.tierRepo.findOne({
      where: { agent_id: agentId, tier },
    });
    if (!existing) return;

    existing.override_route = null;
    assertStreamableResponseMode(
      existing.response_mode,
      `tier "${tier}"`,
      null,
      existing.fallback_routes,
    );
    existing.updated_at = new Date().toISOString();
    await this.tierRepo.save(existing);
    this.routingCache.invalidateAgent(agentId);
  }

  async resetAllOverrides(agentId: string): Promise<void> {
    await this.tierRepo.update(
      { agent_id: agentId },
      {
        override_route: null,
        fallback_routes: null,
        updated_at: new Date().toISOString(),
      },
    );
    this.routingCache.invalidateAgent(agentId);
  }

  /* ── Fallbacks ── */

  async getFallbacks(agentId: string, tier: string): Promise<ModelRoute[]> {
    const existing = await this.tierRepo.findOne({ where: { agent_id: agentId, tier } });
    return existing?.fallback_routes ?? [];
  }

  async setFallbacks(
    agentId: string,
    tenantId: string,
    tier: string,
    models: string[],
    routes?: ModelRoute[],
  ): Promise<ModelRoute[]> {
    const existing = await this.tierRepo.findOne({ where: { agent_id: agentId, tier } });
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
      `tier "${tier}"`,
      existing.override_route,
      fallbackRoutes,
    );
    existing.fallback_routes = fallbackRoutes;
    existing.updated_at = new Date().toISOString();
    await this.tierRepo.save(existing);
    this.routingCache.invalidateAgent(agentId);
    return existing.fallback_routes ?? [];
  }

  async clearFallbacks(agentId: string, tier: string): Promise<void> {
    const existing = await this.tierRepo.findOne({ where: { agent_id: agentId, tier } });
    if (!existing) return;
    assertStreamableResponseMode(
      existing.response_mode,
      `tier "${tier}"`,
      existing.override_route,
      null,
    );
    existing.fallback_routes = null;
    existing.updated_at = new Date().toISOString();
    await this.tierRepo.save(existing);
    this.routingCache.invalidateAgent(agentId);
  }

  /**
   * Build the fallback_routes column from caller-provided routes when present,
   * otherwise resolve each model name via discovery. Order is preserved.
   *
   * Throws BadRequestException when any model can't be resolved to a single
   * (provider, authType, model) tuple — the caller's existing
   * `fallback_routes` row is left untouched.
   *
   * Issue #1790: this used to `return null` on resolution failure, which
   * `setFallbacks` then persisted, silently wiping the user's existing
   * fallback list while the UI toasted "Fallback added". PR #1825 plugged
   * the most common trigger (same model offered by two authTypes) by making
   * the frontend send routes; throwing here removes the underlying wipe path
   * for every other trigger (e.g. disconnected providers, discovery drift,
   * malformed payloads). It does not narrow which inputs reach this path.
   *
   * `keyLabel` on each route is preserved as-is — the caller decides which
   * provider key each fallback pins to. See `resolveFallbackRoutes` for how
   * persisted entries are carried over.
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
    const resolution = resolveFallbackRoutes(models, available, routes, storedRoutes);
    if (!resolution.ok) {
      throw new BadRequestException(describeUnresolvedFallback(resolution.model));
    }
    return resolution.routes;
  }
}
