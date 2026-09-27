import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import {
  getMessageDetails,
  flagMessageMiscategorized,
  clearMessageMiscategorized,
  type AutofixOperation,
} from '../services/api.js';
import { inferProviderName } from '../services/routing-utils.js';
import { getModelDisplayName } from '../services/model-display.js';
import { AUTOFIX_STATUS_LABELS, manifestErrorDocsUrl, isSuccessStatus } from 'manifest-shared';
import { formatErrorClass, formatErrorOrigin } from '../services/formatters.js';
import { isPlanRequestLimitMessage } from '../services/message-error-taxonomy.js';
import { ModelParamsSection, RequestHeadersSection } from './MessageDetailsSections.jsx';
import { routingTierLabel } from './message-table-types.js';

export interface MessageDetailsProps {
  messageId: string;
  /** Open a linked message (the Autofix sibling) in the same list. */
  onOpenMessage?: (id: string) => void;
}

function MetaField(props: { label: string; value: string | null | undefined }): JSX.Element {
  return (
    <Show when={props.value}>
      <span class="msg-detail__meta-item">
        <span class="msg-detail__meta-label">{props.label}</span>
        {props.value}
      </span>
    </Show>
  );
}

function MiscategorizeControl(props: {
  messageId: string;
  initiallyFlagged: boolean;
}): JSX.Element {
  const [flagged, setFlagged] = createSignal(props.initiallyFlagged);
  const [busy, setBusy] = createSignal(false);

  async function toggle() {
    // Belt-and-suspenders: `disabled={busy()}` on the button already rejects
    // real clicks during an in-flight request. This guard catches the narrow
    // race where Solid's event delegation could fire the handler before the
    // disabled attribute commits, and tests can't reliably reproduce it.
    /* v8 ignore next */
    if (busy()) return;
    setBusy(true);
    try {
      if (flagged()) {
        await clearMessageMiscategorized(props.messageId);
        setFlagged(false);
      } else {
        await flagMessageMiscategorized(props.messageId);
        setFlagged(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      class="msg-detail__miscat-btn"
      onClick={toggle}
      disabled={busy()}
      title="Flag this message's routing category as wrong. Repeated flags reduce this category's routing score for this harness."
      aria-pressed={flagged()}
    >
      {flagged() ? 'Flagged as miscategorized (undo)' : 'Wrong category?'}
    </button>
  );
}

/**
 * Human-readable description of a Phoenix operation.
 */
function describeOperation(op: AutofixOperation): string {
  switch (op.type) {
    case 'drop_param':
      return op.from
        ? `Removed unsupported parameter "${op.from}"`
        : 'Removed an unsupported parameter';
    case 'rename_param':
      return op.from && op.to ? `Renamed "${op.from}" to "${op.to}"` : 'Renamed a parameter';
    case 'clamp_param':
      return op.from && op.to
        ? `Adjusted ${op.from} from ${op.from} to ${op.to}`
        : 'Adjusted a value to fit the allowed range';
    case 'set_param':
      return op.from && op.to ? `Set "${op.from}" to ${op.to}` : 'Set a required parameter value';
    case 'remap_model':
      return op.from && op.to
        ? `Switched from "${op.from}" to "${op.to}"`
        : 'Replaced the model with a supported one';
    case 'remove_unsupported_schema_keywords':
      return 'Cleaned unsupported JSON Schema keywords from tool definitions';
    case 'remove_unsupported_message_fields':
      return op.from
        ? `Removed unsupported field "${op.from}" from messages`
        : 'Removed unsupported fields from messages';
    default:
      return op.from && op.to ? `${op.type}: ${op.from} → ${op.to}` : op.type;
  }
}

/**
 * Autofix card. Shows the branding, a human phrase, the operation details,
 * Phoenix IDs, and a link to the paired row.
 */
export function AutofixSection(props: {
  role: string | null;
  operations: AutofixOperation[] | null;
  phoenix: {
    status: string | null;
    issueId: string | null;
    patchId: string | null;
    healAttemptId: string | null;
    explanation?: {
      summary: string;
      operations: Array<{ type: string; detail: string }>;
      source: string;
    } | null;
  } | null;
  sibling: { id: string; role: string | null; status: string } | null;
  onOpenMessage?: (id: string) => void;
}): JSX.Element {
  const isOriginal = () => props.role === 'original';
  // Prefer Phoenix's own explanation (authoritative, built from the real edit) over
  // our generic phrase and locally re-derived operation prose.
  const explanation = () => props.phoenix?.explanation ?? null;
  const phrase = () => {
    const summary = explanation()?.summary;
    if (summary) return summary;
    if (!isOriginal())
      return 'Manifest caught an error, repaired the request, and retried it successfully.';
    return props.sibling
      ? 'This request failed. Manifest repaired it automatically and retried.'
      : 'This request failed. Autofix tried but could not find a repair.';
  };
  // One row per edit: Phoenix's per-op detail when present, else our local fallback.
  const fixRows = (): Array<{ type: string; detail: string }> => {
    const ex = explanation();
    if (ex && ex.operations.length > 0) return ex.operations;
    return (props.operations ?? []).map((op) => ({ type: op.type, detail: describeOperation(op) }));
  };

  return (
    <div class="autofix-card-row">
      <div class="autofix-card autofix-card--autofix">
        <div class="autofix-card__branding">
          <span class="autofix-icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m21.45 11.11-3-1.5-2.68-1.34-.03-.03-1.34-2.68-1.5-3c-.34-.68-1.45-.68-1.79 0l-1.5 3-1.34 2.68-.03.03-2.68 1.34-3 1.5c-.34.17-.55.52-.55.89s.21.72.55.89l3 1.5 2.68 1.34.03.03 1.34 2.68 1.5 3c.17.34.52.55.89.55s.72-.21.89-.55l1.5-3 1.34-2.68.03-.03 2.68-1.34 3-1.5c.34-.17.55-.52.55-.89s-.21-.72-.55-.89Z" />
            </svg>
          </span>
          <span class="autofix-card__title">autofix</span>
        </div>

        <p class="autofix-card__phrase">{phrase()}</p>

        <Show when={fixRows().length > 0}>
          <table class="error-autofix-row__meta-table">
            <tbody>
              <For each={fixRows()}>
                {(op) => (
                  <tr>
                    <td class="error-autofix-row__meta-label">Fix</td>
                    <td class="error-autofix-row__meta-value">
                      <strong>{op.type}</strong>
                      <span class="error-autofix-row__meta-hint">{op.detail}</span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>

        <Show
          when={
            props.phoenix &&
            (props.phoenix.issueId || props.phoenix.patchId || props.phoenix.healAttemptId)
          }
        >
          <div class="autofix-card__ids">
            <Show when={props.phoenix!.issueId}>
              <span>Issue {props.phoenix!.issueId!.slice(0, 8)}</span>
            </Show>
            <Show when={props.phoenix!.patchId}>
              <span>Patch {props.phoenix!.patchId!.slice(0, 8)}</span>
            </Show>
            <Show when={props.phoenix!.healAttemptId}>
              <span>Heal-attempt {props.phoenix!.healAttemptId!.slice(0, 8)}</span>
            </Show>
          </div>
        </Show>

        <Show when={props.sibling && props.onOpenMessage}>
          <button
            type="button"
            class={
              isOriginal()
                ? 'error-autofix-row__autofix-btn'
                : 'error-autofix-row__autofix-btn error-autofix-row__autofix-btn--secondary'
            }
            style="margin-top: 10px;"
            onClick={() => props.onOpenMessage!(props.sibling!.id)}
          >
            {isOriginal() ? (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  style="flex-shrink: 0;"
                >
                  <path d="m21.45 11.11-3-1.5-2.68-1.34-.03-.03-1.34-2.68-1.5-3c-.34-.68-1.45-.68-1.79 0l-1.5 3-1.34 2.68-.03.03-2.68 1.34-3 1.5c-.34.17-.55.52-.55.89s.21.72.55.89l3 1.5 2.68 1.34.03.03 1.34 2.68 1.5 3c.17.34.52.55.89.55s.72-.21.89-.55l1.5-3 1.34-2.68.03-.03 2.68-1.34 3-1.5c.34-.17.55-.52.55-.89s-.21-.72-.55-.89Z" />
                </svg>
                View Autofix retry
              </>
            ) : (
              <>← View original request</>
            )}
          </button>
        </Show>
      </div>
    </div>
  );
}

export default function MessageDetails(props: MessageDetailsProps): JSX.Element {
  const [data] = createResource(() => props.messageId, getMessageDetails);

  return (
    <div class="msg-detail">
      <Show when={data.loading && !data.error}>
        <div class="msg-detail__loader">
          <div class="msg-detail__spinner" />
          <span>Loading details...</span>
        </div>
      </Show>
      <Show when={data.error}>
        <div class="msg-detail__error">Failed to load details</div>
      </Show>
      <Show when={!data.error && data() && !data.loading}>
        {(() => {
          const d = data()!;
          const m = d.message;
          const provider = m.model ? inferProviderName(m.model) : null;
          // Normalize status for display: a superseded failure (fallback / autofix
          // original) still renders its real two-state outcome. isSuccessStatus
          // accepts both the legacy `ok` and the canonical `success`.
          const displayStatus = () => {
            if (m.status === 'pending' || m.status === 'cancelled') {
              return {
                label: m.status === 'pending' ? 'Pending' : 'Cancelled',
                cls: 'status-badge status-badge--neutral',
              };
            }
            if (isSuccessStatus(m.status))
              return { label: 'Success', cls: 'status-badge status-badge--ok' };
            return { label: 'Failed', cls: 'status-badge status-badge--error' };
          };
          const isAutofixOriginal = m.autofix_applied && m.autofix_role === 'original';
          const isAutofixRetry = m.autofix_applied && m.autofix_role === 'retry';
          // The superseded primary of a fallback flow (legacy status `fallback_error`,
          // now the canonical `failed` + `superseded`), excluding the Autofix original
          // which has its own next-action panel.
          const isFallbackError =
            m.status === 'fallback_error' || (m.superseded === true && !isAutofixOriginal);
          const isFallbackTrigger = !!m.fallback_from_model && !isFallbackError;
          const hasTrigger = isAutofixRetry || isFallbackTrigger;
          const hasNextAction = isAutofixOriginal || isFallbackError;
          const isTripleLayout = hasTrigger && hasNextAction && !!m.error_message;
          const isPlanLimitBlock = () => isPlanRequestLimitMessage(m);
          return (
            <>
              {/* ── Message section — always first ─────────────────── */}
              <div class="msg-detail__section">
                <div class="msg-detail__section-title">Request</div>
                <div class="msg-detail__meta">
                  <span class="msg-detail__meta-item">
                    <span class="msg-detail__meta-label">Status</span>
                    <span class={displayStatus().cls}>{displayStatus().label}</span>
                  </span>
                  <MetaField
                    label="Autofix"
                    value={m.autofix_status ? AUTOFIX_STATUS_LABELS[m.autofix_status] : null}
                  />
                  <MetaField label="ID" value={m.id} />
                  <MetaField label="Provider" value={provider} />
                  <MetaField label="Auth" value={m.auth_type} />
                  <MetaField label="API Key" value={m.provider_key_label ?? 'Default'} />
                  <MetaField label="Model" value={m.model ? getModelDisplayName(m.model) : null} />
                  <MetaField label="Model ID" value={m.model} />
                  <MetaField label="Trace" value={m.trace_id?.slice(0, 16)} />
                  <MetaField
                    label="Routing"
                    value={
                      m.header_tier_name ??
                      (m.specificity_category
                        ? m.specificity_category.replace(/_/g, ' ')
                        : routingTierLabel(m.routing_tier))
                    }
                  />
                  <Show when={m.specificity_category}>
                    <MiscategorizeControl
                      messageId={m.id}
                      initiallyFlagged={m.specificity_miscategorized}
                    />
                  </Show>
                  <MetaField
                    label="Reason"
                    value={m.routing_reason === 'direct' ? 'DIRECT' : m.routing_reason}
                  />
                  <MetaField label="Service" value={m.service_type} />
                  <MetaField label="Session" value={m.session_key} />
                  <MetaField label="Description" value={m.description} />
                  <MetaField label="App" value={m.caller_attribution?.appName} />
                  <MetaField label="SDK" value={m.caller_attribution?.sdk} />
                  <MetaField label="Skill" value={m.skill_name} />
                </div>
              </div>

              {/* ── Error + trigger/action blocks ─────────────────── */}
              <Show when={m.error_message || hasTrigger}>
                {(() => {
                  /* Reusable blocks */
                  const errorBlock = (
                    <div
                      class={
                        hasNextAction || hasTrigger
                          ? 'error-autofix-row__error'
                          : 'error-autofix-row__error error-autofix-row__error--full'
                      }
                    >
                      <div class="error-autofix-row__title">Error</div>
                      <div class="msg-detail__error-inline">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
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
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                        <span>
                          {m.error_message}
                          <Show when={isPlanLimitBlock()}>
                            {' '}
                            Upgrade to Pro for unlimited requests.
                          </Show>
                        </span>
                        <Show when={isPlanLimitBlock()}>
                          <A
                            href="/upgrade?reason=requests"
                            class="btn btn--primary btn--sm"
                            style="text-decoration: none; flex-shrink: 0; margin-left: 8px;"
                          >
                            Upgrade plan
                          </A>
                        </Show>
                      </div>
                      <table class="error-autofix-row__meta-table">
                        <tbody>
                          <Show when={m.error_code}>
                            <tr>
                              <td class="error-autofix-row__meta-label">Code</td>
                              <td class="error-autofix-row__meta-value">
                                <a
                                  class="msg-detail__error-code"
                                  href={manifestErrorDocsUrl(m.error_code!)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {m.error_code}
                                </a>
                                <span class="error-autofix-row__meta-hint">
                                  Read the docs for this error.
                                </span>
                              </td>
                            </tr>
                          </Show>
                          <Show when={formatErrorOrigin(m.error_origin)}>
                            <tr>
                              <td class="error-autofix-row__meta-label">Origin</td>
                              <td class="error-autofix-row__meta-value">
                                <strong>{formatErrorOrigin(m.error_origin)}</strong>
                                <span class="error-autofix-row__meta-hint">
                                  {m.error_origin === 'provider' &&
                                    'The LLM provider rejected the request.'}
                                  {m.error_origin === 'transport' &&
                                    'Network or connection failure.'}
                                  {m.error_origin === 'config' && 'Manifest configuration issue.'}
                                  {m.error_origin === 'policy' &&
                                    'A Manifest usage limit was reached.'}
                                  {m.error_origin === 'internal' && 'An unexpected Manifest error.'}
                                  {m.error_origin === 'request' &&
                                    'Your agent sent a request Manifest could not route. No provider was called.'}
                                </span>
                              </td>
                            </tr>
                          </Show>
                          <Show when={formatErrorClass(m.error_class)}>
                            <tr>
                              <td class="error-autofix-row__meta-label">Type</td>
                              <td class="error-autofix-row__meta-value">
                                <strong>{formatErrorClass(m.error_class)}</strong>
                                <span class="error-autofix-row__meta-hint">
                                  {m.error_class === 'invalid_request' &&
                                    'The request is malformed. Wrong parameter, unsupported value, or missing field.'}
                                  {m.error_class === 'rate_limit' &&
                                    'Too many requests. The provider is throttling.'}
                                  {m.error_class === 'auth' &&
                                    'Authentication failed. Invalid or expired API key.'}
                                  {m.error_class === 'billing' &&
                                    'The provider rejected the request for billing or quota reasons.'}
                                  {m.error_class === 'timeout' &&
                                    'The request timed out before the provider responded.'}
                                  {m.error_class === 'server_error' &&
                                    'The provider experienced an internal error.'}
                                  {m.error_class === 'no_provider_key' &&
                                    'No API key is configured for this provider.'}
                                  {m.error_class === 'plan_request_limit_exceeded' &&
                                    'The Manifest Free plan monthly request quota was reached.'}
                                </span>
                              </td>
                            </tr>
                          </Show>
                        </tbody>
                      </table>
                    </div>
                  );

                  const arrowBlock = (
                    <div class="error-autofix-row__arrow">
                      <svg
                        class="error-autofix-row__arrow-right"
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="M6 13h6v4l6-5-6-5v4H6z" />
                      </svg>
                      <svg
                        class="error-autofix-row__arrow-down"
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="M13 12V6h-2v6H7l5 6 5-6z" />
                      </svg>
                    </div>
                  );

                  const autofixTriggerCard = (
                    <div class="error-autofix-row__autofix error-autofix-row__autofix--autofix">
                      <div class="error-autofix-row__autofix-title">
                        <span class="autofix-icon">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="12"
                            height="12"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="m21.45 11.11-3-1.5-2.68-1.34-.03-.03-1.34-2.68-1.5-3c-.34-.68-1.45-.68-1.79 0l-1.5 3-1.34 2.68-.03.03-2.68 1.34-3 1.5c-.34.17-.55.52-.55.89s.21.72.55.89l3 1.5 2.68 1.34.03.03 1.34 2.68 1.5 3c.17.34.52.55.89.55s.72-.21.89-.55l1.5-3 1.34-2.68.03-.03 2.68-1.34 3-1.5c.34-.17.55-.52.55-.89s-.21-.72-.55-.89Z" />
                          </svg>
                        </span>
                        <span class="autofix-card__title">autofix</span>
                      </div>
                      <p class="error-autofix-row__autofix-text" style="font-size: 12px;">
                        This request was triggered by an autofix.
                      </p>
                    </div>
                  );

                  const fallbackTriggerCard = (
                    <div class="error-autofix-row__autofix error-autofix-row__autofix--fallback">
                      <div class="error-autofix-row__autofix-title">
                        <span class="fallback-icon">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="12"
                            height="12"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="m7.84 13.75 1.33-1.49-2.53-2.25h8.37c2.21 0 4 1.79 4 4s-1.79 4-4 4h-3v2h3c3.31 0 6-2.69 6-6s-2.69-6-6-6H6.63l2.53-2.25-1.33-1.49-5.34 4.75 5.34 4.75Z" />
                          </svg>
                        </span>
                        <span class="autofix-card__title">fallback</span>
                      </div>
                      <p class="error-autofix-row__autofix-text" style="font-size: 12px;">
                        <strong>Attempt #{((m.fallback_index as number) ?? 0) + 1}:</strong> this
                        request was triggered by a fallback from{' '}
                        <strong>
                          {m.fallback_from_model
                            ? getModelDisplayName(m.fallback_from_model)
                            : 'unknown'}
                        </strong>
                        .
                      </p>
                    </div>
                  );

                  const autofixNextCard = (
                    <div class="error-autofix-row__autofix error-autofix-row__autofix--autofix">
                      <div class="error-autofix-row__autofix-title">
                        <span class="autofix-icon">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="12"
                            height="12"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="m21.45 11.11-3-1.5-2.68-1.34-.03-.03-1.34-2.68-1.5-3c-.34-.68-1.45-.68-1.79 0l-1.5 3-1.34 2.68-.03.03-2.68 1.34-3 1.5c-.34.17-.55.52-.55.89s.21.72.55.89l3 1.5 2.68 1.34.03.03 1.34 2.68 1.5 3c.17.34.52.55.89.55s.72-.21.89-.55l1.5-3 1.34-2.68.03-.03 2.68-1.34 3-1.5c.34-.17.55-.52.55-.89s-.21-.72-.55-.89Z" />
                          </svg>
                        </span>
                        <span class="autofix-card__title">autofix</span>
                      </div>
                      <p class="error-autofix-row__autofix-text">
                        Autofix was attempted after this error.
                      </p>
                      <Show when={m.autofix_sibling && props.onOpenMessage}>
                        <button
                          type="button"
                          class="error-autofix-row__autofix-btn"
                          onClick={() => props.onOpenMessage!(m.autofix_sibling!.id)}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            style="flex-shrink: 0;"
                          >
                            <path d="m21.45 11.11-3-1.5-2.68-1.34-.03-.03-1.34-2.68-1.5-3c-.34-.68-1.45-.68-1.79 0l-1.5 3-1.34 2.68-.03.03-2.68 1.34-3 1.5c-.34.17-.55.52-.55.89s.21.72.55.89l3 1.5 2.68 1.34.03.03 1.34 2.68 1.5 3c.17.34.52.55.89.55s.72-.21.89-.55l1.5-3 1.34-2.68.03-.03 2.68-1.34 3-1.5c.34-.17.55-.52.55-.89s-.21-.72-.55-.89Z" />
                          </svg>
                          View Autofix retry
                        </button>
                      </Show>
                    </div>
                  );

                  const fallbackNextCard = (
                    <div class="error-autofix-row__autofix error-autofix-row__autofix--fallback">
                      <div class="error-autofix-row__autofix-title">
                        <span class="fallback-icon">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="12"
                            height="12"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="m7.84 13.75 1.33-1.49-2.53-2.25h8.37c2.21 0 4 1.79 4 4s-1.79 4-4 4h-3v2h3c3.31 0 6-2.69 6-6s-2.69-6-6-6H6.63l2.53-2.25-1.33-1.49-5.34 4.75 5.34 4.75Z" />
                          </svg>
                        </span>
                        <span class="autofix-card__title">fallback</span>
                      </div>
                      <p class="error-autofix-row__autofix-text">
                        A fallback was triggered after this error.
                      </p>
                    </div>
                  );

                  /* Cases 4-7: Triple layout — trigger | error | next action */
                  if (isTripleLayout) {
                    const triggerCard = isAutofixRetry ? autofixTriggerCard : fallbackTriggerCard;
                    const nextCard = isAutofixOriginal ? autofixNextCard : fallbackNextCard;
                    const arrowBlock2 = (
                      <div class="error-autofix-row__arrow">
                        <svg
                          class="error-autofix-row__arrow-right"
                          xmlns="http://www.w3.org/2000/svg"
                          width="20"
                          height="20"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="M6 13h6v4l6-5-6-5v4H6z" />
                        </svg>
                        <svg
                          class="error-autofix-row__arrow-down"
                          xmlns="http://www.w3.org/2000/svg"
                          width="20"
                          height="20"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="M13 12V6h-2v6H7l5 6 5-6z" />
                        </svg>
                      </div>
                    );
                    return (
                      <div class="error-autofix-row error-autofix-row--triple">
                        {triggerCard}
                        {arrowBlock}
                        {errorBlock}
                        {arrowBlock2}
                        {nextCard}
                      </div>
                    );
                  }

                  /* Case 2: Error + autofix (no trigger) */
                  if (m.error_message && isAutofixOriginal) {
                    return (
                      <div class="error-autofix-row">
                        {errorBlock}
                        {arrowBlock}
                        {autofixNextCard}
                      </div>
                    );
                  }

                  /* Case 3: Error + fallback (no trigger) */
                  if (m.error_message && isFallbackError) {
                    return (
                      <div class="error-autofix-row">
                        {errorBlock}
                        {arrowBlock}
                        {fallbackNextCard}
                      </div>
                    );
                  }

                  /* Cases 8-9: Trigger + error, nothing after → 50/50 */
                  if (m.error_message && hasTrigger && !hasNextAction) {
                    const triggerCard = isAutofixRetry ? autofixTriggerCard : fallbackTriggerCard;
                    return (
                      <div class="error-autofix-row">
                        {triggerCard}
                        {arrowBlock}
                        {errorBlock}
                      </div>
                    );
                  }

                  /* Error only → full width */
                  if (m.error_message) {
                    return (
                      <div class="error-autofix-row error-autofix-row--solo">{errorBlock}</div>
                    );
                  }

                  /* ── No error: trigger-only cards (autofix retry success, fallback success) */
                  if (isAutofixRetry && !m.error_message) {
                    return (
                      <AutofixSection
                        role={m.autofix_role}
                        operations={m.autofix_operations}
                        phoenix={m.autofix_decision}
                        sibling={m.autofix_sibling}
                        onOpenMessage={props.onOpenMessage}
                      />
                    );
                  }

                  if (isFallbackTrigger && !m.error_message) {
                    return (
                      <div class="autofix-card-row">
                        <div class="autofix-card autofix-card--fallback">
                          <div class="autofix-card__branding">
                            <span class="fallback-icon">
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="12"
                                height="12"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path d="m7.84 13.75 1.33-1.49-2.53-2.25h8.37c2.21 0 4 1.79 4 4s-1.79 4-4 4h-3v2h3c3.31 0 6-2.69 6-6s-2.69-6-6-6H6.63l2.53-2.25-1.33-1.49-5.34 4.75 5.34 4.75Z" />
                              </svg>
                            </span>
                            <span class="autofix-card__title">fallback</span>
                          </div>
                          <p class="autofix-card__phrase" style="font-size: 12px;">
                            <strong>Attempt #{((m.fallback_index as number) ?? 0) + 1}:</strong>{' '}
                            this request was triggered by a fallback from{' '}
                            <strong>
                              {m.fallback_from_model
                                ? getModelDisplayName(m.fallback_from_model)
                                : 'unknown'}
                            </strong>
                            .
                          </p>
                        </div>
                      </div>
                    );
                  }

                  return null;
                })()}
              </Show>

              <Show when={(m.attempts?.length ?? 0) > 0}>
                <div class="message-details__section">
                  <h4>Provider attempts</h4>
                  <table class="details-table" aria-label="Provider attempts">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Status</th>
                        <th>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={m.attempts}>
                        {(attempt, index) => (
                          <tr>
                            <td>{index() + 1}</td>
                            <td>{attempt.provider ?? 'Unknown'}</td>
                            <td>{attempt.model ? getModelDisplayName(attempt.model) : '—'}</td>
                            <td>{attempt.status}</td>
                            <td>
                              {attempt.cost_usd == null
                                ? '—'
                                : `$${Number(attempt.cost_usd).toFixed(6)}`}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>

              {/* Model Parameters renders above Request Headers — params
                  are user intent (what the request asked for); headers are
                  protocol noise. */}
              <Show when={m.request_params && Object.keys(m.request_params).length > 0}>
                <ModelParamsSection params={m.request_params!} />
              </Show>

              <Show when={m.request_headers && Object.keys(m.request_headers).length > 0}>
                <RequestHeadersSection headers={m.request_headers!} />
              </Show>
            </>
          );
        })()}
      </Show>
    </div>
  );
}
