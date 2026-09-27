import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';

/**
 * PRESERVATION SPEC — do not delete with the component.
 *
 * "Error classes by frequency" (ErrorClassCard) was deliberately UNMOUNTED
 * from the dashboards because the backend does not yet aggregate real
 * error_class data. Product intent: reintroduce the SAME widget once the
 * backend can populate it (see the component's header comment).
 *
 * This spec pins the component so it survives until then:
 *  - it must keep rendering from an ErrorBreakdownResponse ({ by_class }),
 *  - it must keep its title and its bar-per-class layout,
 *  - it must keep its empty state.
 *
 * If you are reintroducing the widget: mount <ErrorClassCard range=… /> on
 * GlobalOverview/Overview, wire GET /overview/error-breakdown to real data,
 * and replace this preservation spec with real page-level coverage.
 */

const breakdown = vi.fn();
vi.mock('../../src/services/api/analytics.js', () => ({
  RECOVERED_REQUESTS_TOOLTIP: 'Successful requests that were recovered by Autofix or fallback.',
  REQUEST_SUCCESS_RATE_TOOLTIP: 'Successful requests over all requests. Recovered requests count as successful.',
  totalAttemptsTooltip: (doctor: boolean) =>
    doctor
      ? 'Every provider call counts here, including fallback retries and autofixed attempts. One request can produce several attempts.'
      : 'Every provider call counts here, including fallback retries. One request can produce several attempts.',
  MODEL_SUCCESS_RATE_TOOLTIP: 'Successful attempts over all attempts for this model.',
  PROVIDER_SUCCESS_RATE_TOOLTIP: 'Successful attempts over all attempts for this provider.',
  CONNECTION_SUCCESS_RATE_TOOLTIP_30D:
    'Successful attempts over all attempts for this connection, over the last 30 days.',
  CONNECTION_SUCCESS_RATE_TOOLTIP:
    'Successful attempts over all attempts for this connection, on the filtered period.',
  CONNECTION_HARNESS_SUCCESS_RATE_TOOLTIP:
    'Successful attempts over all attempts for this harness on this connection.',
  HARNESS_SUCCESS_RATE_TOOLTIP: 'Successful requests over all requests for this harness.',
  HARNESS_TOTAL_REQUESTS_TOOLTIP:
    'Logical requests from this harness, one per call, whatever the number of attempts.',
  attemptSuccessRate: (row: { attempts: number; succeeded?: number }) =>
    !row.attempts || row.succeeded == null ? null : row.succeeded / row.attempts,
  getErrorBreakdown: (...args: unknown[]) => breakdown(...args),
}));
vi.mock('../../src/services/sse.js', () => ({ messagePing: () => 0 }));

import ErrorClassCard from '../../src/components/ErrorClassCard';

describe('ErrorClassCard (unmounted, preserved for reintroduction)', () => {
  // Raw-imports every page source; under heavy parallel-suite load that can
  // exceed the default 5s timeout (same headroom as sse.test.ts).
  it('is intentionally not mounted on any dashboard yet', { timeout: 20000 }, async () => {
    const pages = import.meta.glob('../../src/pages/**/*.tsx', {
      query: '?raw',
      import: 'default',
    });
    for (const load of Object.values(pages)) {
      const src = (await load()) as string;
      expect(src.includes('ErrorClassCard')).toBe(false);
    }
  });

  it('still renders the frequency bars from an ErrorBreakdownResponse', async () => {
    breakdown.mockResolvedValue({
      by_class: { rate_limit: 12, invalid_request: 5, server_error: 0 },
      by_origin: {},
      auto_fixed: 3,
    });

    render(() => <ErrorClassCard range="7d" />);

    await waitFor(() => {
      expect(screen.getByText('Error classes by frequency')).toBeDefined();
      expect(screen.getByText('Rate limit')).toBeDefined();
      expect(screen.getByText('Invalid request')).toBeDefined();
    });
    // Zero-count classes are filtered out.
    expect(screen.queryByText('Server error')).toBeNull();
  });

  it('still renders its empty state when there are no errors', async () => {
    breakdown.mockResolvedValue({ by_class: {}, by_origin: {}, auto_fixed: 0 });

    render(() => <ErrorClassCard range="7d" />);

    await waitFor(() => {
      expect(screen.getByText('No errors in this period')).toBeDefined();
    });
  });
});
