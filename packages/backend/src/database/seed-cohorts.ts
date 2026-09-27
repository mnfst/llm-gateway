import { DataSource, Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import type { ModelRoute } from 'manifest-shared';
import { auth } from '../auth/auth.instance';
import { Tenant } from '../entities/tenant.entity';
import { Agent } from '../entities/agent.entity';
import { AgentApiKey } from '../entities/agent-api-key.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';
import { hashKey, keyPrefix } from '../common/utils/hash.util';
import { getSeedConnections } from './seed-messages';

const OLD_USER_EMAIL = 'olduser@manifest.build';
const OLD_USER_PASSWORD = 'manifest';
const OLD_TENANT_ID = 'seed-tenant-old-001';
const OLD_AGENT_ID = 'seed-agent-old-001';
const OLD_OTLP_KEY_ID = 'seed-otlp-key-old-001';
const OLD_OTLP_KEY = 'mnfst_dev-otlp-key-old-001';

/** Public so tests / logs / docs share one source of truth for the cohort logins. */
export const COHORT_SEED = {
  oldUserEmail: OLD_USER_EMAIL,
  oldUserPassword: OLD_USER_PASSWORD,
  oldTenantId: OLD_TENANT_ID,
  oldAgentId: OLD_AGENT_ID,
  oldOtlpKey: OLD_OTLP_KEY,
} as const;

// Model targets for the legacy agent's complexity tiers — purely cosmetic, so
// the four tier cards show real models instead of empty pickers in the demo.
const LEGACY_TIER_ROUTES: ModelRoute[] = [
  { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
  { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
  { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4-5-20250929' },
  { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4-5-20250929' },
];

const LEGACY_SPECIFICITY_ROUTES: Record<string, ModelRoute> = {
  coding: { provider: 'anthropic', authType: 'subscription', model: 'claude-sonnet-4-5-20250929' },
  trading: { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
};

export interface CohortSeedDeps {
  dataSource: DataSource;
  tenantRepo: Repository<Tenant>;
  agentRepo: Repository<Agent>;
  agentKeyRepo: Repository<AgentApiKey>;
  providerRepo: Repository<TenantProvider>;
  enabledProviderRepo: Repository<AgentEnabledProvider>;
  tierRepo: Repository<TierAssignment>;
  specificityRepo: Repository<SpecificityAssignment>;
  logger: Logger;
  /** The existing admin demo agent id — becomes the "clean" cohort. */
  cleanAgentId: string;
}

/**
 * Seeds two routing cohorts that demonstrate the complexity / task-specific
 * deprecation gate:
 *
 * - **clean** — the existing admin demo agent. Its providers are enabled so the
 *   routing page renders, but no complexity / task-specific config is seeded, so
 *   the dashboard shows the simplified Default + Custom surface only.
 * - **legacy** — a brand-new `olduser@manifest.build` + agent that is "invested"
 *   in the deprecated surfaces (complexity routing on with per-tier overrides +
 *   active task-specific categories), so the dashboard keeps showing them.
 *
 * Idempotent: keyed on the legacy (olduser) agent, so re-seeding an existing DB
 * is a no-op.
 */
export async function seedRoutingCohorts(deps: CohortSeedDeps): Promise<void> {
  const exists = await deps.agentRepo.count({ where: { id: OLD_AGENT_ID } });
  if (exists > 0) return;

  await seedCleanCohort(deps);
  await seedLegacyCohort(deps);

  deps.logger.log(
    `Seeded routing cohorts: clean=${deps.cleanAgentId} (Default + Custom only), ` +
      `legacy=${OLD_USER_EMAIL} (complexity + task-specific visible)`,
  );
}

async function seedCleanCohort(deps: CohortSeedDeps): Promise<void> {
  // The admin demo agent is the "clean" cohort: enable the already-seeded
  // provider connections so the routing page renders (it gates on "has at least
  // one enabled provider"), but seed no complexity / task-specific config so the
  // agent stays clean and gets the simplified Default + Custom surface.
  for (const conn of getSeedConnections()) {
    await deps.enabledProviderRepo.insert({
      agent_id: deps.cleanAgentId,
      tenant_provider_id: conn.id,
    });
  }
}

async function seedLegacyCohort(deps: CohortSeedDeps): Promise<void> {
  await auth.api.signUpEmail({
    body: { email: OLD_USER_EMAIL, password: OLD_USER_PASSWORD, name: 'Old User' },
  });
  await deps.dataSource.query(`UPDATE "user" SET "emailVerified" = true WHERE email = $1`, [
    OLD_USER_EMAIL,
  ]);
  const rows = await deps.dataSource.query(`SELECT id FROM "user" WHERE email = $1`, [
    OLD_USER_EMAIL,
  ]);
  const userId = rows.length > 0 ? String(rows[0].id) : null;
  if (!userId) return;

  await deps.tenantRepo.insert({
    id: OLD_TENANT_ID,
    name: userId,
    owner_user_id: userId,
    organization_name: 'Old User Org',
    email: OLD_USER_EMAIL,
    is_active: true,
  });

  await deps.agentRepo.insert({
    id: OLD_AGENT_ID,
    name: 'demo-agent',
    description: 'Legacy agent — complexity + task-specific routing still visible',
    agent_category: 'personal',
    agent_platform: 'openclaw',
    is_active: true,
    tenant_id: OLD_TENANT_ID,
  });

  await deps.agentKeyRepo.insert({
    id: OLD_OTLP_KEY_ID,
    key: null,
    key_hash: hashKey(OLD_OTLP_KEY),
    key_prefix: keyPrefix(OLD_OTLP_KEY),
    label: 'Demo OTLP ingest key',
    tenant_id: OLD_TENANT_ID,
    agent_id: OLD_AGENT_ID,
    is_active: true,
  });

  // The legacy tenant needs its own provider connections; enable them for the
  // agent so the routing page renders.
  for (const conn of getSeedConnections()) {
    const providerId = `${conn.id}-old`;
    await deps.providerRepo.insert({
      id: providerId,
      tenant_id: OLD_TENANT_ID,
      created_by_user_id: userId,
      provider: conn.provider,
      auth_type: conn.auth_type,
      label: 'Default',
      priority: 0,
      is_active: true,
    });
    await deps.enabledProviderRepo.insert({
      agent_id: OLD_AGENT_ID,
      tenant_provider_id: providerId,
    });
  }

  // Mark the agent as invested in the deprecated routing surfaces.
  await deps.agentRepo.update({ id: OLD_AGENT_ID }, { complexity_routing_enabled: true });

  await deps.tierRepo.insert(
    ['simple', 'standard', 'complex', 'reasoning'].map((tier, i) => ({
      id: `seed-tier-${tier}`,
      agent_id: OLD_AGENT_ID,
      tier,
      override_route: LEGACY_TIER_ROUTES[i],
    })),
  );

  await deps.specificityRepo.insert(
    ['coding', 'trading'].map((category) => ({
      id: `seed-spec-${category}`,
      agent_id: OLD_AGENT_ID,
      category,
      is_active: true,
      override_route: LEGACY_SPECIFICITY_ROUTES[category],
    })),
  );
}
