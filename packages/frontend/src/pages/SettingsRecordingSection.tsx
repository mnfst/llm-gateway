import { createResource, createSignal, type Component } from 'solid-js';
import { getRecording, updateRecording } from '../services/api.js';
import { checkIsSelfHosted } from '../services/setup-status.js';
import { toast } from '../services/toast-store.js';

const SettingsRecordingSection: Component<{ agentName: () => string }> = (props) => {
  const [config, { mutate }] = createResource(() => props.agentName(), getRecording);
  const [saving, setSaving] = createSignal(false);
  // Where the logs live depends on the deployment: self-hosted keeps them in
  // the operator's own database, cloud in the Manifest workspace.
  const [selfHosted] = createResource(checkIsSelfHosted);

  const enabled = () => (!config.loading && !config.error ? (config()?.enabled ?? false) : false);
  const busy = () => saving() || config.loading || Boolean(config.error);

  const toggle = async () => {
    if (busy()) return;
    const agentName = props.agentName();
    setSaving(true);
    try {
      const next = await updateRecording(agentName, { enabled: !enabled() });
      if (props.agentName() === agentName) {
        mutate(next);
        toast.success(`Logs ${next.enabled ? 'enabled' : 'disabled'}`);
      }
    } catch {
      // fetchMutate already shows the backend error.
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 class="settings-section__title">Logs</h2>
      <div class="settings-card">
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Enable logs</span>
            <span class="settings-card__label-desc">
              Log the full content of every request and every attempt, so you can see what your
              agent sends. You will find these logs on the Requests page, inside each request.{' '}
              {selfHosted.state === 'ready' &&
                (selfHosted()
                  ? "On this self-hosted install, logs stay in your own database and never reach Manifest's cloud."
                  : 'Logs are stored in your Manifest workspace.')}
            </span>
          </div>
          <div class="settings-card__control settings-card__control--end">
            <button
              type="button"
              role="switch"
              aria-checked={enabled()}
              aria-label="Enable logs"
              class="settings-switch"
              classList={{ 'settings-switch--on': enabled() }}
              disabled={busy()}
              onClick={() => void toggle()}
            >
              <span class="settings-switch__track">
                <span class="settings-switch__thumb" />
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default SettingsRecordingSection;
