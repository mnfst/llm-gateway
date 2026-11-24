import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

let capturedLifecycleOpts: any = null;
let capturedChartOpts: any = null;
let capturedChartData: any = null;
const mockGetErrorBreakdown = vi.fn();

const routerNavigate = vi.hoisted(() => vi.fn());
vi.mock('@solidjs/router', () => ({
  useNavigate: () => routerNavigate,
}));

vi.mock('uplot', () => ({
  default: class MockUPlot {
    static paths = {
      bars: () => vi.fn(),
    };

    bbox = { width: 800 };
    cursor = { idx: 0 };
    data: number[][] = [];

    constructor(opts: any, data: any) {
      capturedChartOpts = opts;
      capturedChartData = data;
      this.data = data;
    }

    posToIdx = () => 0;
    valToPos = () => 120;
    destroy = vi.fn();
  },
}));

vi.mock('../../src/services/theme.js', () => ({
  getHsl: (name: string) => `hsl(var(${name}))`,
  getHslA: (name: string, alpha: number) => `hsla(var(${name}), ${alpha})`,
}));

vi.mock('../../src/services/chart-utils.js', () => ({
  useChartLifecycle: (opts: any) => {
    capturedLifecycleOpts = opts;
  },
  createBaseAxes: (axisColor: string, gridColor: string) => [
    { stroke: axisColor, grid: { stroke: gridColor } },
    { stroke: axisColor, grid: { stroke: gridColor } },
  ],
  parseTimestamps: (rows: unknown[]) => rows.map((_, i) => 1_700_000_000 + i * 3600),
  createTimeScaleRange: () => vi.fn(),
  createFormatLegendTimestamp: () => vi.fn(),
  formatLegendTokens: (_u: unknown, value: number) => String(value),
  isMultiDayRange: (range: string) => range !== '24h',
  fillDailyGaps: (
    rows: unknown[],
    _range: string,
    key: string,
    buildMissing: (bucket: string) => unknown,
  ) => {
    const missingKey = key === 'date' ? '2026-06-04' : '2026-06-04 00:00:00';
    if (rows.length) {
      buildMissing(missingKey);
      return rows;
    }
    return [buildMissing(missingKey)];
  },
}));

vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: (props: { text: string }) => (
    <span data-testid="info-tooltip" role="button">
      {props.text}
    </span>
  ),
}));

vi.mock('../../src/services/sse.js', () => ({
  messagePing: () => 0,
}));

vi.mock('../../src/services/api/analytics.js', () => ({
  RECOVERED_REQUESTS_TOOLTIP: 'Successful requests that were recovered by Autofix or fallback.',
  REQUEST_SUCCESS_RATE_TOOLTIP:
    'Successful requests over all requests. Recovered requests count as successful.',
  getErrorBreakdown: (...args: unknown[]) => mockGetErrorBreakdown(...args),
}));

import GlobalOverviewSkeleton from '../../src/components/GlobalOverviewSkeleton';
import MultiAgentTokenChart, { AGENT_COLORS } from '../../src/components/MultiAgentTokenChart';
import ProviderChartCard from '../../src/components/ProviderChartCard';
import UnifiedChartCard from '../../src/components/UnifiedChartCard';
import AutofixKpiCards from '../../src/components/AutofixKpiCards';
import ErrorClassCard from '../../src/components/ErrorClassCard';
import ReliabilityChart from '../../src/components/ReliabilityChart';

beforeEach(() => {
  vi.clearAllMocks();
  capturedLifecycleOpts = null;
  capturedChartOpts = null;
  capturedChartData = null;
});

const buildCapturedChart = () => {
  const el = capturedLifecycleOpts.el();
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  capturedLifecycleOpts.buildChart();
};

// ProviderChartCard lazy-loads MultiAgentTokenChart (uPlot stays out of the
// initial bundle), so its lifecycle hook is registered asynchronously. Wait for
// the lazy chart to mount before driving buildChart().
const buildLazyChart = async () => {
  await waitFor(() => expect(capturedLifecycleOpts).not.toBeNull());
  buildCapturedChart();
};

describe('analytics chart surface components', () => {
  it('renders the self-healed requests tab from the disposition timeseries', async () => {
    const onTabChange = vi.fn();
    const selfHealedTimeseries = {
      range: '7d',
      by: 'disposition',
      keys: ['healed', 'fallback'],
      buckets: [{ bucket: '2026-06-04', counts: [12, 3] }],
    };
    const { unmount } = render(() => (
      <UnifiedChartCard
        activeTab="selfheal"
        onTabChange={onTabChange}
        requestsValue={10}
        requestsTrendPct={0}
        selfHealedValue={15}
        selfHealedTrendPct={20}
        selfHealedTimeseries={selfHealedTimeseries}
        tokensValue={100}
        tokensTrendPct={0}
        range="7d"
      />
    ));

    expect(
      screen
        .getAllByText('Recovered requests')[0]!
        .closest('button')
        ?.classList.contains('chart-card__stat--active'),
    ).toBe(true);
    expect(screen.getByText('15')).toBeDefined();
    expect(screen.getByText('+20%')).toBeDefined();
    fireEvent.click(screen.getAllByText('Requests')[0]!);
    expect(onTabChange).toHaveBeenCalledWith('requests');
    await buildLazyChart();
    // Stacked series are reversed (top-of-stack first).
    const labels = capturedChartOpts.series.slice(1).map((s: { label: string }) => s.label);
    expect(labels).toContain('Success - recovered by Autofix');
    expect(labels).toContain('Success - recovered by Fallback');
    unmount();
  });

  it.each([
    [
      'requests',
      { agentRequestTimeseries: { agents: ['openai'], timeseries: [{ hour: '1', openai: 2 }] } },
    ],
    [
      'cost',
      {
        costValue: 1,
        agentCostTimeseries: { agents: ['openai'], timeseries: [{ hour: '1', openai: 1 }] },
      },
    ],
    ['tokens', { agentTimeseries: { agents: ['openai'], timeseries: [{ hour: '1', openai: 3 }] } }],
  ] as const)('passes the %s series to the unified chart', async (activeTab, seriesProps) => {
    capturedLifecycleOpts = null;
    const { unmount } = render(() => (
      <UnifiedChartCard
        activeTab={activeTab}
        onTabChange={vi.fn()}
        requestsValue={2}
        requestsTrendPct={0}
        tokensValue={3}
        tokensTrendPct={0}
        range="24h"
        {...seriesProps}
      />
    ));
    await buildLazyChart();
    unmount();
  });

  it('renders the self-healed empty state and hides the tab without a timeseries', () => {
    const { unmount } = render(() => (
      <UnifiedChartCard
        activeTab="selfheal"
        onTabChange={vi.fn()}
        requestsValue={0}
        requestsTrendPct={0}
        selfHealedValue={0}
        selfHealedTrendPct={0}
        selfHealedTimeseries={{ range: '24h', by: 'disposition', keys: [], buckets: [] }}
        tokensValue={0}
        tokensTrendPct={0}
        range="24h"
      />
    ));
    expect(screen.getByText('No recovered requests in this time range')).toBeDefined();
    unmount();

    // Without a timeseries the tab itself is not rendered.
    const noTab = render(() => (
      <UnifiedChartCard
        activeTab="requests"
        onTabChange={vi.fn()}
        requestsValue={0}
        requestsTrendPct={0}
        tokensValue={0}
        tokensTrendPct={0}
        range="24h"
      />
    ));
    expect(screen.queryByText('Recovered requests')).toBeNull();
    noTab.unmount();
  });

  it('orders disposition series success → healed → fallback → error (legend and stack)', async () => {
    // Backend delivers keys in an arbitrary order; the chart must normalize.
    const { container, unmount } = render(() => (
      <ReliabilityChart
        timeseries={{
          range: '7d',
          by: 'disposition',
          keys: ['error', 'fallback', 'success', 'healed'],
          buckets: [{ bucket: '2026-06-04', counts: [4, 3, 1, 2] }],
        }}
        range="7d"
        seriesMode="disposition"
      />
    ));

    // Legend order is the fixed reading order.
    const legend = [...container.querySelectorAll('.rel-chart__legend-item')].map((e) =>
      e.textContent?.trim(),
    );
    expect(legend).toEqual([
      'Success',
      'Success - recovered by Autofix',
      'Success - recovered by Fallback',
      'Error',
    ]);

    // Stack order (bottom → top) follows the same order: the cumulative data
    // rows are reversed (top first), so the LAST row is the bottom (success=1)
    // and the first is the full stack (…+error=10).
    const data = capturedLifecycleOpts.buildData();
    const stacks = data.slice(1).map((s: number[]) => s[0]);
    expect(stacks).toEqual([10, 6, 3, 1]); // error top, then fallback, healed, success bottom
    unmount();
  });

  it('snaps the cursor and shows the hover tooltip on the disposition chart', () => {
    const { container, unmount } = render(() => (
      <ReliabilityChart
        timeseries={{
          range: '7d',
          by: 'disposition',
          keys: ['error', 'fallback', 'success', 'healed'],
          buckets: [{ bucket: '2026-06-04', counts: [4, 3, 1, 2] }],
        }}
        range="7d"
        seriesMode="disposition"
      />
    ));
    buildCapturedChart();

    // Same snapped cursor as the Cost chart.
    expect(capturedChartOpts.cursor.move).toBeTypeOf('function');
    expect(
      capturedChartOpts.cursor.move(
        { posToIdx: () => 0, data: capturedChartData, valToPos: () => 120 },
        57,
        9,
      ),
    ).toEqual([120, 9]);

    capturedChartOpts.hooks.setCursor[0]({
      cursor: { idx: 0 },
      data: capturedChartData,
      bbox: { width: 800 },
      valToPos: () => 120,
    });

    // Rows keep the fixed legend order (NOT value-sorted), with a Total.
    const rows = [...container.querySelectorAll('.agent-chart-tooltip__row')].map((r) => ({
      label: r.querySelector('.agent-chart-tooltip__name')?.textContent,
      value: r.querySelector('.agent-chart-tooltip__value')?.textContent,
    }));
    expect(rows).toEqual([
      { label: 'Success', value: '1' },
      { label: 'Success - recovered by Autofix', value: '2' },
      { label: 'Success - recovered by Fallback', value: '3' },
      { label: 'Error', value: '4' },
    ]);
    expect(container.querySelector('.agent-chart-tooltip__total-value')?.textContent).toBe('10');

    // Cursor off the data hides it.
    capturedChartOpts.hooks.setCursor[0]({ cursor: { idx: -1 } });
    expect(container.querySelector('.agent-chart-tooltip')).toBeNull();
    unmount();
  });

  it('handles an empty reliability series without creating a chart', () => {
    render(() => (
      <ReliabilityChart
        timeseries={{ range: '7d', by: 'metric', keys: ['total_attempts'], buckets: [] }}
        range="7d"
        seriesMode="attempts"
      />
    ));
    expect(capturedLifecycleOpts.buildData()[0]).toHaveLength(0);
    expect(capturedLifecycleOpts.buildChart()).toBeNull();
  });

  it('renders the self-healed KPI cards (rate, share, via Autofix, via Fallback)', () => {
    const base = {
      success_rate: { value: 0.8, previous: 0.7 },
      errors_remaining: { value: 0, previous: 0 },
      coverage: { rate: 0.555, previous_rate: 0.5 },
      dispositions: { healed: 5, no_fix_found: 2, resolving: 1, ineffective: 0 },
      needs_attention: [],
    };
    const { unmount } = render(() => (
      <AutofixKpiCards
        stats={{
          ...base,
          autofix_saves: { value: 5, previous: 0 },
          fallback_saves: { value: 3, previous: 0 },
          total_requests: { value: 100, previous: 0 },
        }}
      />
    ));
    expect(screen.getByText('Success rate')).toBeDefined();
    expect(screen.getByText('80.0%')).toBeDefined();
    // Self-healed share = (5 + 3) / 100.
    expect(screen.getByText('Recovered requests')).toBeDefined();
    expect(screen.getByText('8.0%')).toBeDefined();
    expect(screen.getByText('Failed requests')).toBeDefined();
    expect(screen.getByText('Recovered by Autofix')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('Recovered by Fallback')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    // The five-card row relies on the responsive `overview-stats--5` modifier;
    // an inline grid-template-columns would override the phone breakpoints.
    const grid = screen.getByText('Success rate').closest('.overview-stats') as HTMLElement;
    expect(grid.classList.contains('overview-stats--5')).toBe(true);
    expect(grid.style.gridTemplateColumns).toBe('');
    unmount();

    // Trends: previous window present → percentage badges.
    render(() => (
      <AutofixKpiCards
        stats={{
          ...base,
          autofix_saves: { value: 1, previous: 2 },
          fallback_saves: { value: 1, previous: 2 },
          total_requests: { value: 10, previous: 10 },
        }}
      />
    ));
    expect(screen.getAllByText('-50%').length).toBeGreaterThanOrEqual(2);
  });

  it('deep-links the recovered KPI cards when an agent scope is given', () => {
    const base = {
      success_rate: { value: 0.8, previous: 0.7 },
      errors_remaining: { value: 0, previous: 0 },
      coverage: { rate: 0.555, previous_rate: 0.5 },
      dispositions: { healed: 5, no_fix_found: 2, resolving: 1, ineffective: 0 },
      needs_attention: [],
    };
    render(() => (
      <AutofixKpiCards
        stats={{
          ...base,
          autofix_saves: { value: 5, previous: 0 },
          fallback_saves: { value: 3, previous: 0 },
          total_requests: { value: 100, previous: 0 },
        }}
        agentName="demo-agent"
        range="7d"
      />
    ));
    fireEvent.click(screen.getByText('Failed requests').closest('.overview-stat-card')!);
    expect(routerNavigate).toHaveBeenCalledWith(
      '/messages?agent=demo-agent&range=7d&status=failed',
    );
    fireEvent.click(screen.getByText('Recovered by Autofix').closest('.overview-stat-card')!);
    expect(routerNavigate).toHaveBeenCalledWith(
      '/messages?agent=demo-agent&range=7d&status=ok&trigger=autofix',
    );
    fireEvent.click(screen.getByText('Recovered by Fallback').closest('.overview-stat-card')!);
    expect(routerNavigate).toHaveBeenCalledWith(
      '/messages?agent=demo-agent&range=7d&status=ok&trigger=fallback',
    );
    fireEvent.click(screen.getByText('Recovered requests').closest('.overview-stat-card')!);
    expect(routerNavigate).toHaveBeenCalledWith(
      '/messages?agent=demo-agent&range=7d&status=ok&trigger=autofix,fallback',
    );

    const failedCard = screen.getByText('Failed requests').closest('.overview-stat-card')!;
    expect(failedCard.getAttribute('role')).toBe('link');
    expect((failedCard as HTMLElement).tabIndex).toBe(0);
    fireEvent.keyDown(failedCard, { key: 'Enter' });
    expect(routerNavigate).toHaveBeenLastCalledWith(
      '/messages?agent=demo-agent&range=7d&status=failed',
    );

    const recoveredCard = screen.getByText('Recovered requests').closest('.overview-stat-card')!;
    const tooltip = recoveredCard.querySelector('[data-testid="info-tooltip"]')!;
    const navigationCount = routerNavigate.mock.calls.length;
    fireEvent.keyDown(tooltip, { key: 'Enter' });
    fireEvent.click(tooltip);
    expect(routerNavigate).toHaveBeenCalledTimes(navigationCount);
  });

  it('describes global KPI links as covering all harnesses', () => {
    render(() => (
      <AutofixKpiCards
        stats={{
          success_rate: { value: 0.8, previous: 0.7 },
          errors_remaining: { value: 2, previous: 1 },
          autofix_saves: { value: 5, previous: 0 },
          fallback_saves: { value: 3, previous: 0 },
          total_requests: { value: 100, previous: 0 },
          coverage: { rate: 0.5, previous_rate: 0.4 },
          dispositions: { healed: 5, no_fix_found: 2, resolving: 1, ineffective: 0 },
          needs_attention: [],
        }}
      />
    ));

    expect(
      screen.getByText('Recovered requests').closest('.overview-stat-card')?.getAttribute('title'),
    ).toBe('View recovered requests across all harnesses');
    expect(
      screen.getByText('Failed requests').closest('.overview-stat-card')?.getAttribute('title'),
    ).toBe('View failed requests across all harnesses');
  });

  it('renders and sorts error classes, then renders the empty state', async () => {
    mockGetErrorBreakdown.mockResolvedValueOnce({
      by_class: { rate_limited: 2, timeout: 5, ignored: 0 },
      by_origin: {},
      auto_fixed: 1,
    });
    const { container, unmount } = render(() => <ErrorClassCard range="7d" agentName="demo" />);
    await waitFor(() => expect(screen.getByText('Timeout')).toBeDefined());
    expect(mockGetErrorBreakdown).toHaveBeenCalledWith('7d', 'demo');
    expect(container.querySelector('.error-class-card__label')?.textContent).toBe('Timeout');
    unmount();

    mockGetErrorBreakdown.mockResolvedValueOnce({ by_class: {}, by_origin: {}, auto_fixed: 0 });
    render(() => <ErrorClassCard range="24h" />);
    await waitFor(() => expect(screen.getByText('No errors in this period')).toBeDefined());
  });

  it('renders the global overview skeleton placeholders', () => {
    const { container } = render(() => <GlobalOverviewSkeleton />);
    expect(container.querySelectorAll('.overview-stat-card')).toHaveLength(4);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(10);
  });

  it('renders ProviderChartCard views and changes active view on click', async () => {
    const onViewChange = vi.fn();

    render(() => (
      <ProviderChartCard
        activeView="tokens"
        onViewChange={onViewChange}
        messagesValue={12}
        messagesTrendPct={10}
        tokensValue={1234}
        tokensTrendPct={5}
        costValue={4.56}
        costTrendPct={-2}
        costInfoTooltip="API key cost only"
        range="24h"
        agentTimeseries={{
          agents: ['openai'],
          timeseries: [{ hour: '2026-06-04 10:00:00', openai: 1200 }],
        }}
        agentMessageTimeseries={{
          agents: ['openai'],
          timeseries: [{ hour: '2026-06-04 10:00:00', openai: 12 }],
        }}
        agentCostTimeseries={{
          agents: ['openai'],
          timeseries: [{ hour: '2026-06-04 10:00:00', openai: 4.56 }],
        }}
        colorMap={{ openai: '#111111' }}
      />
    ));

    expect(screen.getByText('Cost')).toBeDefined();
    expect(screen.getByText('Requests')).toBeDefined();
    expect(screen.getByText('Token usage')).toBeDefined();
    expect(screen.getByTestId('info-tooltip')).toBeDefined();
    await buildLazyChart();

    // Tab controls are semantic <button>s (keyboard/a11y).
    const messagesTab = screen.getByText('Requests').closest('button');
    expect(messagesTab).not.toBeNull();
    fireEvent.click(screen.getByText('Requests'));
    expect(onViewChange).toHaveBeenCalledWith('messages');
    fireEvent.click(screen.getByText('Token usage'));
    expect(onViewChange).toHaveBeenCalledWith('tokens');
    fireEvent.click(screen.getByText('Cost'));
    expect(onViewChange).toHaveBeenCalledWith('cost');
  });

  it('explains provider-attempt reliability and Manifest recovery', () => {
    const { unmount } = render(() => (
      <ProviderChartCard
        activeView="messages"
        onViewChange={vi.fn()}
        messagesValue={20}
        messagesTrendPct={0}
        requestSuccessRate={95}
        attemptSuccessRate={80}
        tokensValue={0}
        tokensTrendPct={0}
        range="24h"
      />
    ));

    expect(screen.getByTestId('info-tooltip').textContent).toBe(
      'Caller success: 95.0%. Provider-attempt success: 80.0%. The gap is recovery from fallbacks and Autofix.',
    );
    unmount();

    render(() => (
      <ProviderChartCard
        activeView="messages"
        onViewChange={vi.fn()}
        messagesValue={20}
        messagesTrendPct={0}
        attemptSuccessRate={80}
        tokensValue={0}
        tokensTrendPct={0}
        range="24h"
      />
    ));
    expect(screen.getByTestId('info-tooltip').textContent).toBe('Provider-attempt success: 80.0%.');
  });

  it('renders ProviderChartCard message and cost chart branches', async () => {
    const onViewChange = vi.fn();

    const { unmount } = render(() => (
      <ProviderChartCard
        activeView="messages"
        onViewChange={onViewChange}
        messagesValue={12}
        messagesTrendPct={0}
        tokensValue={1234}
        tokensTrendPct={0}
        costValue={4.56}
        costTrendPct={0}
        range="24h"
        agentTimeseries={{ agents: ['openai'], timeseries: [] }}
        agentMessageTimeseries={{
          agents: ['openai'],
          timeseries: [{ hour: '2026-06-04 10:00:00', openai: 12 }],
        }}
        agentCostTimeseries={{
          agents: ['openai'],
          timeseries: [{ hour: '2026-06-04 10:00:00', openai: 4.56 }],
        }}
        colorMap={{ openai: '#111111' }}
      />
    ));

    expect(screen.getByText('Requests')).toBeDefined();
    await buildLazyChart();
    unmount();
    capturedLifecycleOpts = null;

    render(() => (
      <ProviderChartCard
        activeView="cost"
        onViewChange={onViewChange}
        messagesValue={12}
        messagesTrendPct={0}
        tokensValue={1234}
        tokensTrendPct={0}
        costValue={4.56}
        costTrendPct={0}
        range="24h"
        agentTimeseries={{ agents: ['openai'], timeseries: [] }}
        agentMessageTimeseries={{ agents: ['openai'], timeseries: [] }}
        agentCostTimeseries={{
          agents: ['openai'],
          timeseries: [{ hour: '2026-06-04 10:00:00', openai: 4.56 }],
        }}
        colorMap={{ openai: '#111111' }}
      />
    ));

    expect(screen.getByText('Cost')).toBeDefined();
    await buildLazyChart();
  });

  it('renders ProviderChartCard empty states and hides cost when missing', () => {
    const { unmount } = render(() => (
      <ProviderChartCard
        activeView="messages"
        onViewChange={vi.fn()}
        messagesValue={0}
        messagesTrendPct={0}
        tokensValue={0}
        tokensTrendPct={0}
        range="24h"
        agentTimeseries={{ agents: [], timeseries: [] }}
        agentMessageTimeseries={{ agents: [], timeseries: [] }}
        agentCostTimeseries={{ agents: [], timeseries: [] }}
      />
    ));

    expect(screen.getByText('No request data for this time range')).toBeDefined();
    expect(screen.queryByText('Cost')).toBeNull();
    unmount();

    const tokenEmpty = render(() => (
      <ProviderChartCard
        activeView="tokens"
        onViewChange={vi.fn()}
        messagesValue={0}
        messagesTrendPct={0}
        tokensValue={0}
        tokensTrendPct={0}
        range="24h"
        agentTimeseries={{ agents: [], timeseries: [] }}
        agentMessageTimeseries={{ agents: [], timeseries: [] }}
        agentCostTimeseries={{ agents: [], timeseries: [] }}
      />
    ));

    expect(screen.getByText('No token data for this time range')).toBeDefined();
    tokenEmpty.unmount();

    render(() => (
      <ProviderChartCard
        activeView="cost"
        onViewChange={vi.fn()}
        messagesValue={0}
        messagesTrendPct={0}
        tokensValue={0}
        tokensTrendPct={0}
        costValue={0}
        costTrendPct={0}
        range="24h"
        agentTimeseries={{ agents: [], timeseries: [] }}
        agentMessageTimeseries={{ agents: [], timeseries: [] }}
        agentCostTimeseries={{ agents: [], timeseries: [] }}
      />
    ));

    expect(screen.getByText('No cost data for this time range')).toBeDefined();
  });

  it('builds stacked data for the multi-agent token chart', () => {
    const hover = vi.fn();

    render(() => (
      <MultiAgentTokenChart
        agents={['openai', 'anthropic']}
        timeseries={[{ hour: '2026-06-04 10:00:00', openai: 10, anthropic: 5 }]}
        range="24h"
        colorMap={{ openai: '#111111', anthropic: '#222222' }}
        onHoverValues={hover}
      />
    ));

    buildCapturedChart();
    expect(capturedChartData).toHaveLength(3);
    expect(capturedChartOpts.series).toHaveLength(3);

    capturedChartOpts.hooks.setCursor[0]({
      cursor: { idx: 0 },
      data: capturedChartData,
      bbox: { width: 800 },
      valToPos: () => 120,
    });
    expect(hover).toHaveBeenCalledWith({ openai: 10, anthropic: 5 });

    // Tooltip rows render after a hover with non-zero values.
    expect(screen.getByText('openai')).toBeDefined();
    expect(screen.getByText('Total')).toBeDefined();
  });

  it('formats token y-axis values and snaps the cursor for token charts', () => {
    render(() => (
      <MultiAgentTokenChart
        agents={['openai']}
        timeseries={[{ hour: '2026-06-04 10:00:00', openai: 1234 }]}
        range="24h"
        colorMap={{ openai: '#111111' }}
      />
    ));

    buildCapturedChart();
    // Token axis uses formatLegendTokens (mocked to String()).
    expect(capturedChartOpts.axes[1].values({}, [1234])).toEqual(['1234']);
    expect(
      capturedChartOpts.cursor.move(
        { posToIdx: () => 0, data: [[1700000000]], valToPos: () => 5 },
        7,
        3,
      ),
    ).toEqual([5, 3]);
  });

  it('builds empty and cost multi-day chart states', () => {
    const hover = vi.fn();

    const { container } = render(() => (
      <MultiAgentTokenChart
        agents={['openai']}
        timeseries={[]}
        range="30d"
        colorMap={{ openai: '#111111' }}
        onHoverValues={hover}
        label="Cost"
      />
    ));

    buildCapturedChart();
    expect(capturedChartData[1][0]).toBe(0);
    // Cost y-axis uses formatCost: whole/cent values render normally, but a
    // sub-cent value surfaces as "< $0.01" instead of rounding to "$0.00".
    expect(capturedChartOpts.axes[1].values({}, [1.23])).toEqual(['$1.23']);
    expect(capturedChartOpts.axes[1].values({}, [0.004])).toEqual(['< $0.01']);
    expect(capturedChartOpts.axes[1].values({}, [0])).toEqual(['$0.00']);
    expect(
      capturedChartOpts.cursor.move({ posToIdx: () => null, data: [[]], valToPos: () => 0 }, 42, 9),
    ).toEqual([42, 9]);

    capturedChartOpts.hooks.setCursor[0]({ cursor: { idx: -1 } });
    expect(hover).toHaveBeenCalledWith(null);

    fireEvent.mouseLeave(container.firstElementChild!);
    expect(hover).toHaveBeenLastCalledWith(null);
  });

  it('falls back to a distinct per-index default color for each series (no colorMap)', () => {
    const hover = vi.fn();

    render(() => (
      <MultiAgentTokenChart
        agents={['openai', 'anthropic']}
        timeseries={[{ hour: '2026-06-04 10:00:00', openai: 10, anthropic: 5 }]}
        range="24h"
        onHoverValues={hover}
      />
    ));

    buildCapturedChart();
    // Series are rendered in reverse agent order; each must get the default
    // color for its ORIGINAL index, so colors don't all collapse onto index 0.
    // reversed = ['anthropic'(idx1), 'openai'(idx0)] → AGENT_COLORS[1], [0].
    const strokes = capturedChartOpts.series.slice(1).map((s: { stroke: string }) => s.stroke);
    expect(strokes).toEqual([AGENT_COLORS[1], AGENT_COLORS[0]]);
    // A real per-series distinction: the two strokes differ.
    expect(strokes[0]).not.toBe(strokes[1]);

    capturedChartOpts.hooks.setCursor[0]({
      cursor: { idx: 0 },
      data: capturedChartData,
      bbox: { width: 800 },
      valToPos: () => 700,
    });
    expect(hover).toHaveBeenCalledWith({ openai: 10, anthropic: 5 });
  });

  it('honors an explicit colorMap entry over the per-index fallback', () => {
    render(() => (
      <MultiAgentTokenChart
        agents={['openai', 'anthropic']}
        timeseries={[{ hour: '2026-06-04 10:00:00', openai: 10, anthropic: 5 }]}
        range="24h"
        colorMap={{ openai: '#abcdef' }}
      />
    ));

    buildCapturedChart();
    // reversed order: anthropic (no map → AGENT_COLORS[1]), openai (mapped).
    const strokes = capturedChartOpts.series.slice(1).map((s: { stroke: string }) => s.stroke);
    expect(strokes).toEqual([AGENT_COLORS[1], '#abcdef']);
  });
});
