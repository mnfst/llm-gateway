import { createMemo, For, type Component } from 'solid-js';
import { authBadgeFor, authLabel } from './AuthBadge.js';
import { providerIcon, customProviderLogo } from './ProviderIcon.jsx';
import { customProviderColor, formatCost, formatNumber } from '../services/formatters.js';
import { getModelDisplayName } from '../services/model-display.js';
import {
  inferProviderFromModel,
  inferProviderName,
  resolveProviderId,
  stripCustomPrefix,
} from '../services/routing-utils.js';
import { PROVIDERS } from '../services/providers.js';
import InfoTooltip from './InfoTooltip.jsx';
import {
  attemptSuccessRate,
  totalAttemptsTooltip,
  MODEL_SUCCESS_RATE_TOOLTIP,
  type ModelReliabilityRow,
} from '../services/api/analytics.js';

interface CostByModelRow {
  model: string;
  display_name?: string;
  tokens: number;
  share_pct: number;
  estimated_cost: number;
  auth_type: string | null;
  provider?: string | null;
  custom_provider_name?: string | null;
}

interface CostByModelTableProps {
  rows: CostByModelRow[];
  /** Doctor availability drives the Total attempts tooltip wording. */
  doctorAvailable?: boolean;
  /** Per-model reliability (Total attempts · Success rate). The three columns
      render only when reliability data is provided. */
  reliability?: ModelReliabilityRow[];
}

function resolveRowProvider(row: CostByModelRow): string | undefined {
  if (row.provider) {
    const resolved = resolveProviderId(row.provider);
    if (resolved) return resolved;
  }
  if (row.model) return inferProviderFromModel(row.model);
  return undefined;
}

function resolveRowProviderName(row: CostByModelRow): string | undefined {
  const id = resolveRowProvider(row);
  if (!id) return undefined;
  return (
    PROVIDERS.find((p) => p.id === id)?.name ?? (row.model ? inferProviderName(row.model) : id)
  );
}

const CostByModelTable: Component<CostByModelTableProps> = (props) => {
  const sortedRows = createMemo(() =>
    [...props.rows].sort((a, b) => b.estimated_cost - a.estimated_cost),
  );

  const relFor = (model: string) => props.reliability?.find((r) => r.model === model);

  return (
    <div class="panel" style="margin-top: var(--gap-lg);">
      <div class="panel__title">Model usage</div>
      <p style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); margin: -8px 0 12px;">
        The models used and what they cost you
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Tokens</th>
            <th>% of total</th>
            <th>Cost</th>
            {props.reliability && (
              <>
                <th class="rel-col">
                  Total attempts
                  <InfoTooltip text={totalAttemptsTooltip(props.doctorAvailable ?? false)} />
                </th>
                <th class="rel-col">
                  Success rate
                  <InfoTooltip text={MODEL_SUCCESS_RATE_TOOLTIP} />
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          <For each={sortedRows()}>
            {(row) => (
              <tr>
                <td style="font-family: var(--font-mono); font-size: var(--font-size-sm);">
                  <span style="display: inline-flex; align-items: center; gap: 4px;">
                    {(() => {
                      const provId = resolveRowProvider(row);
                      const isCustom =
                        provId === 'custom' || provId?.startsWith('custom:') === true;
                      if (row.model && isCustom) {
                        const provName = row.custom_provider_name ?? undefined;
                        const logo = customProviderLogo(
                          provName ?? '',
                          16,
                          undefined,
                          row.model ?? undefined,
                        );
                        if (logo) return logo;
                        const letter = (provName ?? stripCustomPrefix(row.model))
                          .charAt(0)
                          .toUpperCase();
                        return (
                          <span
                            class="provider-card__logo-letter"
                            title={provName}
                            style={{
                              background: customProviderColor(provName ?? ''),
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
                      }
                      if (provId) {
                        const provName = resolveRowProviderName(row);
                        return (
                          <span
                            title={`${provName ?? provId} (${authLabel(row.auth_type)})`}
                            style="display: inline-flex; flex-shrink: 0; position: relative; width: 14px; height: 14px;"
                          >
                            {providerIcon(provId, 14)}
                            {authBadgeFor(row.auth_type, 8)}
                          </span>
                        );
                      }
                      return null;
                    })()}
                    {row.model
                      ? row.model.startsWith('custom:')
                        ? stripCustomPrefix(row.model)
                        : row.display_name || getModelDisplayName(row.model)
                      : row.model}
                  </span>
                </td>
                <td>{formatNumber(row.tokens)}</td>
                <td>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="width: 40px; height: 4px; border-radius: 2px; background: hsl(var(--muted)); overflow: hidden;">
                      <div
                        style={`width: ${row.share_pct}%; height: 100%; background: hsl(var(--chart-1)); border-radius: 2px;`}
                      />
                    </div>
                    <span style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                      {Math.round(row.share_pct)}%
                    </span>
                  </div>
                </td>
                <td
                  title={
                    row.estimated_cost > 0 && row.estimated_cost < 0.01
                      ? `$${row.estimated_cost.toFixed(6)}`
                      : undefined
                  }
                >
                  {formatCost(row.estimated_cost) ?? '\u2014'}
                </td>
                {props.reliability && (
                  <>
                    <td class="rel-col">
                      {(() => {
                        const rel = relFor(row.model);
                        return rel ? formatNumber(rel.attempts) : '\u2014';
                      })()}
                    </td>
                    <td class="rel-col">
                      {(() => {
                        const rel = relFor(row.model);
                        const rate = rel ? attemptSuccessRate(rel) : null;
                        return rate == null ? '\u2014' : `${(rate * 100).toFixed(1)}%`;
                      })()}
                    </td>
                  </>
                )}
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
};

export default CostByModelTable;
