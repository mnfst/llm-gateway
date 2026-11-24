import {
  createEffect,
  onCleanup,
  createSignal,
  For,
  Show,
  type Component,
  type Accessor,
  type Setter,
} from 'solid-js';
import type { ProviderDef } from '../services/providers.js';
import {
  getPopupOauthApi,
  renameProviderKey,
  type AuthType,
  type RoutingProvider,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { monitorOAuthPopup } from '../services/oauth-popup.js';

const MAX_LABEL_LENGTH = 50;

function parseOAuthCallbackInput(raw: string, fallbackState: string | null) {
  let code: string | null = null;
  let state: string | null = fallbackState;
  const parts = raw.split(/\s+/).filter(Boolean);

  for (const part of parts) {
    try {
      const url = new URL(part);
      code = code ?? url.searchParams.get('code');
      state = state ?? url.searchParams.get('state');
    } catch {
      if (!code && /^[A-Za-z0-9._~-]{20,}$/.test(part)) {
        code = part;
      }
    }
  }

  return { code, state };
}

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
  onPollProviders?: () => void | Promise<void>;
  onClose: () => void;
  addKeyOpen?: Accessor<boolean>;
  setAddKeyOpen?: Setter<boolean>;
  activeKeys?: Accessor<RoutingProvider[]>;
}

const OAuthDetailView: Component<Props> = (props) => {
  const [pasteFlowActive, setPasteFlowActive] = createSignal(false);
  const [flowKeyCount, setFlowKeyCount] = createSignal<number | null>(null);
  const [successHandled, setSuccessHandled] = createSignal(false);
  const [pasteUrl, setPasteUrl] = createSignal('');
  const [pasteError, setPasteError] = createSignal<string | null>(null);
  const [oauthState, setOauthState] = createSignal<string | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [addingAccount, setAddingAccount] = createSignal(false);

  // Dispose the OAuth popup monitor if the view unmounts mid-flow, otherwise its
  // 300ms URL poll keeps running after the component is gone.
  let disposeOAuthMonitor: (() => void) | null = null;
  onCleanup(() => disposeOAuthMonitor?.());

  const isMultiKey = () => (props.activeKeys?.() ?? []).length > 1;
  const isXaiProvider = () => props.provId === 'xai';
  const isOpenAiProvider = () => props.provId === 'openai';
  const callbackPlaceholder = () =>
    isXaiProvider()
      ? 'Paste the xAI authorization code or callback URL'
      : 'http://localhost:1455/auth/callback?code=...';
  const showConnectFlow = () => !props.connected() || addingAccount() || pasteFlowActive();
  const showConnectedFlow = () => props.connected() && !addingAccount() && !pasteFlowActive();
  const activeKeyCount = () => (props.activeKeys?.() ?? []).length;
  const flowHasConnected = () => {
    const baseline = flowKeyCount();
    if (baseline === null) return false;
    return baseline > 0 ? activeKeyCount() > baseline : props.connected();
  };

  const finishOAuthSuccess = () => {
    if (successHandled()) return;
    setSuccessHandled(true);
    setPasteFlowActive(false);
    setFlowKeyCount(null);
    setPasteUrl('');
    setPasteError(null);
    setOauthState(null);
    setAddingAccount(false);
    toast.success(`${props.provDef.name} subscription connected`);
    props.onUpdate();
  };

  // When "Add another key" is clicked in the header, launch a new OAuth popup.
  createEffect(() => {
    if (props.addKeyOpen?.() && props.connected() && !props.busy()) {
      setAddingAccount(true);
      props.setAddKeyOpen?.(false);
      void handleOAuthLogin();
    }
  });

  const oauthApi = () => getPopupOauthApi(props.provId);

  createEffect(() => {
    if (!pasteFlowActive()) return;
    const poll = props.onPollProviders ?? props.onUpdate;
    const interval = window.setInterval(() => {
      poll();
    }, 2000);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    if (pasteFlowActive() && flowHasConnected()) finishOAuthSuccess();
  });

  const handleOAuthLogin = async () => {
    props.setBusy(true);
    setPasteUrl('');
    setPasteError(null);
    try {
      const { url } = await oauthApi().getUrl(props.agentName);
      try {
        setOauthState(new URL(url).searchParams.get('state'));
      } catch {
        setOauthState(null);
      }
      const popup = window.open(url, 'manifest-oauth', 'width=500,height=700');
      if (!popup) {
        toast.error(
          'Popup was blocked by your browser. Allow popups for this site, then try again.',
        );
        if (props.connected()) setAddingAccount(false);
        setOauthState(null);
        props.setBusy(false);
        return;
      }

      setPasteFlowActive(true);
      setFlowKeyCount(activeKeyCount());
      setSuccessHandled(false);
      props.setBusy(false);

      // Dispose any in-flight monitor from a previous start before replacing it,
      // so repeated logins don't orphan the earlier poll/listener handle.
      disposeOAuthMonitor?.();
      disposeOAuthMonitor = monitorOAuthPopup(
        popup,
        {
          onSuccess: finishOAuthSuccess,
          onFailure: () => {
            // Popup closed without auto-redirect — user needs to paste the URL
          },
        },
        `/oauth/${props.provId}/done`,
      );
    } catch {
      if (props.connected()) setAddingAccount(false);
      props.setBusy(false);
    }
  };

  const handlePasteSubmit = async () => {
    const raw = pasteUrl().trim();
    if (!raw) return;

    try {
      const { code, state } = parseOAuthCallbackInput(raw, oauthState());
      if (!code || !state) {
        setPasteError(
          props.provId === 'xai'
            ? 'Paste the authorization code shown by xAI, or paste the full callback URL after approval.'
            : 'URL is missing the authorization code. Make sure you copied the full URL.',
        );
        return;
      }

      props.setBusy(true);
      setPasteError(null);
      await oauthApi().submitCallback(code, state);
      finishOAuthSuccess();
    } catch (err) {
      // The server's message says what went wrong. Network failures (fetch
      // rejects with a TypeError) and empty messages get the generic hint.
      setPasteError(
        err instanceof Error && !(err instanceof TypeError) && err.message
          ? err.message
          : 'Failed to exchange token. The URL may have expired. Try logging in again.',
      );
    } finally {
      props.setBusy(false);
    }
  };

  const cancelAddAccount = () => {
    setAddingAccount(false);
    setPasteFlowActive(false);
    setFlowKeyCount(null);
    setSuccessHandled(false);
    setPasteUrl('');
    setPasteError(null);
    setOauthState(null);
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      const result = await oauthApi().revoke(props.agentName);
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
      const result = await oauthApi().revoke(props.agentName, label);
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
        <Show
          when={pasteFlowActive()}
          fallback={
            <>
              <p class="provider-detail__hint">
                Log in with your {props.provDef.name} account to connect your subscription.
              </p>
              <button
                class="btn btn--primary provider-detail__action"
                disabled={props.busy()}
                onClick={handleOAuthLogin}
              >
                <Show when={!props.busy()} fallback={<span class="spinner" />}>
                  Log in with {props.provDef.name}
                </Show>
              </button>
            </>
          }
        >
          <Show
            when={isXaiProvider()}
            fallback={
              <>
                <p class="provider-detail__hint">
                  A login window has opened. If it does not close automatically after sign-in, paste
                  the callback URL below.
                </p>
                <Show when={isOpenAiProvider()}>
                  <p class="provider-detail__hint" style="margin-top: 8px;">
                    Copy the full URL from the{' '}
                    <span style="color: hsl(var(--foreground)); font-weight: 500;">
                      popup's address bar
                    </span>{' '}
                    and paste it below:
                  </p>
                  <video
                    src="/images/oauth-callback-example.mp4"
                    poster="/images/oauth-callback-example.png"
                    preload="auto"
                    autoplay
                    loop
                    muted
                    playsinline
                    style="width: 100%; border-radius: var(--radius); border: 1px solid hsl(var(--border)); margin-top: 12px;"
                  />
                </Show>
              </>
            }
          >
            <p class="provider-detail__hint">
              A login window has opened. After approving access, paste the authorization code xAI
              shows. If your browser lands on a callback URL, paste that URL instead.
            </p>
          </Show>
          <div class="provider-detail__field" style="margin-top: 12px;">
            <input
              type="text"
              class="provider-detail__input"
              classList={{ 'provider-detail__input--error': !!pasteError() }}
              autocomplete="off"
              placeholder={callbackPlaceholder()}
              value={pasteUrl()}
              onInput={(e) => {
                setPasteUrl(e.currentTarget.value);
                setPasteError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handlePasteSubmit();
              }}
            />
            <Show when={pasteError()}>
              <div class="provider-detail__error">{pasteError()}</div>
            </Show>
            <button
              class="btn btn--primary btn--sm provider-detail__action"
              style="margin-top: 8px;"
              disabled={props.busy() || !pasteUrl().trim()}
              onClick={handlePasteSubmit}
            >
              <Show when={!props.busy()} fallback={<span class="spinner" />}>
                Connect
              </Show>
            </button>
          </div>
        </Show>
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
          <div class="provider-detail__footer">
            <button
              class="btn btn--outline provider-detail__disconnect"
              disabled={props.busy()}
              onClick={handleDisconnect}
            >
              <Show when={!props.busy()} fallback={<span class="spinner" />}>
                Disconnect all
              </Show>
            </button>
            <div style="flex: 1;" />
            <button class="btn btn--primary btn--sm" onClick={() => props.onClose()}>
              Done
            </button>
          </div>
        </Show>
        {/* Single key — original view */}
        <Show when={!isMultiKey()}>
          <div class="provider-detail__field">
            <span class="provider-detail__no-key">
              Connected via {props.provDef.subscriptionLabel ?? 'subscription'}
            </span>
          </div>
          <div class="provider-detail__footer">
            <button
              class="btn btn--outline provider-detail__disconnect"
              disabled={props.busy()}
              onClick={handleDisconnect}
            >
              <Show when={!props.busy()} fallback={<span class="spinner" />}>
                Disconnect
              </Show>
            </button>
            <div style="flex: 1;" />
            <button class="btn btn--primary btn--sm" onClick={() => props.onClose()}>
              Done
            </button>
          </div>
        </Show>
      </Show>
    </>
  );
};

export default OAuthDetailView;
