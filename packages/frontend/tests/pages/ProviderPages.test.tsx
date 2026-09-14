import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetSearchParams = vi.fn();
let mockSearchParams: Record<string, string | undefined> = {};
const mockGetGlobalProviders = vi.fn();
const mockGetAgents = vi.fn();
const mockGetAgentProviders = vi.fn();
const mockGetCustomProviders = vi.fn();
const mockProviderSelectModal = vi.fn();

const mockNavigate = vi.fn();
vi.mock('@solidjs/router', () => ({
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
  useNavigate: () => mockNavigate,
  Navigate: (props: { href: string }) => <div data-testid="navigate" data-href={props.href} />,
}));

// The Local providers page only exists on self-hosted installs; cloud
// redirects to BYOK. Default to self-hosted so the page tests apply.
let mockIsSelfHosted = true;
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => Promise.resolve(mockIsSelfHosted),
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children: unknown }) => <title>{props.children as string}</title>,
}));

vi.mock('../../src/components/ProviderSelectModal.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    mockProviderSelectModal(props);
    return (
      <div role="dialog" aria-label="provider modal">
        <button onClick={() => (props.onUpdate as () => Promise<void>)()}>update</button>
        <button onClick={() => (props.onClose as () => void)()}>close</button>
      </div>
    );
  },
}));

const mockCustomProviderForm = vi.fn();
vi.mock('../../src/components/CustomProviderForm.jsx', () => ({
  default: (props: Record<string, unknown>) => {
    mockCustomProviderForm(props);
    return (
      <div data-testid="custom-provider-form">
        Custom provider form
        <button onClick={() => (props.onCreated as () => void)()}>created</button>
        <button onClick={() => (props.onBack as () => void)()}>back</button>
      </div>
    );
  },
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: (providerId: string) =>
    providerId === 'openai' ? <span data-testid="provider-icon" /> : null,
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI', supportsSubscription: true },
    { id: 'anthropic', name: 'Anthropic', supportsSubscription: true },
    { id: 'groq', name: 'Groq' },
    { id: 'ollama', name: 'Ollama', localOnly: true },
  ],
}));

vi.mock('../../src/services/formatters.js', () => ({
  customProviderColor: () => '#654321',
  formatNumber: (value: number) => String(value),
  formatCost: (value: number) => `$${value.toFixed(2)}`,
  formatTimeAgo: () => 'recently',
}));

const mockGetProviderUsage = vi.fn();
// Use the real mergeUsage so the merge logic stays under test through the page.
vi.mock('../../src/services/api/providers.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/api/providers')>(
    '../../src/services/api/providers',
  );
  return {
    getProviders: (...args: unknown[]) => mockGetGlobalProviders(...args),
    getProviderUsage: (...args: unknown[]) => mockGetProviderUsage(...args),
    mergeUsage: actual.mergeUsage,
    connectionUsage: actual.connectionUsage,
  };
});

vi.mock('../../src/services/api.js', () => ({
  getAgents: (...args: unknown[]) => mockGetAgents(...args),
  getProviders: (...args: unknown[]) => mockGetAgentProviders(...args),
  getCustomProviders: (...args: unknown[]) => mockGetCustomProviders(...args),
}));

vi.mock('../../src/services/api/analytics.js', () => ({
  RECOVERED_REQUESTS_TOOLTIP: 'Successful requests that were recovered by Autofix or fallback.',
  REQUEST_SUCCESS_RATE_TOOLTIP:
    'Successful requests over all requests. Recovered requests count as successful.',
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
  getPerProviderReliability: () => Promise.resolve([]),
}));

// SSE ping signals drive the usage resource's source; stub them to no-op
// accessors so the page mounts without a live EventSource under jsdom.
vi.mock('../../src/services/sse.js', () => ({
  messagePing: () => 0,
  analyticsPing: () => 0,
  routingPing: () => 0,
}));

const mockRenameProviderKey = vi.fn();
vi.mock('../../src/services/api/routing.js', () => ({
  renameProviderKey: (...args: unknown[]) => mockRenameProviderKey(...args),
}));

// Sparkline is excluded from coverage and renders a real <canvas>-backed chart;
// stub it so the rename/usage rows render deterministically under jsdom.
vi.mock('../../src/components/Sparkline.jsx', () => ({
  default: (props: { data?: number[] }) => (
    <span data-testid="sparkline">{props.data?.length ?? 0}</span>
  ),
}));

const mockToastSuccess = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import Subscriptions from '../../src/pages/providers/Subscriptions';
import Byok from '../../src/pages/providers/Byok';
import LocalProviders from '../../src/pages/providers/Local';

const connection = (id: string, label: string, active = true) => ({
  id,
  label,
  key_prefix: null,
  priority: 0,
  connected_at: '2026-01-01',
  models_fetched_at: null,
  cached_model_count: 3,
  is_active: active,
});

const globalProvidersResponse = {
  providers: [
    {
      provider: 'openai',
      auth_type: 'subscription',
      connection_count: 1,
      connections: [connection('sub-openai', 'ChatGPT')],
      total_models: 3,
      consumption_tokens: 42,
      consumption_messages: 2,
      consumption_cost: 0,
      last_used_at: '2026-06-01T00:00:00Z',
      sparkline_7d: [],
    },
    {
      provider: 'custom:cp-1',
      auth_type: 'api_key',
      connection_count: 1,
      connections: [connection('key-custom', 'Production', false)],
      total_models: 2,
      consumption_tokens: 7,
      consumption_messages: 1,
      consumption_cost: 0,
      last_used_at: null,
      sparkline_7d: [],
    },
    {
      provider: 'ollama',
      auth_type: 'local',
      connection_count: 1,
      connections: [connection('local-ollama', 'Default')],
      total_models: 5,
      consumption_tokens: 9,
      consumption_messages: 1,
      consumption_cost: 0,
      last_used_at: null,
      sparkline_7d: [],
    },
  ],
  model_counts: { openai: 10, groq: 4, ollama: 5 },
};

describe('provider pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockIsSelfHosted = true;
    mockRenameProviderKey.mockResolvedValue(undefined);
    mockGetGlobalProviders.mockResolvedValue(globalProvidersResponse);
    // The usage endpoint returns the per-(provider, auth_type) stats that the
    // page merges into config. Derive it from the same fixture so the existing
    // usage assertions still hold.
    mockGetProviderUsage.mockResolvedValue({
      providers: globalProvidersResponse.providers.map((p) => ({
        provider: p.provider,
        auth_type: p.auth_type,
        key_label: 'Default',
        consumption_tokens: p.consumption_tokens,
        consumption_messages: p.consumption_messages,
        consumption_cost: p.consumption_cost,
        attempts_30d: p.auth_type === 'subscription' ? 129 : 188,
        succeeded_30d: p.auth_type === 'subscription' ? 119 : 148,
        last_used_at: p.last_used_at,
        sparkline_7d: p.sparkline_7d,
      })),
    });
    mockGetAgents.mockResolvedValue({ agents: [{ agent_name: 'demo-agent' }] });
    mockGetAgentProviders.mockResolvedValue([{ id: 'route-provider' }]);
    mockGetCustomProviders.mockResolvedValue([
      {
        id: 'cp-1',
        name: 'Custom Gateway',
        base_url: 'https://example.test/v1',
        api_kind: 'openai',
        has_api_key: true,
        models: [],
        created_at: '2026-01-01',
      },
    ]);
  });

  // Both the connected rows and the supported-provider list render from the
  // (synchronous) global-providers resource, but the rename + connect handlers
  // depend on firstAgentName() — which only populates once the agents resource
  // resolves. The supported-provider "Connect" button is disabled until then
  // (disabled={!firstAgentName()}), so an enabled Connect button is the signal
  // that the agent is available before we drive those handlers.
  const waitForConnectedAgent = async (anchorText = 'Production') => {
    await waitFor(() => expect(screen.getByText(anchorText)).toBeDefined());
    await waitFor(() =>
      expect(
        (screen.getAllByText('Connect') as HTMLButtonElement[]).some((btn) => !btn.disabled),
      ).toBe(true),
    );
  };

  it('shows each connection its OWN attempt rate, never the provider blend', async () => {
    // The bug this pins: OpenAI subscription at 92.2% was displayed as ~83%
    // because the list read a provider-level rate blending in the api_key
    // connection's failures. Rows must read their (provider, auth_type) grain.
    render(() => <Subscriptions />);
    await waitFor(() => expect(screen.getByText('ChatGPT')).toBeDefined());

    // 119 / 129 = 92.2%, the subscription connection's own rate.
    // Appears on the header card AND the row: both read the same grain.
    await waitFor(() => expect(screen.getAllByText('92.2%').length).toBeGreaterThan(0));
    expect(screen.getAllByText('129').length).toBeGreaterThan(0);
    // The blended provider rate (267/317 = 84.2%) must appear nowhere.
    expect(screen.queryByText('84.2%')).toBeNull();
  });

  it('flags connections whose credential an upstream rejected', async () => {
    // A 401 from upstream leaves the connection active but skipped in routing.
    // Both title branches render: one with the rejected status, one without.
    mockGetGlobalProviders.mockResolvedValue({
      ...globalProvidersResponse,
      providers: globalProvidersResponse.providers.map((p) =>
        p.provider === 'openai'
          ? {
              ...p,
              connections: [
                {
                  ...connection('sub-openai', 'ChatGPT'),
                  requires_reauth: true,
                  last_auth_failure: {
                    statusCode: 401,
                    reason: 'subscription_token_rejected',
                    keyLabel: 'ChatGPT',
                    provider: 'openai',
                    at: Date.now(),
                  },
                },
                {
                  ...connection('sub-openai-2', 'ChatGPT Backup'),
                  requires_reauth: true,
                  last_auth_failure: null,
                },
              ],
            }
          : p,
      ),
    });

    render(() => <Subscriptions />);
    await waitFor(() => expect(screen.getByText('ChatGPT')).toBeDefined());

    await waitFor(() => expect(screen.getAllByText('Needs re-auth')).toHaveLength(2));
    const badges = screen.getAllByText('Needs re-auth');
    expect(badges[0].getAttribute('title')).toContain('HTTP 401');
    expect(badges[1].getAttribute('title')).not.toContain('HTTP');
  });

  it('renders the subscriptions page and opens the connect modal', async () => {
    render(() => <Subscriptions />);

    await waitFor(() => {
      expect(screen.getByText('Subscriptions')).toBeDefined();
      expect(screen.getByText('My subscription connections')).toBeDefined();
      expect(screen.getByText('ChatGPT')).toBeDefined();
    });

    fireEvent.click(screen.getAllByText('Connect')[0]!);
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'provider modal' })).toBeDefined();
      expect(mockProviderSelectModal).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'demo-agent',
          providers: [{ id: 'route-provider' }],
        }),
      );
    });
    fireEvent.click(screen.getByText('update'));
    await waitFor(() => {
      expect(mockGetAgentProviders.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    fireEvent.click(screen.getByText('close'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'provider modal' })).toBeNull();
    });
  });

  it('renders inactive subscription rows even when they have no usage', async () => {
    mockGetGlobalProviders.mockResolvedValue({
      ...globalProvidersResponse,
      providers: [
        ...globalProvidersResponse.providers,
        {
          provider: 'anthropic',
          auth_type: 'subscription',
          connection_count: 1,
          connections: [connection('sub-old-claude', 'Old Claude', false)],
          total_models: 0,
          consumption_tokens: 0,
          consumption_messages: 0,
          consumption_cost: 0,
          last_used_at: null,
          sparkline_7d: [],
        },
      ],
    });

    render(() => <Subscriptions />);

    await waitFor(() => expect(screen.getByText('Old Claude')).toBeDefined());
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Old Claude').closest('tr')!);
    expect(mockNavigate).toHaveBeenCalledWith('/providers/connections/sub-old-claude');
  });

  it('deep-links the connect modal to a specific provider when added from its row', async () => {
    render(() => <Subscriptions />);

    // Each supported-provider row carries its own "Connect" button; clicking it
    // opens straight into that provider's connection form (deep link) rather
    // than the generic picker list. Index 0 is the first supported provider
    // (OpenAI). Wait until the agents resource resolves so the button enables.
    await waitFor(() => {
      expect((screen.getAllByText('Connect')[0] as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getAllByText('Connect')[0]!);
    await waitFor(() => {
      expect(mockProviderSelectModal).toHaveBeenCalledWith(
        expect.objectContaining({
          providerDeepLink: { providerId: 'openai', authType: 'subscription' },
        }),
      );
    });
  });

  it('renders the BYOK (usage-based) page with custom provider connections', async () => {
    render(() => <Byok />);

    await waitFor(() => {
      expect(screen.getByText('Usage-based')).toBeDefined();
      expect(screen.getByText('My usage-based connections')).toBeDefined();
      expect(screen.getByText('Custom Gateway')).toBeDefined();
      expect(screen.getByText('Inactive')).toBeDefined();
      expect(screen.getByText('Supported usage-based providers')).toBeDefined();
    });
  });

  it('still renders connected rows when the usage endpoint rejects', async () => {
    // Config resolves so connections paint; usage rejects → the page's usage
    // resource catch returns [] and the row shows zeroed usage (0 tokens).
    mockGetProviderUsage.mockRejectedValue(new Error('usage down'));

    render(() => <Subscriptions />);

    await waitFor(() => expect(screen.getByText('ChatGPT')).toBeDefined());
    await waitFor(() => expect(screen.getByText(/0 tokens/)).toBeDefined());
  });

  it('renders the local providers page', async () => {
    render(() => <LocalProviders />);

    await waitFor(() => {
      expect(screen.getByText('Local')).toBeDefined();
      expect(screen.getByText('My local connections')).toBeDefined();
      expect(screen.getAllByText('Ollama').length).toBeGreaterThan(0);
    });
  });

  it('redirects the local providers page to the usage-based page in cloud', async () => {
    mockIsSelfHosted = false;
    const { container } = render(() => <LocalProviders />);

    await waitFor(() => {
      const navigate = container.querySelector('[data-testid="navigate"]');
      expect(navigate).not.toBeNull();
      expect(navigate?.getAttribute('data-href')).toBe('/providers/usage-based');
    });
    // The page content (its connected-connections heading) must not render —
    // cloud short-circuits straight to the redirect.
    expect(container.textContent).not.toContain('My local connections');
  });

  it('auto-opens the modal from add=true and clears the query param', async () => {
    mockSearchParams = { add: 'true' };
    render(() => <LocalProviders />);

    await waitFor(() => {
      // The deep-link handling lives in a createEffect (not the render body), and
      // clears the param with replace so a refresh/back-nav can't re-trigger it.
      expect(mockSetSearchParams).toHaveBeenCalledWith({ add: undefined }, { replace: true });
      expect(screen.getByRole('dialog', { name: 'provider modal' })).toBeDefined();
    });
  });

  it('does not auto-open the modal without the add=true deep-link', async () => {
    mockSearchParams = {};
    render(() => <Subscriptions />);

    await waitFor(() => {
      expect(screen.getByText('Subscriptions')).toBeDefined();
    });
    // No deep-link → the effect must not clear the param or open the modal.
    expect(mockSetSearchParams).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'provider modal' })).toBeNull();
  });

  it('disables Add buttons when no agent exists for the modal context', async () => {
    mockGetAgents.mockResolvedValue({ agents: [] });
    render(() => <Byok />);

    await waitFor(() => {
      const addButton = screen.getAllByText('Connect')[0] as HTMLButtonElement;
      expect(addButton.disabled).toBe(true);
    });
  });

  it('renders supported providers when API calls fail', async () => {
    mockGetGlobalProviders.mockRejectedValue(new Error('providers failed'));
    mockGetAgents.mockRejectedValue(new Error('agents failed'));
    mockGetAgentProviders.mockRejectedValue(new Error('agent providers failed'));
    mockGetCustomProviders.mockRejectedValue(new Error('custom providers failed'));

    render(() => <Subscriptions />);

    await waitFor(() => {
      expect(screen.getByText('Supported subscription providers')).toBeDefined();
      expect(screen.getByText('OpenAI')).toBeDefined();
      expect((screen.getAllByText('Connect')[0] as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('opens the modal with empty lists when modal context fetches fail', async () => {
    mockSearchParams = { add: 'true' };
    mockGetAgentProviders.mockRejectedValue(new Error('agent providers failed'));
    mockGetCustomProviders.mockRejectedValue(new Error('custom providers failed'));

    render(() => <Byok />);

    await waitFor(() => {
      expect(mockProviderSelectModal).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'demo-agent',
          providers: [],
          customProviders: [],
        }),
      );
    });
  });

  it('navigates to the connection detail via row click, keyboard, and View details', async () => {
    render(() => <Byok />);
    // The custom:cp-1 connection (label "Production") is inactive but has usage,
    // so it renders as a connected row.
    await waitFor(() => expect(screen.getByText('Production')).toBeDefined());

    const row = screen.getByText('Production').closest('tr')!;

    // View details button → navigate (and stop propagation).
    fireEvent.click(screen.getByText('View details'));
    expect(mockNavigate).toHaveBeenCalledWith('/providers/connections/key-custom');

    mockNavigate.mockClear();
    // Keyboard activation on the row itself (target === currentTarget) → navigate.
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/providers/connections/key-custom');

    mockNavigate.mockClear();
    fireEvent.keyDown(row, { key: ' ' });
    expect(mockNavigate).toHaveBeenCalledWith('/providers/connections/key-custom');

    mockNavigate.mockClear();
    // A non-activating key on the row is ignored.
    fireEvent.keyDown(row, { key: 'a' });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('ignores keyboard events bubbling up from a child element of the row', async () => {
    render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Production')).toBeDefined());

    // Dispatch the keydown from a descendant (the provider name span) so that
    // event.target !== event.currentTarget and the handler early-returns.
    const child = screen.getByText('Production');
    fireEvent.keyDown(child, { key: 'Enter' });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renames a connection inline and refetches on success', async () => {
    render(() => <Byok />);
    await waitForConnectedAgent();

    // Enter rename mode via the per-row edit button.
    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;

    // Edit the value, then save via the Save button.
    fireEvent.input(input, { target: { value: 'Renamed key' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalledWith(
        'demo-agent',
        'custom:cp-1',
        'Production',
        'Renamed key',
        'api_key',
      );
      expect(mockToastSuccess).toHaveBeenCalledWith('Connection renamed');
    });
    // After success the input is dismissed (renamingId cleared).
    await waitFor(() => expect(screen.queryByDisplayValue('Renamed key')).toBeNull());
  });

  it('saves a rename when pressing Enter in the input', async () => {
    render(() => <Byok />);
    await waitForConnectedAgent();

    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Via enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalledWith(
        'demo-agent',
        'custom:cp-1',
        'Production',
        'Via enter',
        'api_key',
      );
    });
  });

  it('shows a validation error when the new name is empty', async () => {
    render(() => <Byok />);
    await waitForConnectedAgent();

    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Name cannot be empty')).toBeDefined());
    expect(mockRenameProviderKey).not.toHaveBeenCalled();
  });

  it('cancels the rename without calling the API when the name is unchanged', async () => {
    render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Production')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    // Saving with the same value just exits rename mode (no API call).
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.queryByDisplayValue('Production')).toBeNull());
    expect(mockRenameProviderKey).not.toHaveBeenCalled();
  });

  it('cancels the rename via the Cancel button and via Escape', async () => {
    render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Production')).toBeDefined());

    // Cancel button path.
    fireEvent.click(screen.getByLabelText('Rename Production'));
    await screen.findByDisplayValue('Production');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByDisplayValue('Production')).toBeNull());

    // Escape-key path.
    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByDisplayValue('Production')).toBeNull());
    expect(mockRenameProviderKey).not.toHaveBeenCalled();
  });

  it('surfaces the API error message when a rename fails', async () => {
    mockRenameProviderKey.mockRejectedValue(new Error('Name already taken'));
    render(() => <Byok />);
    await waitForConnectedAgent();

    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Clashing name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Name already taken')).toBeDefined());
    // The input stays open so the user can correct the name.
    expect(screen.getByDisplayValue('Clashing name')).toBeDefined();
  });

  it('falls back to a generic message when a rename rejects without a message', async () => {
    mockRenameProviderKey.mockRejectedValue({});
    render(() => <Byok />);
    await waitForConnectedAgent();

    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Another name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Failed to rename')).toBeDefined());
  });

  it('aborts a rename when there is no agent to scope it to', async () => {
    // With no agent, firstAgentName() is empty and submitRename early-returns
    // before touching the API.
    mockGetAgents.mockResolvedValue({ agents: [] });
    // A connection still renders because it has usage, even without an agent.
    render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Production')).toBeDefined());

    fireEvent.click(screen.getByLabelText('Rename Production'));
    const input = (await screen.findByDisplayValue('Production')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'No agent name' } });
    fireEvent.click(screen.getByText('Save'));

    // No API call and the input stays open (no toast, no rename).
    expect(mockRenameProviderKey).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('No agent name')).toBeDefined();
  });

  it('renders the list view with active-connection counts and opens the connect modal', async () => {
    render(() => <Subscriptions />);
    await waitForConnectedAgent('ChatGPT');

    // Switch from the default grid view to the list view.
    fireEvent.click(screen.getByLabelText('List view'));

    // OpenAI has one active subscription connection → the active-count label
    // renders in the list row.
    await waitFor(() => expect(screen.getByText('1 active connection')).toBeDefined());

    // The list-view per-provider Connect button opens the modal deep-linked to
    // that provider. Scope to the OpenAI row inside the supported-provider list
    // table (the connected-rows table also shows "OpenAI", but its first button
    // is the rename pencil — pick the row whose button actually reads "Connect").
    const openaiConnect = screen
      .getAllByText('OpenAI')
      .map((el) => el.closest('tr'))
      .map((tr) =>
        Array.from(tr?.querySelectorAll('button') ?? []).find(
          (btn) => btn.textContent?.trim() === 'Connect',
        ),
      )
      .find((btn): btn is HTMLButtonElement => !!btn)!;
    fireEvent.click(openaiConnect);

    await waitFor(() => {
      expect(mockProviderSelectModal).toHaveBeenCalledWith(
        expect.objectContaining({
          providerDeepLink: { providerId: 'openai', authType: 'subscription' },
        }),
      );
    });
  });

  it('disables the list-view Connect button when no agent exists', async () => {
    mockGetAgents.mockResolvedValue({ agents: [] });
    render(() => <Subscriptions />);
    await waitFor(() => expect(screen.getByText('Subscriptions')).toBeDefined());

    fireEvent.click(screen.getByLabelText('List view'));

    await waitFor(() => {
      const connectButtons = screen.getAllByText('Connect') as HTMLButtonElement[];
      expect(connectButtons.every((btn) => btn.disabled)).toBe(true);
    });
  });

  it('pluralizes the active-connection label for multiple connections', async () => {
    // Two active connections under one provider → plural "connections".
    mockGetGlobalProviders.mockResolvedValue({
      providers: [
        {
          provider: 'openai',
          auth_type: 'subscription',
          connection_count: 2,
          connections: [connection('sub-1', 'Plan A'), connection('sub-2', 'Plan B')],
          total_models: 3,
          consumption_tokens: 42,
          consumption_messages: 2,
          consumption_cost: 0,
          last_used_at: '2026-06-01T00:00:00Z',
          sparkline_7d: [],
        },
      ],
      model_counts: {},
    });

    render(() => <Subscriptions />);
    await waitFor(() => expect(screen.getByText('Plan A')).toBeDefined());

    fireEvent.click(screen.getByLabelText('List view'));
    await waitFor(() => expect(screen.getByText('2 active connections')).toBeDefined());
  });

  it('labels local providers as "Connected" in the list view', async () => {
    render(() => <LocalProviders />);
    await waitFor(() => expect(screen.getByText('My local connections')).toBeDefined());

    fireEvent.click(screen.getByLabelText('List view'));
    // Local providers use the "Connected" label rather than an active-count.
    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0));
  });

  it('opens and closes the custom provider modal on the BYOK page', async () => {
    render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Add custom provider')).toBeDefined());

    // Wait for agent to load so the modal can render (guarded by firstAgentName()).
    await waitFor(() =>
      expect(
        (screen.getAllByText('Connect') as HTMLButtonElement[]).some((btn) => !btn.disabled),
      ).toBe(true),
    );

    fireEvent.click(screen.getByText('Add custom provider'));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Add custom provider' })).toBeDefined(),
    );
    expect(mockCustomProviderForm).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'demo-agent' }),
    );
    // initialData must NOT be passed in create mode.
    expect(mockCustomProviderForm).toHaveBeenCalledWith(
      expect.not.objectContaining({ initialData: expect.anything() }),
    );

    // Close via Escape key.
    const overlay = document.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.keyDown(overlay, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add custom provider' })).toBeNull(),
    );
    // Closing refetches both global and custom providers.
    expect(mockGetGlobalProviders.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockGetCustomProviders.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('closes the custom modal via overlay click', async () => {
    render(() => <Byok />);
    await waitFor(() =>
      expect(
        (screen.getAllByText('Connect') as HTMLButtonElement[]).some((btn) => !btn.disabled),
      ).toBe(true),
    );

    fireEvent.click(screen.getByText('Add custom provider'));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Add custom provider' })).toBeDefined(),
    );

    // Click the overlay itself (target === currentTarget).
    const overlay = document.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add custom provider' })).toBeNull(),
    );
  });

  it('closes the custom modal when the form fires onCreated', async () => {
    render(() => <Byok />);
    await waitFor(() =>
      expect(
        (screen.getAllByText('Connect') as HTMLButtonElement[]).some((btn) => !btn.disabled),
      ).toBe(true),
    );

    fireEvent.click(screen.getByText('Add custom provider'));
    await waitFor(() => expect(screen.getByTestId('custom-provider-form')).toBeDefined());

    fireEvent.click(screen.getByText('created'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add custom provider' })).toBeNull(),
    );
  });

  it('closes the custom modal when the form fires onBack', async () => {
    render(() => <Byok />);
    await waitFor(() =>
      expect(
        (screen.getAllByText('Connect') as HTMLButtonElement[]).some((btn) => !btn.disabled),
      ).toBe(true),
    );

    fireEvent.click(screen.getByText('Add custom provider'));
    await waitFor(() => expect(screen.getByTestId('custom-provider-form')).toBeDefined());

    fireEvent.click(screen.getByText('back'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add custom provider' })).toBeNull(),
    );
  });

  it('renders a usage sparkline for connected rows that have 7-day data', async () => {
    // A connected row with a non-empty sparkline_7d renders the Sparkline cell;
    // the default fixtures use empty arrays, so this drives the sparkline branch.
    mockGetGlobalProviders.mockResolvedValue({
      providers: [
        {
          provider: 'openai',
          auth_type: 'subscription',
          connection_count: 1,
          connections: [connection('sub-spark', 'Sparkly')],
          total_models: 3,
        },
      ],
      model_counts: {},
    });
    // Sparkline data now arrives via the usage endpoint and is merged in.
    mockGetProviderUsage.mockResolvedValue({
      providers: [
        {
          provider: 'openai',
          auth_type: 'subscription',
          key_label: 'Sparkly',
          consumption_tokens: 1200,
          consumption_messages: 5,
          consumption_cost: 0,
          attempts_30d: 5,
          succeeded_30d: 5,
          last_used_at: '2026-06-01T00:00:00Z',
          sparkline_7d: [1, 2, 3, 4],
        },
      ],
    });

    render(() => <Subscriptions />);
    await waitFor(() => expect(screen.getByText('Sparkly')).toBeDefined());
    // The stubbed Sparkline reports its data length (4 points).
    await waitFor(() => {
      const spark = screen.getByTestId('sparkline');
      expect(spark.textContent).toBe('4');
    });
  });
  // ── Collapsed connections list ──────────────────────────────────────────
  // Past six connections the list is capped inside its own card so the
  // supported-provider catalog below stays reachable. Nothing is dropped: the
  // card scrolls, and the footer button expands it to full height.
  const manyConnections = (count: number) => ({
    providers: [
      {
        provider: 'openai',
        auth_type: 'api_key',
        connection_count: count,
        connections: Array.from({ length: count }, (_, i) =>
          connection(`key-${i}`, `Key ${i + 1}`),
        ),
        total_models: 3,
        consumption_tokens: 1,
        consumption_messages: 1,
        consumption_cost: 0,
        last_used_at: null,
        sparkline_7d: [],
      },
    ],
    model_counts: {},
  });

  it('leaves the connections list uncapped at six connections', async () => {
    mockGetGlobalProviders.mockResolvedValue(manyConnections(6));
    mockGetProviderUsage.mockResolvedValue({ providers: [] });
    const { container } = render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Key 6')).toBeDefined());

    expect(container.querySelector('.connections-panel--collapsed')).toBeNull();
    expect(screen.queryByText(/^Show all /)).toBeNull();
  });

  it('caps the connections list past six and names how many there are', async () => {
    mockGetGlobalProviders.mockResolvedValue(manyConnections(9));
    mockGetProviderUsage.mockResolvedValue({ providers: [] });
    const { container } = render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Key 9')).toBeDefined());

    expect(container.querySelector('.connections-panel--collapsed')).not.toBeNull();
    const toggle = screen.getByText('Show all 9 connections').closest('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Every row stays in the DOM: the card scrolls, it does not paginate.
    expect(screen.getByText('Key 1')).toBeDefined();
    expect(screen.getByText('Key 9')).toBeDefined();
  });

  it('expands the connections list and collapses it again', async () => {
    mockGetGlobalProviders.mockResolvedValue(manyConnections(8));
    mockGetProviderUsage.mockResolvedValue({ providers: [] });
    const { container } = render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Show all 8 connections')).toBeDefined());

    const toggle = screen.getByText('Show all 8 connections').closest('button')!;
    // The button points at the region it expands.
    expect(container.querySelector(`#${toggle.getAttribute('aria-controls')}`)).not.toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText('Show less')).toBeDefined();
      expect(container.querySelector('.connections-panel--collapsed')).toBeNull();
    });
    expect(screen.getByText('Show less').closest('button')!.getAttribute('aria-expanded')).toBe(
      'true',
    );

    fireEvent.click(screen.getByText('Show less').closest('button')!);
    await waitFor(() => {
      expect(screen.getByText('Show all 8 connections')).toBeDefined();
      expect(container.querySelector('.connections-panel--collapsed')).not.toBeNull();
    });
  });

  it('brings the bottom fade back after expanding and collapsing again', async () => {
    mockGetGlobalProviders.mockResolvedValue(manyConnections(8));
    mockGetProviderUsage.mockResolvedValue({ providers: [] });
    const { container } = render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Show all 8 connections')).toBeDefined());

    const body = container.querySelector('.connections-panel__body') as HTMLElement;
    const viewport = container.querySelector('.connections-panel__viewport')!;
    fireEvent.scroll(body);
    expect(viewport.classList.contains('scroll-panel--at-bottom')).toBe(true);

    // Expanding drops the scroll position, so the flag must not survive into
    // the next collapse and hide the fade at the top of the list.
    fireEvent.click(screen.getByText('Show all 8 connections').closest('button')!);
    await waitFor(() => expect(screen.getByText('Show less')).toBeDefined());
    expect(viewport.classList.contains('scroll-panel--at-bottom')).toBe(false);

    fireEvent.click(screen.getByText('Show less').closest('button')!);
    await waitFor(() => expect(screen.getByText('Show all 8 connections')).toBeDefined());
    expect(viewport.classList.contains('scroll-panel--at-bottom')).toBe(false);
  });

  it('drops the bottom fade once the capped list is scrolled to the end', async () => {
    mockGetGlobalProviders.mockResolvedValue(manyConnections(8));
    mockGetProviderUsage.mockResolvedValue({ providers: [] });
    const { container } = render(() => <Byok />);
    await waitFor(() => expect(screen.getByText('Show all 8 connections')).toBeDefined());

    const body = container.querySelector('.connections-panel__body') as HTMLElement;
    const viewport = container.querySelector('.connections-panel__viewport')!;
    expect(viewport.classList.contains('scroll-panel--at-bottom')).toBe(false);

    // jsdom reports zero layout, which reads as "already at the end".
    fireEvent.scroll(body);
    expect(viewport.classList.contains('scroll-panel--at-bottom')).toBe(true);
  });
});
