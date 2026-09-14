import { createResource, createSignal, Index, Show, type Component } from 'solid-js';
import { deriveCustomProviderAlias, normalizeCustomProviderAlias } from 'manifest-shared';
import {
  createCustomProvider,
  deleteCustomProvider,
  probeCustomProvider,
  updateCustomProvider,
  type CustomProviderApiKind,
  type CustomProviderModel,
  type CustomProviderData,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { checkIsSelfHosted } from '../services/setup-status.js';
import type { CustomProviderPrefill } from '../services/routing-params.js';
import InfoTooltip from './InfoTooltip.jsx';

const BASE_URL_PLACEHOLDERS: Record<CustomProviderApiKind, string> = {
  openai: 'https://api.example.com/v1',
  anthropic: 'https://api.anthropic.com',
};

interface Props {
  agentName: string;
  onCreated: () => void;
  onBack: () => void;
  initialData?: CustomProviderData;
  prefill?: CustomProviderPrefill;
  onDeleted?: () => void;
}

interface ModelRow {
  model_name: string;
  input_price: string;
  output_price: string;
  price_estimated: boolean;
}

const ESTIMATED_PRICE_TOOLTIP = 'Estimated price. This may not be accurate.';

const emptyRow = (): ModelRow => ({
  model_name: '',
  input_price: '',
  output_price: '',
  price_estimated: false,
});

const toModelRows = (models: CustomProviderModel[] | undefined): ModelRow[] =>
  (models ?? []).map((m) => ({
    model_name: m.model_name,
    input_price:
      m.input_price_per_million_tokens != null ? String(m.input_price_per_million_tokens) : '',
    output_price:
      m.output_price_per_million_tokens != null ? String(m.output_price_per_million_tokens) : '',
    price_estimated: m.price_estimated === true,
  }));

const CustomProviderForm: Component<Props> = (props) => {
  const isEdit = () => !!props.initialData;

  const prefillRows = (): ModelRow[] => {
    if (!props.prefill?.models?.length) return [emptyRow()];
    return props.prefill.models.map((m) => ({
      model_name: m.model_name,
      input_price: m.input_price ?? '',
      output_price: m.output_price ?? '',
      price_estimated: false,
    }));
  };

  const [name, setName] = createSignal(props.initialData?.name ?? props.prefill?.name ?? '');
  // The alias follows the name while creating, until the user edits it by
  // hand. In edit mode it is the stored value: a rename must never rewrite
  // the model ids clients already use.
  const [alias, setAlias] = createSignal(
    props.initialData ? (props.initialData.alias ?? '') : (deriveCustomProviderAlias(name()) ?? ''),
  );
  const [aliasTouched, setAliasTouched] = createSignal(isEdit());
  const normalizedAlias = () => normalizeCustomProviderAlias(alias());
  const modelIdPreview = () =>
    normalizedAlias() ? `${normalizedAlias()}/<model>` : 'custom:<provider-id>/<model>';
  const [baseUrl, setBaseUrl] = createSignal(
    props.initialData?.base_url ?? props.prefill?.baseUrl ?? '',
  );
  const [apiKind, setApiKind] = createSignal<CustomProviderApiKind>(
    props.initialData?.api_kind ?? 'openai',
  );
  const [apiKey, setApiKey] = createSignal(props.prefill?.apiKey ?? '');
  const [streamWarmupMs, setStreamWarmupMs] = createSignal<string>(
    props.initialData?.stream_warmup_ms != null ? String(props.initialData.stream_warmup_ms) : '',
  );
  const [editingKey, setEditingKey] = createSignal(false);
  const [rows, setRows] = createSignal<ModelRow[]>(
    props.initialData ? toModelRows(props.initialData.models) : prefillRows(),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [probeBusy, setProbeBusy] = createSignal(false);
  const [probeError, setProbeError] = createSignal<string | null>(null);
  const [isSelfHosted] = createResource(() => checkIsSelfHosted());

  const handleProbe = async () => {
    const url = baseUrl().trim();
    if (!url) {
      setProbeError('Enter a base URL first');
      return;
    }
    setProbeBusy(true);
    setProbeError(null);
    try {
      const { models } = await probeCustomProvider(
        props.agentName,
        url,
        apiKey().trim() || undefined,
        apiKind(),
        name().trim() || undefined,
      );
      if (models.length === 0) {
        setProbeError('Server returned no models');
        return;
      }
      setRows(toModelRows(models));
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : 'Probe failed');
    } finally {
      setProbeBusy(false);
    }
  };

  const updateRow = (
    index: number,
    field: 'model_name' | 'input_price' | 'output_price',
    value: string,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, [field]: value, price_estimated: false } : r)),
    );
  };

  const addRow = () => setRows((prev) => [...prev, emptyRow()]);

  const removeRow = (index: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const validModels = () => rows().filter((r) => r.model_name.trim());
  const hasEstimatedPrices = () => rows().some((r) => r.price_estimated);

  const canSubmit = () => name().trim() && baseUrl().trim() && validModels().length > 0 && !busy();

  const parsePrice = (v: string): number => Number(v.replace(',', '.'));

  const buildModels = (): CustomProviderModel[] =>
    validModels().map((r) => ({
      model_name: r.model_name.trim(),
      ...(r.input_price !== ''
        ? { input_price_per_million_tokens: parsePrice(r.input_price) }
        : {}),
      ...(r.output_price !== ''
        ? { output_price_per_million_tokens: parsePrice(r.output_price) }
        : {}),
      ...(r.price_estimated && (r.input_price !== '' || r.output_price !== '')
        ? { price_estimated: true }
        : {}),
    }));

  const handleCreate = async () => {
    setError(null);
    setBusy(true);
    try {
      await createCustomProvider(props.agentName, {
        name: name().trim(),
        alias: normalizedAlias(),
        base_url: baseUrl().trim(),
        api_kind: apiKind(),
        apiKey: apiKey().trim() || undefined,
        models: buildModels(),
      });
      toast.success(`${name().trim()} connected`);
      props.onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create provider');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    setError(null);
    const warmRaw = streamWarmupMs().trim();
    const warm = warmRaw === '' ? null : Math.round(Number(warmRaw));
    const data: Record<string, unknown> = {
      name: name().trim(),
      alias: normalizedAlias(),
      base_url: baseUrl().trim(),
      models: buildModels(),
      stream_warmup_ms:
        warm !== null && Number.isFinite(warm) && warm >= 1000 && warm <= 120000 ? warm : null,
    };
    if (editingKey()) {
      data.apiKey = apiKey().trim() || undefined;
    }

    setBusy(true);
    try {
      await updateCustomProvider(props.agentName, props.initialData!.id, data as never);
      toast.success(`${name().trim()} updated`);
      props.onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update provider');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await deleteCustomProvider(props.agentName, props.initialData!.id);
      toast.success(`${props.initialData!.name} removed`);
      props.onDeleted?.();
    } catch {
      // error toast from fetchMutate
    } finally {
      setBusy(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleSubmit = () => {
    if (isEdit()) handleUpdate();
    else handleCreate();
  };

  return (
    <div class="provider-detail">
      <button class="modal-back-btn" onClick={props.onBack} aria-label="Back to providers">
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

      <div class="routing-modal__header" style="border: none; padding: 0; margin-bottom: 20px;">
        <div>
          <div class="routing-modal__title">
            {isEdit() ? 'Edit custom provider' : 'Add custom provider'}
          </div>
          <div class="routing-modal__subtitle">
            Connect any OpenAI- or Anthropic-compatible endpoint
          </div>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit()) handleSubmit();
        }}
      >
        <div class="provider-detail__field">
          <label class="provider-detail__label" for="cp-name">
            Provider name
          </label>
          <input
            ref={(el) => requestAnimationFrame(() => el.focus())}
            id="cp-name"
            class="provider-detail__input"
            type="text"
            placeholder="e.g. Groq, Together, Azure"
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              if (!aliasTouched()) setAlias(deriveCustomProviderAlias(e.currentTarget.value) ?? '');
              setError(null);
            }}
          />
        </div>

        <div class="provider-detail__field">
          <label class="provider-detail__label" for="cp-alias">
            Alias
          </label>
          <input
            id="cp-alias"
            class="provider-detail__input"
            type="text"
            placeholder="e.g. vercel-ai-gateway"
            value={alias()}
            onInput={(e) => {
              setAlias(e.currentTarget.value);
              setAliasTouched(true);
              setError(null);
            }}
          />
          <div class="provider-detail__hint" data-testid="cp-alias-hint">
            Models are listed as <code>{modelIdPreview()}</code> in <code>/v1/models</code>.
            <Show when={isEdit()}> Changing the alias changes the model ids your clients use.</Show>
          </div>
        </div>

        <fieldset
          class="provider-detail__format"
          aria-describedby="cp-format-help"
          disabled={isEdit()}
        >
          <legend class="provider-detail__format-legend">API format</legend>
          <div class="provider-detail__format-options" role="radiogroup">
            <label
              class={`provider-detail__format-option${
                apiKind() === 'openai' ? ' provider-detail__format-option--active' : ''
              }${isEdit() ? ' provider-detail__format-option--disabled' : ''}`}
            >
              <input
                type="radio"
                name="cp-api-format"
                value="openai"
                checked={apiKind() === 'openai'}
                disabled={isEdit()}
                onChange={() => setApiKind('openai')}
              />
              <span class="provider-detail__format-option-title">OpenAI</span>
              <span class="provider-detail__format-option-path">/v1/chat/completions</span>
            </label>
            <label
              class={`provider-detail__format-option${
                apiKind() === 'anthropic' ? ' provider-detail__format-option--active' : ''
              }${isEdit() ? ' provider-detail__format-option--disabled' : ''}`}
            >
              <input
                type="radio"
                name="cp-api-format"
                value="anthropic"
                checked={apiKind() === 'anthropic'}
                disabled={isEdit()}
                onChange={() => setApiKind('anthropic')}
              />
              <span class="provider-detail__format-option-title">Anthropic</span>
              <span class="provider-detail__format-option-path">/v1/messages</span>
            </label>
          </div>
          <p id="cp-format-help" class="provider-detail__format-help">
            <Show when={isEdit()} fallback={<>Most providers use OpenAI format.</>}>
              Format can't be changed after creation. Delete and recreate to switch.
            </Show>
          </p>
        </fieldset>

        <div class="provider-detail__field">
          <label class="provider-detail__label" for="cp-base-url">
            Base URL
          </label>
          <div class="provider-detail__key-row">
            <input
              id="cp-base-url"
              class="provider-detail__input"
              type="url"
              placeholder={BASE_URL_PLACEHOLDERS[apiKind()]}
              value={baseUrl()}
              onInput={(e) => {
                setBaseUrl(e.currentTarget.value);
                setError(null);
                setProbeError(null);
              }}
            />
            <button
              type="button"
              class="btn btn--outline btn--sm"
              onClick={handleProbe}
              disabled={probeBusy() || !baseUrl().trim()}
              aria-label={
                apiKind() === 'anthropic'
                  ? "Fetch models from the server's /v1/models endpoint"
                  : "Fetch models from the server's /models endpoint"
              }
            >
              {probeBusy() ? <span class="spinner" /> : 'Fetch models'}
            </button>
          </div>
          <Show when={isSelfHosted()}>
            <div
              class="provider-detail__hint"
              style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); margin-top: 4px;"
            >
              For local servers use <code>http://host.docker.internal:&lt;port&gt;</code> (Docker),{' '}
              <code>http://host.containers.internal:&lt;port&gt;</code> (Podman), or{' '}
              <code>http://localhost:&lt;port&gt;</code> (native). HTTPS required for public URLs.
            </div>
          </Show>
          <Show when={probeError()}>
            <div class="provider-detail__error" role="alert" style="margin-top: 4px;">
              {probeError()}
            </div>
          </Show>
        </div>

        <div class="provider-detail__field">
          <label class="provider-detail__label" for="cp-stream-warmup">
            Stream timeout (ms){' '}
            <span style="color: hsl(var(--muted-foreground)); font-weight: 400;">optional</span>
          </label>
          <input
            id="cp-stream-warmup"
            class="provider-detail__input"
            type="number"
            min="1000"
            max="120000"
            step="1000"
            placeholder="inherit (tier / env / 15000 default)"
            value={streamWarmupMs()}
            onInput={(e) => setStreamWarmupMs(e.currentTarget.value)}
          />
          <div
            class="provider-detail__hint"
            style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); margin-top: 4px;"
          >
            How long streaming waits for the first token before failover. Raise for local models
            with slow cold loads (e.g. 45000–60000). Clamped 1000–120000; blank inherits.
          </div>
        </div>

        <div class="provider-detail__field">
          <label class="provider-detail__label" for="cp-api-key">
            API Key{' '}
            <span style="color: hsl(var(--muted-foreground)); font-weight: 400;">
              (optional for local providers)
            </span>
          </label>
          <Show when={isEdit() && !editingKey()}>
            <div class="provider-detail__key-row">
              <input
                id="cp-api-key"
                class="provider-detail__input provider-detail__input--disabled"
                type="text"
                value={props.initialData?.has_api_key ? '••••••••••••' : 'No key set'}
                disabled
                aria-label="Current API key (masked)"
              />
              <button
                type="button"
                class="btn btn--outline btn--sm"
                onClick={() => {
                  setEditingKey(true);
                  setApiKey('');
                }}
              >
                Change
              </button>
            </div>
          </Show>
          <Show when={!isEdit() || editingKey()}>
            <input
              id="cp-api-key"
              class="provider-detail__input provider-detail__input--masked"
              type="text"
              autocomplete="off"
              placeholder="sk-..."
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
            />
          </Show>
        </div>

        <div class="provider-detail__field">
          <div id="cp-models-label" class="provider-detail__label custom-provider-models__label">
            Models
            <Show when={hasEstimatedPrices()}>
              <InfoTooltip text={ESTIMATED_PRICE_TOOLTIP} />
            </Show>
          </div>
          <div class="custom-provider-models" aria-labelledby="cp-models-label">
            <div class="custom-provider-models__columns" aria-hidden="true">
              <span class="custom-provider-models__column custom-provider-models__column--name">
                Model name
              </span>
              <span class="custom-provider-models__column custom-provider-models__column--price">
                Input / 1M tokens
              </span>
              <span class="custom-provider-models__column custom-provider-models__column--price">
                Output / 1M tokens
              </span>
              <span class="custom-provider-models__column-spacer" />
            </div>
            <Index each={rows()}>
              {(row, i) => (
                <div class="custom-provider-model-row">
                  <input
                    class="provider-detail__input custom-provider-model-row__name"
                    type="text"
                    placeholder="Model name"
                    aria-label={`Model ${i + 1} name`}
                    value={row().model_name}
                    onInput={(e) => updateRow(i, 'model_name', e.currentTarget.value)}
                  />
                  <input
                    class="provider-detail__input custom-provider-model-row__price"
                    type="text"
                    inputmode="decimal"
                    placeholder="$/M in"
                    aria-label={`Model ${i + 1} input price per million tokens`}
                    value={row().input_price}
                    onInput={(e) => updateRow(i, 'input_price', e.currentTarget.value)}
                  />
                  <input
                    class="provider-detail__input custom-provider-model-row__price"
                    type="text"
                    inputmode="decimal"
                    placeholder="$/M out"
                    aria-label={`Model ${i + 1} output price per million tokens`}
                    value={row().output_price}
                    onInput={(e) => updateRow(i, 'output_price', e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="custom-provider-model-row__remove"
                    onClick={() => removeRow(i)}
                    disabled={rows().length <= 1}
                    aria-label={`Remove model ${i + 1}`}
                    title="Remove"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
              )}
            </Index>
            <button
              type="button"
              class="btn btn--outline btn--sm"
              onClick={addRow}
              disabled={!rows().at(-1)?.model_name.trim()}
              style="margin-top: 4px; align-self: flex-start;"
            >
              + Add model
            </button>
          </div>
        </div>

        {error() && (
          <div class="provider-detail__error" role="alert">
            {error()}
          </div>
        )}

        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 16px;">
          <Show when={isEdit()} fallback={<div />}>
            <button
              type="button"
              class="btn btn--outline btn--sm provider-detail__disconnect"
              disabled={busy()}
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete provider
            </button>
          </Show>
          <button
            type="submit"
            class="btn btn--primary btn--sm provider-detail__action"
            disabled={!canSubmit()}
          >
            {busy() ? <span class="spinner" /> : isEdit() ? 'Save changes' : 'Connect'}
          </button>
        </div>
      </form>

      {/* -- Delete Confirmation Modal -- */}
      <Show when={showDeleteConfirm()}>
        <div
          class="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowDeleteConfirm(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowDeleteConfirm(false);
          }}
        >
          <div
            class="modal-card"
            style="max-width: 400px;"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-provider-modal-title"
          >
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--gap-lg);">
              <h3
                id="delete-provider-modal-title"
                style="margin: 0; font-size: var(--font-size-lg);"
              >
                Delete provider
              </h3>
              <button
                style="background: none; border: none; cursor: pointer; color: hsl(var(--muted-foreground)); padding: 4px;"
                onClick={() => setShowDeleteConfirm(false)}
                aria-label="Close"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <p style="font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); margin-bottom: var(--gap-lg);">
              Remove{' '}
              <strong style="color: hsl(var(--foreground));">{props.initialData?.name}</strong>?
              This will delete all its models and any routing assignments using them. This action
              cannot be undone.
            </p>
            <div style="display: flex; gap: var(--gap-sm); justify-content: flex-end;">
              <button
                class="btn btn--outline btn--sm"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={busy()}
              >
                Cancel
              </button>
              <button class="btn btn--danger btn--sm" onClick={handleDelete} disabled={busy()}>
                {busy() ? <span class="spinner" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default CustomProviderForm;
