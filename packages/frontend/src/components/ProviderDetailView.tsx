import {
  Show,
  createSignal,
  createMemo,
  createEffect,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import { PROVIDERS } from '../services/providers.js';
import { providerIcon } from './ProviderIcon.js';
import {
  connectProvider,
  disconnectProvider,
  refreshProviderModels,
  type RoutingProvider,
  type AuthType,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { formatTimeAgo } from '../services/formatters.js';
import CopyButton from './CopyButton.js';
import ProviderKeyForm, { MAX_KEYS_PER_PROVIDER } from './ProviderKeyForm.js';
import OAuthDetailView from './OAuthDetailView.js';
import AnthropicOAuthDetailView from './AnthropicOAuthDetailView.js';
import DeviceCodeDetailView from './DeviceCodeDetailView.js';
import { getRoutingProviderApiKeyUrl } from '../services/provider-api-key-urls.js';

export interface ProviderDetailViewProps {
  provId: string;
  agentName: string;
  providers: RoutingProvider[];
  selectedAuthType: Accessor<AuthType>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  keyInput: Accessor<string>;
  setKeyInput: Setter<string>;
  editing: Accessor<boolean>;
  setEditing: Setter<boolean>;
  validationError: Accessor<string | null>;
  setValidationError: Setter<string | null>;
  onBack: () => void;
  onUpdate: () => void | Promise<void>;
  onPollProviders?: () => void | Promise<void>;
  onClose: () => void;
  initialAddKey?: boolean;
}

const ProviderDetailView: Component<ProviderDetailViewProps> = (props) => {
  const provDef = PROVIDERS.find((p) => p.id === props.provId)!;

  const getProviderByAuth = (authType: AuthType) =>
    props.providers.find((p) => p.provider === props.provId && p.auth_type === authType);

  const isConnectedApiKey = (): boolean => {
    const p = getProviderByAuth('api_key');
    return !!p && p.is_active && p.has_api_key;
  };

  const isSubscriptionConnected = (): boolean => {
    const p = getProviderByAuth('subscription');
    return !!p && p.is_active;
  };

  const isSubscriptionWithToken = (): boolean => {
    const p = getProviderByAuth('subscription');
    return !!p && p.is_active && p.has_api_key;
  };

  const isNoKeyConnected = (): boolean => {
    const p = getProviderByAuth('api_key');
    return !!p && p.is_active && !!provDef.noKeyRequired;
  };

  const getKeyPrefixDisplay = (authType: AuthType): string => {
    const p = getProviderByAuth(authType);
    if (p?.key_prefix) return `${p.key_prefix}${'•'.repeat(8)}`;
    return '••••••••••••';
  };

  const isSubMode = () => props.selectedAuthType() === 'subscription';
  const subscriptionAuthMode = () =>
    provDef.subscriptionAuthMode ?? (provDef.subscriptionKeyPlaceholder ? 'token' : undefined);
  const isPopupOAuthFlow = () => isSubMode() && subscriptionAuthMode() === 'popup_oauth';
  const isPopupPasteFlow = () => isSubMode() && subscriptionAuthMode() === 'popup_paste';
  const isDeviceCodeFlow = () => isSubMode() && subscriptionAuthMode() === 'device_code';
  const isCommandOnly = () =>
    isSubMode() &&
    !!provDef.subscriptionCommand &&
    !provDef.subscriptionKeyPlaceholder &&
    !subscriptionAuthMode();
  const connected = () =>
    isSubMode()
      ? isCommandOnly()
        ? isSubscriptionConnected()
        : subscriptionAuthMode() === 'token'
          ? isSubscriptionWithToken()
          : isSubscriptionConnected()
      : isConnectedApiKey() || isNoKeyConnected();
  const isOllama = provDef.noKeyRequired;

  const [addKeyOpen, setAddKeyOpen] = createSignal(false);

  createEffect(() => {
    if (props.initialAddKey) setAddKeyOpen(true);
  });

  const supportsMultiKey = () => props.selectedAuthType() !== 'local';

  const activeKeys = createMemo(() =>
    props.providers.filter(
      (p) =>
        p.provider === props.provId &&
        p.auth_type === props.selectedAuthType() &&
        p.is_active &&
        p.has_api_key,
    ),
  );

  // Closed providers keep existing connections manageable but take no new ones.
  const subscriptionClosed = () => isSubMode() && !!provDef.subscriptionClosedNote;
  const showConnectFlow = () => !subscriptionClosed() || connected();

  const showAddKeyButton = () =>
    connected() &&
    !subscriptionClosed() &&
    supportsMultiKey() &&
    activeKeys().length < MAX_KEYS_PER_PROVIDER &&
    !addKeyOpen();

  const handleOllamaConnect = async () => {
    props.setBusy(true);
    try {
      await connectProvider(props.agentName, {
        provider: props.provId,
        authType: props.selectedAuthType(),
      });
      toast.success(`${provDef.name} connected`);
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshedModelCount, setRefreshedModelCount] = createSignal<number | null>(null);
  const [refreshedAt, setRefreshedAt] = createSignal<string | null>(null);

  const activeProviderRow = () => getProviderByAuth(props.selectedAuthType());
  const modelCount = () => refreshedModelCount() ?? activeProviderRow()?.cached_model_count ?? 0;
  const lastFetchedAgo = () =>
    formatTimeAgo(refreshedAt() ?? activeProviderRow()?.models_fetched_at ?? null);

  const handleRefreshModels = async () => {
    setRefreshing(true);
    let refreshed = false;
    try {
      const result = await refreshProviderModels(
        props.agentName,
        props.provId,
        props.selectedAuthType(),
      );
      if (result.ok) {
        refreshed = true;
        setRefreshedModelCount(result.model_count);
        setRefreshedAt(result.last_fetched_at);
        toast.success(
          `${provDef.name}: refreshed ${result.model_count} model${result.model_count === 1 ? '' : 's'}`,
        );
      } else {
        toast.error(result.error ?? `Couldn't refresh ${provDef.name}`);
      }
      await props.onUpdate();
      if (refreshed) {
        setRefreshedModelCount(null);
        setRefreshedAt(null);
      }
    } catch {
      // network/server error toast already raised by fetchMutate
    } finally {
      setRefreshing(false);
    }
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await disconnectProvider(
        props.agentName,
        props.provId,
        props.selectedAuthType(),
      );
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      props.onBack();
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  return (
    <div class="provider-detail">
      {/* Back arrow */}
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

      {/* Title */}
      <div class="routing-modal__header" style="border: none; padding: 0; margin-bottom: 15px;">
        <div>
          <div class="routing-modal__title">Connect provider</div>
        </div>
      </div>

      {/* Provider row */}
      <div class="provider-detail__header" style="justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="provider-detail__icon">
            {providerIcon(props.provId, 28) ?? (
              <span
                class="provider-card__logo-letter"
                style={{
                  background: provDef.color,
                  width: '32px',
                  height: '32px',
                  'font-size': '13px',
                }}
              >
                {provDef.initial}
              </span>
            )}
          </span>
          <div class="provider-detail__name">
            {provDef.name}
            <Show when={provDef.beta}>
              <span class="provider-detail__beta-badge">beta</span>
            </Show>
          </div>
        </div>
        <div class="provider-detail__header-actions">
          <Show when={showAddKeyButton()}>
            <button
              type="button"
              class="btn btn--sm"
              style="background: hsl(var(--foreground)); color: hsl(var(--background)); border: none; font-size: var(--font-size-xs); display: inline-flex; align-items: center; gap: 4px;"
              onClick={() => setAddKeyOpen(true)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M4 11h11v2H4zm0-5h16v2H4zm0 10h8v2H4zm15-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" />
              </svg>
              {isSubMode() ? 'Add connection' : 'Add another key'}
            </button>
          </Show>
        </div>
      </div>

      <Show when={subscriptionClosed()}>
        <p class="provider-detail__hint" role="note">
          {provDef.subscriptionClosedNote}
        </p>
      </Show>

      <Show when={isSubMode() && provDef.subscriptionRequirementNote}>
        <p style="font-size: 14px; color: hsl(var(--muted-foreground)); margin: 0 0 12px; line-height: 1.5;">
          {provDef.subscriptionRequirementNote}
        </p>
      </Show>

      <Show when={connected()}>
        <div class="provider-detail__models-bar">
          <span>
            {modelCount()} model
            {modelCount() === 1 ? '' : 's'}
            <Show when={lastFetchedAgo()}> - last refreshed: {lastFetchedAgo()}</Show>
          </span>
          <button
            class="btn btn--outline btn--sm provider-detail__refresh-btn"
            disabled={refreshing() || props.busy()}
            onClick={handleRefreshModels}
            aria-label={`Refresh models from ${provDef.name}`}
            title={`Refresh models from ${provDef.name}`}
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
              classList={{ 'provider-detail__refresh-icon--spinning': refreshing() }}
            >
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            {refreshing() ? 'Refreshing…' : 'Refresh models'}
          </button>
        </div>
      </Show>

      {/* Subscription sign-in URL instruction (token mode with external sign-in) */}
      <Show when={showConnectFlow() && isSubMode() && provDef.subscriptionSignInUrl}>
        <p class="provider-detail__hint">
          {provDef.subscriptionSignInHint ??
            `Sign in to your ${provDef.name} account to get your API key, then paste it below.`}
        </p>
        <a
          class="btn btn--primary btn--sm provider-detail__signin-btn"
          href={provDef.subscriptionSignInUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${provDef.subscriptionSignInLabel ?? 'Sign in'} (opens in a new tab)`}
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
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          {provDef.subscriptionSignInLabel ?? 'Sign in'}
        </a>
      </Show>

      {/* Subscription terminal instruction */}
      <Show when={showConnectFlow() && isSubMode() && provDef.subscriptionCommand}>
        <p class="provider-detail__hint">
          {isCommandOnly()
            ? 'Run the command below to log in via your browser.'
            : 'Run the command below, then paste the token.'}
        </p>
        <div class="modal-terminal">
          <div class="modal-terminal__header">
            <div class="modal-terminal__dots">
              <span class="modal-terminal__dot modal-terminal__dot--red" />
              <span class="modal-terminal__dot modal-terminal__dot--yellow" />
              <span class="modal-terminal__dot modal-terminal__dot--green" />
            </div>
            <div class="modal-terminal__tabs">
              <span class="modal-terminal__tab modal-terminal__tab--active">Terminal</span>
            </div>
          </div>
          <div class="modal-terminal__body">
            <CopyButton text={provDef.subscriptionCommand!} />
            <div>
              <span class="modal-terminal__prompt">$</span>
              <span class="modal-terminal__code">{provDef.subscriptionCommand}</span>
            </div>
          </div>
        </div>
      </Show>

      {/* Command-only subscription */}
      <Show when={showConnectFlow() && isCommandOnly()}>
        <p class="provider-detail__hint" style="margin-top: 16px;">
          A browser window will open for you to log in. Once authenticated, the connection will be
          detected automatically.
        </p>
        <Show when={connected()}>
          <button
            class="btn btn--outline provider-detail__action provider-detail__disconnect"
            disabled={props.busy()}
            onClick={handleDisconnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Disconnect
            </Show>
          </button>
        </Show>
        <Show when={!connected()}>
          <button class="btn btn--primary provider-detail__action" onClick={props.onBack}>
            Done
          </button>
        </Show>
      </Show>

      {/* OAuth subscription */}
      <Show when={showConnectFlow() && isPopupOAuthFlow()}>
        <OAuthDetailView
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
          onPollProviders={props.onPollProviders}
          onClose={props.onClose}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          activeKeys={activeKeys}
        />
      </Show>

      {/* Paste-code OAuth subscription (Anthropic) */}
      <Show when={showConnectFlow() && isPopupPasteFlow()}>
        <AnthropicOAuthDetailView
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
          onClose={props.onClose}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          activeKeys={activeKeys}
        />
      </Show>

      {/* Device-code subscription */}
      <Show when={showConnectFlow() && isDeviceCodeFlow()}>
        <DeviceCodeDetailView
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
          onClose={props.onClose}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          activeKeys={activeKeys}
        />
      </Show>

      {/* Ollama (no key) */}
      <Show when={isOllama}>
        <div class="provider-detail__field">
          <span class="provider-detail__no-key">No API key required for local models</span>
          <Show when={getRoutingProviderApiKeyUrl(props.provId)}>
            <a
              href={getRoutingProviderApiKeyUrl(props.provId)}
              target="_blank"
              rel="noopener noreferrer"
              class="provider-detail__docs-link"
              style="margin-left: 8px; font-size: var(--font-size-sm); color: hsl(var(--muted-foreground));"
            >
              Get {provDef.name} ↗
            </a>
          </Show>
        </div>
        <Show when={!connected()}>
          <button
            class="btn btn--primary provider-detail__action"
            disabled={props.busy()}
            onClick={handleOllamaConnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Connect
            </Show>
          </button>
        </Show>
        <Show when={connected()}>
          <button
            class="btn btn--outline provider-detail__action provider-detail__disconnect"
            disabled={props.busy()}
            onClick={handleDisconnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Disconnect
            </Show>
          </button>
        </Show>
      </Show>

      {/* API key / subscription token form (non-Ollama, non-command-only, non-OAuth) */}
      <Show
        when={
          showConnectFlow() &&
          !isOllama &&
          !isCommandOnly() &&
          !isPopupOAuthFlow() &&
          !isPopupPasteFlow() &&
          !isDeviceCodeFlow()
        }
      >
        <ProviderKeyForm
          provDef={provDef}
          provId={props.provId}
          agentName={props.agentName}
          isSubMode={isSubMode}
          connected={connected}
          selectedAuthType={props.selectedAuthType}
          busy={props.busy}
          setBusy={props.setBusy}
          keyInput={props.keyInput}
          setKeyInput={props.setKeyInput}
          editing={props.editing}
          setEditing={props.setEditing}
          validationError={props.validationError}
          setValidationError={props.setValidationError}
          getKeyPrefixDisplay={getKeyPrefixDisplay}
          providers={props.providers}
          addKeyOpen={addKeyOpen}
          setAddKeyOpen={setAddKeyOpen}
          onBack={props.onBack}
          onUpdate={props.onUpdate}
        />
      </Show>
    </div>
  );
};

export default ProviderDetailView;
