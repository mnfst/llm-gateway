import { Show, Suspense, lazy, type Component, type JSX } from 'solid-js';
import InfoTooltip from './InfoTooltip.jsx';
import { formatNumber, formatCost } from '../services/formatters.js';
import { RECOVERED_REQUESTS_TOOLTIP, type AutofixTimeseries } from '../services/api/analytics.js';

const MultiAgentTokenChart = lazy(() => import('./MultiAgentTokenChart.jsx'));
const ReliabilityChart = lazy(() => import('./ReliabilityChart.jsx'));

export type ChartTab = 'requests' | 'selfheal' | 'cost' | 'tokens';

interface AgentTimeseries {
  agents: string[];
  timeseries: Array<Record<string, number | string>>;
}

export interface UnifiedChartCardProps {
  activeTab: ChartTab;
  onTabChange: (tab: ChartTab) => void;
  // Requests tab
  /** Tab label override: the connection pages count ATTEMPTS, not requests. */
  requestsLabel?: string;
  /** Optional ⓘ next to the requests/attempts tab label. */
  requestsInfoTooltip?: string;
  requestsValue: number;
  requestsTrendPct: number;
  agentRequestTimeseries?: AgentTimeseries;
  /** When set, the Requests tab shows this (disposition) instead of agentRequestTimeseries */
  requestStatusTimeseries?: AutofixTimeseries;
  /** Series mode for the status chart (colors/labels): disposition by default. */
  requestStatusSeriesMode?: string;
  // Self-healed requests tab (the recovered subset — autofix + fallback).
  // The tab renders only when the timeseries is provided.
  selfHealedValue?: number;
  selfHealedTrendPct?: number;
  selfHealedTimeseries?: AutofixTimeseries;
  // Cost tab
  costValue?: number;
  costTrendPct?: number;
  costInfoTooltip?: string;
  agentCostTimeseries?: AgentTimeseries;
  // Token usage tab
  tokensValue: number;
  tokensTrendPct: number;
  agentTimeseries?: AgentTimeseries;
  // Shared
  range: string;
  colorMap?: Record<string, string>;
  /** Filter controls rendered in the subtitle bar */
  seriesFilters?: JSX.Element;
}

const trendBadge = (pct: number) => {
  if (pct === 0) return null;
  const clamped = Math.max(-999, Math.min(999, Math.round(pct)));
  if (clamped === 0) return null;
  const sign = clamped > 0 ? '+' : '';
  return (
    <span class="trend trend--neutral">
      {sign}
      {clamped}%
    </span>
  );
};

const EMPTY = (msg: string) => (
  <div style="height: 260px; color: hsl(var(--muted-foreground)); display: flex; align-items: center; justify-content: center;">
    {msg}
  </div>
);

const UnifiedChartCard: Component<UnifiedChartCardProps> = (props) => {
  const showCost = () => props.costValue != null;

  const tabTitle = (): string => {
    switch (props.activeTab) {
      case 'requests':
        return props.requestsLabel ?? 'Requests';
      case 'selfheal':
        return 'Recovered requests';
      case 'cost':
        return 'Cost';
      case 'tokens':
        return 'Token usage';
    }
  };

  return (
    <div class="chart-card">
      {/* ── Stat header tabs ── */}
      <div class="chart-card__header">
        <button
          type="button"
          class="chart-card__stat chart-card__stat--clickable"
          classList={{ 'chart-card__stat--active': props.activeTab === 'requests' }}
          onClick={() => props.onTabChange('requests')}
        >
          <span class="chart-card__label">
            {props.requestsLabel ?? 'Requests'}
            <Show when={props.requestsInfoTooltip}>
              <InfoTooltip text={props.requestsInfoTooltip!} />
            </Show>
          </span>
          <div class="chart-card__value-row">
            <span class="chart-card__value">{formatNumber(props.requestsValue)}</span>
            {trendBadge(props.requestsTrendPct)}
          </div>
        </button>
        <Show when={props.selfHealedTimeseries}>
          <button
            type="button"
            class="chart-card__stat chart-card__stat--clickable"
            classList={{ 'chart-card__stat--active': props.activeTab === 'selfheal' }}
            onClick={() => props.onTabChange('selfheal')}
          >
            <span class="chart-card__label">
              Recovered requests
              <InfoTooltip text={RECOVERED_REQUESTS_TOOLTIP} />
            </span>
            <div class="chart-card__value-row">
              <span class="chart-card__value">{formatNumber(props.selfHealedValue ?? 0)}</span>
              {trendBadge(props.selfHealedTrendPct ?? 0)}
            </div>
          </button>
        </Show>
        <Show when={showCost()}>
          <button
            type="button"
            class="chart-card__stat chart-card__stat--clickable"
            classList={{ 'chart-card__stat--active': props.activeTab === 'cost' }}
            onClick={() => props.onTabChange('cost')}
          >
            <span class="chart-card__label">
              Cost
              <Show when={props.costInfoTooltip}>
                <InfoTooltip text={props.costInfoTooltip!} />
              </Show>
            </span>
            <div class="chart-card__value-row">
              <span class="chart-card__value">{formatCost(props.costValue!) ?? '$0.00'}</span>
              {trendBadge(props.costTrendPct ?? 0)}
            </div>
          </button>
        </Show>
        <button
          type="button"
          class="chart-card__stat chart-card__stat--clickable"
          classList={{ 'chart-card__stat--active': props.activeTab === 'tokens' }}
          onClick={() => props.onTabChange('tokens')}
        >
          <span class="chart-card__label">Token usage</span>
          <div class="chart-card__value-row">
            <span class="chart-card__value">{formatNumber(props.tokensValue)}</span>
            {trendBadge(props.tokensTrendPct)}
          </div>
        </button>
      </div>

      {/* ── Subtitle bar: title + contextual filters ── */}
      <div class="chart-card__subtitle">
        <span class="chart-card__subtitle-title">{tabTitle()}</span>
        {/* The grouping filters (by status/provider/harness) only apply to the
            other tabs — self-healed is already a fixed autofix/fallback split. */}
        <Show when={props.seriesFilters && props.activeTab !== 'selfheal'}>
          <div class="chart-card__filters">{props.seriesFilters}</div>
        </Show>
      </div>

      {/* ── Chart body ── */}
      <div class="chart-card__body">
        <Suspense fallback={EMPTY('Loading chart…')}>
          <Show when={props.activeTab === 'requests'}>
            <Show
              when={props.requestStatusTimeseries}
              fallback={
                <Show
                  when={props.agentRequestTimeseries?.agents.length}
                  fallback={EMPTY('No request data for this time range')}
                >
                  <MultiAgentTokenChart
                    agents={props.agentRequestTimeseries!.agents}
                    timeseries={props.agentRequestTimeseries!.timeseries}
                    range={props.range}
                    colorMap={props.colorMap}
                    label="Requests"
                  />
                </Show>
              }
            >
              <Show
                when={props.requestStatusTimeseries!.buckets.length > 0}
                fallback={EMPTY('No request data for this time range')}
              >
                <ReliabilityChart
                  timeseries={props.requestStatusTimeseries!}
                  range={props.range}
                  seriesMode={props.requestStatusSeriesMode ?? 'disposition'}
                />
              </Show>
            </Show>
          </Show>
          <Show when={props.activeTab === 'selfheal'}>
            <Show
              when={props.selfHealedTimeseries && props.selfHealedTimeseries.buckets.length > 0}
              fallback={EMPTY('No recovered requests in this time range')}
            >
              <ReliabilityChart
                timeseries={props.selfHealedTimeseries!}
                range={props.range}
                seriesMode="disposition"
              />
            </Show>
          </Show>
          <Show when={props.activeTab === 'cost'}>
            <Show
              when={props.agentCostTimeseries?.agents.length}
              fallback={EMPTY('No cost data for this time range')}
            >
              <MultiAgentTokenChart
                agents={props.agentCostTimeseries!.agents}
                timeseries={props.agentCostTimeseries!.timeseries}
                range={props.range}
                colorMap={props.colorMap}
                label="Cost"
              />
            </Show>
          </Show>
          <Show when={props.activeTab === 'tokens'}>
            <Show
              when={props.agentTimeseries?.agents.length}
              fallback={EMPTY('No token data for this time range')}
            >
              <MultiAgentTokenChart
                agents={props.agentTimeseries!.agents}
                timeseries={props.agentTimeseries!.timeseries}
                range={props.range}
                colorMap={props.colorMap}
              />
            </Show>
          </Show>
        </Suspense>
      </div>
    </div>
  );
};

export default UnifiedChartCard;
