import { createSignal, For, onCleanup, Show, type Component } from 'solid-js';
import { MAX_KEYS_PER_PROVIDER } from 'manifest-shared';
import { providerIcon } from './ProviderIcon.js';
import {
  copilotDeviceCode,
  copilotPollToken,
  disconnectProvider,
  type CopilotPollStatus,
  type RoutingProvider,
} from '../services/api.js';
import { toast } from '../services/toast-store.js';

function copyToClipboard(text: string, setCopied: (v: boolean) => void) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    })
    .catch(() => {
      /* fallback: user-select: all still works */
    });
}

type Phase = 'idle' | 'loading' | 'awaiting' | 'success' | 'error';

interface Props {
  agentName: string;
  connected: boolean;
  activeKeys?: RoutingProvider[];
  onBack: () => void;
  onConnected: () => void;
  onUpdated?: () => void;
  onDisconnected: () => void;
}

const SLOW_DOWN_INCREASE = 5;
const MAX_POLL_ERRORS = 5;

const CopilotDeviceLogin: Component<Props> = (props) => {
  const [phase, setPhase] = createSignal<Phase>('idle');
  const [userCode, setUserCode] = createSignal('');
  const [verificationUri, setVerificationUri] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let pollTimeout: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const activeKeys = () => (props.activeKeys ?? []).slice().sort((a, b) => a.priority - b.priority);
  const isMultiKey = () => activeKeys().length > 1;
  const canAddAnother = () => activeKeys().length < MAX_KEYS_PER_PROVIDER;
  const showConnectedState = () => props.connected && (phase() === 'idle' || phase() === 'error');

  onCleanup(() => {
    cancelled = true;
    if (pollTimeout) clearTimeout(pollTimeout);
  });

  const startLogin = async () => {
    setPhase('loading');
    setError('');
    cancelled = false;
    try {
      const result = await copilotDeviceCode(props.agentName);
      setUserCode(result.user_code);
      setVerificationUri(result.verification_uri);
      setPhase('awaiting');
      schedulePoll(result.device_code, Math.max(result.interval, 5));
    } catch {
      setError('Failed to start GitHub login. Please try again.');
      setPhase('error');
    }
  };

  const schedulePoll = (code: string, delaySec: number, errorCount = 0) => {
    if (cancelled) return;
    pollTimeout = setTimeout(async () => {
      if (cancelled) return;
      try {
        const result = await copilotPollToken(props.agentName, code);
        if (cancelled) return;
        const next = handlePollResult(result.status, delaySec);
        if (next > 0) schedulePoll(code, next, 0);
      } catch {
        if (cancelled) return;
        const nextErrors = errorCount + 1;
        if (nextErrors >= MAX_POLL_ERRORS) {
          setError('Connection lost. Please try again.');
          setPhase('error');
        } else {
          schedulePoll(code, delaySec, nextErrors);
        }
      }
    }, delaySec * 1000);
  };

  /** Returns next delay (seconds), or 0 to stop. */
  const handlePollResult = (status: CopilotPollStatus, currentDelay: number): number => {
    if (status === 'complete') {
      setPhase('success');
      toast.success('GitHub Copilot connected');
      props.onConnected();
      return 0;
    }
    if (status === 'expired') {
      setError('Device code expired. Please try again.');
      setPhase('error');
      return 0;
    }
    if (status === 'denied') {
      setError('Authorization was denied.');
      setPhase('error');
      return 0;
    }
    if (status === 'slow_down') {
      return currentDelay + SLOW_DOWN_INCREASE;
    }
    return currentDelay;
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      const result = await disconnectProvider(props.agentName, 'copilot', 'subscription');
      if (result?.notifications?.length) {
        for (const msg of result.notifications) toast.error(msg);
      }
      props.onDisconnected();
    } catch {
      /* error toast from fetchMutate */
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteKey = async (label: string) => {
    setBusy(true);
    try {
      const result = await disconnectProvider(props.agentName, 'copilot', 'subscription', label);
      if (result?.notifications?.length) {
        for (const msg of result.notifications) toast.error(msg);
      }
      props.onUpdated?.();
    } catch {
      /* error toast from fetchMutate */
    } finally {
      setBusy(false);
    }
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

      <div class="routing-modal__header" style="border: none; padding: 0; margin-bottom: 15px;">
        <div>
          <div class="routing-modal__title">Connect provider</div>
        </div>
      </div>

      <div class="provider-detail__header">
        <span class="provider-detail__icon">{providerIcon('copilot', 28)}</span>
        <div class="provider-detail__title-group">
          <div class="provider-detail__name">GitHub Copilot</div>
        </div>
      </div>

      {/* Connected state */}
      <Show when={showConnectedState()}>
        <Show
          when={isMultiKey()}
          fallback={
            <p class="provider-detail__hint" style="color: var(--success-color, #22c55e);">
              Connected via GitHub device login.
            </p>
          }
        >
          <div class="provider-detail__field">
            <label class="provider-detail__label">Accounts</label>
            <ul
              role="list"
              aria-label="Accounts for GitHub Copilot"
              style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;"
            >
              <For each={activeKeys()}>
                {(k) => (
                  <li style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid hsl(var(--border)); border-radius: 6px; background: hsl(var(--muted) / 0.3);">
                    <div style="flex: 1; min-width: 0;">
                      <div style="font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        {k.label}
                      </div>
                      <div style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                        Connected via GitHub Copilot subscription
                      </div>
                    </div>
                    <button
                      class="provider-detail__disconnect-icon"
                      disabled={busy()}
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
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={error()}>
          <div class="provider-detail__error">{error()}</div>
        </Show>
        <Show when={canAddAnother()}>
          <button
            class="btn btn--primary provider-detail__action"
            disabled={busy()}
            onClick={startLogin}
          >
            <Show when={!busy()} fallback={<span class="spinner" />}>
              Add another key
            </Show>
          </button>
        </Show>
        <button
          class="btn btn--outline provider-detail__action provider-detail__disconnect"
          disabled={busy()}
          onClick={handleDisconnect}
        >
          <Show when={!busy()} fallback={<span class="spinner" />}>
            Disconnect
          </Show>
        </button>
      </Show>

      {/* Idle / Error — show start button */}
      <Show when={!props.connected && (phase() === 'idle' || phase() === 'error')}>
        <p class="provider-detail__hint">
          Requires an active GitHub Copilot subscription. This will open a GitHub device login.
        </p>
        <Show when={error()}>
          <div class="provider-detail__error">{error()}</div>
        </Show>
        <button class="btn btn--primary provider-detail__action" onClick={startLogin}>
          Sign in with GitHub
        </button>
      </Show>

      {/* Loading — fetching device code */}
      <Show when={phase() === 'loading'}>
        <div class="provider-detail__field" style="text-align: center; padding: 24px 0;">
          <span class="spinner" />
        </div>
      </Show>

      {/* Awaiting — show code + URL */}
      <Show when={phase() === 'awaiting'}>
        <div class="copilot-device-login__code-box">
          <p class="provider-detail__hint" style="margin-bottom: 12px;">
            Copy the code, then open GitHub to enter it:
          </p>
          <div class="copilot-device-login__code-row">
            <div class="copilot-device-login__code" aria-label="Device code">
              {userCode()}
            </div>
            <button
              class="copilot-device-login__copy-btn"
              onClick={() => copyToClipboard(userCode(), setCopied)}
              aria-label={copied() ? 'Copied' : 'Copy device code'}
              title={copied() ? 'Copied' : 'Copy'}
            >
              <Show
                when={copied()}
                fallback={
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
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                }
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
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </Show>
            </button>
          </div>
          <a
            class="btn btn--primary copilot-device-login__open-btn"
            href={verificationUri()}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open GitHub
          </a>
          <p class="copilot-device-login__waiting">
            <span class="spinner" style="width: 14px; height: 14px; margin-right: 8px;" />
            Waiting for authorization...
          </p>
        </div>
      </Show>

      {/* Success */}
      <Show when={phase() === 'success'}>
        <p class="provider-detail__hint" style="color: var(--success-color, #22c55e);">
          GitHub Copilot connected successfully.
        </p>
      </Show>
    </div>
  );
};

export default CopilotDeviceLogin;
