import { createSignal, For, Show, type JSX } from 'solid-js';
import InfoTooltip from './InfoTooltip.jsx';

const MODEL_PARAMS_TOOLTIP =
  'Provider-specific request parameters that affected this call, e.g. ' +
  "DeepSeek's `thinking` toggle. The set is curated per provider today; " +
  'support for additional models and custom user-defined parameters lands ' +
  'here as it ships.';

/**
 * Render an effective model parameter value as a readable string. Objects
 * and arrays get pretty-printed with two-space indent so future provider
 * knobs (`reasoning_effort`, `safety: { mode: 'permissive' }`, etc.) wrap
 * naturally inside the value cell instead of becoming an unbreakable
 * single-line token. `undefined` matches the em-dash convention used
 * elsewhere in this panel for absent telemetry.
 */
export function formatParamValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

export function RequestHeadersSection(props: { headers: Record<string, string> }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const entries = (): Array<[string, string]> =>
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b));
  const tableId = `msg-detail-request-headers-${Math.random().toString(36).slice(2, 10)}`;
  return (
    <div class={`toggle-panel${open() ? ' toggle-panel--open' : ''}`}>
      <div class="toggle-panel__header">
        <button
          type="button"
          class="msg-detail__section-title msg-detail__section-title--toggle"
          aria-expanded={open() ? 'true' : 'false'}
          aria-controls={tableId}
          onClick={() => setOpen((v) => !v)}
        >
          Request Headers
          <span class="msg-detail__count-badge">{entries().length}</span>
          <span
            class="msg-detail__chevron"
            classList={{ 'msg-detail__chevron--open': open() }}
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="m18.57 11.18-10-7c-.3-.21-.7-.24-1.04-.07-.33.17-.54.51-.54.89v14c0 .37.21.71.54.89.15.08.3.11.46.11.2 0 .4-.06.57-.18l10-7a.997.997 0 0 0 0-1.64Z" />
            </svg>
          </span>
        </button>
      </div>
      <Show when={open()}>
        <div class="data-table-scroll" id={tableId}>
          <table class="data-table msg-detail__table">
            <thead>
              <tr>
                <th>Header</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <For each={entries()}>
                {([k, v]) => (
                  <tr>
                    <td class="msg-detail__mono-xs">{k}</td>
                    <td class="msg-detail__mono-xs msg-detail__log-body">{v}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

export function ModelParamsSection(props: { params: Record<string, unknown> }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const entries = (): Array<[string, unknown]> =>
    Object.entries(props.params).sort(([a], [b]) => a.localeCompare(b));
  const tableId = `msg-detail-model-params-${Math.random().toString(36).slice(2, 10)}`;
  return (
    <div class={`toggle-panel${open() ? ' toggle-panel--open' : ''}`}>
      <div class="toggle-panel__header">
        <button
          type="button"
          class="msg-detail__section-title msg-detail__section-title--toggle"
          aria-expanded={open() ? 'true' : 'false'}
          aria-controls={tableId}
          onClick={() => setOpen((v) => !v)}
        >
          Model Parameters
          <span class="msg-detail__count-badge">{entries().length}</span>
          <span
            class="msg-detail__chevron"
            classList={{ 'msg-detail__chevron--open': open() }}
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="m18.57 11.18-10-7c-.3-.21-.7-.24-1.04-.07-.33.17-.54.51-.54.89v14c0 .37.21.71.54.89.15.08.3.11.46.11.2 0 .4-.06.57-.18l10-7a.997.997 0 0 0 0-1.64Z" />
            </svg>
          </span>
        </button>
        <InfoTooltip text={MODEL_PARAMS_TOOLTIP} />
      </div>
      <Show when={open()}>
        <div class="data-table-scroll" id={tableId}>
          <table class="data-table msg-detail__table">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <For each={entries()}>
                {([k, v]) => (
                  <tr>
                    <td class="msg-detail__mono-xs">{k}</td>
                    <td class="msg-detail__mono-xs msg-detail__param-value">
                      {formatParamValue(v)}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
