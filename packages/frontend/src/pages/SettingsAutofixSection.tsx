import { createResource, createSignal, createEffect, onCleanup, type Component } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { getAutofix, updateAutofix } from '../services/api.js';

/**
 * Per-agent Autofix toggle on the Settings page. Fetches its own status and
 * persists the on/off choice. The effective value shown here already reflects
 * the deployment-mode default resolved by the backend (ON in cloud, OFF in
 * self-hosted) when the agent has made no explicit choice. The legal line under
 * the card is the consent act: the backend records the install-level consent on
 * the first enable, no confirmation dialog involved.
 */
const SettingsAutofixSection: Component<{ agentName: () => string }> = (props) => {
  const [config, { mutate }] = createResource(() => props.agentName(), getAutofix);
  const [saving, setSaving] = createSignal(false);

  // Guard the errored read: accessing an errored SolidJS resource re-throws, so
  // short-circuit to off (the switch stays disabled via busy() below). Also gate
  // on `config.loading`: Solid keeps the previous agent's value during a refetch,
  // so without this the switch would briefly show the prior agent's state when
  // you switch harnesses.
  const enabled = () => (!config.loading && !config.error ? (config()?.enabled ?? false) : false);
  // Also disabled after a failed read: without a known current state a click
  // would blindly write a value the user never saw.
  const busy = () => saving() || config.loading || Boolean(config.error);

  // No busy() guard needed: the switch is the only caller and it is disabled
  // while busy, so a re-entrant click cannot dispatch.
  const saveEnabled = async (nextEnabled: boolean) => {
    // Pin the agent this click targets. If the user switches harnesses before
    // the save resolves, don't mutate the (now different) agent's resource.
    const agentName = props.agentName();
    setSaving(true);
    try {
      const next = await updateAutofix(agentName, { enabled: nextEnabled });
      if (props.agentName() === agentName) mutate(next);
    } catch {
      // `updateAutofix` (via `fetchMutate`) already surfaces the backend error as a
      // toast, so don't raise a second generic one here — just stop the spinner.
    } finally {
      setSaving(false);
    }
  };

  const [searchParams] = useSearchParams();
  const [highlighted, setHighlighted] = createSignal(searchParams.highlight === 'autofix');
  createEffect(() => {
    if (highlighted()) {
      // onCleanup, not a return value: Solid feeds an effect's return into the
      // next run instead of calling it, so a returned closure never fires.
      const timer = setTimeout(() => setHighlighted(false), 1500);
      onCleanup(() => clearTimeout(timer));
    }
  });

  return (
    <>
      <h2 class="settings-section__title">Autofix</h2>
      <div
        class="settings-card settings-card--flush"
        classList={{ 'settings-card--highlight': highlighted() }}
      >
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Autofix failing requests</span>
            <span class="settings-card__label-desc">
              When a request fails with a fixable error, Manifest repairs it and retries once before
              falling back, so a bad request gets fixed instead of just failing over.
            </span>
          </div>
          <div class="settings-card__control settings-card__control--end">
            <button
              type="button"
              role="switch"
              aria-checked={enabled()}
              aria-label="Autofix"
              class="settings-switch"
              classList={{ 'settings-switch--on': enabled() }}
              disabled={busy()}
              onClick={() => void saveEnabled(!enabled())}
            >
              <span class="settings-switch__track">
                <span class="settings-switch__thumb" />
              </span>
            </button>
          </div>
        </div>
      </div>
      <p class="autofix-consent__legal settings-card__legal">
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
    </>
  );
};

export default SettingsAutofixSection;
