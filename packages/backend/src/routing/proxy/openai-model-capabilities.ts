import type { ModelModality } from 'manifest-shared';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';

const FEATURE_CAPABILITIES = ['stream', 'tools'] as const;

type FeatureCapability = (typeof FEATURE_CAPABILITIES)[number];

/**
 * Opt-in capability extension for `/v1/models` entries
 * (`GET /v1/models?capabilities=true`).
 *
 * Every field is optional: a missing field means "unknown", never
 * "unsupported". Discovery metadata is positive-assertion only, so the
 * projection must not coerce absent data into `false` or `["text"]`.
 */
export interface OpenAiModelCapabilities {
  input_modalities?: readonly ModelModality[];
  output_modalities?: readonly ModelModality[];
  features?: readonly FeatureCapability[];
  supported_endpoints?: readonly string[];
}

export function openAiModelCapabilities(
  model: DiscoveredModel,
): OpenAiModelCapabilities | undefined {
  const out: OpenAiModelCapabilities = {};
  if (model.inputModalities?.length) out.input_modalities = model.inputModalities;
  if (model.outputModalities?.length) out.output_modalities = model.outputModalities;
  const features = model.capabilities?.filter((capability): capability is FeatureCapability =>
    (FEATURE_CAPABILITIES as readonly string[]).includes(capability),
  );
  if (features?.length) out.features = features;
  if (model.supportedEndpoints?.length) out.supported_endpoints = model.supportedEndpoints;
  return Object.keys(out).length > 0 ? out : undefined;
}
