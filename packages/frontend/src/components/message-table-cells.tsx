import { Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { routingTierLabel, type MessageRow, type MessageColumnKey } from './message-table-types.js';
import InfoTooltip from './InfoTooltip.jsx';
import {
  formatCost,
  formatNumber,
  formatTime,
  formatDuration,
  customProviderColor,
} from '../services/formatters.js';
import {
  inferProviderFromModel,
  inferProviderName,
  resolveProviderId,
  stripCustomPrefix,
} from '../services/routing-utils.js';
import { PROVIDERS } from '../services/providers.js';
import { getModelDisplayName } from '../services/model-display.js';
import { providerIcon, customProviderLogo } from './ProviderIcon.jsx';
import { authBadgeFor, authLabel } from './AuthBadge.js';
import { platformIcon, isSuccessStatus } from 'manifest-shared';
import { isPlanRequestLimitMessage } from '../services/message-error-taxonomy.js';

const MONO = 'font-family: var(--font-mono);';
const MONO_XS =
  'font-family: var(--font-mono); font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));';

export function HeartbeatIcon(): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

export function AutofixIcon(): JSX.Element {
  return (
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
  );
}

export function FallbackIcon(): JSX.Element {
  return (
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
  );
}

const HEADER_LABELS: Record<MessageColumnKey, string> = {
  date: 'Date',
  message: 'Request',
  cost: 'Cost',
  totalTokens: 'Tokens',
  input: 'Input',
  output: 'Output',
  model: 'Model',
  cache: 'Cache',
  duration: 'Latency',
  status: 'Status',
  attempts: 'Attempts',
  selfheal: 'Recovery attempts',
  agent: 'Harness',
};

const TOOLTIP_TEXT: Partial<Record<MessageColumnKey, string>> = {
  totalTokens: 'Tokens are units of text that AI models process. More tokens = higher cost.',
  input: "Tokens sent to the model (your prompt). Also called 'input tokens'.",
  output: "Tokens returned by the model (its response). Also called 'output tokens'.",
};

export function columnHeader(key: MessageColumnKey, tooltips?: boolean): JSX.Element {
  const label = key === 'totalTokens' && tooltips ? 'Total Tokens' : HEADER_LABELS[key];
  const tip = TOOLTIP_TEXT[key];
  return tip && (tooltips || key !== 'totalTokens') ? (
    <>
      {label}
      <InfoTooltip text={tip} />
    </>
  ) : (
    <>{label}</>
  );
}

export function DateCell(item: MessageRow): JSX.Element {
  return <td style={`white-space: nowrap; width: 1%; ${MONO_XS}`}>{formatTime(item.timestamp)}</td>;
}

export function MessageCell(item: MessageRow): JSX.Element {
  return (
    <td style={MONO_XS}>
      {item.id.slice(0, 8)}
      {item.routing_reason === 'heartbeat' && (
        <span
          title="Heartbeat"
          style="display: inline-flex; align-items: center; margin-left: 4px; color: hsl(var(--muted-foreground)); opacity: 0.7;"
        >
          {<HeartbeatIcon />}
        </span>
      )}
    </td>
  );
}

export function CostCell(item: MessageRow): JSX.Element {
  // Subscription rows with a non-zero cost are per-request subscriptions
  // like OpenCode Go (docs-attributed $/request). Flat-fee subscriptions
  // (Claude Max, ChatGPT Plus, GLM Coding, Copilot) report $0 and keep the
  // "Included in subscription" treatment.
  const isPerRequestSubscription =
    item.auth_type === 'subscription' && item.cost != null && item.cost > 0;
  return (
    <td style={MONO}>
      <Show
        when={item.auth_type === 'subscription' && !isPerRequestSubscription}
        fallback={
          <span
            title={
              isPerRequestSubscription
                ? `Per-request subscription cost: $${Number(item.cost!).toFixed(6)}`
                : item.cost != null && Number(item.cost) > 0 && Number(item.cost) < 0.01
                  ? `$${Number(item.cost).toFixed(6)}`
                  : undefined
            }
          >
            {item.cost != null ? (formatCost(item.cost) ?? '\u2014') : '\u2014'}
          </span>
        }
      >
        <span style="color: hsl(var(--muted-foreground));" title="Included in subscription">
          $0.00
        </span>
      </Show>
    </td>
  );
}

/**
 * Resolve the provider ID for a message row. Prefers the stored `provider`
 * column (populated by the proxy from routing resolution) over inference from
 * the model name prefix, which is ambiguous for subscription providers like
 * Ollama Cloud whose catalog includes models named after other vendors
 * (e.g. `deepseek-v3.2`, `kimi-k2:1t`, `gemma4:31b`).
 */
function resolveMessageProvider(item: MessageRow): string | undefined {
  if (item.provider) {
    const resolved = resolveProviderId(item.provider);
    if (resolved) return resolved;
  }
  if (item.model) return inferProviderFromModel(item.model);
  return undefined;
}

function resolveMessageProviderName(item: MessageRow): string | undefined {
  const id = resolveMessageProvider(item);
  if (!id) return undefined;
  return (
    PROVIDERS.find((p) => p.id === id)?.name ?? (item.model ? inferProviderName(item.model) : id)
  );
}

export function ModelCell(item: MessageRow): JSX.Element {
  const provId = resolveMessageProvider(item);
  const provName = resolveMessageProviderName(item);
  // Custom providers are identified by either the literal 'custom' (from
  // inferProviderFromModel on a `custom:...` model name) or by a stored
  // provider column of the form `custom:<uuid>` (from resolveProviderId,
  // which returns custom-prefixed IDs unchanged). Their display name arrives
  // pre-resolved from the backend as `custom_provider_name` (null when the
  // provider was deleted).
  const isCustomProvider = provId === 'custom' || provId?.startsWith('custom:') === true;
  return (
    <td style={MONO_XS}>
      <span style="display: inline-flex; align-items: center; gap: 4px;">
        {item.model && isCustomProvider ? (
          (() => {
            const customName = item.custom_provider_name ?? undefined;
            const logo = customProviderLogo(
              customName ?? '',
              16,
              undefined,
              item.model ?? undefined,
            );
            if (logo) return logo;
            const letter = (customName ?? stripCustomPrefix(item.model!)).charAt(0).toUpperCase();
            return (
              <span
                class="provider-card__logo-letter"
                title={customName}
                style={{
                  background: customProviderColor(customName ?? ''),
                  width: '16px',
                  height: '16px',
                  'font-size': '9px',
                  'flex-shrink': '0',
                  'border-radius': '50%',
                }}
              >
                {letter}
              </span>
            );
          })()
        ) : provId ? (
          <span
            role="img"
            aria-label={`${provName ?? provId} (${authLabel(item.auth_type)})`}
            title={`${provName ?? provId} (${authLabel(item.auth_type)})`}
            style="display: inline-flex; flex-shrink: 0; position: relative; color: hsl(var(--foreground)); width: 14px; height: 14px;"
          >
            {providerIcon(provId, 14)}
            {authBadgeFor(item.auth_type, 8)}
          </span>
        ) : null}
        {item.model
          ? item.model.startsWith('custom:')
            ? stripCustomPrefix(item.model)
            : getModelDisplayName(item.model)
          : '\u2014'}
        {item.header_tier_name ? (
          <span
            class={`tier-badge tier-badge--custom tier-color--${item.header_tier_color ?? 'indigo'}`}
            title={item.header_tier_name}
          >
            {item.header_tier_name}
          </span>
        ) : item.specificity_category ? (
          <span class="tier-badge tier-badge--specificity">
            {item.specificity_category.replace(/_/g, ' ')}
          </span>
        ) : item.routing_tier && item.routing_tier !== 'fallback' ? (
          <span class="tier-badge-tooltip">
            <span class={`tier-badge tier-badge--${item.routing_tier}`}>
              {routingTierLabel(item.routing_tier)}
            </span>
            {(item.routing_tier === 'direct' || item.routing_tier === 'default') && (
              <span class="tier-badge-tooltip__bubble">
                {item.routing_tier === 'direct'
                  ? 'The caller requested a specific model. No routing applied.'
                  : 'Routed through the default tier.'}
              </span>
            )}
          </span>
        ) : null}
      </span>
    </td>
  );
}

export function TokenCell(value: number | null): JSX.Element {
  return <td style={`width: 130px; ${MONO}`}>{value != null ? formatNumber(value) : '\u2014'}</td>;
}

export function SmallTokenCell(value: number | null): JSX.Element {
  return (
    <td style={`width: 102px; ${MONO_XS}`}>{value != null ? formatNumber(value) : '\u2014'}</td>
  );
}

export function CacheCell(item: MessageRow): JSX.Element {
  const has = (item.cache_read_tokens ?? 0) > 0 || (item.cache_creation_tokens ?? 0) > 0;
  return (
    <td style={`width: 192px; ${MONO_XS}`}>
      {has
        ? `Read: ${formatNumber(item.cache_read_tokens ?? 0)} / Write: ${formatNumber(item.cache_creation_tokens ?? 0)}`
        : '\u2014'}
    </td>
  );
}

export function DurationCell(item: MessageRow): JSX.Element {
  return (
    <td style={MONO_XS}>
      {item.duration_ms != null ? formatDuration(item.duration_ms) : '\u2014'}
    </td>
  );
}

export function AgentCell(
  item: MessageRow,
  platformLookup?: (
    name: string,
  ) => { platform: string | null; category: string | null } | undefined,
): JSX.Element {
  const icon = () => {
    const info = item.agent_name && platformLookup ? platformLookup(item.agent_name) : undefined;
    return info?.platform ? platformIcon(info.platform, info.category) : undefined;
  };
  return (
    <td style="white-space: nowrap; font-weight: 500; font-size: var(--font-size-xs);">
      <span style="display: inline-flex; align-items: center; gap: 5px;">
        <Show when={icon()}>
          {(src) => (
            <img
              src={src()}
              alt=""
              width="14"
              height="14"
              class="platform-icon"
              style="flex-shrink: 0;"
            />
          )}
        </Show>
        {item.agent_name ?? '\u2014'}
      </span>
    </td>
  );
}

export function AttemptsCell(item: MessageRow): JSX.Element {
  return <td style={MONO_XS}>{item.attempt_count ?? 1}</td>;
}

export function SelfHealCell(item: MessageRow): JSX.Element {
  const hasAutofix = !!item.autofix_applied;
  const hasFallback = !!item.fallback_from_model;

  if (!hasAutofix && !hasFallback) return <td style={MONO_XS}>{'\u2014'}</td>;

  return (
    <td>
      <span style="display: inline-flex; align-items: center; gap: 4px;">
        {hasAutofix && (
          <span
            class="trigger-badge trigger-badge--autofix"
            title="Autofix"
            style="padding: 1px 3px;"
          >
            <AutofixIcon />
            autofix
          </span>
        )}
        {hasFallback && (
          <span
            class="trigger-badge trigger-badge--fallback"
            title="Fallback"
            style="padding: 1px 3px;"
          >
            <FallbackIcon />
            fallback
          </span>
        )}
      </span>
    </td>
  );
}

/**
 * Compact origin descriptor appended to "Failed" (e.g. "Failed: Provider").
 */
const ERROR_DESCRIPTORS: Record<string, string> = {
  provider: 'Provider',
  transport: 'Transport',
  config: 'Setup',
  policy: 'Custom limit',
  internal: 'Manifest error',
  request: 'Bad request',
};

function isPlanLimitBlock(item: MessageRow): boolean {
  return isPlanRequestLimitMessage(item);
}

function statusErrorDescriptor(item: MessageRow): string | null {
  if (isPlanLimitBlock(item)) return 'Plan limit';
  return item.error_origin ? (ERROR_DESCRIPTORS[item.error_origin] ?? null) : null;
}

/**
 * Outcome status pill. Pending and caller-cancelled work is neutral; completed
 * outcomes remain the familiar Success/Failed binary.
 */
function describeStatusPill(item: MessageRow): {
  label: string;
  title?: string;
  cls: string;
  limitAgent: string | null;
} {
  const isSuccess = isSuccessStatus(item.status);
  if (isSuccess) {
    return { label: 'Success', cls: 'status-badge status-badge--ok', limitAgent: null };
  }
  if (item.status === 'pending' || item.status === 'cancelled') {
    return {
      label: item.status === 'pending' ? 'Pending' : 'Cancelled',
      cls: 'status-badge status-badge--neutral',
      limitAgent: null,
    };
  }
  // The pill stays a plain "Failed": the cause (provider, setup, custom
  // limit...) lives in the drawer's error message, and rides here only as a
  // hover title so the column reads binary at a glance.
  return {
    label: 'Failed',
    title: statusErrorDescriptor(item) ?? undefined,
    cls: 'status-badge status-badge--error',
    limitAgent: item.error_origin === 'policy' ? item.agent_name : null,
  };
}

export function StatusCell(item: MessageRow, _agentName: string | undefined): JSX.Element {
  const pill = describeStatusPill(item);

  // A Manifest software limit is one red pill linking to its agent's limits page.
  if (pill.limitAgent) {
    const planLimit = isPlanLimitBlock(item);
    return (
      <td style={planLimit ? 'padding: 8.1px var(--gap-md)' : undefined}>
        <A
          class={pill.cls}
          href={
            planLimit
              ? '/upgrade?reason=requests'
              : `/harnesses/${encodeURIComponent(pill.limitAgent)}/limits`
          }
          title={
            planLimit
              ? 'Free plan request limit reached - upgrade to Pro'
              : 'Manifest usage limit reached - open your limits'
          }
        >
          {pill.label}
        </A>
        {planLimit && (
          <A
            href="/upgrade?reason=requests"
            class="btn btn--primary btn--sm"
            style="margin-left: 6px; font-size: 11px; padding: 2px 8px; text-decoration: none;"
          >
            Upgrade plan
          </A>
        )}
      </td>
    );
  }

  const badge = (
    <span class={pill.cls} title={pill.title}>
      {pill.label}
    </span>
  );

  return <td>{badge}</td>;
}

export interface CellRenderContext {
  agentName?: string;
  customProviderName: (model: string) => string | undefined;
  agentPlatformLookup?: (
    name: string,
  ) => { platform: string | null; category: string | null } | undefined;
  onFallbackErrorClick?: (model: string) => void;
  onTriggerClick?: (id: string) => void;
}

export function renderCell(
  key: MessageColumnKey,
  item: MessageRow,
  ctx: CellRenderContext,
): JSX.Element {
  switch (key) {
    case 'date':
      return DateCell(item);
    case 'message':
      return MessageCell(item);
    case 'cost':
      return CostCell(item);
    case 'totalTokens':
      return TokenCell(item.total_tokens);
    case 'input':
      return SmallTokenCell(item.input_tokens);
    case 'output':
      return SmallTokenCell(item.output_tokens);
    case 'model':
      return ModelCell(item);
    case 'cache':
      return CacheCell(item);
    case 'duration':
      return DurationCell(item);
    case 'status':
      return StatusCell(item, ctx.agentName);
    case 'attempts':
      return AttemptsCell(item);
    case 'selfheal':
      return SelfHealCell(item);
    case 'agent':
      return AgentCell(item, ctx.agentPlatformLookup);
  }
}
