import {
  createEffect,
  createSignal,
  For,
  onMount,
  Show,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import type { ProviderDef } from '../services/providers.js';
import {
  startAnthropicOAuth,
  submitAnthropicOAuth,
  revokeAnthropicOAuth,
  getAnthropicOAuthPending,
  renameProviderKey,
  type AuthType,
  type RoutingProvider,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';

interface Props {
  provDef: ProviderDef;
  provId: string;
  agentName: string;
  connected: Accessor<boolean>;
  selectedAuthType: Accessor<AuthType>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  onBack: () => void;
  onUpdate: () => void;
  onClose: () => void;
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  activeKeys?: Accessor<RoutingProvider[]>;
}

const MAX_LABEL_LENGTH = 50;

/**
 * Anthropic subscription connect view. Sign in with Claude opens an OAuth
 * popup; the user pastes the resulting `<code>#<state>` payload back into
 * the input. Tokens are stored as refreshable JSON blobs and rotated by
 * the proxy automatically on every request.
 */
const AnthropicOAuthDetailView: Component<Props> = (props) => {
  const [state, setState] = createSignal<string | null>(null);
  const [input, setInput] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [addingAccount, setAddingAccount] = createSignal(false);

  const isMultiKey = () => (props.activeKeys?.() ?? []).length > 1;
  const showConnectFlow = () => !props.connected() || addingAccount();
  const showConnectedFlow = () => props.connected() && !addingAccount();

  // When "Add another key" is clicked in the header, launch a new OAuth popup.
  createEffect(() => {
    if (props.addKeyOpen?.() && props.connected() && !props.busy()) {
      setAddingAccount(true);
      props.setAddKeyOpen?.(false);
      void handleSignIn();
    }
  });

  // Restore any pending OAuth flow so the paste field still works after the
  // modal was closed mid-dance.
  onMount(async () => {
    if (props.connected()) return;
    try {
      const { state: pending } = await getAnthropicOAuthPending(props.agentName);
      if (pending) setState(pending);
    } catch {
      // Missing pending state just means the user hasn't started a flow yet.
    }
  });

  const handleSignIn = async () => {
    setError(null);
    // Open synchronously while the click still has user activation. Browsers
    // can block a window opened after the OAuth start request completes.
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      toast.error('Popup was blocked by your browser. Allow popups for this site, then try again.');
      if (props.connected()) setAddingAccount(false);
      return;
    }
    // The blank page is same-origin, so remove its access to the dashboard
    // before navigating it to Anthropic.
    popup.opener = null;

    props.setBusy(true);
    try {
      const { url, state: authState } = await startAnthropicOAuth(props.agentName);
      setState(authState);
      if (!popup.closed) popup.location.replace(url);
    } catch {
      popup.close();
      if (props.connected()) setAddingAccount(false);
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleSubmit = async () => {
    const raw = input().trim().replace(/\s/g, '');
    if (!raw) return;

    if (!raw.includes('#')) {
      setError(
        "That doesn't look like an authorization code. Make sure you copied the full string from the redirect page.",
      );
      return;
    }
    const pastedState = raw.slice(raw.indexOf('#') + 1);
    if (!pastedState) {
      setError(
        "That doesn't look like an authorization code. Make sure you copied the full string from the redirect page.",
      );
      return;
    }

    props.setBusy(true);
    setError(null);
    try {
      const authState = state() ?? pastedState;
      await submitAnthropicOAuth(props.agentName, raw, authState);
      toast.success(`${props.provDef.name} subscription connected`);
      setAddingAccount(false);
      setInput('');
      setState(null);
      props.onUpdate();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to exchange code. The code may have expired. Sign in again to retry.',
      );
    } finally {
      props.setBusy(false);
    }
  };

  const cancelAddAccount = () => {
    setAddingAccount(false);
    setInput('');
    setError(null);
    setState(null);
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await revokeAnthropicOAuth(props.agentName);
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

  const handleDeleteKey = async (label: string) => {
    props.setBusy(true);
    try {
      const result = await revokeAnthropicOAuth(props.agentName, label);
      if (result?.notifications?.length) {
        for (const msg of result.notifications) {
          toast.error(msg);
        }
      }
      props.onUpdate();
    } catch {
      // error toast from fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

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
      await renameProviderKey(
        props.agentName,
        props.provId,
        k.label,
        newLabel,
        props.selectedAuthType(),
      );
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
    <>
      <Show when={showConnectFlow()}>
        <div class="anthropic-detail__primary">
          <p class="provider-detail__hint">
            Sign in with your Claude Pro or Max account. Manifest will route through your
            subscription with auto-refreshing tokens.
          </p>
          <button
            class="btn btn--primary anthropic-detail__btn"
            disabled={props.busy()}
            onClick={handleSignIn}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Sign in with Claude
            </Show>
          </button>
        </div>

        <div class="anthropic-detail__alt">
          <div class="anthropic-detail__alt-divider">
            <span>Paste the authorization code</span>
          </div>
          <p class="anthropic-detail__alt-hint">
            After signing in, Anthropic's redirect page shows a code. Copy the full string and paste
            it below.
          </p>
          <input
            class="provider-detail__input provider-detail__input--masked"
            classList={{ 'provider-detail__input--error': !!error() }}
            type="text"
            autocomplete="off"
            placeholder="Authorization code"
            aria-label="Anthropic authorization code"
            value={input()}
            onInput={(e) => {
              setInput(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
          />
          <Show when={error()}>
            <div class="provider-detail__error">{error()}</div>
          </Show>
          <button
            class="btn btn--primary anthropic-detail__btn"
            disabled={props.busy() || !input().trim()}
            onClick={handleSubmit}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Connect
            </Show>
          </button>
        </div>
        <Show when={addingAccount()}>
          <button
            class="btn btn--outline provider-detail__action"
            disabled={props.busy()}
            onClick={cancelAddAccount}
          >
            Cancel
          </button>
        </Show>
      </Show>
      <Show when={showConnectedFlow()}>
        {/* Multi-key list */}
        <Show when={isMultiKey()}>
          <div class="provider-detail__field">
            <label class="provider-detail__label">Accounts</label>
            <ul
              role="list"
              aria-label={`OAuth accounts for ${props.provDef.name}`}
              style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;"
            >
              <For each={props.activeKeys!()}>
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
                              Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
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
                            onClick={() => handleDeleteKey(k.label)}
                            aria-label={`Delete account ${k.label}`}
                            title="Delete account"
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
          </div>
          <button
            class="btn btn--outline provider-detail__action provider-detail__disconnect"
            disabled={props.busy()}
            onClick={handleDisconnect}
          >
            <Show when={!props.busy()} fallback={<span class="spinner" />}>
              Disconnect all
            </Show>
          </button>
        </Show>
        {/* Single key — original view */}
        <Show when={!isMultiKey()}>
          <div class="provider-detail__field">
            <span class="provider-detail__no-key">
              Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
            </span>
          </div>
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
    </>
  );
};

export default AnthropicOAuthDetailView;
