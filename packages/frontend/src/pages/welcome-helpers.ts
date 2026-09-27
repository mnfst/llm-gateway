import type { AvailableModel } from '../services/api.js';

const MAX_FALLBACKS = 2;

/** A model the user starred in the embedded Playground (primary route pick). */
export interface PlaygroundModelSelection {
  model: string;
  provider: string;
  authType: string;
}

export interface OnboardingAgentSummary {
  agent_name: string;
  display_name?: string | null;
  agent_category?: string | null;
  agent_platform?: string | null;
  message_count?: number;
  has_successful_message?: boolean;
}

export interface OnboardingMessageSummary {
  status?: string | null;
  error_message?: string | null;
  provider?: string | null;
  model?: string | null;
  duration_ms?: number | null;
}

/** Agents are returned newest first, so resume the newest unfinished setup.
 *
 * The backend returns `message_count` but not `has_successful_message`.
 * `has_successful_message` is kept in the interface for forward-compatibility
 * if the backend ever adds it. Until then, an agent with zero provider
 * attempts (`message_count === 0`) is the safe signal for "never activated". */
export function findResumableAgent(
  agents: OnboardingAgentSummary[],
): OnboardingAgentSummary | null {
  return (
    agents.find((agent) => {
      if (typeof agent.has_successful_message === 'boolean') return !agent.has_successful_message;
      return !agent.message_count;
    }) ?? null
  );
}

export function isSuccessfulAgentMessage(
  message: OnboardingMessageSummary | null | undefined,
): boolean {
  return message?.status === 'success' || message?.status === 'ok';
}

/** Best model per independent provider, ordered by quality — the routing proposal. */
export function proposeChain(
  models: AvailableModel[],
  preferred?: PlaygroundModelSelection | null,
): AvailableModel[] {
  const preferredModel = preferred
    ? models.find(
        (model) =>
          model.model_name === preferred.model &&
          model.provider.toLowerCase() === preferred.provider.toLowerCase() &&
          (model.auth_type ?? 'api_key') === preferred.authType,
      )
    : undefined;
  const bestByProvider = new Map<string, AvailableModel>();
  for (const m of models) {
    // A second credential for the same provider is useful, but it is not an
    // independent fallback. The reliability promise is about provider-level
    // redundancy, so select at most one model from each provider.
    const key = m.provider.toLowerCase();
    if (preferredModel && key === preferredModel.provider.toLowerCase()) continue;
    const current = bestByProvider.get(key);
    if (!current || m.quality_score > current.quality_score) bestByProvider.set(key, m);
  }
  const independent = [...bestByProvider.values()].sort(
    (a, b) => b.quality_score - a.quality_score,
  );
  return preferredModel
    ? [preferredModel, ...independent.slice(0, MAX_FALLBACKS)]
    : independent.slice(0, 1 + MAX_FALLBACKS);
}
