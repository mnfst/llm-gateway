import {
  compareProviderParamSpecs,
  deleteProviderParamValue,
  getProviderParamValue,
  providerParamIsApplicable,
  setProviderParamValue,
  type JsonValue,
  type ModelParamGroup,
  type ProviderParamSpec,
} from 'manifest-shared';
import { createEffect, createSignal, For, Show, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { RequestParamDefaults } from '../services/api.js';
import Select from './Select.jsx';

interface Props {
  open: boolean;
  slotLabel: string;
  current: RequestParamDefaults | null;
  specs: readonly ProviderParamSpec[];
  requestParamsUrl?: string;
  // True while the per-model specs are still being fetched (dialog opens
  // immediately, specs arrive async).
  loading?: boolean;
  onSave: (paramDefaults: RequestParamDefaults | null) => Promise<unknown>;
  onClose: () => void;
}

type DraftState = Record<string, JsonValue>;

const UNSET_OPTION_VALUE = '__manifest_param_unset__';

const GROUP_LABELS: Record<ModelParamGroup, string> = {
  generation_length: 'Generation length',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  tooling: 'Tooling',
  output_format: 'Output format',
  observability: 'Observability',
  provider_metadata: 'Provider metadata',
};

const trimTrailingPunct = (text: string): string => text.replace(/[.\s]+$/, '');

const GROUP_ORDER: readonly ModelParamGroup[] = [
  'generation_length',
  'sampling',
  'reasoning',
  'tooling',
  'output_format',
  'observability',
  'provider_metadata',
];

const stateFromCurrent = (
  specs: readonly ProviderParamSpec[],
  current: RequestParamDefaults | null,
): DraftState => {
  let draft: DraftState = {};
  for (const spec of specs) {
    if (spec.default !== undefined) {
      draft = setProviderParamValue(draft, spec.path, spec.default);
    }
  }
  if (!current) return draft;
  for (const spec of specs) {
    const stored = getProviderParamValue(current, spec.path);
    if (stored !== undefined) draft = setProviderParamValue(draft, spec.path, stored as JsonValue);
  }
  return draft;
};

// Paths the harness actually stores. Only these (and whatever the user edits)
// are saved: a value equal to the provider default is still an explicit choice.
const setPathsFromCurrent = (
  specs: readonly ProviderParamSpec[],
  current: RequestParamDefaults | null,
): Set<string> =>
  new Set(
    current
      ? specs
          .filter((spec) => getProviderParamValue(current, spec.path) !== undefined)
          .map((spec) => spec.path)
      : [],
  );

const groupSpecs = (specs: readonly ProviderParamSpec[]) =>
  GROUP_ORDER.map((group) => ({
    group,
    specs: specs.filter((spec) => spec.group === group).sort(compareProviderParamSpecs),
  })).filter((item) => item.specs.length > 0);

const valuesEqual = (a: unknown, b: unknown) =>
  typeof a === 'object' || typeof b === 'object'
    ? /* v8 ignore next -- current MPS entries compare primitives; keep defensive JsonValue equality. */
      JSON.stringify(a) === JSON.stringify(b)
    : a === b;

const clampNumber = (value: number, fallback: number, min?: number, max?: number): number => {
  if (!Number.isFinite(value)) return fallback;
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
};

const decimalPlaces = (value: number): number => {
  const text = String(value);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
};

const numberDefault = (spec: ProviderParamSpec): number =>
  typeof spec.default === 'number' ? spec.default : 0;

const ModelParamsDialog: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal<DraftState>(stateFromCurrent(props.specs, props.current));
  const [setPaths, setSetPaths] = createSignal<Set<string>>(
    setPathsFromCurrent(props.specs, props.current),
  );
  const [saving, setSaving] = createSignal(false);
  const hasSpecs = () => props.specs.length > 0;

  createEffect(() => {
    if (props.open) {
      setDraft(stateFromCurrent(props.specs, props.current));
      setSetPaths(setPathsFromCurrent(props.specs, props.current));
    }
  });

  const valueFor = (spec: ProviderParamSpec): JsonValue | undefined => {
    if (!providerParamIsApplicable(spec, draft())) {
      return spec.default as JsonValue | undefined;
    }
    const value = getProviderParamValue(draft(), spec.path);
    return (value === undefined ? spec.default : value) as JsonValue | undefined;
  };

  const isSet = (spec: ProviderParamSpec): boolean => setPaths().has(spec.path);

  const pathRoot = (path: string): string => path.split('.')[0] ?? path;

  // The proxy fills in the default of every applicable sibling under a nested
  // root that has a value set (e.g. thinking.budget_tokens with thinking.type),
  // so such a row is sent even though the user never set it.
  const sentWithRoot = (spec: ProviderParamSpec): boolean =>
    spec.path.includes('.') &&
    spec.default !== undefined &&
    props.specs.some(
      (other) =>
        other.path !== spec.path &&
        pathRoot(other.path) === pathRoot(spec.path) &&
        isSet(other) &&
        isApplicable(other),
    );

  const setValue = (spec: ProviderParamSpec, value: JsonValue) => {
    setDraft(setProviderParamValue(draft(), spec.path, value));
    setSetPaths(new Set([...setPaths(), spec.path]));
  };

  // Back to "not set": the client's value passes through. The draft keeps the
  // provider default so dependent params still evaluate their availability.
  const unsetValue = (spec: ProviderParamSpec) => {
    setDraft(
      spec.default === undefined
        ? deleteProviderParamValue(draft(), spec.path)
        : setProviderParamValue(draft(), spec.path, spec.default),
    );
    const next = new Set(setPaths());
    next.delete(spec.path);
    setSetPaths(next);
  };

  const isApplicable = (spec: ProviderParamSpec): boolean =>
    providerParamIsApplicable(spec, draft());
  const isDisabled = (spec: ProviderParamSpec): boolean => saving() || !isApplicable(spec);

  const labelForPath = (path: string): string =>
    props.specs.find((s) => s.path === path)?.label ?? path;

  const formatValueList = (values: readonly JsonValue[]): string => {
    const quoted = values.map((v) => `"${String(v)}"`);
    if (quoted.length === 1) return quoted[0]!;
    if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
    return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
  };

  const describeBlocker = (spec: ProviderParamSpec): string | null => {
    if (!spec.applicability) return null;
    const { only, except } = spec.applicability;
    if (only) {
      const rules = Array.isArray(only) ? only : [only];
      const rule = rules[0];
      if (!rule) return null;
      const parts = Object.entries(rule).map(([path, value]) => {
        const label = labelForPath(path);
        const list = Array.isArray(value) ? (value as readonly JsonValue[]) : [value as JsonValue];
        return `set ${label} to ${formatValueList(list)}`;
      });
      return `To configure this parameter, ${parts.join(' and ')}.`;
    }
    if (except) {
      const draftSnapshot = draft();
      const rules = Array.isArray(except) ? except : [except];
      const active = rules.find((rule) =>
        Object.entries(rule).every(([path, value]) => {
          const current = getProviderParamValue(draftSnapshot, path);
          if (Array.isArray(value))
            return (value as readonly JsonValue[]).includes(current as JsonValue);
          if (value !== null && typeof value === 'object' && 'not' in value) {
            const notVal = (value as { not: JsonValue | readonly JsonValue[] }).not;
            if (Array.isArray(notVal))
              return !(notVal as readonly JsonValue[]).includes(current as JsonValue);
            return current !== notVal;
          }
          return current === value;
        }),
      );
      if (!active) return null;
      const parts = Object.entries(active).map(([path, value]) => {
        const label = labelForPath(path);
        if (Array.isArray(value)) {
          return `${label} is ${formatValueList(value as readonly JsonValue[])}`;
        }
        if (value !== null && typeof value === 'object' && 'not' in value) {
          return `${label} is set to a custom value`;
        }
        return `${label} is "${String(value)}"`;
      });
      return `Unavailable while ${parts.join(' and ')}.`;
    }
    return null;
  };

  const canUnset = (spec: ProviderParamSpec): boolean => spec.default === undefined;

  const selectValue = (spec: ProviderParamSpec): string => {
    const value = valueFor(spec);
    if (value === undefined && canUnset(spec)) return UNSET_OPTION_VALUE;
    return typeof value === 'string' ? value : String(spec.default ?? '');
  };

  const selectOptions = (spec: ProviderParamSpec) => [
    ...(canUnset(spec) ? [{ label: 'None', value: UNSET_OPTION_VALUE }] : []),
    ...(spec.values ?? []).map((v) => ({ label: String(v), value: String(v) })),
  ];

  const numericValue = (spec: ProviderParamSpec): number => {
    const value = valueFor(spec);
    return typeof value === 'number' && Number.isFinite(value) ? value : numberDefault(spec);
  };

  const sliderStep = (spec: ProviderParamSpec): number => spec.range?.step ?? 1;

  const sliderValue = (raw: number, spec: ProviderParamSpec): number => {
    const min = spec.range?.min ?? 0;
    const max = spec.range?.max ?? 100;
    const step = sliderStep(spec);
    const snapped = Math.round((raw - min) / step) * step + min;
    const clamped = clampNumber(snapped, numberDefault(spec), min, max);
    return Number(clamped.toFixed(decimalPlaces(step)));
  };

  const ToggleRow = (spec: ProviderParamSpec) => {
    const currentValue = () => valueFor(spec);
    const values = () => (spec.values ?? []) as readonly JsonValue[];
    const onValue = () => values().find((v) => String(v) === 'enabled') ?? values()[0] ?? true;
    const offValue = () => values().find((v) => String(v) === 'disabled') ?? values()[1] ?? false;
    const isOn = () => valuesEqual(currentValue(), onValue());
    return (
      <button
        type="button"
        class="model-params__toggle"
        aria-pressed={isOn()}
        aria-label={`${spec.label}: ${String(currentValue())}`}
        disabled={isDisabled(spec)}
        onClick={() => setValue(spec, isOn() ? offValue() : onValue())}
      >
        <span class="provider-toggle__switch" classList={{ 'provider-toggle__switch--on': isOn() }}>
          <span class="provider-toggle__switch-thumb" />
        </span>
      </button>
    );
  };

  const SelectRow = (spec: ProviderParamSpec) => (
    <div class="model-params__field">
      <Select
        label={spec.label}
        options={selectOptions(spec)}
        value={selectValue(spec)}
        disabled={isDisabled(spec)}
        onChange={(v) => {
          if (v === UNSET_OPTION_VALUE && canUnset(spec)) {
            unsetValue(spec);
            return;
          }
          setValue(spec, v);
        }}
      />
    </div>
  );

  const SliderRow = (spec: ProviderParamSpec) => {
    const min = () => spec.range?.min ?? 0;
    const max = () => spec.range?.max ?? 100;
    const value = () => numericValue(spec);
    const setSliderVal = (next: number) => {
      if (isDisabled(spec)) return;
      setValue(spec, sliderValue(next, spec));
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDisabled(spec)) return;
      const step = sliderStep(spec);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSliderVal(value() - step);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSliderVal(value() + step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSliderVal(min());
      } else if (e.key === 'End') {
        e.preventDefault();
        setSliderVal(max());
      }
    };

    // Unset: the text box stays empty (default as placeholder) while the
    // thumb rests on the default, since a slider always needs a position.
    const text = () => (isSet(spec) ? String(value()) : '');
    let numberInputRef: HTMLInputElement | undefined;
    createEffect(() => {
      const next = text();
      if (numberInputRef && document.activeElement !== numberInputRef) {
        numberInputRef.value = next;
      }
    });

    const commitFromText = (raw: string) => {
      if (isDisabled(spec)) return;
      const normalized = raw.replace(',', '.').trim();
      if (normalized === '') {
        unsetValue(spec);
        return;
      }
      if (normalized === '-' || normalized === '.' || normalized === '-.') {
        return;
      }
      const parsed = Number.parseFloat(normalized);
      if (!Number.isFinite(parsed)) return;
      setValue(spec, sliderValue(parsed, spec));
    };

    return (
      <div
        class="model-params__slider-control"
        classList={{ 'model-params__slider-field--disabled': isDisabled(spec) }}
      >
        <input
          ref={(el) => {
            numberInputRef = el;
            if (el) el.value = text();
          }}
          type="text"
          inputmode="decimal"
          class="model-params__number model-params__number--slider"
          placeholder={String(value())}
          disabled={isDisabled(spec)}
          aria-label={`${spec.label} value`}
          onBlur={(e) => (e.currentTarget.value = text())}
          onInput={(e) => commitFromText(e.currentTarget.value)}
        />
        <div class="model-params__slider-field">
          <div class="model-params__slider-track-wrapper">
            <div class="model-params__slider-track-bg" />
            <For each={[0, 25, 50, 75, 100]}>
              {(pct) => (
                <span
                  class="model-params__slider-tick"
                  style={`left: calc(6px + (100% - 12px) * ${pct} / 100)`}
                />
              )}
            </For>
            <input
              type="range"
              class="model-params__slider"
              min={min()}
              max={max()}
              step={sliderStep(spec)}
              value={value()}
              disabled={isDisabled(spec)}
              aria-label={spec.label}
              aria-disabled={isDisabled(spec)}
              onInput={(e) => setSliderVal(Number.parseFloat(e.currentTarget.value))}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div class="model-params__slider-bounds">
            <span class="model-params__slider-bound">{min()}</span>
            <span class="model-params__slider-bound">{max()}</span>
          </div>
        </div>
      </div>
    );
  };

  const NumberRow = (spec: ProviderParamSpec) => {
    const value = () => (isSet(spec) ? numericValue(spec) : '');
    const setFromInput = (raw: string) => {
      if (isDisabled(spec)) return;
      if (raw.trim() === '') {
        unsetValue(spec);
        return;
      }
      const parsed = Number.parseFloat(raw);
      const clamped = clampNumber(parsed, numberDefault(spec), spec.range?.min, spec.range?.max);
      setValue(spec, spec.type === 'integer' ? Math.trunc(clamped) : clamped);
    };
    return (
      <input
        class="model-params__number"
        type="number"
        min={spec.range?.min}
        max={spec.range?.max}
        value={value()}
        placeholder={spec.default === undefined ? 'Not set' : String(spec.default)}
        disabled={isDisabled(spec)}
        aria-label={spec.label}
        onInput={(e) => setFromInput(e.currentTarget.value)}
      />
    );
  };

  const renderControl = (spec: ProviderParamSpec) => {
    if (spec.type === 'boolean') return ToggleRow(spec);
    if (spec.type === 'enum') {
      const values = spec.values?.map(String) ?? [];
      if (values.length === 2 && values.includes('enabled') && values.includes('disabled')) {
        return ToggleRow(spec);
      }
      return SelectRow(spec);
    }
    if ((spec.type === 'integer' || spec.type === 'number') && spec.range?.max !== undefined) {
      return SliderRow(spec);
    }
    return NumberRow(spec);
  };

  const handleSave = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      let out: RequestParamDefaults = {};
      const nestedRootsWithOverrides = new Set(
        props.specs
          .filter((spec) => spec.path.includes('.'))
          .filter((spec) => isApplicable(spec))
          .filter((spec) => isSet(spec))
          .map((spec) => spec.path.split('.')[0]),
      );

      for (const spec of props.specs) {
        if (!isApplicable(spec)) continue;
        const value = valueFor(spec);
        if (value === undefined) continue;
        const root = spec.path.split('.')[0];
        const includeNestedDefault =
          spec.path.includes('.') && nestedRootsWithOverrides.has(root) && value !== undefined;
        if (includeNestedDefault || isSet(spec)) {
          out = setProviderParamValue(out, spec.path, value);
        }
      }

      await props.onSave(Object.keys(out).length === 0 ? null : out);
      props.onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !saving()) props.onClose();
  };

  const ParamRow = (rowProps: { spec: ProviderParamSpec }) => {
    const spec = () => rowProps.spec;
    const description = () => trimTrailingPunct(spec().description) + '.';
    const defaultLabel = () => (spec().default === undefined ? 'none' : String(spec().default));
    return (
      <div
        class="model-params__row"
        classList={{ 'model-params__row--disabled': !isApplicable(spec()) }}
      >
        <div class="model-params__row-text">
          <div class="model-params__label-title">
            <span>{spec().label}</span>
            <code class="model-params__param-key">{spec().path}</code>
            <Show when={!isApplicable(spec()) && describeBlocker(spec())}>
              {(message) => (
                <span class="model-params__help" tabIndex={0} aria-label={message()}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8" />
                    <path d="M11 16h2v2h-2zm2.27-9.75c-2.08-.75-4.47.35-5.21 2.41l1.88.68c.18-.5.56-.9 1.07-1.13s1.08-.26 1.58-.08a2.01 2.01 0 0 1 1.32 1.86c0 1.04-1.66 1.86-2.24 2.07-.4.14-.67.52-.67.94v1h2v-.34c1.04-.51 2.91-1.69 2.91-3.68a4.015 4.015 0 0 0-2.64-3.73" />
                  </svg>
                  <span class="model-params__help-tooltip" role="tooltip">
                    {message()}
                  </span>
                </span>
              )}
            </Show>
          </div>
          <div class="model-params__label-hint">{description()}</div>
          <div class="model-params__default-hint">
            Default: {defaultLabel()}
            <Show when={isApplicable(spec())}>
              {' · '}
              <Show
                when={isSet(spec())}
                fallback={
                  sentWithRoot(spec()) ? `Default sent with ${pathRoot(spec().path)}` : 'Not set'
                }
              >
                Set{' · '}
                <button
                  type="button"
                  class="model-params__reset"
                  disabled={saving()}
                  aria-label={`Reset ${spec().label}`}
                  onClick={() => unsetValue(spec())}
                >
                  Reset
                </button>
              </Show>
            </Show>
          </div>
        </div>
        <div class="model-params__row-control">{renderControl(spec())}</div>
      </div>
    );
  };

  return (
    <Portal>
      <Show when={props.open}>
        <div
          class="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving()) props.onClose();
          }}
        >
          <div
            class="modal-card model-params__dialog model-params-modal"
            classList={{ 'model-params-modal--empty': !props.loading && !hasSpecs() }}
            style="user-select: none;"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-params-dialog-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            <h2 class="modal-card__title" id="model-params-dialog-title">
              Model parameters
            </h2>
            <p class="modal-card__desc">
              {props.loading
                ? `Loading parameters for ${props.slotLabel}…`
                : hasSpecs()
                  ? `Values you set override the client's request for ${props.slotLabel}; unset ones keep the client's value. Requests that name a model instead of auto skip them.`
                  : `No parameter controls are published for ${props.slotLabel} yet.`}
            </p>

            <div class="model-params__body">
              <Show
                when={!props.loading}
                fallback={
                  <div class="model-params__status">
                    <span class="spinner" />
                    <span>Loading parameters…</span>
                  </div>
                }
              >
                <Show
                  when={hasSpecs()}
                  fallback={
                    <div class="model-params__empty">
                      <Show
                        when={props.requestParamsUrl}
                        fallback={
                          <p class="model-params__status">
                            This model has no configurable parameters.
                          </p>
                        }
                      >
                        <a
                          class="btn btn--outline btn--sm model-params__empty-link"
                          href={props.requestParamsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Request model parameters for ${props.slotLabel}`}
                        >
                          Request parameters for this model
                        </a>
                      </Show>
                    </div>
                  }
                >
                  <For each={groupSpecs(props.specs)}>
                    {(group) => (
                      <div class="model-params__group">
                        <div class="model-params__group-header">
                          <span>{GROUP_LABELS[group.group]}</span>
                        </div>
                        <div class="model-params__group-card">
                          <For each={group.specs}>
                            {(spec, index) => (
                              <>
                                <Show when={index() > 0}>
                                  <div class="model-params__separator" />
                                </Show>
                                <ParamRow spec={spec} />
                              </>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </div>

            <div class="modal-card__footer model-params__footer">
              <Show when={!props.loading && hasSpecs() && props.requestParamsUrl}>
                <a
                  class="model-params__request-link"
                  href={props.requestParamsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Request parameters for ${props.slotLabel}`}
                >
                  Request
                </a>
              </Show>
              <div class="model-params__footer-actions">
                <button
                  class="btn btn--ghost btn--sm"
                  onClick={props.onClose}
                  disabled={saving()}
                  type="button"
                >
                  {!props.loading && hasSpecs() ? 'Cancel' : 'Close'}
                </button>
                <Show when={!props.loading && hasSpecs()}>
                  <button
                    class="btn btn--primary btn--sm"
                    onClick={handleSave}
                    disabled={saving()}
                    type="button"
                  >
                    {saving() ? <span class="spinner" /> : 'Save'}
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  );
};

export default ModelParamsDialog;
