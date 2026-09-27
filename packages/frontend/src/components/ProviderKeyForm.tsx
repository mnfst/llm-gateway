import {
  For,
  Show,
  createMemo,
  createEffect,
  createSignal,
  on,
  onMount,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import { MAX_KEYS_PER_PROVIDER as SHARED_MAX_KEYS_PER_PROVIDER } from 'manifest-shared';
import type { ProviderDef, SubscriptionEndpointRegion } from '../services/providers.js';
import { validateApiKey, validateSubscriptionKey } from '../services/provider-utils.js';
import {
  connectProvider,
  disconnectProvider,
  renameProviderKey,
  revokeOpenaiOAuth,
  type AuthType,
  type RoutingProvider,
} from '../services/api.js';
import {
  getRoutingProviderApiKeyUrl,
  getSubscriptionProviderKeyUrl,
} from '../services/provider-api-key-urls.js';
import { suggestNextProviderKeyLabel } from '../services/provider-key-labels.js';
import { toast } from '../services/toast-store.js';

export const MAX_KEYS_PER_PROVIDER = SHARED_MAX_KEYS_PER_PROVIDER;
const MAX_LABEL_LENGTH = 50;
const WORKSPACE_ID_PLACEHOLDER = '<workspace-id>';

function baseUrlPlaceholderMatches(
  placeholder: string | undefined,
  baseUrl: string | null | undefined,
): boolean {
  if (!placeholder || !baseUrl) return false;
  try {
    const placeholderUrl = new URL(placeholder.replace(WORKSPACE_ID_PLACEHOLDER, 'workspace'));
    const baseUrlObject = new URL(baseUrl);
    const placeholderHostTail = placeholderUrl.hostname.split('.').slice(1).join('.');
    const baseUrlHostTail = baseUrlObject.hostname.split('.').slice(1).join('.');

    return !!placeholderHostTail && placeholderHostTail === baseUrlHostTail;
  } catch {
    return false;
  }
}

export interface ProviderKeyFormProps {
  provDef: ProviderDef;
  provId: string;
  agentName: string;
  isSubMode: Accessor<boolean>;
  connected: Accessor<boolean>;
  selectedAuthType: Accessor<AuthType>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  keyInput: Accessor<string>;
  setKeyInput: Setter<string>;
  editing: Accessor<boolean>;
  setEditing: Setter<boolean>;
  validationError: Accessor<string | null>;
  setValidationError: Setter<string | null>;
  getKeyPrefixDisplay: (authType: AuthType) => string;
  /**
   * Full set of providers from the modal — used to derive the active key
   * chain for the current `(provId, selectedAuthType)` tuple. Optional for
   * back-compat with callers that haven't been updated yet (in which case
   * the form falls back to legacy single-key UX).
   */
  providers?: RoutingProvider[];
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  onBack: () => void;
  onUpdate: () => void;
}

const ProviderKeyForm: Component<ProviderKeyFormProps> = (props) => {
  const isPopupOAuth = () => props.provDef.subscriptionAuthMode === 'popup_oauth';
  const shouldRevokeOpenaiOAuth = () =>
    props.provId === 'openai' && isPopupOAuth() && props.selectedAuthType() === 'subscription';
  const isApiKeyCredential = () =>
    !props.isSubMode() || props.provDef.subscriptionCredentialKind === 'api-key';
  const credentialNoun = () => (isApiKeyCredential() ? 'API key' : 'setup token');
  const credentialOwnerName = () =>
    props.isSubMode() && props.provDef.subscriptionCredentialName
      ? props.provDef.subscriptionCredentialName
      : props.provDef.name;
  const inputAriaLabel = () => `${credentialOwnerName()} ${credentialNoun()}`;
  const editAriaLabel = () => `New ${credentialOwnerName()} ${credentialNoun()}`;
  const placeholder = () =>
    props.isSubMode()
      ? (props.provDef.subscriptionKeyPlaceholder ?? 'Paste token')
      : props.provDef.keyPlaceholder;
  const endpointRegions = () =>
    props.isSubMode()
      ? (props.provDef.subscriptionEndpointRegions ?? [])
      : (props.provDef.apiKeyEndpointRegions ?? []);
  const hasEndpointRegions = () => endpointRegions().length > 0;
  const defaultEndpointRegion = () => endpointRegions()[0]?.value;
  const customEndpointOptions = () =>
    endpointRegions().filter((region) => !!region.baseUrlPlaceholder);
  const customEndpointOption = () =>
    customEndpointOptions().find((region) => region.value === 'custom') ??
    customEndpointOptions()[0];
  const customEndpointOptionForValue = (value: string | null | undefined) =>
    customEndpointOptions().find((region) =>
      baseUrlPlaceholderMatches(region.baseUrlPlaceholder, value),
    ) ?? customEndpointOption();
  const endpointRegionLabel = (value: string | null | undefined) =>
    endpointRegions().find((region) => region.value === value)?.label ??
    (value ? customEndpointOptionForValue(value)?.label : undefined);
  const whereToGetUrl = () =>
    props.isSubMode()
      ? getSubscriptionProviderKeyUrl(props.provId)
      : getRoutingProviderApiKeyUrl(props.provId);

  // Multi-key chains are supported for api_key and subscription. Local
  // providers (Ollama / LM Studio) don't carry credentials, so they stay
  // on the single-row surface.
  const supportsMultiKey = () => props.selectedAuthType() !== 'local';

  const activeKeys = createMemo<RoutingProvider[]>(() => {
    if (!props.providers) return [];
    return props.providers
      .filter(
        (p) =>
          p.provider === props.provId &&
          p.auth_type === props.selectedAuthType() &&
          p.is_active &&
          p.has_api_key,
      )
      .slice()
      .sort((a, b) => a.priority - b.priority);
  });

  const isListMode = () => supportsMultiKey() && activeKeys().length > 1;
  const savedEndpointRegion = () => activeKeys()[0]?.region;
  const [selectedEndpointRegion, setSelectedEndpointRegion] = createSignal<string | undefined>();
  const [customEndpointUrl, setCustomEndpointUrl] = createSignal('');

  createEffect(() => {
    if (!hasEndpointRegions()) {
      setSelectedEndpointRegion(undefined);
      setCustomEndpointUrl('');
      return;
    }
    if (props.connected()) {
      if (activeKeys().length > 0) {
        const saved = savedEndpointRegion();
        const customOption = saved ? customEndpointOptionForValue(saved) : customEndpointOption();
        if (saved && !endpointRegions().some((region) => region.value === saved) && customOption) {
          setSelectedEndpointRegion(customOption.value);
          setCustomEndpointUrl(saved);
        } else {
          setSelectedEndpointRegion(saved ?? defaultEndpointRegion());
          if (saved !== customOption?.value) setCustomEndpointUrl('');
        }
      } else {
        setSelectedEndpointRegion(undefined);
        setCustomEndpointUrl('');
      }
      return;
    }
    const selected = selectedEndpointRegion();
    if (!selected || !endpointRegions().some((region) => region.value === selected)) {
      setSelectedEndpointRegion(defaultEndpointRegion());
    }
  });

  const displayedEndpointRegion = () => selectedEndpointRegion() ?? defaultEndpointRegion();
  const selectedEndpointRegionOption = () =>
    endpointRegions().find((region) => region.value === displayedEndpointRegion());
  const isCustomEndpointSelected = () => !!selectedEndpointRegionOption()?.baseUrlPlaceholder;
  const endpointRegionPayload = () => {
    if (!hasEndpointRegions()) return undefined;
    if (isCustomEndpointSelected()) return customEndpointUrl().trim() || undefined;
    const selected = selectedEndpointRegion();
    if (selected) return selected;
    return props.connected() ? undefined : defaultEndpointRegion();
  };
  const validateEndpointRegion = () => {
    if (isCustomEndpointSelected() && !customEndpointUrl().trim()) {
      props.setValidationError('Base URL is required');
      return false;
    }
    return true;
  };

  const EndpointRegionSelect = (selectProps: { id: string; disabled?: boolean }) => (
    <Show when={hasEndpointRegions()}>
      <div class="provider-detail__field">
        <label class="provider-detail__label" for={selectProps.id}>
          Region
        </label>
        <select
          id={selectProps.id}
          class="provider-detail__input"
          value={displayedEndpointRegion()}
          disabled={selectProps.disabled}
          onChange={(e) => setSelectedEndpointRegion(e.currentTarget.value)}
        >
          <For each={endpointRegions()}>
            {(region) => <option value={region.value}>{region.label}</option>}
          </For>
        </select>
        <Show when={selectedEndpointRegionOption()?.baseUrlPlaceholder}>
          {(placeholder) => (
            <>
              <label
                class="provider-detail__label"
                for={`${selectProps.id}-base-url`}
                style="margin-top: 8px;"
              >
                Base URL
              </label>
              <input
                id={`${selectProps.id}-base-url`}
                class="provider-detail__input"
                classList={{
                  'provider-detail__input--error':
                    props.validationError() === 'Base URL is required',
                }}
                type="url"
                autocomplete="off"
                placeholder={placeholder()}
                value={customEndpointUrl()}
                disabled={selectProps.disabled}
                onInput={(e) => {
                  setCustomEndpointUrl(e.currentTarget.value);
                  props.setValidationError(null);
                }}
              />
            </>
          )}
        </Show>
      </div>
    </Show>
  );

  const fieldLabel = () => {
    if (isListMode()) return 'API Keys';
    return isApiKeyCredential() ? 'API Key' : 'Setup Token';
  };

  const handleConnect = async (label?: string) => {
    if (!validateEndpointRegion()) return;
    const result = props.isSubMode()
      ? validateSubscriptionKey(props.provDef, props.keyInput())
      : validateApiKey(props.provDef, props.keyInput());
    if (!result.valid) {
      props.setValidationError(result.error!);
      return;
    }

    props.setBusy(true);
    try {
      await connectProvider(props.agentName, {
        provider: props.provId,
        apiKey: props.keyInput().replace(/\s/g, ''),
        authType: props.selectedAuthType(),
        ...(endpointRegionPayload() && { region: endpointRegionPayload() }),
        ...(label && { label }),
      });
      toast.success(`${props.provDef.name} connected`);
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleUpdateKey = async (label?: string) => {
    if (!validateEndpointRegion()) return;
    const result = props.isSubMode()
      ? validateSubscriptionKey(props.provDef, props.keyInput())
      : validateApiKey(props.provDef, props.keyInput());
    if (!result.valid) {
      props.setValidationError(result.error!);
      return;
    }

    // Without an explicit label the backend's legacy path writes to the row
    // labeled 'Default' — wrong target whenever the visible key is named
    // anything else. Pin the update to the key this view is showing.
    const targetLabel = label ?? activeKeys()[0]?.label;
    props.setBusy(true);
    try {
      await connectProvider(props.agentName, {
        provider: props.provId,
        apiKey: props.keyInput().replace(/\s/g, ''),
        authType: props.selectedAuthType(),
        ...(endpointRegionPayload() && { region: endpointRegionPayload() }),
        ...(targetLabel && { label: targetLabel }),
      });
      const noun = props.isSubMode() && !isApiKeyCredential() ? 'token' : 'key';
      toast.success(`${props.provDef.name} ${noun} updated`);
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleDisconnect = async (label?: string) => {
    props.setBusy(true);
    try {
      // OpenAI subscription OAuth needs an explicit revoke call. Skip for
      // labeled deletes inside list mode (those are api_key keys, never the
      // OAuth subscription token).
      if (!label && shouldRevokeOpenaiOAuth()) {
        await revokeOpenaiOAuth(props.agentName).catch(() => {});
      }
      const result = await disconnectProvider(
        props.agentName,
        props.provId,
        props.selectedAuthType(),
        label,
      );
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      // For labeled deletes, stay on the modal so the user can keep editing
      // the remaining chain. For full disconnects, return to the list.
      if (!label) props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  let connectInputRef: HTMLInputElement | undefined;
  onMount(() => {
    if (connectInputRef && !props.connected()) {
      connectInputRef.focus();
    }
  });

  return (
    <>
      {/* Not yet connected — first key */}
      <Show when={!props.connected()}>
        <EndpointRegionSelect id={`${props.provId}-subscription-endpoint`} />
        <div class="provider-detail__field">
          <label class="provider-detail__label">{fieldLabel()}</label>
          <input
            ref={connectInputRef}
            class="provider-detail__input provider-detail__input--masked"
            classList={{ 'provider-detail__input--error': !!props.validationError() }}
            type="text"
            autocomplete="off"
            placeholder={placeholder()}
            aria-label={inputAriaLabel()}
            value={props.keyInput()}
            onInput={(e) => {
              props.setKeyInput(e.currentTarget.value);
              props.setValidationError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConnect();
            }}
          />
          <Show when={props.validationError()}>
            <div class="provider-detail__error">{props.validationError()}</div>
          </Show>
          <Show when={whereToGetUrl()}>
            <p class="provider-detail__key-help">
              <a
                class="provider-detail__key-help-link"
                href={whereToGetUrl()}
                target="_blank"
                rel="noopener noreferrer"
              >
                Get {credentialOwnerName()} {credentialNoun()}
              </a>
            </p>
          </Show>
        </div>
        <button
          class="btn btn--primary provider-detail__action"
          disabled={props.busy() || !props.keyInput().trim()}
          onClick={() => handleConnect()}
        >
          <Show when={!props.busy()} fallback={<span class="spinner" />}>
            Connect
          </Show>
        </button>
      </Show>

      {/* Connected — single key (legacy view, pixel-identical to pre-multi-key) */}
      <Show when={props.connected() && !isListMode()}>
        <div class="provider-detail__field">
          <label class="provider-detail__label">{fieldLabel()}</label>
          <Show when={!props.editing()}>
            <div class="provider-detail__key-row">
              <input
                class="provider-detail__input provider-detail__input--disabled"
                type="text"
                value={props.getKeyPrefixDisplay(props.selectedAuthType())}
                disabled
                aria-label={
                  isApiKeyCredential() ? 'Current API key (masked)' : 'Current setup token (masked)'
                }
              />
              <button
                class="btn btn--outline btn--sm"
                onClick={() => {
                  props.setEditing(true);
                  props.setKeyInput('');
                  props.setValidationError(null);
                }}
              >
                Change
              </button>
              <button
                class="provider-detail__disconnect-icon"
                disabled={props.busy()}
                onClick={() => handleDisconnect()}
                aria-label="Disconnect provider"
                title="Disconnect"
              >
                <Show when={!props.busy()} fallback={<span class="spinner" />}>
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
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                </Show>
              </button>
            </div>
            <Show when={supportsMultiKey() && activeKeys().length < MAX_KEYS_PER_PROVIDER}>
              <AddAnotherKeyAction
                onAdd={(label, apiKey, region) => handleAddKey(props, label, apiKey, region)}
                busy={props.busy}
                setBusy={props.setBusy}
                provDef={props.provDef}
                placeholder={placeholder() ?? 'Paste API key'}
                whereToGetUrl={whereToGetUrl}
                credentialNoun={credentialNoun}
                credentialOwnerName={credentialOwnerName}
                existingLabels={() => activeKeys().map((k) => k.label)}
                open={props.addKeyOpen}
                setOpen={props.setAddKeyOpen}
                isSubscription={props.isSubMode()}
                endpointRegions={endpointRegions()}
                initialEndpointRegion={displayedEndpointRegion()}
              />
            </Show>
          </Show>
          <Show when={props.editing()}>
            <EndpointRegionSelect id={`${props.provId}-subscription-endpoint-edit`} />
            <input
              class="provider-detail__input provider-detail__input--masked"
              classList={{ 'provider-detail__input--error': !!props.validationError() }}
              type="text"
              autocomplete="off"
              placeholder={placeholder()}
              aria-label={editAriaLabel()}
              value={props.keyInput()}
              onInput={(e) => {
                props.setKeyInput(e.currentTarget.value);
                props.setValidationError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleUpdateKey();
              }}
            />
            <Show when={props.validationError()}>
              <div class="provider-detail__error">{props.validationError()}</div>
            </Show>
            <Show when={whereToGetUrl()}>
              <p class="provider-detail__key-help">
                <a
                  class="provider-detail__key-help-link"
                  href={whereToGetUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get {credentialOwnerName()} {credentialNoun()}
                </a>
              </p>
            </Show>
            <button
              class="btn btn--primary provider-detail__action"
              disabled={props.busy() || !props.keyInput().trim()}
              onClick={() => handleUpdateKey()}
              style="margin-top: 12px;"
            >
              Save
            </button>
          </Show>
        </div>
      </Show>

      {/* Connected — list mode (multi-key) */}
      <Show when={props.connected() && isListMode()}>
        <KeyChainView
          provDef={props.provDef}
          provId={props.provId}
          agentName={props.agentName}
          authType={props.selectedAuthType}
          activeKeys={activeKeys}
          busy={props.busy}
          setBusy={props.setBusy}
          placeholder={placeholder() ?? 'Paste API key'}
          credentialNoun={credentialNoun}
          credentialOwnerName={credentialOwnerName}
          whereToGetUrl={whereToGetUrl}
          addKeyOpen={props.addKeyOpen}
          setAddKeyOpen={props.setAddKeyOpen}
          endpointRegions={endpointRegions()}
          endpointRegionLabel={endpointRegionLabel}
          onUpdate={props.onUpdate}
          onDelete={(label) => handleDisconnect(label)}
        />
      </Show>
    </>
  );
};

async function handleAddKey(
  props: ProviderKeyFormProps,
  label: string,
  apiKey: string,
  region?: string,
): Promise<boolean> {
  // Subscription-mode providers (Anthropic Pro, ChatGPT Plus, etc.) often
  // validate paste tokens with a different prefix/format than their api_key
  // counterparts. Branch the validator so the chain-add flow doesn't reject
  // a valid setup token using the api-key rules.
  const result = props.isSubMode()
    ? validateSubscriptionKey(props.provDef, apiKey)
    : validateApiKey(props.provDef, apiKey);
  if (!result.valid) {
    toast.error(result.error!);
    return false;
  }
  props.setBusy(true);
  try {
    await connectProvider(props.agentName, {
      provider: props.provId,
      apiKey: apiKey.replace(/\s/g, ''),
      authType: props.selectedAuthType(),
      label,
      ...(region && { region }),
    });
    toast.success(`${props.provDef.name} key "${label}" added`);
    props.onUpdate();
    return true;
  } catch {
    return false;
  } finally {
    props.setBusy(false);
  }
}

/** @internal Exported for testing only. */
export interface AddAnotherKeyActionProps {
  onAdd: (label: string, apiKey: string, region?: string) => Promise<boolean>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  provDef: ProviderDef;
  placeholder: string;
  whereToGetUrl: () => string | undefined;
  credentialNoun: () => string;
  credentialOwnerName: () => string;
  existingLabels: () => string[];
  open?: Accessor<boolean>;
  setOpen?: Setter<boolean>;
  isSubscription?: boolean;
  endpointRegions?: SubscriptionEndpointRegion[];
  initialEndpointRegion?: string;
}

/** @internal Exported for testing only. */
export const AddAnotherKeyAction: Component<AddAnotherKeyActionProps> = (props) => {
  const [localOpen, setLocalOpen] = createSignal(false);
  const isOpen = () => (props.open ?? localOpen)();
  const setIsOpen = (v: boolean) => {
    (props.setOpen ?? setLocalOpen)(v);
  };
  const [label, setLabel] = createSignal('');
  const [apiKey, setApiKey] = createSignal('');
  const [endpointRegion, setEndpointRegion] = createSignal<string | undefined>(
    props.initialEndpointRegion ?? props.endpointRegions?.[0]?.value,
  );
  const [customEndpointUrl, setCustomEndpointUrl] = createSignal('');
  let apiKeyInputRef: HTMLInputElement | undefined;

  const defaultLabel = () => suggestNextProviderKeyLabel(props.existingLabels());
  const selectedEndpointRegionOption = () =>
    props.endpointRegions?.find((region) => region.value === endpointRegion());
  const customEndpointPayload = () => {
    if (!selectedEndpointRegionOption()?.baseUrlPlaceholder) return endpointRegion();
    return customEndpointUrl().trim() || undefined;
  };

  // Sync label suggestion when opened externally and auto-focus the API key field.
  // Use `on()` with explicit deps to avoid tracking label/endpointRegion signals,
  // which would re-fire the effect (and steal focus) on every keystroke.
  createEffect(
    on(isOpen, (open, prevOpen) => {
      if (open && !label().trim()) {
        setLabel(defaultLabel());
      }
      const defaultEndpointRegion = props.endpointRegions?.[0]?.value;
      if (open && defaultEndpointRegion && !endpointRegion()) {
        setEndpointRegion(props.initialEndpointRegion ?? defaultEndpointRegion);
      }
      if (open && !prevOpen) {
        requestAnimationFrame(() => apiKeyInputRef?.focus());
      }
    }),
  );

  const submit = async () => {
    if (selectedEndpointRegionOption()?.baseUrlPlaceholder && !customEndpointUrl().trim()) {
      toast.error('Base URL is required');
      return;
    }
    const labelToUse = (label().trim() || defaultLabel()).slice(0, MAX_LABEL_LENGTH);
    const ok = await props.onAdd(labelToUse, apiKey().trim(), customEndpointPayload());
    if (ok) {
      setIsOpen(false);
      setLabel('');
      setApiKey('');
      setCustomEndpointUrl('');
    }
  };

  return (
    <Show
      when={isOpen()}
      fallback={
        !props.open ? (
          <button
            type="button"
            class="provider-detail__add-link"
            style="margin-top: 12px; background: none; border: none; padding: 0; color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); cursor: pointer; text-align: left;"
            onClick={() => {
              setLabel(defaultLabel());
              setIsOpen(true);
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
              style="vertical-align: -2px; margin-right: 2px;"
            >
              <path d="M4 11h11v2H4zm0-5h16v2H4zm0 10h8v2H4zm15-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" />
            </svg>
            {props.isSubscription ? ' Add connection' : ' Add another key'}
          </button>
        ) : undefined
      }
    >
      <div
        class="provider-detail__add-form"
        style="margin-top: 12px; padding: 12px; border: 1px solid hsl(var(--border)); border-radius: 6px;"
      >
        <label class="provider-detail__label" for="add-key-label">
          Name
        </label>
        <input
          id="add-key-label"
          class="provider-detail__input"
          type="text"
          maxlength={MAX_LABEL_LENGTH}
          aria-label="Key name"
          value={label()}
          placeholder={defaultLabel()}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
        <Show when={props.endpointRegions?.length}>
          <label class="provider-detail__label" for="add-key-endpoint" style="margin-top: 8px;">
            Region
          </label>
          <select
            id="add-key-endpoint"
            class="provider-detail__input"
            value={endpointRegion()}
            disabled={props.busy()}
            onChange={(e) => setEndpointRegion(e.currentTarget.value)}
          >
            <For each={props.endpointRegions ?? []}>
              {(region) => <option value={region.value}>{region.label}</option>}
            </For>
          </select>
          <Show when={selectedEndpointRegionOption()?.baseUrlPlaceholder}>
            {(placeholder) => (
              <>
                <label
                  class="provider-detail__label"
                  for="add-key-base-url"
                  style="margin-top: 8px;"
                >
                  Base URL
                </label>
                <input
                  id="add-key-base-url"
                  class="provider-detail__input"
                  type="url"
                  autocomplete="off"
                  placeholder={placeholder()}
                  value={customEndpointUrl()}
                  disabled={props.busy()}
                  onInput={(e) => setCustomEndpointUrl(e.currentTarget.value)}
                />
              </>
            )}
          </Show>
        </Show>
        <label class="provider-detail__label" for="add-key-value" style="margin-top: 8px;">
          {props.credentialOwnerName()} {props.credentialNoun()}
        </label>
        <input
          ref={apiKeyInputRef}
          id="add-key-value"
          class="provider-detail__input provider-detail__input--masked"
          type="text"
          autocomplete="off"
          aria-label={`New ${props.credentialOwnerName()} ${props.credentialNoun()}`}
          placeholder={props.placeholder}
          value={apiKey()}
          onInput={(e) => setApiKey(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <Show when={props.whereToGetUrl()}>
          <p class="provider-detail__key-help">
            <a
              class="provider-detail__key-help-link"
              href={props.whereToGetUrl()}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get {props.credentialOwnerName()} {props.credentialNoun()}
            </a>
          </p>
        </Show>
        <div style="display: flex; justify-content: space-between; margin-top: 12px;">
          <button
            class="btn btn--outline btn--sm"
            onClick={() => setIsOpen(false)}
            disabled={props.busy()}
          >
            Cancel
          </button>
          <button
            class="btn btn--primary btn--sm"
            disabled={props.busy() || !apiKey().trim()}
            onClick={submit}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Add key
            </Show>
          </button>
        </div>
      </div>
    </Show>
  );
};

interface KeyChainViewProps {
  provDef: ProviderDef;
  provId: string;
  agentName: string;
  authType: Accessor<AuthType>;
  activeKeys: Accessor<RoutingProvider[]>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  placeholder: string;
  credentialNoun: () => string;
  credentialOwnerName: () => string;
  whereToGetUrl: () => string | undefined;
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  endpointRegions: SubscriptionEndpointRegion[];
  endpointRegionLabel: (value: string | null | undefined) => string | undefined;
  onUpdate: () => void;
  onDelete: (label: string) => void;
}

const KeyChainView: Component<KeyChainViewProps> = (props) => {
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');

  const startRename = (k: RoutingProvider) => {
    setRenamingId(k.id);
    setRenameValue(k.label);
  };

  const commitRename = async (k: RoutingProvider) => {
    const newLabel = renameValue().trim();
    if (!newLabel || newLabel === k.label) {
      setRenamingId(null);
      return;
    }
    props.setBusy(true);
    try {
      await renameProviderKey(props.agentName, props.provId, k.label, newLabel, props.authType());
      toast.success(`Renamed to "${newLabel}"`);
      setRenamingId(null);
      props.onUpdate();
    } catch {
      // toast handled upstream
    } finally {
      props.setBusy(false);
    }
  };

  return (
    <div class="provider-detail__field">
      <label class="provider-detail__label">API Keys</label>
      <ul
        role="list"
        aria-label={`API keys for ${props.provDef.name}`}
        style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;"
      >
        <For each={props.activeKeys()}>
          {(k) => (
            <li style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid hsl(var(--border)); border-radius: 6px; background: hsl(var(--muted) / 0.3);">
              <Show
                when={renamingId() === k.id}
                fallback={
                  <>
                    <div style="flex: 1; min-width: 0;">
                      <div style="font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        {k.label}
                      </div>
                      <div style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                        {[
                          k.key_prefix ? `${k.key_prefix}${'•'.repeat(12)}` : '••••••••••••',
                          props.endpointRegionLabel(k.region),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <button
                      class="btn btn--outline btn--sm"
                      style="flex-shrink: 0;"
                      disabled={props.busy()}
                      onClick={() => startRename(k)}
                    >
                      Rename
                    </button>
                    <button
                      class="provider-detail__disconnect-icon"
                      disabled={props.busy()}
                      onClick={() => props.onDelete(k.label)}
                      aria-label={`Delete key ${k.label}`}
                      title="Delete key"
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
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </>
                }
              >
                <input
                  class="provider-detail__input"
                  type="text"
                  maxlength={MAX_LABEL_LENGTH}
                  aria-label={`Rename ${k.label}`}
                  value={renameValue()}
                  onInput={(e) => setRenameValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(k);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
                <button
                  class="btn btn--primary btn--sm"
                  disabled={props.busy()}
                  onClick={() => commitRename(k)}
                >
                  Save
                </button>
                <button
                  class="btn btn--outline btn--sm"
                  disabled={props.busy()}
                  onClick={() => setRenamingId(null)}
                >
                  Cancel
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.activeKeys().length < MAX_KEYS_PER_PROVIDER}>
        <AddAnotherKeyAction
          onAdd={async (label, apiKey, region) => {
            // Subscription chains paste setup tokens, which validate
            // differently from api keys. Pick the right validator based on
            // the chain's auth_type.
            const result =
              props.authType() === 'subscription'
                ? validateSubscriptionKey(props.provDef, apiKey)
                : validateApiKey(props.provDef, apiKey);
            if (!result.valid) {
              toast.error(result.error!);
              return false;
            }
            props.setBusy(true);
            try {
              await connectProvider(props.agentName, {
                provider: props.provId,
                apiKey: apiKey.replace(/\s/g, ''),
                authType: props.authType(),
                label,
                ...(region && { region }),
              });
              toast.success(`${props.provDef.name} key "${label}" added`);
              props.onUpdate();
              return true;
            } catch {
              return false;
            } finally {
              props.setBusy(false);
            }
          }}
          busy={props.busy}
          setBusy={props.setBusy}
          provDef={props.provDef}
          placeholder={props.placeholder}
          whereToGetUrl={props.whereToGetUrl}
          credentialNoun={props.credentialNoun}
          credentialOwnerName={props.credentialOwnerName}
          existingLabels={() => props.activeKeys().map((k) => k.label)}
          open={props.addKeyOpen}
          setOpen={props.setAddKeyOpen}
          isSubscription={props.authType() === 'subscription'}
          endpointRegions={props.endpointRegions}
          initialEndpointRegion={props.activeKeys()[0]?.region ?? props.endpointRegions[0]?.value}
        />
      </Show>
    </div>
  );
};

export default ProviderKeyForm;
