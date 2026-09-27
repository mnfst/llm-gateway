import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetGlobalProviders = vi.fn();
const mockGetEnabledProviders = vi.fn();
const mockGetAgentProviderDisableImpact = vi.fn();
const mockEnableEnabledProviders = vi.fn();
const mockDisableEnabledProviders = vi.fn();
const mockGetCustomProviders = vi.fn();

vi.mock('@solidjs/router', () => ({
  useParams: () => ({ agentName: 'demo-agent' }),
  // The empty-state fallback (NoConnectionsPrompt) renders <A> links to the
  // provider pages, so the router mock must expose A alongside useParams.
  A: (props: any) => props.children,
}));

// NoConnectionsPrompt (the empty-state fallback) gates a "Local" card on the
// self-hosted check. Stub it so the prompt renders without a real fetch; the
// value doesn't affect the assertions (they only look for "No providers
// connected").
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => Promise.resolve(false),
}));

vi.mock('../../src/services/api/providers.js', () => ({
  getProviders: (...args: unknown[]) => mockGetGlobalProviders(...args),
}));

vi.mock('../../src/services/api.js', () => ({
  getEnabledProviders: (...args: unknown[]) => mockGetEnabledProviders(...args),
  getAgentProviderDisableImpact: (...args: unknown[]) =>
    mockGetAgentProviderDisableImpact(...args),
  enableProviderForAgent: (...args: unknown[]) => mockEnableEnabledProviders(...args),
  disableProviderForAgent: (...args: unknown[]) => mockDisableEnabledProviders(...args),
  getCustomProviders: (...args: unknown[]) => mockGetCustomProviders(...args),
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: (providerId: string) =>
    providerId === 'openai' ? <span data-testid="provider-icon" /> : null,
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
  ],
}));

vi.mock('../../src/services/formatters.js', () => ({
  customProviderColor: () => '#123456',
}));

const mockToastError = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import AgentProviders from '../../src/pages/AgentProviders';

const providersResponse = {
  providers: [
    {
      provider: 'openai',
      auth_type: 'api_key',
      connection_count: 1,
      total_models: 2,
      consumption_tokens: 0,
      consumption_messages: 0,
      consumption_cost: 0,
      last_used_at: null,
      sparkline_7d: [],
      connections: [
        {
          id: 'up-openai',
          label: 'Work',
          key_prefix: 'sk-',
          priority: 0,
          connected_at: '2026-01-01',
          models_fetched_at: null,
          cached_model_count: 2,
          is_active: true,
        },
      ],
    },
    {
      provider: 'anthropic',
      auth_type: 'subscription',
      connection_count: 1,
      total_models: 1,
      consumption_tokens: 0,
      consumption_messages: 0,
      consumption_cost: 0,
      last_used_at: null,
      sparkline_7d: [],
      connections: [
        {
          id: 'up-anthropic',
          label: 'Max',
          key_prefix: null,
          priority: 0,
          connected_at: '2026-01-01',
          models_fetched_at: null,
          cached_model_count: 1,
          is_active: true,
        },
      ],
    },
    {
      provider: 'custom:cp-1',
      auth_type: 'api_key',
      connection_count: 1,
      total_models: 4,
      consumption_tokens: 0,
      consumption_messages: 0,
      consumption_cost: 0,
      last_used_at: null,
      sparkline_7d: [],
      connections: [
        {
          id: 'up-custom',
          label: 'Gateway',
          key_prefix: null,
          priority: 0,
          connected_at: '2026-01-01',
          models_fetched_at: null,
          cached_model_count: 4,
          is_active: true,
        },
      ],
    },
  ],
  model_counts: {},
};

describe('AgentProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGlobalProviders.mockResolvedValue(providersResponse);
    mockGetEnabledProviders.mockResolvedValue({ enabled: ['up-openai'] });
    mockGetAgentProviderDisableImpact.mockResolvedValue({
      affected_tiers: [{ tier: 'default', model: 'gpt-4o', position: 'primary' }],
    });
    mockEnableEnabledProviders.mockResolvedValue({ ok: true });
    mockDisableEnabledProviders.mockResolvedValue({ ok: true });
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

  it('renders connected global providers with enable toggles', async () => {
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeDefined();
      expect(screen.getByText('Anthropic')).toBeDefined();
      expect(screen.getByText('Custom Gateway')).toBeDefined();
    });

    expect(screen.getAllByText('API Key').length).toBeGreaterThan(0);
    expect(screen.getByText('Subscription')).toBeDefined();
    expect(screen.getByLabelText('Disable OpenAI Work')).toBeDefined();
    expect(screen.getByLabelText('Enable Anthropic Max')).toBeDefined();
  });

  it('keeps a long connection name within its cell without removing the models column', async () => {
    const longLabel = 'from MyTrainer LLM Judges and Evaluation Platform';
    mockGetGlobalProviders.mockResolvedValue({
      ...providersResponse,
      providers: providersResponse.providers.map((provider) =>
        provider.provider === 'openai'
          ? {
              ...provider,
              connections: [{ ...provider.connections[0], label: longLabel }],
            }
          : provider,
      ),
    });

    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByTitle(longLabel)).toBeDefined();
    });

    expect(screen.getByTitle(longLabel).style.textOverflow).toBe('ellipsis');
    expect(screen.getByRole('columnheader', { name: 'Models' })).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('enables a provider with PUT', async () => {
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Anthropic Max')).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText('Enable Anthropic Max'));

    await waitFor(() => {
      expect(mockEnableEnabledProviders).toHaveBeenCalledWith('demo-agent', 'up-anthropic');
    });
  });

  it('blocks disabling with an error toast when the provider has routed models', async () => {
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByLabelText('Disable OpenAI Work')).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText('Disable OpenAI Work'));

    await waitFor(() => {
      expect(mockGetAgentProviderDisableImpact).toHaveBeenCalledWith('demo-agent', 'up-openai');
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Can't disable OpenAI"));
    });
    expect(mockDisableEnabledProviders).not.toHaveBeenCalled();
  });

  it('disables directly with DELETE when no models are routed', async () => {
    mockGetAgentProviderDisableImpact.mockResolvedValue({ affected_tiers: [] });
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByLabelText('Disable OpenAI Work')).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText('Disable OpenAI Work'));

    await waitFor(() => {
      expect(mockDisableEnabledProviders).toHaveBeenCalledWith('demo-agent', 'up-openai');
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('renders an empty state when no active providers exist', async () => {
    mockGetGlobalProviders.mockResolvedValue({ providers: [], model_counts: {} });
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByText('No providers connected')).toBeDefined();
    });
  });

  it('falls back to an empty state when initial API calls fail', async () => {
    mockGetGlobalProviders.mockRejectedValue(new Error('providers failed'));
    mockGetEnabledProviders.mockRejectedValue(new Error('access failed'));
    mockGetCustomProviders.mockRejectedValue(new Error('custom failed'));

    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByText('No providers connected')).toBeDefined();
    });
  });

  it('shows an error toast and aborts when the impact check fails', async () => {
    mockGetAgentProviderDisableImpact.mockRejectedValue(new Error('impact failed'));
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByLabelText('Disable OpenAI Work')).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText('Disable OpenAI Work'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Couldn't check"));
    });
    expect(mockDisableEnabledProviders).not.toHaveBeenCalled();
  });

  it('clears busy state when enable or disable calls fail', async () => {
    mockEnableEnabledProviders.mockRejectedValueOnce(new Error('enable failed'));
    mockGetAgentProviderDisableImpact.mockResolvedValue({ affected_tiers: [] });
    mockDisableEnabledProviders.mockRejectedValueOnce(new Error('disable failed'));
    render(() => <AgentProviders />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Anthropic Max')).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText('Enable Anthropic Max'));
    await waitFor(() => {
      expect((screen.getByLabelText('Enable Anthropic Max') as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    fireEvent.click(screen.getByLabelText('Disable OpenAI Work'));
    await waitFor(() => {
      expect(mockDisableEnabledProviders).toHaveBeenCalledWith('demo-agent', 'up-openai');
    });
    await waitFor(() => {
      expect((screen.getByLabelText('Disable OpenAI Work') as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });
});
