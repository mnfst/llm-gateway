import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { createSignal, type Accessor, type Setter } from 'solid-js';

const mockConnectProvider = vi.fn();
const mockDisconnectProvider = vi.fn();
const mockRefreshProviderModels = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  connectProvider: (...args: unknown[]) => mockConnectProvider(...args),
  disconnectProvider: (...args: unknown[]) => mockDisconnectProvider(...args),
  refreshProviderModels: (...args: unknown[]) => mockRefreshProviderModels(...args),
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatTimeAgo: (ts: string | null | undefined) => (ts ? '5m ago' : null),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/CopyButton.js', () => ({
  default: (props: { text: string }) => <span data-testid="copy-btn">{props.text}</span>,
}));

vi.mock('../../src/components/ProviderKeyForm.js', () => ({
  default: (props: {
    provId: string;
    agentName: string;
    isSubMode: Accessor<boolean>;
    connected: Accessor<boolean>;
    selectedAuthType: Accessor<AuthType>;
    busy: Accessor<boolean>;
    keyInput: Accessor<string>;
    editing: Accessor<boolean>;
    validationError: Accessor<string | null>;
    providers: RoutingProvider[];
    onBack: () => void;
    onUpdate: () => void;
  }) => (
    <div
      data-agent={props.agentName}
      data-auth={props.selectedAuthType()}
      data-busy={String(props.busy())}
      data-connected={String(props.connected())}
      data-editing={String(props.editing())}
      data-has-back={String(Boolean(props.onBack))}
      data-has-update={String(Boolean(props.onUpdate))}
      data-input={props.keyInput()}
      data-is-sub-mode={String(props.isSubMode())}
      data-provider-count={String(props.providers.length)}
      data-provider-id={props.provId}
      data-testid="provider-key-form"
      data-validation-error={props.validationError() ?? ''}
    />
  ),
  MAX_KEYS_PER_PROVIDER: 50,
}));

vi.mock('../../src/components/OAuthDetailView.js', () => ({
  default: (props: {
    provId: string;
    connected: Accessor<boolean>;
    selectedAuthType: Accessor<AuthType>;
    busy: Accessor<boolean>;
    onClose: () => void;
  }) => (
    <div
      data-auth={props.selectedAuthType()}
      data-busy={String(props.busy())}
      data-connected={String(props.connected())}
      data-has-close={String(Boolean(props.onClose))}
      data-provider-id={props.provId}
      data-testid="oauth-detail-view"
    />
  ),
}));

vi.mock('../../src/components/AnthropicOAuthDetailView.js', () => ({
  default: (props: {
    provId: string;
    connected: Accessor<boolean>;
    selectedAuthType: Accessor<AuthType>;
    busy: Accessor<boolean>;
    onClose: () => void;
  }) => (
    <div
      data-auth={props.selectedAuthType()}
      data-busy={String(props.busy())}
      data-connected={String(props.connected())}
      data-has-close={String(Boolean(props.onClose))}
      data-provider-id={props.provId}
      data-testid="anthropic-oauth-detail-view"
    />
  ),
}));

vi.mock('../../src/components/DeviceCodeDetailView.js', () => ({
  default: (props: {
    provId: string;
    connected: Accessor<boolean>;
    selectedAuthType: Accessor<AuthType>;
    busy: Accessor<boolean>;
    onClose: () => void;
  }) => (
    <div
      data-auth={props.selectedAuthType()}
      data-busy={String(props.busy())}
      data-connected={String(props.connected())}
      data-has-close={String(Boolean(props.onClose))}
      data-provider-id={props.provId}
      data-testid="device-code-detail-view"
    />
  ),
}));

import ProviderDetailView from '../../src/components/ProviderDetailView';
import { toast } from '../../src/services/toast-store.js';
import type { AuthType, RoutingProvider } from '../../src/services/api.js';

function createTestProps(
  overrides: Partial<{
    provId: string;
    providers: RoutingProvider[];
    selectedAuthType: AuthType;
    busy: boolean;
  }> = {},
) {
  const [busy, setBusy] = createSignal(overrides.busy ?? false);
  const [keyInput, setKeyInput] = createSignal('');
  const [editing, setEditing] = createSignal(false);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [selectedAuthType, setSelectedAuthType] = createSignal<AuthType>(
    overrides.selectedAuthType ?? 'api_key',
  );

  return {
    provId: overrides.provId ?? 'ollama',
    agentName: 'test-agent',
    providers: overrides.providers ?? [],
    selectedAuthType: selectedAuthType as Accessor<AuthType>,
    busy,
    setBusy: setBusy as Setter<boolean>,
    keyInput,
    setKeyInput: setKeyInput as Setter<string>,
    editing,
    setEditing: setEditing as Setter<boolean>,
    validationError,
    setValidationError: setValidationError as Setter<string | null>,
    onBack: vi.fn(),
    onUpdate: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('ProviderDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectProvider.mockResolvedValue({});
    mockDisconnectProvider.mockResolvedValue({ notifications: [] });
    mockRefreshProviderModels.mockResolvedValue({
      ok: true,
      model_count: 3,
      last_fetched_at: '2026-04-12T10:00:00Z',
      error: null,
    });
  });

  describe('Ollama connect flow', () => {
    it('shows Connect button for disconnected Ollama', () => {
      const props = createTestProps({ provId: 'ollama', providers: [] });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByText('Connect')).toBeDefined();
    });

    it('calls connectProvider and callbacks on successful connect', async () => {
      const props = createTestProps({ provId: 'ollama', providers: [] });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByText('Connect'));

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
          provider: 'ollama',
          authType: 'api_key',
        });
        expect(props.onBack).toHaveBeenCalled();
        expect(props.onUpdate).toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith('Ollama connected');
      });
    });

    it('handles connect failure gracefully', async () => {
      mockConnectProvider.mockRejectedValueOnce(new Error('fail'));
      const props = createTestProps({ provId: 'ollama', providers: [] });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByText('Connect'));

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalled();
        expect(props.onBack).not.toHaveBeenCalled();
      });
    });
  });

  describe('Ollama disconnect flow', () => {
    const connectedOllamaProviders: RoutingProvider[] = [
      {
        id: 'p1',
        provider: 'ollama',
        auth_type: 'api_key',
        is_active: true,
        has_api_key: false,
        connected_at: '2025-01-01',
      },
    ];

    it('shows Disconnect button for connected Ollama', () => {
      const props = createTestProps({
        provId: 'ollama',
        providers: connectedOllamaProviders,
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByText('Disconnect')).toBeDefined();
    });

    it('calls disconnectProvider on disconnect click', async () => {
      const props = createTestProps({
        provId: 'ollama',
        providers: connectedOllamaProviders,
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockDisconnectProvider).toHaveBeenCalledWith('test-agent', 'ollama', 'api_key');
        expect(props.onBack).toHaveBeenCalled();
        expect(props.onUpdate).toHaveBeenCalled();
      });
    });

    it('handles disconnect failure gracefully', async () => {
      mockDisconnectProvider.mockRejectedValueOnce(new Error('fail'));
      const props = createTestProps({
        provId: 'ollama',
        providers: connectedOllamaProviders,
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockDisconnectProvider).toHaveBeenCalled();
        expect(props.onBack).not.toHaveBeenCalled();
      });
    });

    it('shows notification toasts from disconnect result', async () => {
      mockDisconnectProvider.mockResolvedValueOnce({
        notifications: ['Provider had active tiers'],
      });
      const props = createTestProps({
        provId: 'ollama',
        providers: connectedOllamaProviders,
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Provider had active tiers');
        expect(props.onBack).toHaveBeenCalled();
      });
    });
  });

  describe('OpenAI subscription renders OAuthDetailView', () => {
    it('renders OAuthDetailView for popup_oauth subscription flow', () => {
      const connectedOpenaiSub: RoutingProvider[] = [
        {
          id: 'p1',
          provider: 'openai',
          auth_type: 'subscription',
          is_active: true,
          has_api_key: false,
          connected_at: '2025-01-01',
        },
      ];
      const props = createTestProps({
        provId: 'openai',
        providers: connectedOpenaiSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByTestId('oauth-detail-view')).toBeDefined();
    });
  });

  describe('Gemini subscription renders OAuthDetailView', () => {
    it('renders OAuthDetailView for gemini popup_oauth subscription flow', () => {
      const connectedGeminiSub: RoutingProvider[] = [
        {
          id: 'p1',
          provider: 'gemini',
          auth_type: 'subscription',
          is_active: true,
          has_api_key: false,
          connected_at: '2025-01-01',
        },
      ];
      const props = createTestProps({
        provId: 'gemini',
        providers: connectedGeminiSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByTestId('oauth-detail-view')).toBeDefined();
    });
  });

  describe('providers closed to new subscriptions (Google)', () => {
    const googleSub = (overrides: Partial<RoutingProvider> = {}): RoutingProvider => ({
      id: 'p1',
      provider: 'gemini',
      auth_type: 'subscription',
      is_active: true,
      has_api_key: true,
      connected_at: '2025-01-01',
      ...overrides,
    });

    it('shows only the closure note when there is no connection', () => {
      const props = createTestProps({ provId: 'gemini', selectedAuthType: 'subscription' });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByRole('note').textContent).toContain(
        'no longer allows new Gemini sign-ins',
      );
      expect(screen.queryByTestId('oauth-detail-view')).toBeNull();
      expect(screen.queryByTestId('provider-key-form')).toBeNull();
    });

    it('keeps an existing connection manageable but offers no new one', () => {
      const props = createTestProps({
        provId: 'gemini',
        providers: [googleSub()],
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByTestId('oauth-detail-view')).toBeDefined();
      expect(screen.getByRole('note')).toBeDefined();
      expect(screen.queryByText('Add connection')).toBeNull();
    });

    it('still offers another connection for open providers', () => {
      const props = createTestProps({
        provId: 'openai',
        providers: [googleSub({ provider: 'openai' })],
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByText('Add connection')).toBeDefined();
      expect(screen.queryByRole('note')).toBeNull();
    });

    it('leaves the Google API key flow untouched', () => {
      const props = createTestProps({ provId: 'gemini', selectedAuthType: 'api_key' });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByTestId('provider-key-form')).toBeDefined();
      expect(screen.queryByRole('note')).toBeNull();
    });
  });

  describe('Anthropic subscription renders paste-code OAuth flow', () => {
    it('renders AnthropicOAuthDetailView for popup_paste subscription flow', () => {
      const connectedAnthropicSub: RoutingProvider[] = [
        {
          id: 'p1',
          provider: 'anthropic',
          auth_type: 'subscription',
          is_active: true,
          has_api_key: true,
          connected_at: '2025-01-01',
        },
      ];
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByTestId('anthropic-oauth-detail-view')).toBeDefined();
    });
  });

  describe('Copilot subscription renders device-code flow', () => {
    it('renders DeviceCodeDetailView for device_code subscription flow', () => {
      const connectedCopilotSub: RoutingProvider[] = [
        {
          id: 'p1',
          provider: 'copilot',
          auth_type: 'subscription',
          is_active: true,
          has_api_key: true,
          connected_at: '2025-01-01',
        },
      ];
      const props = createTestProps({
        provId: 'copilot',
        providers: connectedCopilotSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByTestId('device-code-detail-view')).toBeDefined();
    });
  });

  describe('Kiro subscription renders device-code flow', () => {
    it('renders DeviceCodeDetailView for the Kiro device_code subscription flow', () => {
      const props = createTestProps({
        provId: 'kiro',
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      const view = screen.getByTestId('device-code-detail-view');
      expect(view).toBeDefined();
      expect(view.getAttribute('data-provider-id')).toBe('kiro');
    });
  });

  it('renders back button', () => {
    const props = createTestProps();
    render(() => <ProviderDetailView {...props} />);
    const btn = screen.getByLabelText('Back to providers');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(props.onBack).toHaveBeenCalled();
  });

  it('renders ProviderKeyForm for non-Ollama providers', () => {
    const props = createTestProps({ provId: 'anthropic' });
    render(() => <ProviderDetailView {...props} />);
    expect(screen.getByTestId('provider-key-form')).toBeDefined();
  });

  it('keeps the add-key action available after 5 active keys', () => {
    const providers: RoutingProvider[] = Array.from({ length: 6 }, (_, index) => ({
      id: `p${index + 1}`,
      provider: 'openai',
      auth_type: 'api_key',
      is_active: true,
      has_api_key: true,
      label: `Key ${index + 1}`,
      priority: index,
      connected_at: '2026-01-01',
    }));
    const props = createTestProps({ provId: 'openai', providers });

    render(() => <ProviderDetailView {...props} />);

    expect(screen.getByText('Add another key')).toBeDefined();
  });

  describe('per-provider refresh button', () => {
    const connectedAnthropicSub: RoutingProvider[] = [
      {
        id: 'p1',
        provider: 'anthropic',
        auth_type: 'subscription',
        is_active: true,
        has_api_key: true,
        connected_at: '2025-01-01',
        models_fetched_at: '2026-04-12T09:55:00Z',
        cached_model_count: 12,
      },
    ];

    it('hides the refresh button when the provider is not connected', () => {
      const props = createTestProps({ provId: 'anthropic', providers: [] });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.queryByLabelText('Refresh models from Anthropic')).toBeNull();
    });

    it('shows the refresh button and last-refreshed indicator when connected', () => {
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);
      expect(screen.getByLabelText('Refresh models from Anthropic')).toBeDefined();
      expect(screen.getByText(/12 models - last refreshed: 5m ago/)).toBeDefined();
    });

    it('calls refreshProviderModels with the provider and auth type and shows a success toast', async () => {
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(mockRefreshProviderModels).toHaveBeenCalledWith(
          'test-agent',
          'anthropic',
          'subscription',
        );
        expect(toast.success).toHaveBeenCalledWith('Anthropic: refreshed 3 models');
        expect(props.onUpdate).toHaveBeenCalled();
      });
    });

    it('updates the model count immediately after a successful refresh', async () => {
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      const [providers, setProviders] = createSignal(connectedAnthropicSub);
      props.onUpdate.mockImplementation(() => {
        setProviders([
          {
            ...connectedAnthropicSub[0]!,
            cached_model_count: 3,
            models_fetched_at: '2026-04-12T10:00:00Z',
          },
        ]);
      });
      render(() => <ProviderDetailView {...props} providers={providers()} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(screen.getByText(/3 models - last refreshed: 5m ago/)).toBeDefined();
      });
    });

    it('keeps refreshing until the parent model catalog has reloaded', async () => {
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      let finishUpdate!: () => void;
      props.onUpdate.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishUpdate = resolve;
          }),
      );
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(screen.getByText('Refreshing…')).toBeDefined();
      });
      finishUpdate();

      await waitFor(() => {
        expect(screen.getByText('Refresh models')).toBeDefined();
      });
    });

    it('shows a singular model count in the success toast', async () => {
      mockRefreshProviderModels.mockResolvedValueOnce({
        ok: true,
        model_count: 1,
        last_fetched_at: '2026-04-12T10:00:00Z',
        error: null,
      });
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Anthropic: refreshed 1 model');
      });
    });

    it('shows the backend error message in the toast when refresh fails', async () => {
      mockRefreshProviderModels.mockResolvedValueOnce({
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: 'Provider returned no models',
      });
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Provider returned no models');
        expect(props.onUpdate).toHaveBeenCalled();
      });
    });

    it("falls back to a generic message when the backend doesn't supply one", async () => {
      mockRefreshProviderModels.mockResolvedValueOnce({
        ok: false,
        model_count: 0,
        last_fetched_at: null,
        error: null,
      });
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Couldn't refresh Anthropic");
      });
    });

    it('swallows network errors without throwing', async () => {
      mockRefreshProviderModels.mockRejectedValueOnce(new Error('boom'));
      const props = createTestProps({
        provId: 'anthropic',
        providers: connectedAnthropicSub,
        selectedAuthType: 'subscription',
      });
      render(() => <ProviderDetailView {...props} />);

      fireEvent.click(screen.getByLabelText('Refresh models from Anthropic'));

      await waitFor(() => {
        expect(mockRefreshProviderModels).toHaveBeenCalled();
      });
      expect(props.onUpdate).not.toHaveBeenCalled();
    });
  });
});
