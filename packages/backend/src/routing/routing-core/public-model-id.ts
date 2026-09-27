import type { DiscoveredModel } from '../../model-discovery/model-fetcher';

/**
 * Public model ids: the names Manifest publishes in `/v1/models` and accepts
 * back from clients, as opposed to the internal ids discovery stores.
 */
export const OPENAI_MODEL_ID_AUTO = 'auto';
export const SUBSCRIPTION_MODEL_SUFFIX = '-subscription';

/** Encode a provider-native model for Manifest's public subscription route. */
export function subscriptionOpenAiModelId(provider: string, modelId: string): string {
  const normalizedProvider = provider.toLowerCase();
  if (modelId === OPENAI_MODEL_ID_AUTO || normalizedProvider.startsWith('custom:')) return modelId;

  const prefix = `${normalizedProvider}/`;
  const routeId = modelId.toLowerCase().startsWith(prefix)
    ? modelId
    : `${normalizedProvider}/${modelId}`;
  return routeId.endsWith(SUBSCRIPTION_MODEL_SUFFIX)
    ? routeId
    : `${routeId}${SUBSCRIPTION_MODEL_SUFFIX}`;
}

/**
 * Public id of a custom provider model. With an alias the model publishes as
 * `<alias>/<model_name>`; without one it keeps the internal
 * `custom:<uuid>/<model_name>` key. The internal key always resolves (see
 * `routeForOpenAiModelId`), so client configs written before an alias was
 * set keep working.
 */
function customOpenAiModelId(model: DiscoveredModel): string {
  if (!model.providerAlias) return model.id;
  const prefix = `${model.provider}/`;
  const modelName = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
  return `${model.providerAlias}/${modelName}`;
}

export function openAiModelId(model: DiscoveredModel): string {
  const provider = model.provider.toLowerCase();
  if (provider.startsWith('custom:')) return customOpenAiModelId(model);

  const prefix = `${provider}/`;
  const routeId = model.id.toLowerCase().startsWith(prefix) ? model.id : `${provider}/${model.id}`;
  return model.authType === 'subscription'
    ? subscriptionOpenAiModelId(provider, model.id)
    : routeId;
}
