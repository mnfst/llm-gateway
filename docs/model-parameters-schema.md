# MPS Schema

MPS stands for Model Parameters Schema.

This document defines the JSON language used by the model parameter schema
catalog. The catalog is metadata: it describes which request parameters Manifest
can configure for a provider/auth/model tuple. User-selected values still live in
`agent_model_params`.

The runtime source is the versioned `modelparams` npm package, generated from
the same modelparams.dev catalog. Manifest loads that package catalog at runtime
and keeps provider/auth/model route matching inside
`ProviderParamSpecService`.

The executable validator is `isParamApplicability` in
`packages/shared/src/provider-params-spec.ts`. Any schema change must update:

- this document
- the shared TypeScript types
- `isParamApplicability`
- the shared tests that prove invalid shapes are rejected

## Schema Entry

Each entry describes one provider/auth/model tuple and its available parameters.

```json
{
  "provider": "anthropic",
  "authType": "api_key",
  "model": "claude-haiku-4-5-20251001",
  "params": [
    {
      "path": "top_p",
      "type": "number",
      "label": "Top P",
      "description": "Controls nucleus sampling by limiting generation to tokens whose cumulative probability reaches this value.",
      "default": 1,
      "range": { "min": 0, "max": 1, "step": 0.01 },
      "group": "sampling",
      "applicability": {
        "except": [{ "thinking.type": ["adaptive", "enabled"] }, { "temperature": { "not": 1 } }]
      }
    }
  ]
}
```

Rules:

- `provider`, `authType`, and `model` identify exactly one model route.
- `params` is the non-empty list of parameters for that exact route.
- `path` is a dot path into stored params and outbound request params.
- `type` is semantic data type, not a UI control kind.
- `label` is user-facing copy.
- `description` is developer-facing explanatory copy for the raw parameter.
- `default` is the provider default Manifest should display when known.
- `values` is allowed only for finite choices.
- `range` describes numeric bounds and optional step.
- `group` is a semantic grouping for ordering and display.
- `applicability` is optional; omitted means always available.
- Do not add ad hoc rule fields such as `conflictsWith`, `disabledWhen`,
  `ui`, or provider-specific metadata. Express availability through
  `applicability`.

## Applicability

`applicability` controls whether a parameter is available for the current draft
or request params.

Only two top-level keys are allowed:

- `only`: the parameter is available only when the rule matches.
- `except`: the parameter is unavailable when the rule matches.

At least one of `only` or `except` must be present. Unknown keys are invalid.

### Rule Shape

A rule is either:

- one non-empty match object
- a non-empty array of match objects

Array rules are OR semantics. A single match object is AND semantics.

```json
{
  "except": [{ "thinking.type": ["adaptive", "enabled"] }, { "temperature": { "not": 1 } }]
}
```

This means: disable the param when `thinking.type` is `adaptive` or `enabled`,
or when `temperature` exists and is not `1`.

### Match Values

Each match key is a dot path. Each match value must be one of:

- JSON primitive: string, number, boolean, or null
- non-empty array of JSON primitives
- `{ "not": <primitive or non-empty primitive array> }`

Objects other than `{ "not": ... }` are invalid.
Empty arrays are invalid.
Empty match objects are invalid.

Examples:

```json
{ "thinking.type": "enabled" }
```

```json
{ "thinking.type": ["adaptive", "enabled"] }
```

```json
{ "temperature": { "not": 1 } }
```

## Evaluation Semantics

Evaluation uses the current params object after dot-path expansion.

For a normal match:

- primitive value matches by JSON equality
- array value matches if any primitive item equals the actual value
- missing paths do not match

For `{ "not": value }`:

- missing paths do not match
- present paths match when the actual value is not equal to `value`

For a param spec:

1. If `only` is present and does not match, the param is unavailable.
2. If `except` is present and matches, the param is unavailable.
3. Otherwise the param is available.

## Storage And Request Merge

Saved model params store UI values using the same dot-path shape as `path`.
They do not store derived UI state or provider-specific rule state.

The outbound proxy merge:

1. expands needed nested defaults for configured nested roots
2. merges configured Manifest values last, so Manifest values win for the same provider path
3. omits params that are not applicable under the final effective values

Client request body values that do not overlap configured Manifest model
params stay in the outbound provider request.

## Adding A New Rule

Prefer expressing new provider behavior with existing `applicability` syntax.

Add new schema syntax only when a provider rule cannot be represented with:

- exact match
- one-of match
- negated match
- OR of match objects
- AND within one match object

When extending the language, update the executable validator and add tests for
both accepted and rejected shapes in
`packages/shared/__tests__/provider-params-spec.spec.ts`.
