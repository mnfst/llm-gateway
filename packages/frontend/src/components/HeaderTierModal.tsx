import { createMemo, createResource, createSignal, For, Show, type Component } from 'solid-js';
import { TIER_COLORS, type TierColor } from 'manifest-shared';
import HeaderComboBox, { type HeaderSuggestion } from './HeaderComboBox.js';
import {
  createHeaderTier,
  getSeenHeaders,
  setHeaderTierResponseMode,
  setHeaderTierStreamWarmup,
  updateHeaderTier,
  type HeaderTier,
  type SeenHeader,
} from '../services/api/header-tiers.js';
import { toast } from '../services/toast-store.js';
import type { AvailableModel, ModelCapability, ResponseMode } from '../services/api.js';

const RESERVED_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
]);
const HEADER_KEY_RE = /^[a-z0-9-]+$/;
const MAX_NAME_LEN = 32;
const MAX_HEADER_VALUE_LEN = 128;

interface Props {
  agentName: string;
  existingTiers: HeaderTier[];
  /** When set, the modal is in edit mode and prefills from this tier. */
  editing?: HeaderTier;
  onClose: () => void;
  onSaved: (tier: HeaderTier) => void;
  /** When set, shows a back arrow instead of close button. */
  onBack?: () => void;
  /** When set and editing, shows a Delete tier button. */
  onDelete?: (id: string) => void;
  /** Available models for stream compatibility check. */
  models?: AvailableModel[];
}

const HeaderTierModal: Component<Props> = (props) => {
  const editingTier = props.editing;

  const [name, setName] = createSignal(editingTier?.name ?? '');
  const [headerKey, setHeaderKey] = createSignal(editingTier?.header_key ?? '');
  const [headerValue, setHeaderValue] = createSignal(editingTier?.header_value ?? '');
  const [badgeColor, setBadgeColor] = createSignal<TierColor>(
    (editingTier?.badge_color as TierColor | undefined) ?? 'indigo',
  );
  const [streamMode, setStreamMode] = createSignal<boolean>(
    editingTier?.response_mode === 'stream',
  );

  // Stream warmup override (ms). Empty string = inherit (provider -> global 15s default).
  const [streamWarmup, setStreamWarmup] = createSignal<string>(
    editingTier?.stream_warmup_ms != null ? String(editingTier.stream_warmup_ms) : '',
  );
  const [submitting, setSubmitting] = createSignal(false);
  const [triedSubmit, setTriedSubmit] = createSignal(false);

  const [seen] = createResource<SeenHeader[]>(() =>
    getSeenHeaders(props.agentName).catch(() => []),
  );

  // When editing, exclude the row being edited from uniqueness checks so its
  // own current values don't trip the "already exists" errors.
  const otherTiers = createMemo(() =>
    editingTier ? props.existingTiers.filter((t) => t.id !== editingTier.id) : props.existingTiers,
  );

  /** Models in this tier that don't support streaming. */
  const incompatibleModels = () => {
    if (!editingTier) return [];
    const caps = new Map<string, readonly ModelCapability[]>();
    for (const m of props.models ?? []) {
      if (m.capabilities) caps.set(m.model_name, m.capabilities);
    }
    const hasStream = (model: string) => caps.get(model)?.includes('stream') ?? false;
    const result: { model: string; position: string }[] = [];
    const route = editingTier.override_route;
    if (route && !hasStream(route.model)) {
      result.push({ model: route.model, position: 'Primary' });
    }
    for (const [i, fb] of (editingTier.fallback_routes ?? []).entries()) {
      if (!hasStream(fb.model)) {
        result.push({ model: fb.model, position: `Fallback ${i + 1}` });
      }
    }
    return result;
  };
  const canEnableStream = () => incompatibleModels().length === 0;

  const keySuggestions = (): HeaderSuggestion[] => {
    const rows = seen() ?? [];
    return rows
      .filter((r) => !RESERVED_KEYS.has(r.key))
      .map((r) => ({
        label: r.key,
        value: r.key,
        group: r.sdks[0],
        sublabel:
          r.top_values.length > 0
            ? `${r.count}× · ${r.top_values.slice(0, 3).join(' · ')}`
            : `${r.count}× seen`,
      }));
  };

  const valueSuggestions = (): HeaderSuggestion[] => {
    const key = headerKey().trim().toLowerCase();
    if (!key) return [];
    const row = (seen() ?? []).find((r) => r.key === key);
    return (row?.top_values ?? []).map((v) => ({ label: v, value: v }));
  };

  const validateName = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return 'Name is required';
    if (trimmed.length > MAX_NAME_LEN) return `Name must be ${MAX_NAME_LEN} characters or fewer`;
    const lower = trimmed.toLowerCase();
    if (otherTiers().some((t) => t.name.toLowerCase() === lower)) {
      return 'A tier with this name already exists';
    }
    return undefined;
  };

  const validateKey = (raw: string): string | undefined => {
    const key = raw.trim().toLowerCase();
    if (!key) return 'Header key is required';
    if (!HEADER_KEY_RE.test(key)) {
      return 'Header keys can only contain lowercase letters, digits, and hyphens';
    }
    if (RESERVED_KEYS.has(key)) {
      return "This header is stripped for security and can't be used as a match rule";
    }
    return undefined;
  };

  const validateValue = (rawValue: string, rawKey: string): string | undefined => {
    const v = rawValue.trim();
    if (!v) return 'Header value is required';
    if (v.length > MAX_HEADER_VALUE_LEN) {
      return `Header value must be ${MAX_HEADER_VALUE_LEN} characters or fewer`;
    }
    // Quotes and backslashes would break the rendered SDK snippets (Python/TS
    // wrap the value in `"..."`, cURL wraps it in `'...'`). Reject up front
    // instead of escaping inside every snippet generator.
    if (v.includes('"') || v.includes("'") || v.includes('\\')) {
      return 'Header value cannot contain quotes or backslashes';
    }
    const key = rawKey.trim().toLowerCase();
    if (otherTiers().some((t) => t.header_key === key && t.header_value === v)) {
      return 'Another tier already matches this header key and value';
    }
    return undefined;
  };

  const nameError = (): string | undefined => (triedSubmit() ? validateName(name()) : undefined);
  const keyError = (): string | undefined => (triedSubmit() ? validateKey(headerKey()) : undefined);
  const valueError = (): string | undefined =>
    triedSubmit() ? validateValue(headerValue(), headerKey()) : undefined;

  const isValid = (): boolean =>
    validateName(name()) === undefined &&
    validateKey(headerKey()) === undefined &&
    validateValue(headerValue(), headerKey()) === undefined;

  const submit = async (): Promise<void> => {
    setTriedSubmit(true);
    if (!isValid() || submitting()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name().trim(),
        header_key: headerKey().trim().toLowerCase(),
        header_value: headerValue().trim(),
        badge_color: badgeColor(),
      };
      // Validate stream warmup override before any persisting call so an
      // invalid value cannot leave a partially saved tier behind.
      const warmupRaw = streamWarmup().trim();
      let warmupVal: number | null = null;
      if (warmupRaw !== '') {
        const parsed = Number(warmupRaw);
        if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 120000) {
          throw new Error(
            'Stream timeout must be a whole number between 1,000 and 120,000 ms, or left blank to inherit.',
          );
        }
        warmupVal = parsed;
      }
      let saved = editingTier
        ? await updateHeaderTier(props.agentName, editingTier.id, payload)
        : await createHeaderTier(props.agentName, payload);
      // Persist response mode change if toggled
      const newMode: ResponseMode = streamMode() ? 'stream' : 'buffered';
      if (saved.response_mode !== newMode) {
        saved = await setHeaderTierResponseMode(props.agentName, saved.id, newMode);
      }
      // Persist stream warmup override if changed
      if (warmupVal !== (saved.stream_warmup_ms ?? null)) {
        saved = await setHeaderTierStreamWarmup(props.agentName, saved.id, warmupVal);
      }
      props.onSaved(saved);
      props.onClose();
    } catch (err) {
      const fallback = editingTier ? 'Failed to update tier' : 'Failed to create tier';
      toast.error(err instanceof Error ? err.message : fallback);
    } finally {
      setSubmitting(false);
    }
  };

  const titleText = editingTier ? 'Edit custom tier' : 'Create custom tier';
  const descText = editingTier
    ? 'Update the header rule, name, or color for this tier. Model and fallbacks are managed on the card.'
    : 'Custom routing lets you identify requests based on their headers and assign specific models to them.';
  const submitLabel = (): string => {
    if (editingTier) return submitting() ? 'Saving…' : 'Save changes';
    return submitting() ? 'Creating…' : 'Create tier';
  };

  return (
    <div class="modal-overlay header-tier-modal-backdrop" onClick={props.onClose}>
      <div
        class="modal-card header-tier-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-tier-modal-title"
        style={{ position: 'relative' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.defaultPrevented && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape' && !e.defaultPrevented) props.onClose();
        }}
      >
        <Show
          when={props.onBack}
          fallback={
            <button
              type="button"
              class="modal__close header-tier-modal__close"
              onClick={props.onClose}
              aria-label="Close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="m9.17 13.41-3.54 3.54a.996.996 0 0 0 .71 1.7c.26 0 .51-.1.71-.29l2.83-2.83L12 13.41l2.83 2.83 2.12 2.12c.2.2.45.29.71.29s.51-.1.71-.29a.996.996 0 0 0 0-1.41l-3.54-3.54L13.42 12l4.95-4.95a.996.996 0 1 0-1.41-1.41l-4.95 4.95-4.95-4.95a.996.996 0 1 0-1.41 1.41L10.6 12l-1.41 1.41Z" />
              </svg>
            </button>
          }
        >
          <button type="button" class="modal-back-btn" onClick={props.onBack} aria-label="Back">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M14.71 7.29a.996.996 0 0 0-1.41 0l-4 4a.996.996 0 0 0 0 1.41l4 4c.2.2.45.29.71.29s.51-.1.71-.29a.996.996 0 0 0 0-1.41L11.43 12l3.29-3.29a.996.996 0 0 0 0-1.41Z" />
            </svg>
          </button>
        </Show>
        <h2 class="modal-card__title" id="header-tier-modal-title">
          {titleText}
        </h2>
        <p class="modal-card__desc">{descText}</p>

        <label class="modal-card__field-label" for="header-tier-name">
          Tier name
        </label>
        <input
          ref={(el) => requestAnimationFrame(() => el.focus())}
          id="header-tier-name"
          class="modal-card__input"
          classList={{ 'modal-card__input--error': nameError() !== undefined }}
          type="text"
          value={name()}
          placeholder="My custom tier"
          maxlength={MAX_NAME_LEN}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <Show when={nameError()}>
          <div class="header-tier-modal__error">{nameError()}</div>
        </Show>

        <label class="modal-card__field-label" for="header-tier-key">
          Header key
        </label>
        <HeaderComboBox
          id="header-tier-key"
          value={headerKey()}
          onInput={setHeaderKey}
          suggestions={keySuggestions()}
          placeholder="x-manifest-tier"
          invalid={keyError() !== undefined}
          errorMessage={keyError()}
          freeFormHint={`Use "${headerKey().trim()}" as a custom header`}
        />

        <label class="modal-card__field-label" for="header-tier-value">
          Header value
        </label>
        <HeaderComboBox
          id="header-tier-value"
          value={headerValue()}
          onInput={setHeaderValue}
          suggestions={valueSuggestions()}
          placeholder="custom-value"
          invalid={valueError() !== undefined}
          errorMessage={valueError()}
          disabled={!headerKey().trim()}
          freeFormHint={`Use "${headerValue().trim()}" as a custom value`}
        />

        <div class="modal-card__field-label">Badge color</div>
        <div class="header-tier-modal__swatches" role="radiogroup" aria-label="Badge color">
          <For each={TIER_COLORS}>
            {(c) => (
              <button
                type="button"
                role="radio"
                aria-checked={badgeColor() === c}
                aria-label={c}
                class="header-tier-modal__swatch"
                classList={{
                  [`header-tier-modal__swatch--${c}`]: true,
                  'header-tier-modal__swatch--active': badgeColor() === c,
                }}
                onClick={() => setBadgeColor(c)}
              />
            )}
          </For>
        </div>

        <div class="response-mode-modal__field-header" style="margin-top: 16px;">
          <span class="response-mode-modal__field-title">Stream mode</span>
          <button
            class="routing-switch"
            classList={{
              'routing-switch--on': streamMode(),
              'routing-switch--disabled': !streamMode() && !canEnableStream(),
            }}
            disabled={!streamMode() && !canEnableStream()}
            onClick={() => {
              if (streamMode()) setStreamMode(false);
              else if (canEnableStream()) setStreamMode(true);
            }}
          >
            <span class="routing-switch__track">
              <span class="routing-switch__thumb" />
            </span>
          </button>
        </div>
        <Show
          when={streamMode()}
          fallback={
            <p class="response-mode-modal__desc">
              Responses are returned as a single payload once the model finishes generating.
            </p>
          }
        >
          <p class="response-mode-modal__desc">
            Responses are streamed token by token as the model generates them.
          </p>
        </Show>
        <Show when={!streamMode() && incompatibleModels().length > 0}>
          <div class="response-mode-modal__blocker" style="margin-top: 8px;">
            <p class="response-mode-modal__blocker-text">
              {incompatibleModels().length === 1 ? 'This model does' : 'These models do'} not
              support streaming. Change {incompatibleModels().length === 1 ? 'it' : 'them'} to
              enable stream mode.
            </p>
            <div class="response-mode-modal__blocker-list">
              <For each={incompatibleModels()}>
                {(item) => (
                  <div class="response-mode-modal__blocker-row">
                    <span class="response-mode-modal__blocker-model">{item.model}</span>
                    <span class="response-mode-modal__blocker-meta">{item.position}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <label
          class="modal-card__field-label"
          for="header-tier-warmup"
          style="margin-top: 16px; display: block;"
        >
          Stream timeout (ms)
        </label>
        <input
          id="header-tier-warmup"
          class="modal-card__input"
          type="number"
          min={1000}
          max={120000}
          step={1000}
          value={streamWarmup()}
          placeholder="15000 (default)"
          onInput={(e) => setStreamWarmup(e.currentTarget.value)}
        />
        <p class="response-mode-modal__desc">
          How long to wait for the first token before failing over. Leave blank to inherit the
          provider setting, then the global default (15s). Raise this only for tiers that route to
          local or JIT-loaded models — e.g. 60000 for cold model loads.
        </p>

        <div class="header-tier-modal__footer">
          <Show when={editingTier && props.onDelete}>
            <button
              type="button"
              class="btn btn--outline header-tier-modal__delete-btn"
              onClick={() => {
                if (confirm(`Delete tier "${editingTier!.name}"?`)) {
                  props.onDelete!(editingTier!.id);
                }
              }}
            >
              Delete tier
            </button>
          </Show>
          <div class="header-tier-modal__footer-right">
            <Show when={!props.onBack}>
              <button type="button" class="btn btn--ghost" onClick={props.onClose}>
                Cancel
              </button>
            </Show>
            <button type="button" class="btn btn--primary" disabled={submitting()} onClick={submit}>
              {submitLabel()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeaderTierModal;
