import {
  compareProviderParamSpecs,
  expandConfiguredParamDefaults,
  omitProviderInapplicableParams,
  providerParamIsApplicable,
  setProviderParamValue,
  type ProviderParamSpec,
} from './provider-params-spec';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Per-route UI/storage values shaped by `ProviderParamSpec.path`. */
export type RequestParamDefaults = Record<string, JsonValue>;

/**
 * Merge configured Manifest params into a request body using the route's
 * param specs. Storage stays as UI values. The provider wire shape is the
 * same path shape unless a future provider needs a dedicated transformer.
 */
export function applyRequestParamDefaults<T extends Record<string, unknown>>(
  body: T,
  defaults: RequestParamDefaults | null | undefined,
  specs: readonly ProviderParamSpec[],
): T {
  return applyRequestParamDefaultsWithOverrides(body, defaults, specs).body;
}

/** Keep the saved overrides separate from caller input for protocol adapters. */
export function applyRequestParamDefaultsWithOverrides<T extends Record<string, unknown>>(
  body: T,
  defaults: RequestParamDefaults | null | undefined,
  specs: readonly ProviderParamSpec[],
): { body: T; overrides?: RequestParamDefaults } {
  const orderedSpecs = [...specs].sort(compareProviderParamSpecs);
  if (!defaults) return { body: omitProviderInapplicableParams(body, orderedSpecs) };

  const expanded = expandConfiguredParamDefaults(defaults, orderedSpecs);
  let overrides: RequestParamDefaults = {};
  for (const spec of orderedSpecs) {
    if (!providerParamIsApplicable(spec, expanded)) continue;
    if (!hasPath(expanded, spec.path)) continue;
    overrides = setProviderParamValue(
      overrides,
      spec.path,
      getPath(expanded, spec.path) as JsonValue,
    );
  }

  return {
    body: omitProviderInapplicableParams(deepMerge(body, overrides), orderedSpecs) as T,
    overrides,
  };
}

function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredCloneRecord(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (isRecord(value) && isRecord(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function getPath(values: Record<string, unknown>, path: string): unknown {
  let current: unknown = values;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasPath(values: Record<string, unknown>, path: string): boolean {
  let current: unknown = values;
  const segments = path.split('.');
  for (let i = 0; i < segments.length; i++) {
    if (!isRecord(current) || !(segments[i] in current)) return false;
    current = current[segments[i]];
  }
  return true;
}

function structuredCloneRecord<T extends Record<string, unknown>>(
  value: T,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
