import {
  compareProviderParamSpecs,
  expandConfiguredParamDefaults,
  getProviderParamValue,
  omitProviderInapplicableParams,
  providerParamIsApplicable,
  setProviderParamValue,
  type ProviderParamSpec,
} from './provider-params-spec';
import type { JsonValue, RequestParamDefaults } from './request-params';

/**
 * Snapshot which model parameters were effectively in play for a provider
 * attempt. Values are UI/storage values, not provider-specific serialized
 * wire fragments.
 */
export interface RequestParamsSnapshotInput {
  /** The inbound request body before model-param defaults are merged. */
  body: Record<string, unknown>;
  /** Saved params for the resolved route scope, if any. */
  modelParams: RequestParamDefaults | null | undefined;
  /** MPS catalog specs for the resolved provider/auth/model. */
  specs: readonly ProviderParamSpec[];
}

export function snapshotRequestParams(
  input: RequestParamsSnapshotInput,
): RequestParamDefaults | null {
  const { body, modelParams, specs } = input;
  const orderedSpecs = [...specs].sort(compareProviderParamSpecs);
  const expandedParams = modelParams
    ? expandConfiguredParamDefaults(modelParams, orderedSpecs)
    : null;
  let out: RequestParamDefaults = {};

  for (const spec of orderedSpecs) {
    if (expandedParams && hasPath(expandedParams, spec.path)) {
      out = setProviderParamValue(
        out,
        spec.path,
        getProviderParamValue(expandedParams, spec.path) as JsonValue,
      );
      continue;
    }
    if (hasPath(body, spec.path)) {
      out = setProviderParamValue(out, spec.path, getPath(body, spec.path) as JsonValue);
      continue;
    }
    if (spec.default !== undefined && providerParamIsApplicable(spec, out)) {
      out = setProviderParamValue(out, spec.path, spec.default);
    }
  }

  const effective = addSpeclessKnobs(
    omitProviderInapplicableParams(out, orderedSpecs),
    body,
    orderedSpecs,
  );
  return Object.keys(effective).length > 0 ? effective : null;
}

/**
 * Top-level body keys that are never model knobs: routing identity, message
 * content, tool definitions, and transport flags.
 */
const NON_KNOB_KEYS = new Set([
  'model',
  'messages',
  'input',
  'tools',
  'functions',
  'system',
  'instructions',
  'prompt',
  'metadata',
  'user',
  'stream',
  'stream_options',
]);

/** Longest string still plausibly a knob value rather than prompt content. */
const MAX_KNOB_STRING = 64;

/** Largest serialized structured knob (a schema-sized object is content, not a knob). */
const MAX_KNOB_JSON_CHARS = 2048;

/**
 * Keep the raw request's spec-less knobs. The spec walk above only records
 * params the MPS catalog knows for the resolved route, but a param without a
 * spec still reaches the provider verbatim — and when the provider rejects it,
 * a snapshot that silently omitted it hides the very knob that caused the
 * failure (a caller-sent `temperature` on a model whose catalog entry dropped
 * the knob left a snapshot showing only `thinking`/`max_tokens` while the wire
 * error said temperature). The snapshot is body-first: everything the caller
 * sent is recorded except content (the key denylist) and anything content-sized
 * ({@link knobValueFits}) — the catalog's role is confined to the params it
 * knows (saved-param overrides, defaults, applicability), never to deciding
 * whether a caller-sent knob existed.
 */
function addSpeclessKnobs(
  effective: RequestParamDefaults,
  body: Record<string, unknown>,
  specs: readonly ProviderParamSpec[],
): RequestParamDefaults {
  const specRoots = new Set(specs.map((spec) => spec.path.split('.')[0]));
  let out = effective;
  for (const [key, value] of Object.entries(body)) {
    if (specRoots.has(key) || NON_KNOB_KEYS.has(key)) continue;
    // setProviderParamValue reads the key as a dotted path — a literal dotted
    // key would be recorded as a nested object, so skip rather than mangle.
    if (key.includes('.')) continue;
    if (!knobValueFits(value)) continue;
    out = setProviderParamValue(out, key, value as JsonValue);
  }
  return out;
}

/**
 * A knob value is any scalar or small structure whose every string leaf is
 * knob-sized. The leaf rule is what keeps content out of structured values — a
 * `response_format: { type: 'json_object' }` fits, an object smuggling a prompt
 * in a nested string does not.
 */
function knobValueFits(value: unknown): boolean {
  if (value === null) return true; // an explicit null is part of the raw request
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= MAX_KNOB_STRING;
  if (Array.isArray(value) || isRecord(value)) {
    if (JSON.stringify(value).length > MAX_KNOB_JSON_CHARS) return false;
    const leaves = Array.isArray(value) ? value : Object.values(value);
    return leaves.every(knobValueFits);
  }
  return false; // undefined, functions, symbols — not JSON, not a knob
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
