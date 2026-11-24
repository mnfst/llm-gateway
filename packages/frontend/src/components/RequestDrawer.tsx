import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  Show,
  For,
  onCleanup,
  type Component,
} from 'solid-js';
import {
  getMessageDetails,
  type AttemptRecording,
  type AutofixDecision,
} from '../services/api/messages.js';
import {
  AUTOFIX_STATUS_LABELS,
  isFailedStatus,
  isSuccessStatus,
  type AutofixStatus,
} from 'manifest-shared';
import { formatParamValue } from './MessageDetailsSections.jsx';
import { providerIcon } from './ProviderIcon.jsx';
import { AutofixIcon, FallbackIcon } from './message-table-cells.jsx';
import { authBadgeFor } from './AuthBadge.js';
import RequestMessages, { type RecordingView } from './RequestMessages.jsx';
import '../styles/request-drawer.css';

export interface RequestDrawerProps {
  messageId: string | null;
  onClose: () => void;
  onOpenMessage?: (id: string) => void;
}

type AttemptTab = 'details' | 'messages' | 'tools' | 'raw' | 'headers' | 'params';

interface Attempt {
  id: string;
  index: number;
  type: 'initial' | 'fallback' | 'autofix';
  status: string;
  provider: string;
  model: string;
  auth_type: string;
  error_message?: string;
  error_origin?: string;
  error_class?: string;
  error_http_status?: number;
  model_id?: string;
  trace_id?: string;
  routing_tier?: string;
  routing_reason?: string;
  service_type?: string;
  session_key?: string;
  description?: string;
  duration_ms?: number;
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
  fallback_from_model?: string;
  fallback_index?: number;
  request_headers?: Record<string, string>;
  request_params?: Record<string, unknown>;
  autofix_applied?: boolean;
  autofix_operations?: any;
  autofix_decision?: AutofixDecision;
  autofix_role?: string;
  autofix_sibling?: any;
  recording?: AttemptRecording | null;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mon} ${day}, ${hh}:${mm}:${ss}`;
}

function statusLabel(status: string): string {
  if (status === 'pending') return 'Pending';
  if (status === 'cancelled') return 'Cancelled';
  if (isSuccessStatus(status)) return 'Success';
  if (status === 'auto_fixed') return 'Autofixed';
  if (status === 'rate_limited') return 'Rate limited';
  return 'Failed';
}

/** The attempt's HTTP code as displayed: 200 for success, the provider's
    error code otherwise, ERR when the failure carried no HTTP response. */
function attemptCode(att: { status: string; error_http_status?: number }): string {
  if (att.status === 'pending') return '—';
  if (att.status === 'cancelled') return 'CXL';
  if (isSuccessStatus(att.status)) return '200';
  return att.error_http_status != null ? String(att.error_http_status) : 'ERR';
}

function requestStatusClass(status: string): string {
  if (isSuccessStatus(status)) return 'drawer-status--success';
  if (status === 'pending' || status === 'cancelled') return 'drawer-status--neutral';
  return 'drawer-status--error';
}

function attemptStatusClass(status: string): string {
  if (isSuccessStatus(status)) return 'attempt-code--ok';
  if (status === 'pending' || status === 'cancelled') return 'attempt-code--neutral';
  return 'attempt-code--error';
}

function attemptErrorMessage(
  att: Pick<Attempt, 'status' | 'error_message'>,
  requestMessage: unknown,
): string | undefined {
  if (!isFailedStatus(att.status)) return undefined;
  if (typeof att.error_message === 'string' && att.error_message.trim()) {
    return att.error_message;
  }
  if (typeof requestMessage === 'string' && requestMessage.trim()) return requestMessage;
  return 'Request failed without an error message.';
}

function inferType(att: any, index: number, msg: any): Attempt['type'] {
  if (att.autofix_role === 'retry') return 'autofix';
  if (att.fallback_from_model || att.fallback_index) return 'fallback';
  // For backend summary attempts (no autofix_role/fallback fields),
  // use position: first = initial, rest = fallback (unless autofix on the request)
  if (index > 0 && msg.autofix_applied) return 'autofix';
  if (index > 0) return 'fallback';
  return 'initial';
}

function buildAttempts(msg: any): Attempt[] {
  // When the backend provides a real attempts array, use it
  if (Array.isArray(msg.attempts)) {
    return msg.attempts.map((att: any, i: number) => ({
      id: att.id,
      index: i + 1,
      type: inferType(att, i, msg),
      status: att.status,
      provider: att.provider ?? msg.provider,
      model: att.model ?? msg.model ?? msg.model_id,
      auth_type: att.auth_type ?? msg.auth_type,
      error_message: attemptErrorMessage(att, msg.error_message),
      error_origin: att.error_origin ?? undefined,
      error_class: att.error_class ?? undefined,
      error_http_status: att.error_http_status ?? undefined,
      model_id: att.model_id ?? undefined,
      trace_id: att.trace_id ?? msg.trace_id,
      routing_tier: att.routing_tier ?? undefined,
      routing_reason: att.routing_reason ?? undefined,
      service_type: att.service_type ?? msg.service_type,
      session_key: att.session_key ?? msg.session_key,
      description: att.description ?? msg.description,
      duration_ms: att.duration_ms ?? undefined,
      cost: att.cost_usd != null ? Number(att.cost_usd) : undefined,
      input_tokens: att.input_tokens ?? undefined,
      fallback_from_model: att.fallback_from_model ?? undefined,
      fallback_index: att.fallback_index ?? undefined,
      output_tokens: att.output_tokens ?? undefined,
      request_headers: att.request_headers ?? undefined,
      request_params: att.request_params ?? undefined,
      autofix_applied: att.autofix_applied ?? false,
      autofix_operations: att.autofix_operations ?? undefined,
      autofix_decision: att.autofix_decision ?? msg.autofix_decision,
      autofix_role: att.autofix_role ?? undefined,
      autofix_sibling: att.autofix_sibling ?? msg.autofix_sibling,
      recording: att.recording ?? null,
    }));
  }

  // Fallback: single attempt from the message row itself
  let type: Attempt['type'] = 'initial';
  if (msg.fallback_from_model) type = 'fallback';
  if (msg.autofix_role === 'retry') type = 'autofix';

  return [
    {
      id: msg.id,
      index: 1,
      type,
      status: msg.status,
      provider: msg.provider,
      model: msg.model || msg.model_id,
      auth_type: msg.auth_type,
      error_message: attemptErrorMessage(msg, msg.error_message),
      error_origin: msg.error_origin,
      error_class: msg.error_class,
      error_http_status: msg.error_http_status,
      model_id: msg.model_id,
      trace_id: msg.trace_id,
      routing_tier: msg.routing_tier,
      routing_reason: msg.routing_reason,
      service_type: msg.service_type,
      session_key: msg.session_key,
      description: msg.description,
      duration_ms: msg.duration_ms,
      cost: msg.cost,
      input_tokens: msg.input_tokens,
      fallback_from_model: msg.fallback_from_model ?? undefined,
      fallback_index: msg.fallback_index ?? undefined,
      output_tokens: msg.output_tokens,
      request_headers: msg.request_headers,
      request_params: msg.request_params,
      autofix_applied: msg.autofix_applied,
      autofix_operations: msg.autofix_operations,
      autofix_decision: msg.autofix_decision,
      autofix_role: msg.autofix_role,
      autofix_sibling: msg.autofix_sibling,
      recording: null,
    },
  ];
}

const RequestDrawer: Component<RequestDrawerProps> = (props) => {
  const [selectedAttempt, setSelectedAttempt] = createSignal(0);
  const [tab, setTab] = createSignal<AttemptTab>('details');
  const open = () => props.messageId !== null;

  const [data] = createResource(
    () => (props.messageId ? props.messageId : false),
    (id) => getMessageDetails(id as string),
  );

  const m = () => {
    const raw = data();
    if (!raw) return null;
    return (raw as any).message ?? raw;
  };

  const attempts = createMemo(() => {
    const msg = m();
    if (!msg) return [];
    return buildAttempts(msg);
  });

  const currentAttempt = () => attempts()[selectedAttempt()] ?? null;

  const visibleTabs = createMemo(() => {
    const att = currentAttempt();
    const tabs: Array<{ value: AttemptTab; label: string }> = [
      { value: 'details', label: 'Details' },
    ];
    if (att?.recording) {
      tabs.push({ value: 'messages', label: 'Messages' });
      tabs.push({ value: 'tools', label: 'Tools' });
      tabs.push({ value: 'raw', label: 'Raw' });
    }
    if (att?.request_headers && Object.keys(att.request_headers).length > 0) {
      tabs.push({ value: 'headers', label: 'Request headers' });
    }
    if (att?.request_params && Object.keys(att.request_params).length > 0) {
      tabs.push({ value: 'params', label: 'Model params' });
    }
    return tabs;
  });

  const recordingView = createMemo((): RecordingView => {
    const t = tab();
    if (t === 'tools') return 'tools';
    if (t === 'raw') return 'raw';
    return 'messages';
  });

  // Reset attempt + tab when message changes
  createEffect(() => {
    if (props.messageId) {
      setSelectedAttempt(0);
      setTab('details');
    }
  });

  // Reset tab if current tab disappears
  createEffect(() => {
    const tabs = visibleTabs();
    if (tabs.length > 0 && !tabs.some((t) => t.value === tab())) {
      setTab(tabs[0]!.value);
    }
  });

  // Close on Escape
  if (typeof document !== 'undefined') {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open()) props.onClose();
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  }

  const requestStatus = () => {
    const msg = m();
    if (!msg) return 'error';
    if (msg.autofix_role === 'retry' && isSuccessStatus(msg.status)) return 'success';
    return msg.status;
  };

  const headerProvider = () => currentAttempt()?.provider ?? m()?.provider;
  const headerAuthType = () => currentAttempt()?.auth_type ?? m()?.auth_type;
  const headerModel = () => currentAttempt()?.model ?? m()?.model ?? m()?.model_id;

  return (
    <>
      <div class="drawer" classList={{ 'drawer--open': open() }}>
        <Show when={m()}>
          {(msg) => (
            <>
              {/* ── Request header (full width) ── */}
              <div class="drawer__header">
                <div class="drawer__title-row">
                  <h3 class="drawer__title">Request {msg().id?.slice(0, 12)}</h3>
                  <button class="drawer__close" onClick={props.onClose} aria-label="Close">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
                <div class="drawer__meta-row">
                  <span class={`drawer-status ${requestStatusClass(requestStatus())}`}>
                    {statusLabel(requestStatus())}
                  </span>
                  <Show when={msg().autofix_status as AutofixStatus | null}>
                    {(autofixStatus) => (
                      <>
                        <span class="drawer__meta-sep">&middot;</span>
                        <span class="drawer__meta-text">
                          Autofix: {AUTOFIX_STATUS_LABELS[autofixStatus()]}
                        </span>
                      </>
                    )}
                  </Show>
                  <Show when={headerProvider()}>
                    <span class="drawer__meta-sep">&middot;</span>
                    <span
                      class="drawer__meta-text"
                      style="display: inline-flex; align-items: center; gap: 4px;"
                    >
                      <span style="display: inline-flex; position: relative; flex-shrink: 0; width: 14px; height: 14px;">
                        {providerIcon(headerProvider(), 14)}
                        {authBadgeFor(headerAuthType(), 8)}
                      </span>
                      {headerModel()}
                    </span>
                  </Show>
                  <Show when={msg().timestamp}>
                    <span class="drawer__meta-sep">&middot;</span>
                    <span class="drawer__meta-text">{fmtDate(msg().timestamp)}</span>
                  </Show>
                </div>
              </div>

              <div class="drawer__split">
                {/* Attempts sidebar — hidden when no attempts */}
                <Show when={attempts().length > 0}>
                  <div class="drawer__sidebar">
                    <div class="drawer__sidebar-title">Attempts</div>
                    <For each={attempts()}>
                      {(att, idx) => (
                        <button
                          class="attempt-item"
                          classList={{ 'attempt-item--active': selectedAttempt() === idx() }}
                          onClick={() => {
                            setSelectedAttempt(idx());
                            setTab('details');
                          }}
                        >
                          <span class="attempt-item__num">{att.index}</span>
                          <span class="attempt-item__icon">
                            {att.type === 'fallback' ? (
                              <FallbackIcon />
                            ) : att.type === 'autofix' ? (
                              <AutofixIcon />
                            ) : (
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="14"
                                height="14"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                              >
                                <path d="M5 12h14" />
                                <path d="m12 5 7 7-7 7" />
                              </svg>
                            )}
                          </span>
                          <span class="attempt-item__model">{att.model ?? 'No provider'}</span>
                          <span class={`attempt-code ${attemptStatusClass(att.status)}`}>
                            {attemptCode(att)}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Attempt content */}
                <div class="drawer__content">
                  <Show
                    when={currentAttempt()}
                    fallback={
                      <>
                        <div class="panel__tabs drawer__tabs-full" role="tablist">
                          <For each={visibleTabs()}>
                            {(t) => (
                              <button
                                class="panel__tab"
                                classList={{ 'panel__tab--active': tab() === t.value }}
                                role="tab"
                                onClick={() => setTab(t.value)}
                              >
                                {t.label}
                              </button>
                            )}
                          </For>
                        </div>
                        <div class="drawer__body">
                          <Show when={tab() === 'details'}>
                            <div style="color: hsl(var(--muted-foreground));">
                              Manifest rejected this request before contacting a provider.
                            </div>
                          </Show>
                        </div>
                      </>
                    }
                  >
                    {(att) => (
                      <>
                        {/* Tabs */}
                        <div class="panel__tabs drawer__tabs-full" role="tablist">
                          <For each={visibleTabs()}>
                            {(t) => (
                              <button
                                class="panel__tab"
                                classList={{ 'panel__tab--active': tab() === t.value }}
                                role="tab"
                                onClick={() => setTab(t.value)}
                              >
                                {t.label}
                              </button>
                            )}
                          </For>
                        </div>

                        <Show when={tab() === 'messages' || tab() === 'tools' || tab() === 'raw'}>
                          <div class="drawer__messages-pane">
                            <RequestMessages
                              recording={att().recording ?? null}
                              view={recordingView()}
                            />
                          </div>
                        </Show>

                        <Show when={tab() !== 'messages' && tab() !== 'tools' && tab() !== 'raw'}>
                          <div class="drawer__body">
                            {/* Details tab */}
                            <Show when={tab() === 'details'}>
                              <div class="drawer-metadata">
                                <div class="drawer-kv">
                                  <span class="drawer-kv__key">Status</span>
                                  <span style="display: inline-flex; align-items: center; gap: 6px;">
                                    {statusLabel(att().status)}
                                    <span
                                      class={`attempt-code ${attemptStatusClass(att().status)}`}
                                    >
                                      {attemptCode(att())}
                                    </span>
                                  </span>
                                </div>
                                <div class="drawer-kv">
                                  <span class="drawer-kv__key">Type</span>
                                  <span style="text-transform: capitalize;">{att().type}</span>
                                </div>
                                <div class="drawer-kv">
                                  <span class="drawer-kv__key">Provider</span>
                                  <span style="display: inline-flex; align-items: center; gap: 6px;">
                                    {providerIcon(att().provider, 14)}
                                    {att().provider ?? '-'}
                                  </span>
                                </div>
                                <Show when={att().auth_type}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Auth</span>
                                    <span>{att().auth_type}</span>
                                  </div>
                                </Show>
                                <div class="drawer-kv">
                                  <span class="drawer-kv__key">Model</span>
                                  <span>{att().model ?? '-'}</span>
                                </div>
                                <Show when={att().model_id && att().model_id !== att().model}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Model ID</span>
                                    <span>{att().model_id}</span>
                                  </div>
                                </Show>
                                <Show when={att().trace_id}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Trace ID</span>
                                    <span>{att().trace_id}</span>
                                  </div>
                                </Show>
                                <Show when={att().routing_tier}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Routing tier</span>
                                    <span>{att().routing_tier}</span>
                                  </div>
                                </Show>
                                <Show when={att().routing_reason}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Reason</span>
                                    <span>{att().routing_reason}</span>
                                  </div>
                                </Show>
                                <Show when={att().service_type}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Service type</span>
                                    <span>{att().service_type}</span>
                                  </div>
                                </Show>
                                <Show when={att().session_key}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Session</span>
                                    <span>{att().session_key}</span>
                                  </div>
                                </Show>
                                <Show when={att().duration_ms != null}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Duration</span>
                                    <span>{att().duration_ms}ms</span>
                                  </div>
                                </Show>
                                <Show when={att().cost != null}>
                                  <div class="drawer-kv">
                                    <span class="drawer-kv__key">Cost</span>
                                    <span>${att().cost?.toFixed(4)}</span>
                                  </div>
                                </Show>
                                <div class="drawer-kv">
                                  <span class="drawer-kv__key">Input tokens</span>
                                  <span>{att().input_tokens?.toLocaleString()}</span>
                                </div>
                                <div class="drawer-kv">
                                  <span class="drawer-kv__key">Output tokens</span>
                                  <span>{att().output_tokens?.toLocaleString()}</span>
                                </div>

                                {/* ── The attempt's story, in reading order ──────
                                  1. ORIGIN cards (why this attempt exists) —
                                     before the error;
                                  2. the ERROR card (what happened here);
                                  3. CONSEQUENCE cards (what this failure
                                     triggered next) — after the error.
                                  Cumulative by design: the error card is never
                                  replaced by a context card. ── */}

                                {/* Origin: this attempt IS the healed Autofix retry */}
                                <Show when={att().autofix_role === 'retry'}>
                                  <div class="drawer-context-card drawer-context-card--autofix">
                                    <div style="margin-bottom: 8px;">
                                      <span class="trigger-badge trigger-badge--autofix">
                                        <AutofixIcon />
                                        autofix
                                      </span>
                                    </div>
                                    <div style="font-size: var(--font-size-sm); color: hsl(var(--foreground)); margin-bottom: 8px;">
                                      {isSuccessStatus(att().status)
                                        ? 'This Autofix retry recovered the request.'
                                        : 'Manifest applied a fix and retried, but this attempt failed.'}
                                    </div>
                                    <Show when={att().autofix_decision?.explanation?.summary}>
                                      <div style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); margin-bottom: 8px;">
                                        {att().autofix_decision!.explanation!.summary}
                                      </div>
                                    </Show>
                                    <Show when={att().autofix_operations}>
                                      <table
                                        class="error-autofix-row__meta-table"
                                        style="--meta-table-border: hsl(222 47% 50% / 0.3); margin-top: 0;"
                                      >
                                        <tbody>
                                          <For each={att().autofix_operations as any[]}>
                                            {(op: any) => (
                                              <tr>
                                                <td class="error-autofix-row__meta-label">Fix</td>
                                                <td>
                                                  {op.type}
                                                  {(op.args?.from ?? op.from)
                                                    ? `: ${op.args?.from ?? op.from}`
                                                    : ''}
                                                  {(op.args?.to ?? op.to)
                                                    ? ` → ${op.args?.to ?? op.to}`
                                                    : ''}
                                                </td>
                                              </tr>
                                            )}
                                          </For>
                                        </tbody>
                                      </table>
                                    </Show>
                                  </div>
                                </Show>

                                {/* Origin: this attempt IS the fallback recovery */}
                                <Show when={att().fallback_from_model}>
                                  <div class="drawer-context-card drawer-context-card--fallback">
                                    <div style="margin-bottom: 8px;">
                                      <span class="trigger-badge trigger-badge--fallback">
                                        <FallbackIcon />
                                        fallback
                                      </span>
                                    </div>
                                    <div style="font-size: var(--font-size-sm); color: hsl(var(--foreground));">
                                      {isSuccessStatus(att().status)
                                        ? 'This fallback recovered the request.'
                                        : 'This fallback attempt failed.'}{' '}
                                      Fell back from {att().fallback_from_model}.
                                    </div>
                                  </div>
                                </Show>

                                {/* Error block if this attempt failed — never hidden
                                  by the context cards around it */}
                                <Show when={att().error_message}>
                                  <div class="drawer-context-card drawer-context-card--error">
                                    <div style="font-size: var(--font-size-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; color: hsl(var(--foreground));">
                                      Error
                                    </div>
                                    <div style="font-size: var(--font-size-sm); color: hsl(var(--destructive)); font-family: var(--font-mono, monospace); overflow-wrap: anywhere; white-space: pre-wrap; margin-bottom: 8px;">
                                      {att().error_message}
                                    </div>
                                    <Show
                                      when={
                                        att().error_origin ||
                                        att().error_class ||
                                        att().error_http_status
                                      }
                                    >
                                      <table
                                        class="error-autofix-row__meta-table"
                                        style="--meta-table-border: hsl(var(--destructive) / 0.25);"
                                      >
                                        <tbody>
                                          <Show when={att().error_origin}>
                                            <tr>
                                              <td class="error-autofix-row__meta-label">Origin</td>
                                              <td>{att().error_origin}</td>
                                            </tr>
                                          </Show>
                                          <Show when={att().error_class}>
                                            <tr>
                                              <td class="error-autofix-row__meta-label">Type</td>
                                              <td>{att().error_class}</td>
                                            </tr>
                                          </Show>
                                          <Show when={att().error_http_status}>
                                            <tr>
                                              <td class="error-autofix-row__meta-label">
                                                HTTP status
                                              </td>
                                              <td>{att().error_http_status}</td>
                                            </tr>
                                          </Show>
                                        </tbody>
                                      </table>
                                    </Show>
                                  </div>
                                </Show>

                                {/* Consequence: this failed attempt was autofixed
                                  and retried right after */}
                                <Show
                                  when={att().autofix_applied && att().autofix_role !== 'retry'}
                                >
                                  <div class="drawer-context-card drawer-context-card--autofix">
                                    <div style="margin-bottom: 8px;">
                                      <span class="trigger-badge trigger-badge--autofix">
                                        <AutofixIcon />
                                        autofix
                                      </span>
                                    </div>
                                    <div style="font-size: var(--font-size-sm); color: hsl(var(--foreground)); margin-bottom: 8px;">
                                      {`This attempt failed and was autofixed.${
                                        attempts().length > att().index
                                          ? ` Retried as attempt ${att().index + 1}.`
                                          : ''
                                      }`}
                                    </div>
                                    <Show when={att().autofix_decision?.explanation?.summary}>
                                      <div style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); margin-bottom: 8px;">
                                        {att().autofix_decision!.explanation!.summary}
                                      </div>
                                    </Show>
                                    <Show when={att().autofix_operations}>
                                      <table
                                        class="error-autofix-row__meta-table"
                                        style="--meta-table-border: hsl(222 47% 50% / 0.3); margin-top: 0;"
                                      >
                                        <tbody>
                                          <For each={att().autofix_operations as any[]}>
                                            {(op: any) => (
                                              <tr>
                                                <td class="error-autofix-row__meta-label">Fix</td>
                                                <td>
                                                  {op.type}
                                                  {(op.args?.from ?? op.from)
                                                    ? `: ${op.args?.from ?? op.from}`
                                                    : ''}
                                                  {(op.args?.to ?? op.to)
                                                    ? ` → ${op.args?.to ?? op.to}`
                                                    : ''}
                                                </td>
                                              </tr>
                                            )}
                                          </For>
                                        </tbody>
                                      </table>
                                    </Show>
                                  </div>
                                </Show>

                                {/* Consequence: this failed attempt was recovered by
                                  a LATER fallback attempt */}
                                <Show
                                  when={
                                    isFailedStatus(att().status) &&
                                    !(att().autofix_applied && att().autofix_role !== 'retry') &&
                                    attempts().length > att().index &&
                                    attempts()[att().index]?.fallback_from_model
                                  }
                                >
                                  <div class="drawer-context-card drawer-context-card--fallback">
                                    <div style="margin-bottom: 8px;">
                                      <span class="trigger-badge trigger-badge--fallback">
                                        <FallbackIcon />
                                        fallback
                                      </span>
                                    </div>
                                    <div style="font-size: var(--font-size-sm); color: hsl(var(--foreground));">
                                      This attempt failed.{' '}
                                      {isSuccessStatus(attempts()[att().index]?.status)
                                        ? 'Recovered by fallback to'
                                        : 'Continued with fallback to'}{' '}
                                      {attempts()[att().index]?.model} (attempt {att().index + 1}).
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </Show>

                            {/* Headers tab */}
                            <Show when={tab() === 'headers' && att().request_headers}>
                              <div class="drawer-metadata">
                                <For
                                  each={Object.entries(att().request_headers!).sort(([a], [b]) =>
                                    a.localeCompare(b),
                                  )}
                                >
                                  {([key, val]) => (
                                    <div class="drawer-kv">
                                      <span class="drawer-kv__key">{key}</span>
                                      <span style="word-break: break-all;">{String(val)}</span>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>

                            {/* Params tab */}
                            <Show when={tab() === 'params' && att().request_params}>
                              <div class="drawer-metadata">
                                <For
                                  each={Object.entries(att().request_params!).sort(([a], [b]) =>
                                    a.localeCompare(b),
                                  )}
                                >
                                  {([key, val]) => (
                                    <div class="drawer-kv">
                                      <span class="drawer-kv__key">{key}</span>
                                      <span style="word-break: break-all; font-family: var(--font-mono, monospace); font-size: var(--font-size-xs);">
                                        {formatParamValue(val)}
                                      </span>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            </>
          )}
        </Show>

        <Show when={!m() && open()}>
          <div
            class="drawer__body"
            style="display: flex; align-items: center; justify-content: center; height: 200px; color: hsl(var(--muted-foreground));"
          >
            Loading...
          </div>
        </Show>
      </div>
    </>
  );
};

export default RequestDrawer;
