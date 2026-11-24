import { inferProviderFromModel, type ModelRoute } from 'manifest-shared';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';
import { unambiguousRoute } from '../routing-core/route-helpers';
import { openAiModelId } from '../routing-core/public-model-id';

export {
  OPENAI_MODEL_ID_AUTO,
  SUBSCRIPTION_MODEL_SUFFIX,
  openAiModelId,
  subscriptionOpenAiModelId,
} from '../routing-core/public-model-id';

export interface ExplicitModelRouteCandidate {
  provider: string;
  model: string;
  providerQualified: boolean;
}

/**
 * Resolve the `model` field of a proxy request to a route.
 *
 * Matches the provider-qualified id published by `/v1/models`
 * (`openai/gpt-5.4-nano`) first, then the bare provider-native name
 * (`gpt-5.4-nano`) when it names exactly one discovered model.
 *
 * Returns null for an unknown name, and for a bare name carried by more than
 * one connection (the same id under both an API key and a subscription) — the
 * caller cannot guess which was meant.
 */
export function routeForOpenAiModelId(
  modelId: string,
  models: readonly DiscoveredModel[],
): ModelRoute | null {
  for (const model of models) {
    if (!model.authType) continue;
    if (openAiModelId(model) !== modelId) continue;
    return {
      provider: model.provider,
      authType: model.authType,
      model: model.id,
    };
  }
  return unambiguousRoute(modelId, [...models]);
}

/**
 * Infer the provider transport and provider-native model from an explicit
 * request when the model is not yet present in the discovered catalog.
 *
 * Provider-qualified IDs use the first path segment as the transport
 * (`openrouter/anthropic/claude` → OpenRouter + `anthropic/claude`). Bare IDs
 * are accepted only when their naming convention identifies a provider.
 * Connection and auth-type checks remain the caller's responsibility.
 */
export function explicitModelRouteCandidate(modelId: string): ExplicitModelRouteCandidate | null {
  if (modelId.startsWith('custom:')) {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex <= 0) return null;
    return {
      provider: modelId.slice(0, slashIndex),
      model: modelId,
      providerQualified: true,
    };
  }

  const slashIndex = modelId.indexOf('/');
  if (slashIndex > 0 && slashIndex < modelId.length - 1) {
    return {
      provider: modelId.slice(0, slashIndex).toLowerCase(),
      model: modelId.slice(slashIndex + 1),
      providerQualified: true,
    };
  }

  const provider = inferProviderFromModel(modelId);
  return provider ? { provider, model: modelId, providerQualified: false } : null;
}
