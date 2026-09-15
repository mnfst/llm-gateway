/**
 * Shared resolution of the upstream endpoint + forwarded model id for a
 * provider request. Both the proxy (`proxy-fallback.service.ts`) and the
 * Playground (`playground.service.ts`) forward provider traffic and must apply
 * the SAME region/endpoint overrides and vendor-prefix stripping — otherwise a
 * request that routes correctly through the proxy hits the wrong endpoint (or
 * 404s on a prefixed model id) when sent from the Playground.
 *
 * Previously this logic lived inline in the proxy only; the Playground
 * reimplemented a subset (custom providers, then MiniMax), which left qwen, zai
 * and copilot mis-routed from the Playground. Centralising it here keeps the
 * two paths in lock-step.
 */
import type { Logger } from '@nestjs/common';
import {
  buildCustomEndpoint,
  buildEndpointOverride,
  resolveBedrockEndpointKey,
  resolveEndpointKey,
  type ProviderEndpoint,
} from './provider-endpoints';
import { CustomProviderService } from '../custom-provider/custom-provider.service';
import { normalizeMinimaxSubscriptionBaseUrl } from '../provider-base-url';
import { getBedrockMantleBaseUrl, isBedrockRegion } from '../bedrock-region';
import { getVertexBaseUrl, parseVertexDeployment } from '../vertex-deployment';
import { MINIMAX_BASE_URLS } from '../oauth/minimax/minimax-oauth-helpers';
import { getQwenCompatibleBaseUrl, isQwenResolvedEndpoint } from '../qwen-region';
import {
  getXiaomiTokenPlanBaseUrl,
  isXiaomiProviderId,
  isXiaomiTokenPlanRegion,
} from '../xiaomi-region';
import { getZaiCodingPlanBaseUrl } from '../zai-region';

const XIAOMI_MODEL_PREFIXES = ['xiaomi/', 'mimo/', 'xiaomi-mimo/'] as const;

/** A custom provider's stored endpoint config (subset used for forwarding). */
export interface CustomProviderEndpointConfig {
  base_url: string;
  api_kind?: 'openai' | 'anthropic' | null;
}

export interface ResolveForwardEndpointParams {
  provider: string;
  /** Credential auth type (`api_key` / `subscription` / `local`). */
  authType: string | undefined;
  /** The requested model id, possibly vendor-prefixed (e.g. `minimax/abab`). */
  model: string;
  /** Persisted region for the credential (e.g. `cn`), when known. */
  providerRegion?: string | null;
  /** OAuth resource_url (MiniMax region base URL), when present. */
  resourceUrl?: string;
  /**
   * Pre-fetched custom provider row when `provider` is a custom id. Callers own
   * the DB lookup so this resolver stays synchronous and easily testable.
   */
  customProvider?: CustomProviderEndpointConfig | null;
  /** Optional logger for invalid-input warnings (matches proxy behaviour). */
  logger?: Pick<Logger, 'warn'>;
}

export interface ResolvedForwardEndpoint {
  /** Endpoint override to forward through, or undefined to use the built-in. */
  customEndpoint?: ProviderEndpoint;
  /** Model id to send upstream, with any vendor prefix stripped. */
  forwardModel: string;
}

/**
 * Compute the endpoint override + forwarded model id for a provider request.
 * Pure and synchronous — callers fetch the custom-provider row (if any) and the
 * region/resource_url, then pass them in.
 */
export function resolveForwardEndpoint(
  params: ResolveForwardEndpointParams,
): ResolvedForwardEndpoint {
  const { provider, authType, model, providerRegion, resourceUrl, customProvider, logger } = params;
  const lower = provider.toLowerCase();
  let forwardModel = model;
  let customEndpoint: ProviderEndpoint | undefined;

  // --- Vendor-prefix stripping --------------------------------------------
  // Native/subscription endpoints expect bare model ids. A custom endpoint
  // override short-circuits ProviderClient's own prefix stripping, so we must
  // strip here for any provider that may route through an override below.
  if (lower === 'copilot' && forwardModel.startsWith('copilot/')) {
    forwardModel = forwardModel.substring('copilot/'.length);
  }
  if (
    lower === 'minimax' &&
    authType === 'subscription' &&
    forwardModel.toLowerCase().startsWith('minimax/')
  ) {
    forwardModel = forwardModel.substring('minimax/'.length);
  }
  if (lower === 'zai' && authType === 'subscription') {
    const lowerModel = forwardModel.toLowerCase();
    if (lowerModel.startsWith('z-ai/')) {
      forwardModel = forwardModel.substring('z-ai/'.length);
    } else if (lowerModel.startsWith('zai/')) {
      forwardModel = forwardModel.substring('zai/'.length);
    }
  }
  if (isXiaomiProviderId(lower) && authType === 'subscription') {
    const lowerModel = forwardModel.toLowerCase();
    const prefix = XIAOMI_MODEL_PREFIXES.find((candidate) => lowerModel.startsWith(candidate));
    if (prefix) {
      forwardModel = forwardModel.substring(prefix.length);
    }
  }

  const vertexDeployment = parseVertexDeployment(providerRegion);

  // --- Endpoint overrides --------------------------------------------------
  if (CustomProviderService.isCustom(provider)) {
    if (customProvider) {
      customEndpoint = buildCustomEndpoint(
        customProvider.base_url,
        customProvider.api_kind ?? 'openai',
      );
      forwardModel = CustomProviderService.rawModelName(model);
    }
  } else if (resolveEndpointKey(provider) === 'bedrock' && isBedrockRegion(providerRegion)) {
    customEndpoint = buildEndpointOverride(
      getBedrockMantleBaseUrl(providerRegion),
      resolveBedrockEndpointKey(model),
    );
  } else if (resolveEndpointKey(provider) === 'vertex' && vertexDeployment) {
    // Connections that carry `project/location` address Vertex the way Google
    // Cloud accounts do; everything else stays on the express base URL.
    customEndpoint = buildEndpointOverride(getVertexBaseUrl(vertexDeployment), 'vertex');
  } else if (resolveEndpointKey(provider) === 'qwen' && isQwenResolvedEndpoint(providerRegion)) {
    customEndpoint = buildEndpointOverride(getQwenCompatibleBaseUrl(providerRegion), 'qwen');
  } else if (authType === 'api_key' && lower === 'minimax' && providerRegion === 'cn') {
    customEndpoint = buildEndpointOverride(MINIMAX_BASE_URLS.cn, 'minimax');
  } else if (authType === 'subscription' && lower === 'minimax') {
    // OAuth tokens carry the region in resource_url; pasted Coding Plan tokens
    // (`sk-cp-`) don't, so fall back to the persisted region column. Only CN
    // needs an override — global already matches the built-in base URL.
    if (resourceUrl) {
      const minimaxBaseUrl = normalizeMinimaxSubscriptionBaseUrl(resourceUrl);
      if (minimaxBaseUrl) {
        customEndpoint = buildEndpointOverride(minimaxBaseUrl, 'minimax-subscription');
      } else {
        logger?.warn('Ignoring invalid MiniMax subscription resource URL');
      }
    } else if (providerRegion === 'cn') {
      customEndpoint = buildEndpointOverride(
        `${MINIMAX_BASE_URLS.cn}/anthropic/v1`,
        'minimax-subscription',
      );
    }
  } else if (authType === 'subscription' && lower === 'zai' && providerRegion === 'cn') {
    customEndpoint = buildEndpointOverride(getZaiCodingPlanBaseUrl('cn'), 'zai-subscription');
  } else if (
    authType === 'subscription' &&
    isXiaomiProviderId(lower) &&
    isXiaomiTokenPlanRegion(providerRegion)
  ) {
    customEndpoint = buildEndpointOverride(
      getXiaomiTokenPlanBaseUrl(providerRegion),
      'xiaomi-subscription',
    );
  }

  return { customEndpoint, forwardModel };
}
