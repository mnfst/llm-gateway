/**
 * Verifies the LIVE-UPDATE requirement: the provider pages' usage resource
 * must re-fetch when the SSE ping signals change, so a newly ingested message
 * (analyticsPing) or a provider connect/disconnect/rename (routingPing) refreshes
 * the stats. We back the ping
 * mocks with real Solid signals and assert the usage endpoint is re-invoked
 * when either bumps; config (the cheap endpoint) must NOT re-fetch on pings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const [analyticsPingSig, setAnalyticsPing] = createSignal(0);
const [routingPingSig, setRoutingPing] = createSignal(0);

const mocks = vi.hoisted(() => ({
  getGlobalProviders: vi.fn(),
  getProviderUsage: vi.fn(),
  getAgents: vi.fn(),
  getAgentProviders: vi.fn(),
  getCustomProviders: vi.fn(),
}));

vi.mock('@solidjs/meta', () => ({ Title: () => null }));
vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [{}, vi.fn()],
}));

vi.mock('../../src/services/api/providers.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/api/providers')>(
    '../../src/services/api/providers',
  );
  return {
    getProviders: (...a: unknown[]) => mocks.getGlobalProviders(...a),
    getProviderUsage: (...a: unknown[]) => mocks.getProviderUsage(...a),
    connectionUsage: () => Promise.resolve([]),
    mergeUsage: actual.mergeUsage,
  };
});

vi.mock('../../src/services/api.js', () => ({
  getAgents: (...a: unknown[]) => mocks.getAgents(...a),
  getProviders: (...a: unknown[]) => mocks.getAgentProviders(...a),
  getCustomProviders: (...a: unknown[]) => mocks.getCustomProviders(...a),
}));

vi.mock('../../src/services/api/routing.js', () => ({
  renameProviderKey: vi.fn(),
}));

vi.mock('../../src/services/sse.js', () => ({
  analyticsPing: () => analyticsPingSig(),
  routingPing: () => routingPingSig(),
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: () => null,
}));
vi.mock('../../src/components/Sparkline.jsx', () => ({ default: () => null }));

import Byok from '../../src/pages/providers/Byok';

describe('provider usage live updates', () => {
  beforeEach(() => {
    setAnalyticsPing(0);
    setRoutingPing(0);
    mocks.getGlobalProviders.mockResolvedValue({
      providers: [
        {
          provider: 'openai',
          auth_type: 'api_key',
          connection_count: 1,
          connections: [
            {
              id: 'c1',
              label: 'Default',
              key_prefix: null,
              priority: 0,
              connected_at: '2026-01-01',
              models_fetched_at: null,
              cached_model_count: 1,
              is_active: true,
            },
          ],
          total_models: 1,
        },
      ],
      model_counts: {},
    });
    mocks.getProviderUsage.mockResolvedValue({ providers: [] });
    mocks.getAgents.mockResolvedValue({ agents: [{ agent_name: 'demo' }] });
    mocks.getAgentProviders.mockResolvedValue([]);
    mocks.getCustomProviders.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('re-fetches usage on analyticsPing and routingPing, but not config', async () => {
    render(() => <Byok />);

    await waitFor(() => expect(mocks.getProviderUsage).toHaveBeenCalledTimes(1));
    expect(mocks.getGlobalProviders).toHaveBeenCalledTimes(1);

    // Coalesced message activity bumps analyticsPing → usage refetch.
    setAnalyticsPing(1);
    await waitFor(() => expect(mocks.getProviderUsage).toHaveBeenCalledTimes(2));

    // A provider change bumps routingPing → usage refetch.
    setRoutingPing(1);
    await waitFor(() => expect(mocks.getProviderUsage).toHaveBeenCalledTimes(3));

    // Config is the cheap endpoint; pings must not trigger it.
    expect(mocks.getGlobalProviders).toHaveBeenCalledTimes(1);
  });
});
