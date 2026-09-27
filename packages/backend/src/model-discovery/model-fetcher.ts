/**
 * Types for provider-native model discovery.
 *
 * Each provider's /models API is called using a FetcherConfig that describes
 * the endpoint, auth header, and response parser. The result is a list of
 * DiscoveredModel objects cached in tenant_providers.cached_models.
 */

import type { AuthType, ModelCapability, ModelModality } from 'manifest-shared';

/**
 * Default context-window size assumed when a provider's API or the pricing
 * cache does not report one. Single source of truth for model discovery.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

export interface LongContextPricing {
  /** Default rates apply through this many prompt tokens; long-context rates apply above it. */
  thresholdTokens: number;
  inputPricePerToken: number;
  outputPricePerToken: number;
  cacheReadPricePerToken?: number;
  cacheWritePricePerToken?: number;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  /** Identifies context windows that can be recalculated without replacing provider metadata. */
  contextWindowSource?: 'provider' | 'subscription_config';
  inputPricePerToken: number | null;
  outputPricePerToken: number | null;
  cacheReadPricePerToken?: number;
  cacheWritePricePerToken?: number;
  longContextPricing?: LongContextPricing;
  capabilityReasoning: boolean;
  capabilityCode: boolean;
  capabilities?: readonly ModelCapability[];
  inputModalities?: readonly ModelModality[];
  outputModalities?: readonly ModelModality[];
  supportedEndpoints?: readonly string[];
  qualityScore: number;
  authType?: AuthType;
  /** Custom providers only: the display name the user gave the provider. */
  providerName?: string;
  /**
   * Custom providers only: the alias `/v1/models` publishes the model under
   * (`<providerAlias>/<model_name>`). Absent when the provider has no alias,
   * in which case the internal `custom:<uuid>/<model_name>` id is published.
   */
  providerAlias?: string;
}

export interface FetcherConfig {
  /** Base URL for the models endpoint. */
  endpoint: string | ((key: string) => string);
  /** Build the Authorization / auth header(s). */
  buildHeaders: (key: string, authType?: string) => Record<string, string>;
  /** Parse provider-specific response JSON into DiscoveredModel[]. */
  parse: (body: unknown, provider: string) => DiscoveredModel[];
}
