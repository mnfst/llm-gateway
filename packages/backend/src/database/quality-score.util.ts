export interface QualityScoreInput {
  model_name: string;
  input_price_per_token: number | null;
  output_price_per_token: number | null;
  capability_reasoning: boolean;
  capability_code: boolean;
  context_window: number;
}

/**
 * Models where data signals alone cannot determine the correct quality tier.
 * These encode editorial benchmark-level judgments that price + capabilities
 * cannot derive. Kept minimal — only models the formula misclassifies.
 */
export const QUALITY_OVERRIDES: ReadonlyMap<string, number> = new Map([
  // Anthropic mid-tier despite frontier-level price + capabilities
  ['claude-sonnet-4-5-20250929', 4],
  ['claude-sonnet-4-20250514', 4],
  // Expensive code-only models that benchmark as mid-range, not tier-1.5
  ['gpt-4o', 3],
  ['mistral-large-latest', 3],
  ['kimi-k2', 3],
  // Kimi Coding Plan wire id: models.dev only knows the platform alias
  // (kimi-k3), so the formula sees a zero-price model with no capability
  // flags and would score Moonshot's flagship as ultra-low.
  ['k3', 3],
  // Same zero-price/no-flag profile as k3 — the 256k sibling of the flagship.
  ['k3-256k', 3],
  // Meta-router — computed score from price data doesn't reflect frontier capability
  ['openrouter/auto', 5],
  // Free meta-router — mid-range quality
  ['openrouter/free', 3],
]);

const MINI_VARIANT = /\b(mini|nano|haiku|micro)\b/i;

/**
 * Compute quality_score (1-5) from model data signals.
 *
 * Decision tree based on price tier, capabilities, and context window:
 *   5 = frontier: expensive ($8+/M) with dual capabilities, or code + 1M+ context
 *   4 = tier-1.5: reasoning models $1+/M, or expensive code-only
 *   3 = mid-range: mid-price code models, cheap dual-capability, or reasoning minis
 *   2 = cost-optimized: has code capability
 *   1 = ultra-low: no code, very cheap
 */
export function computeQualityScore(model: QualityScoreInput): number {
  const override = QUALITY_OVERRIDES.get(model.model_name);
  if (override !== undefined) return override;
  // Also check bare name (e.g. "anthropic/claude-sonnet-4-20250514" → "claude-sonnet-4-20250514")
  const slashIdx = model.model_name.indexOf('/');
  if (slashIdx > 0) {
    const bare = model.model_name.substring(slashIdx + 1);
    const bareOverride = QUALITY_OVERRIDES.get(bare);
    if (bareOverride !== undefined) return bareOverride;
  }

  // Null-price models (unknown pricing, e.g. custom providers without price info)
  if (model.input_price_per_token == null || model.output_price_per_token == null) return 2;

  const totalPerM =
    (Number(model.input_price_per_token) + Number(model.output_price_per_token)) * 1_000_000;
  const hasReasoning = model.capability_reasoning;
  const hasCode = model.capability_code;
  const hasBoth = hasReasoning && hasCode;
  const bigContext = model.context_window >= 1_000_000;
  const nameForMatch = slashIdx > 0 ? model.model_name.substring(slashIdx + 1) : model.model_name;
  const isMini = MINI_VARIANT.test(nameForMatch);
  const hasCapabilities = hasReasoning === true || hasCode === true;

  // Zero-price models (local, e.g. Ollama) — score on capabilities only
  if (totalPerM === 0) {
    if (hasBoth && !isMini) return 3;
    if (hasReasoning && !isMini) return 3;
    if (hasReasoning && isMini) return 2;
    if (hasCode) return 2;
    return 1;
  }

  // When capability flags are present, use the full decision tree
  if (hasCapabilities) {
    if (totalPerM >= 8.0 && hasBoth && !isMini) return 5;
    if (totalPerM >= 8.0 && hasCode && bigContext) return 5;
    if (totalPerM >= 1.0 && hasReasoning && !isMini) return 4;
    if (totalPerM >= 8.0 && hasCode) return 4;
    if (totalPerM >= 3.0 && hasCode && !isMini) return 3;
    if (totalPerM >= 0.5 && hasBoth && !isMini) return 3;
    if (hasReasoning && isMini && totalPerM >= 0.5) return 3;
    if (hasCode) return 2;
    return 1;
  }

  // Price-only fallback (e.g. OpenRouter models without capability flags)
  if (totalPerM >= 20.0 && !isMini) return 5;
  if (totalPerM >= 5.0 && !isMini) return 4;
  if (totalPerM >= 1.0 && !isMini) return 3;
  if (totalPerM >= 0.3) return 2;
  return 1;
}
