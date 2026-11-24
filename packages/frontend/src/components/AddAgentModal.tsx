import {
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from 'solid-js';
import { useNavigate } from '@solidjs/router';
import AgentTypeSelect from './AgentTypeSelect.jsx';
import { createAgent, getGlobalProviders } from '../services/api.js';
import { toast } from '../services/toast-store.js';
import { markAgentCreated, markSetupPending } from '../services/recent-agents.js';
import { checkIsSelfHosted } from '../services/setup-status.js';
import { refreshAgents } from '../services/sse.js';
import { type AgentCategory, type AgentPlatform, PLATFORMS_BY_CATEGORY } from 'manifest-shared';

/**
 * "Connect Harness" modal extracted from Workspace so it can be reused by other
 * onboarding surfaces (e.g. an empty-state CTA or a deep-link).
 *
 * Onboarding navigation: a freshly created agent inherits access to every
 * connected provider, so Routing is the most useful first stop.
 * If the tenant has *no* providers yet, we additionally pass
 * `state.openProviders` so Routing opens the provider-connect flow immediately —
 * the new user's very next action is to connect their first provider.
 */
const AddAgentModal: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const navigate = useNavigate();
  const [name, setName] = createSignal('');
  const [category, setCategory] = createSignal<AgentCategory | null>('personal');
  const [platform, setPlatform] = createSignal<AgentPlatform | null>(
    PLATFORMS_BY_CATEGORY['personal'][0] ?? null,
  );
  const [creating, setCreating] = createSignal(false);
  // Both default ON — explicit so create always sends a choice rather than
  // relying on the server-side inherit path (which is OFF for Autofix on
  // self-hosted).
  const [autofixEnabled, setAutofixEnabled] = createSignal(true);
  const [recordingEnabled, setRecordingEnabled] = createSignal(true);
  // Where the logs live depends on the deployment: self-hosted keeps them in
  // the operator's own database, cloud in the Manifest workspace.
  const [selfHosted] = createResource(checkIsSelfHosted);

  // Tracks whether the user dismissed the modal (overlay click / Escape) while a
  // create request was still in flight. A dismissed create must NOT run its
  // post-success side effects (toast, markAgentCreated) or navigate afterwards —
  // otherwise closing the modal mid-request still yanks the user to Routing once
  // the request resolves.
  let cancelled = false;
  // Monotonic id of the current create attempt. Each async hop re-checks the
  // token it started with, so a dismissed or superseded attempt drops its
  // result instead of acting on it.
  let attemptToken = 0;
  const beginAttempt = (): number => {
    cancelled = false;
    return ++attemptToken;
  };
  const isStale = (token: number): boolean => cancelled || token !== attemptToken;
  // Reopening invalidates whatever the previous session left in flight. The
  // success path closes the modal *before* awaiting the providers lookup, and
  // closing is not a dismissal — so a user who immediately reopens to add a
  // second harness would otherwise be yanked to the first one the moment that
  // lookup lands, mid-typing.
  createEffect(() => {
    if (props.open) attemptToken++;
  });
  // If the component unmounts mid-request, treat it like a dismissal so we never
  // navigate from a disposed modal.
  onCleanup(() => {
    cancelled = true;
  });

  const dismiss = () => {
    cancelled = true;
    props.onClose();
    resetForm();
  };

  const handleCategoryChange = (c: AgentCategory) => {
    setCategory(c);
    setPlatform(PLATFORMS_BY_CATEGORY[c][0] ?? null);
  };

  /**
   * @param token attempt id from {@link beginAttempt}, re-checked after every await.
   * @param autofixChoice the Autofix setting pinned when the submit started.
   */
  const createAgentNow = async (token: number, autofixChoice: boolean) => {
    const agentName = name().trim();
    if (!agentName) return;
    setCreating(true);
    try {
      const result = await createAgent({
        name: agentName,
        ...(category() ? { agent_category: category()! } : {}),
        ...(platform() ? { agent_platform: platform()! } : {}),
        autofix_enabled: autofixChoice,
        record_messages: recordingEnabled(),
      });
      // Local creates do not wait for the asynchronous server-sent event. This
      // immediately reruns the sidebar's harness-list resource with fresh data.
      refreshAgents();
      // The user dismissed the modal while the request was in flight — honour
      // that dismissal and skip every success side effect + the navigation.
      if (isStale(token)) return;
      toast.success(`Harness "${agentName}" connected`);
      props.onClose();
      resetForm();
      const slug = result?.agent?.name ?? agentName;
      markAgentCreated(slug);
      // Persistent flag so the setup modal reopens after a page refresh until
      // the user dismisses or completes it (the in-memory mark above is dropped
      // on reload / cleared by AgentGuard once the agent appears in the list).
      markSetupPending(slug);

      // Decide whether to nudge the user into connecting a provider. A brand-new
      // tenant has nothing routed yet, so we open the provider flow on landing.
      // A failed lookup must not block the redirect — fall back to "has none".
      let hasProviders = false;
      try {
        const res = await getGlobalProviders();
        hasProviders = (res?.providers?.length ?? 0) > 0;
      } catch {
        // Treat a failed providers lookup as "no providers" so onboarding still
        // surfaces the connect flow rather than silently skipping it.
      }

      // A dismissal during the providers lookup must also skip the redirect.
      if (isStale(token)) return;

      // Land on Routing either way; the new agent's API key is surfaced there.
      navigate(`/harnesses/${encodeURIComponent(slug)}/routing`, {
        state: {
          newApiKey: result?.apiKey,
          ...(hasProviders ? {} : { openProviders: true }),
        },
      });
    } catch {
      // error toast already shown by fetchMutate
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async () => {
    if (!name().trim()) return;
    // A second submit while the create is already running would issue a
    // duplicate agent-creation request.
    if (creating()) return;
    // The legal line under the toggles is the consent act: the backend records
    // the install-level consent when the create carries autofix_enabled: true.
    await createAgentNow(beginAttempt(), autofixEnabled());
  };

  const resetForm = () => {
    setName('');
    setCategory('personal');
    setPlatform(PLATFORMS_BY_CATEGORY['personal'][0] ?? null);
    setAutofixEnabled(true);
    setRecordingEnabled(true);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) handleCreate();
    if (e.key === 'Escape') dismiss();
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={dismiss}>
        <div
          class="modal-card"
          style="max-width: 540px;"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-agent-title"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <h2 class="modal-card__title" id="add-agent-title">
            Connect Harness
          </h2>
          <p class="modal-card__desc">
            Name your harness to start tracking its LLM usage, costs, and messages in real time.
          </p>

          <div class="agent-type-select-row">
            <div>
              <label class="modal-card__field-label">Type</label>
              <AgentTypeSelect
                category={category()}
                platform={platform()}
                onCategoryChange={handleCategoryChange}
                onPlatformChange={setPlatform}
                disabled={creating()}
              />
            </div>
            <div style="flex: 1;">
              <label class="modal-card__field-label" for="agent-name-input">
                Harness name
              </label>
              <input
                ref={(el) => requestAnimationFrame(() => el.focus())}
                id="agent-name-input"
                class="modal-card__input modal-card__input--lg"
                type="text"
                placeholder="e.g. My Cool Harness"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                disabled={creating()}
              />
            </div>
          </div>

          <div class="add-agent-toggles">
            <div class="model-params__group">
              {/* Same label treatment as the Type / Harness name field labels,
                  not the larger Model-params group header. */}
              <div class="modal-card__field-label add-agent-toggles__header">Settings</div>
              <div class="model-params__group-card">
                <div class="model-params__row">
                  <div class="model-params__row-text">
                    <div class="model-params__label-title">
                      <span>Autofix</span>
                    </div>
                    <div class="model-params__label-hint">
                      Repair eligible failing requests before falling back.
                    </div>
                  </div>
                  <div class="model-params__row-control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autofixEnabled()}
                      aria-label="Autofix"
                      class="settings-switch"
                      classList={{ 'settings-switch--on': autofixEnabled() }}
                      disabled={creating()}
                      onClick={() => setAutofixEnabled(!autofixEnabled())}
                    >
                      <span class="settings-switch__track">
                        <span class="settings-switch__thumb" />
                      </span>
                    </button>
                  </div>
                </div>
                <div class="model-params__separator" />
                <div class="model-params__row">
                  <div class="model-params__row-text">
                    <div class="model-params__label-title">
                      <span>Enable logs</span>
                    </div>
                    <div class="model-params__label-hint">
                      See exactly what your agent sends on every attempt, and debug it faster.{' '}
                      {selfHosted.state === 'ready' &&
                        (selfHosted()
                          ? 'Logs stay in your own database.'
                          : 'Logs are stored in your Manifest workspace.')}
                    </div>
                  </div>
                  <div class="model-params__row-control">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={recordingEnabled()}
                      aria-label="Enable logs"
                      class="settings-switch"
                      classList={{ 'settings-switch--on': recordingEnabled() }}
                      disabled={creating()}
                      onClick={() => setRecordingEnabled(!recordingEnabled())}
                    >
                      <span class="settings-switch__track">
                        <span class="settings-switch__thumb" />
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <Show when={autofixEnabled()}>
            <p class="autofix-consent__legal add-agent-legal">
              By enabling Autofix, you agree to Manifest&apos;s{' '}
              <a href="https://manifest.build/terms" target="_blank" rel="noopener noreferrer">
                Terms
              </a>{' '}
              and{' '}
              <a href="https://manifest.build/privacy" target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>
              .
            </p>
          </Show>

          <div class="modal-card__footer">
            <button
              class="btn btn--primary btn--sm"
              onClick={handleCreate}
              disabled={!name().trim() || creating()}
            >
              {creating() ? <span class="spinner" /> : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default AddAgentModal;
