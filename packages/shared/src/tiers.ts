export const TIERS = ['simple', 'standard', 'complex', 'reasoning'] as const;
export type Tier = (typeof TIERS)[number];

export const DEFAULT_TIER_SLOT = 'default' as const;
export type DefaultTierSlot = typeof DEFAULT_TIER_SLOT;

export const TIER_SLOTS = [...TIERS, DEFAULT_TIER_SLOT] as const;
export type TierSlot = (typeof TIER_SLOTS)[number];

export const TIER_LABELS: Readonly<Record<TierSlot, string>> = {
  simple: 'Simple',
  standard: 'Standard',
  complex: 'Complex',
  reasoning: 'Reasoning',
  default: 'Default',
};

export const TIER_DESCRIPTIONS: Readonly<Record<TierSlot, string>> = {
  simple: 'Heartbeats, greetings, and low-cost tasks that any model can handle.',
  standard: 'General-purpose requests that need a good balance of quality and cost.',
  complex: 'Tasks requiring high quality, nuance, or multi-step reasoning.',
  reasoning: 'Advanced reasoning, planning, and critical decision-making.',
  default: 'Handles every request when complexity routing is off; final fallback otherwise.',
};

/**
 * Superset of the scoring-output `Tier` that includes non-scoring tier values
 * which can legally appear in `agent_messages.routing_tier`: `'direct'` for
 * explicit SDK model overrides and `'playground'` for `/api/v1/playground/run`.
 * Use this type (not `Tier`)
 * for message badges, filters, and telemetry buckets. Do NOT use it in the
 * scoring, routing, or tier-assignment layers — those consume the narrower
 * `Tier` domain.
 */
export const ALL_TIERS = [...TIERS, 'direct', 'playground'] as const;
export type MessageTier = (typeof ALL_TIERS)[number];

export const TIER_LABELS_ALL: Readonly<Record<MessageTier, string>> = {
  ...TIER_LABELS,
  direct: 'Direct',
  playground: 'Playground',
};
