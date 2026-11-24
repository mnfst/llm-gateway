import { BadRequestException } from '@nestjs/common';
import {
  getProviderParamValue,
  pickProviderCompatibleParams,
  providerParamValueIsValid,
  type ProviderParamSpec,
  type RequestParamDefaults,
} from 'manifest-shared';

/**
 * Provider/key compatibility gate, driven by the single MPS provider
 * parameter catalog. Returns the params trimmed to the keys the provider
 * actually consumes — a partially incompatible payload still saves the
 * compatible part rather than throwing, matching the proxy's lenient merge
 * behavior.
 *
 * Throws when the payload is empty (no keys at all) or when no key is
 * compatible with the provider — those are user errors every surface
 * (dashboard, CLI, MCP) should surface, not silently swallow.
 *
 * Adding a new provider knob is one MPS entry; this function does not need
 * to change.
 */
export function sanitizeModelParams(
  provider: string,
  params: RequestParamDefaults,
  specs: readonly ProviderParamSpec[],
): RequestParamDefaults {
  const keys = Object.keys(params).filter(
    (k) => (params as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) {
    throw new BadRequestException('params must contain at least one configurable field');
  }
  const out = pickProviderCompatibleParams(params, specs);
  if (Object.keys(out).length === 0) {
    throw new BadRequestException(
      `Provider "${provider}" does not consume any of the supplied params`,
    );
  }
  for (const spec of specs) {
    const value = getProviderParamValue(out, spec.path);
    if (value !== undefined && !providerParamValueIsValid(spec, value)) {
      throw new BadRequestException(`Invalid value for param "${spec.path}"`);
    }
  }
  return out;
}
