import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

// ─────────────────────────────────────────────────────────────────────────
// NOTE (post-#2207 realignment)
//
// Commit #2207 ("UI design polish... and component cleanup") removed the
// provider LIST + tab bar (Subscription / API Keys / Local), the
// "Connect providers" header/subtitle, the "Done" footer, the list toggle
// switches, and the "Add custom provider" list affordance from
// ProviderSelectContent. The component now opens straight into a single
// provider's detail view, driven by a `providerDeepLink` prop — which is
// exactly how the sole production consumer (ProviderConnectionsPage) uses it.
//
// These tests are realigned to drive ProviderSelectModal through that real
// contract (`providerDeepLink={{ providerId, authType }}`). Every detail-view
// behavior the modal still renders (API-key/token input + validation, connect,
// Change/Save edit, disconnect, OpenAI OAuth popup/paste/BroadcastChannel,
// Anthropic paste-code, MiniMax device-code, Copilot device-login, custom
// provider create/delete wiring) is preserved verbatim.
//
// Assertions that targeted the *removed list/tab/footer chrome* are not faked
// against the detail view — that behavior now lives in dedicated, passing test
// files and is covered there:
//   - List rows, toggle switches, "Add custom provider", API-Keys tab filtering,
//     tab hints, provider/subscription labels in the list:
//       tests/components/ProviderApiKeyTab.test.tsx
//       tests/components/ProviderSubscriptionTab.test.tsx
//       tests/components/ProviderLocalTab.test.tsx
//       tests/components/RoutingTabs.test.tsx
//   - The "Connect providers" header / tab default-active / list-view back nav:
//       tests/components/ProviderSelectContent-deeplink.test.tsx
//       tests/components/ProviderSelectContent.test.tsx
// ─────────────────────────────────────────────────────────────────────────

const broadcastChannelRegistry = new Map<string, Set<MockBroadcastChannel>>();

class MockBroadcastChannel {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    if (!broadcastChannelRegistry.has(name)) {
      broadcastChannelRegistry.set(name, new Set());
    }
    broadcastChannelRegistry.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    const listeners = broadcastChannelRegistry.get(this.name);
    if (!listeners) return;
    for (const channel of listeners) {
      if (channel === this) continue;
      channel.onmessage?.({ data });
    }
  }

  close() {
    broadcastChannelRegistry.get(this.name)?.delete(this);
  }
}

const mockConnectProvider = vi.fn();
const mockDisconnectProvider = vi.fn();
const mockGetOpenaiOAuthUrl = vi.fn();
const mockGetXaiOAuthUrl = vi.fn();
const mockSubmitOpenaiOAuthCallback = vi.fn();
const mockSubmitXaiOAuthCallback = vi.fn();
const mockPollMinimaxOAuth = vi.fn();
const mockRevokeOpenaiOAuth = vi.fn();
const mockRevokeXaiOAuth = vi.fn();
const mockRevokeMinimaxOAuth = vi.fn();
const mockStartMinimaxOAuth = vi.fn();
const mockStartAnthropicOAuth = vi.fn();
const mockSubmitAnthropicOAuth = vi.fn();
const mockRevokeAnthropicOAuth = vi.fn();
const mockGetAnthropicOAuthPending = vi.fn().mockResolvedValue({ state: null });
const mockRenameProviderKey = vi.fn();
const mockCreateCustomProvider = vi.fn();
const mockUpdateCustomProvider = vi.fn();
const mockDeleteCustomProvider = vi.fn();
const mockProbeCustomProvider = vi.fn();
const mockRefreshProviderModels = vi.fn();
const mockCopilotDeviceCode = vi.fn();
const mockCopilotPollToken = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  connectProvider: (...args: unknown[]) => mockConnectProvider(...args),
  disconnectProvider: (...args: unknown[]) => mockDisconnectProvider(...args),
  refreshProviderModels: (...args: unknown[]) => mockRefreshProviderModels(...args),
  getOpenaiOAuthUrl: (...args: unknown[]) => mockGetOpenaiOAuthUrl(...args),
  getXaiOAuthUrl: (...args: unknown[]) => mockGetXaiOAuthUrl(...args),
  submitOpenaiOAuthCallback: (...args: unknown[]) => mockSubmitOpenaiOAuthCallback(...args),
  submitXaiOAuthCallback: (...args: unknown[]) => mockSubmitXaiOAuthCallback(...args),
  pollMinimaxOAuth: (...args: unknown[]) => mockPollMinimaxOAuth(...args),
  revokeOpenaiOAuth: (...args: unknown[]) => mockRevokeOpenaiOAuth(...args),
  revokeXaiOAuth: (...args: unknown[]) => mockRevokeXaiOAuth(...args),
  revokeMinimaxOAuth: (...args: unknown[]) => mockRevokeMinimaxOAuth(...args),
  startMinimaxOAuth: (...args: unknown[]) => mockStartMinimaxOAuth(...args),
  getDeviceCodeApi: (id: string) => ({
    start: (...args: unknown[]) => mockStartMinimaxOAuth(...args),
    poll: (...args: unknown[]) => mockPollMinimaxOAuth(...args),
    revoke: (...args: unknown[]) => mockRevokeMinimaxOAuth(...args),
    hasRegion: id === 'minimax',
  }),
  startAnthropicOAuth: (...args: unknown[]) => mockStartAnthropicOAuth(...args),
  submitAnthropicOAuth: (...args: unknown[]) => mockSubmitAnthropicOAuth(...args),
  revokeAnthropicOAuth: (...args: unknown[]) => mockRevokeAnthropicOAuth(...args),
  getAnthropicOAuthPending: (...args: unknown[]) => mockGetAnthropicOAuthPending(...args),
  renameProviderKey: (...args: unknown[]) => mockRenameProviderKey(...args),
  createCustomProvider: (...args: unknown[]) => mockCreateCustomProvider(...args),
  updateCustomProvider: (...args: unknown[]) => mockUpdateCustomProvider(...args),
  deleteCustomProvider: (...args: unknown[]) => mockDeleteCustomProvider(...args),
  probeCustomProvider: (...args: unknown[]) => mockProbeCustomProvider(...args),
  copilotDeviceCode: (...args: unknown[]) => mockCopilotDeviceCode(...args),
  copilotPollToken: (...args: unknown[]) => mockCopilotPollToken(...args),
  getPopupOauthApi: (providerId: string) =>
    providerId === 'xai'
      ? {
          getUrl: (...args: unknown[]) => mockGetXaiOAuthUrl(...args),
          submitCallback: (...args: unknown[]) => mockSubmitXaiOAuthCallback(...args),
          revoke: (...args: unknown[]) => mockRevokeXaiOAuth(...args),
        }
      : {
          getUrl: (...args: unknown[]) => mockGetOpenaiOAuthUrl(...args),
          submitCallback: (...args: unknown[]) => mockSubmitOpenaiOAuthCallback(...args),
          revoke: (...args: unknown[]) => mockRevokeOpenaiOAuth(...args),
        },
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: vi.fn().mockResolvedValue(false),
  checkIsOllamaAvailable: vi.fn().mockResolvedValue(false),
  checkLocalLlmHost: vi.fn().mockResolvedValue('localhost'),
}));

import ProviderSelectModal from '../../src/components/ProviderSelectModal';
import { toast } from '../../src/services/toast-store.js';
import type { RoutingProvider } from '../../src/services/api.js';

// Helpers ──────────────────────────────────────────────────────────────────

type DeepLink = { providerId: string; authType?: 'api_key' | 'subscription' | 'local' };

const connectedProvider: RoutingProvider = {
  id: 'p1',
  provider: 'openai',
  is_active: true,
  has_api_key: true,
  key_prefix: 'sk-proj-',
  connected_at: '2025-01-01',
  auth_type: 'api_key',
};

// Valid key that passes OpenAI validation (prefix "sk-", min 50 chars)
const VALID_OPENAI_KEY = 'sk-' + 'a'.repeat(50);
// Valid key shape for Alibaba/Qwen (prefix "sk-", min 30 chars)
const VALID_QWEN_KEY = 'sk-' + 'a'.repeat(30);

describe('ProviderSelectModal', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onUpdate: ReturnType<typeof vi.fn>;

  const renderModal = (
    props: {
      providers?: RoutingProvider[];
      customProviders?: unknown[];
      deepLink?: DeepLink;
      customProviderPrefill?: unknown;
    } = {},
  ) =>
    render(() => (
      <ProviderSelectModal
        providers={props.providers ?? []}
        customProviders={props.customProviders as never}
        onClose={onClose}
        onUpdate={onUpdate}
        agentName="test-agent"
        providerDeepLink={props.deepLink as never}
        customProviderPrefill={props.customProviderPrefill as never}
      />
    ));

  const openApiKey = (providerId: string, providers: RoutingProvider[] = []) =>
    renderModal({ providers, deepLink: { providerId, authType: 'api_key' } });

  const openSubscription = (providerId: string, providers: RoutingProvider[] = []) =>
    renderModal({ providers, deepLink: { providerId, authType: 'subscription' } });

  beforeEach(() => {
    vi.clearAllMocks();
    broadcastChannelRegistry.clear();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    onClose = vi.fn();
    onUpdate = vi.fn();
    mockConnectProvider.mockResolvedValue({});
    mockDisconnectProvider.mockResolvedValue({ notifications: [] });
    mockRefreshProviderModels.mockResolvedValue({ ok: true, model_count: 0 });
    mockGetOpenaiOAuthUrl.mockResolvedValue({
      url: 'https://auth.openai.com/oauth/authorize?test=1',
    });
    mockPollMinimaxOAuth.mockResolvedValue({
      status: 'pending',
      message: 'Waiting for MiniMax approval…',
      pollIntervalMs: 2000,
    });
    mockRevokeOpenaiOAuth.mockResolvedValue({ ok: true });
    mockRevokeAnthropicOAuth.mockResolvedValue({ ok: true, notifications: [] });
    mockRevokeMinimaxOAuth.mockResolvedValue({ ok: true, notifications: [] });
    mockStartMinimaxOAuth.mockResolvedValue({
      flowId: 'flow-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://www.minimax.io/verify',
      expiresAt: Date.now() + 60_000,
      pollIntervalMs: 2000,
    });
  });

  // ── Overlay / modal-card behavior (survives on ProviderSelectModal) ──────

  it('renders the modal overlay and card', () => {
    const { container } = renderModal({ deepLink: { providerId: 'openai', authType: 'api_key' } });
    expect(container.querySelector('.modal-overlay')).not.toBeNull();
    expect(container.querySelector('.modal-card')).not.toBeNull();
  });

  it('renders the detail-view title for the selected provider', () => {
    openApiKey('openai');
    expect(screen.getByText('Connect provider')).toBeDefined();
  });

  it('calls onClose when clicking overlay background', () => {
    const { container } = renderModal({ deepLink: { providerId: 'openai', authType: 'api_key' } });
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close when clicking inside the modal card', () => {
    const { container } = renderModal({ deepLink: { providerId: 'openai', authType: 'api_key' } });
    const card = container.querySelector('.modal-card')!;
    fireEvent.click(card);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape key', () => {
    const { container } = renderModal({ deepLink: { providerId: 'openai', authType: 'api_key' } });
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe('detail view', () => {
    it('shows API key input for the deep-linked provider', () => {
      openApiKey('openai');
      expect(screen.getByLabelText('OpenAI API key')).toBeDefined();
    });

    it('shows where-to-get API key link for selected provider', () => {
      openApiKey('openai');
      const link = screen.getByRole('link', { name: 'Get OpenAI API key' });
      expect(link.getAttribute('href')).toBe('https://platform.openai.com/api-keys');
      expect(link.getAttribute('target')).toBe('_blank');
    });

    it('closes the modal when the back button is clicked (deep-link has no list)', () => {
      openApiKey('openai');
      expect(screen.getByLabelText('OpenAI API key')).toBeDefined();
      fireEvent.click(screen.getByLabelText('Back to providers'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('shows disconnect icon for connected providers', () => {
      openApiKey('openai', [connectedProvider]);
      expect(screen.getByLabelText('Disconnect provider')).toBeDefined();
    });

    it("shows 'Change' button for connected non-ollama providers", () => {
      openApiKey('openai', [connectedProvider]);
      expect(screen.getByText('Change')).toBeDefined();
    });

    it("shows 'Connect' button for non-connected providers", () => {
      openApiKey('openai');
      expect(screen.getByText('Connect')).toBeDefined();
    });

    it('shows masked key prefix for connected providers', () => {
      openApiKey('openai', [connectedProvider]);
      expect(screen.getByLabelText('Current API key (masked)')).toBeDefined();
    });

    it('sends Alibaba API keys with auto region detection selected', async () => {
      openApiKey('qwen');
      fireEvent.input(screen.getByLabelText('Alibaba Cloud API key'), {
        target: { value: VALID_QWEN_KEY },
      });
      fireEvent.click(screen.getByText('Connect'));

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
          provider: 'qwen',
          apiKey: VALID_QWEN_KEY,
          authType: 'api_key',
          region: 'auto',
        });
      });
    });
  });

  describe('connecting a provider', () => {
    it('connects a provider when valid API key is entered and Connect clicked', async () => {
      openApiKey('openai');
      const input = screen.getByLabelText('OpenAI API key');
      fireEvent.input(input, { target: { value: VALID_OPENAI_KEY } });
      fireEvent.click(screen.getByText('Connect'));

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
          provider: 'openai',
          apiKey: VALID_OPENAI_KEY,
          authType: 'api_key',
        });
      });
      expect(onUpdate).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('OpenAI connected');
    });

    it('does not connect when API key is empty', () => {
      openApiKey('openai');
      const connectBtn = screen.getByText('Connect');
      expect(connectBtn.hasAttribute('disabled')).toBe(true);
    });

    it('shows validation error for invalid key prefix', async () => {
      openApiKey('openai');
      const input = screen.getByLabelText('OpenAI API key');
      fireEvent.input(input, {
        target: { value: 'invalid-key-prefix-12345678901234567890123456789012345' },
      });
      fireEvent.click(screen.getByText('Connect'));

      expect(screen.getByText('OpenAI keys start with "sk-"')).toBeDefined();
      expect(mockConnectProvider).not.toHaveBeenCalled();
    });

    it('shows validation error for key that is too short', async () => {
      openApiKey('openai');
      const input = screen.getByLabelText('OpenAI API key');
      fireEvent.input(input, { target: { value: 'sk-short' } });
      fireEvent.click(screen.getByText('Connect'));

      expect(screen.getByText('Key is too short (minimum 50 characters)')).toBeDefined();
      expect(mockConnectProvider).not.toHaveBeenCalled();
    });

    it('clears validation error on input change', async () => {
      openApiKey('openai');
      const input = screen.getByLabelText('OpenAI API key');
      fireEvent.input(input, { target: { value: 'bad' } });
      fireEvent.click(screen.getByText('Connect'));

      expect(screen.getByText('OpenAI keys start with "sk-"')).toBeDefined();

      // Typing clears the error
      fireEvent.input(input, { target: { value: 'sk-' } });
      expect(screen.queryByText('OpenAI keys start with "sk-"')).toBeNull();
    });

    it('connects on Enter key in API key input', async () => {
      openApiKey('openai');
      const input = screen.getByLabelText('OpenAI API key');
      fireEvent.input(input, { target: { value: VALID_OPENAI_KEY } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalled();
      });
    });
  });

  describe('disconnecting a provider', () => {
    it('calls disconnectProvider and triggers onUpdate', async () => {
      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByLabelText('Disconnect provider'));

      await waitFor(() => {
        expect(mockDisconnectProvider).toHaveBeenCalledWith(
          'test-agent',
          'openai',
          'api_key',
          undefined,
        );
      });
      expect(onUpdate).toHaveBeenCalled();
    });

    it('shows error toasts for disconnect notifications', async () => {
      mockDisconnectProvider.mockResolvedValue({
        notifications: ['Model X no longer available. Simple is back to automatic mode.'],
      });

      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByLabelText('Disconnect provider'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Model X no longer available. Simple is back to automatic mode.',
        );
      });
    });

    it('handles disconnect error gracefully', async () => {
      mockDisconnectProvider.mockRejectedValue(new Error('Network error'));

      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByLabelText('Disconnect provider'));

      // Should not throw, busy state should reset
      await waitFor(() => {
        expect(mockDisconnectProvider).toHaveBeenCalled();
      });
    });
  });

  describe('connect error handling', () => {
    it('handles connect error gracefully', async () => {
      mockConnectProvider.mockRejectedValue(new Error('Failed'));

      openApiKey('openai');
      const input = screen.getByLabelText('OpenAI API key');
      fireEvent.input(input, { target: { value: VALID_OPENAI_KEY } });
      fireEvent.click(screen.getByText('Connect'));

      // Should not throw
      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalled();
      });
    });
  });

  describe('updating a key', () => {
    it('switches to edit mode when Change is clicked', () => {
      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByText('Change'));

      // Edit mode shows a masked input and Save button
      expect(screen.getByLabelText('New OpenAI API key')).toBeDefined();
      expect(screen.getByText('Save')).toBeDefined();
    });

    it('saves updated key', async () => {
      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByText('Change'));

      const input = screen.getByLabelText('New OpenAI API key');
      fireEvent.input(input, { target: { value: VALID_OPENAI_KEY } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalledWith('test-agent', {
          provider: 'openai',
          apiKey: VALID_OPENAI_KEY,
          authType: 'api_key',
        });
      });
      expect(toast.success).toHaveBeenCalledWith('OpenAI key updated');
    });

    it('shows validation error for invalid key in edit mode', () => {
      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByText('Change'));

      const input = screen.getByLabelText('New OpenAI API key');
      fireEvent.input(input, { target: { value: 'bad-key' } });
      fireEvent.click(screen.getByText('Save'));

      expect(screen.getByText('OpenAI keys start with "sk-"')).toBeDefined();
      expect(mockConnectProvider).not.toHaveBeenCalled();
    });

    it('handles update key error gracefully', async () => {
      mockConnectProvider.mockRejectedValue(new Error('Server error'));
      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByText('Change'));

      const input = screen.getByLabelText('New OpenAI API key');
      fireEvent.input(input, { target: { value: VALID_OPENAI_KEY } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalled();
      });
    });

    it('triggers handleUpdateKey on Enter key in edit input', async () => {
      openApiKey('openai', [connectedProvider]);
      fireEvent.click(screen.getByText('Change'));

      const input = screen.getByLabelText('New OpenAI API key');
      fireEvent.input(input, { target: { value: VALID_OPENAI_KEY } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(mockConnectProvider).toHaveBeenCalled();
      });
    });
  });

  describe('custom provider create/delete wiring', () => {
    // The custom-provider list and "Add custom provider" affordance moved to
    // ProviderApiKeyTab; the custom form itself is covered by
    // CustomProviderForm.test.tsx. What remains unique to ProviderSelectModal
    // is the create/delete → completeToList() → onUpdate wiring, reached via a
    // prefill (create) or a `custom:<id>` deep link (edit/delete).

    it('calls onUpdate when the custom provider form creates a provider', async () => {
      mockProbeCustomProvider.mockResolvedValue({ models: [{ model_name: 'test-model' }] });
      mockCreateCustomProvider.mockResolvedValue({
        id: 'cp-new',
        name: 'NewProvider',
        base_url: 'http://localhost:8080',
        has_api_key: false,
        models: [{ model_name: 'test-model' }],
        created_at: '2025-01-01',
      });

      renderModal({ customProviderPrefill: {} });

      // The custom form opens directly from the prefill.
      const nameInput = await screen.findByPlaceholderText('e.g. Groq, Together, Azure');
      fireEvent.input(nameInput, { target: { value: 'NewProvider' } });

      const urlInput = screen.getByPlaceholderText('https://api.example.com/v1');
      fireEvent.input(urlInput, { target: { value: 'http://localhost:8080' } });

      const modelInput = screen.getByPlaceholderText('Model name');
      fireEvent.input(modelInput, { target: { value: 'test-model' } });

      // Click Connect (the create-mode button label)
      fireEvent.click(screen.getByText('Connect'));

      await waitFor(() => {
        expect(mockCreateCustomProvider).toHaveBeenCalled();
      });
      expect(onUpdate).toHaveBeenCalled();
    });

    it('calls onUpdate when the custom provider form deletes a provider', async () => {
      mockDeleteCustomProvider.mockResolvedValue({ ok: true });

      const customProviders = [
        {
          id: 'cp-1',
          name: 'TestProv',
          base_url: 'http://localhost:8080',
          has_api_key: false,
          models: [{ model_name: 'm1' }],
          created_at: '2025-01-01',
        },
      ];

      renderModal({
        customProviders,
        deepLink: { providerId: 'custom:cp-1', authType: 'api_key' },
      });

      // The custom editor opens directly from the `custom:` deep link.
      await screen.findByDisplayValue('TestProv');

      // Click Delete provider button to open confirmation dialog
      fireEvent.click(screen.getByText('Delete provider'));

      // Confirm deletion in the confirmation dialog
      await waitFor(() => {
        expect(screen.getByText('Delete')).toBeDefined();
      });
      fireEvent.click(screen.getByText('Delete'));

      await waitFor(() => {
        expect(mockDeleteCustomProvider).toHaveBeenCalledWith('test-agent', 'cp-1');
      });
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  it('shows default masked key when provider has no key_prefix', () => {
    const noPrefix: RoutingProvider = {
      id: 'p4',
      provider: 'openai',
      is_active: true,
      has_api_key: true,
      connected_at: '2025-01-01',
      auth_type: 'api_key',
    };
    openApiKey('openai', [noPrefix]);
    const maskedInput = screen.getByLabelText('Current API key (masked)') as HTMLInputElement;
    expect(maskedInput.value).toContain('••••••••••••');
  });

  describe('subscription detail views', () => {
    it('shows subscription toggle as on for subscription-connected providers with token', () => {
      const subProvider: RoutingProvider = {
        id: 'p-sub',
        provider: 'anthropic',
        is_active: true,
        has_api_key: true,
        key_prefix: 'skst-tok',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      // Anthropic subscription is connected → its detail view shows the
      // "Connected via …" state rather than the sign-in flow.
      openSubscription('anthropic', [subProvider]);
      expect(screen.getByText(/Connected via Claude Max \/ Pro subscription/)).toBeDefined();
    });

    it('opens detail view for Anthropic and shows the OAuth sign-in button', () => {
      openSubscription('anthropic');
      // The detail view for Anthropic uses the paste-code OAuth flow.
      expect(screen.getByText('Sign in with Claude')).toBeDefined();
    });

    it('does not show credits button for non-Anthropic providers', () => {
      openSubscription('openai');
      expect(screen.queryByText('Claim your credits on Claude')).toBeNull();
    });

    it('shows the OAuth sign-in button in Anthropic subscription detail view', () => {
      openSubscription('anthropic');
      expect(screen.getByText('Sign in with Claude')).toBeDefined();
    });

    it('starts the Anthropic OAuth flow and renders the paste-code step', async () => {
      mockStartAnthropicOAuth.mockResolvedValue({
        url: 'https://claude.ai/oauth/authorize?state=abc',
        state: 'abc',
      });
      const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue({
        closed: false,
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
      } as unknown as Window);

      openSubscription('anthropic');
      fireEvent.click(screen.getByText('Sign in with Claude'));

      await waitFor(() => {
        expect(mockStartAnthropicOAuth).toHaveBeenCalledWith('test-agent');
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Anthropic authorization code')).toBeDefined();
      });
      windowOpenSpy.mockRestore();
    });

    it('exchanges a pasted authorization code for an OAuth token', async () => {
      mockStartAnthropicOAuth.mockResolvedValue({
        url: 'https://claude.ai/oauth/authorize?state=xyz',
        state: 'xyz',
      });
      mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });
      const windowOpenSpy = vi.spyOn(window, 'open').mockReturnValue({
        closed: false,
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
      } as unknown as Window);

      openSubscription('anthropic');
      fireEvent.click(screen.getByText('Sign in with Claude'));
      const codeInput = await screen.findByLabelText('Anthropic authorization code');
      fireEvent.input(codeInput, { target: { value: 'auth-code-123#xyz' } });
      fireEvent.click(screen.getByText('Connect'));

      await waitFor(() => {
        expect(mockSubmitAnthropicOAuth).toHaveBeenCalledWith(
          'test-agent',
          'auth-code-123#xyz',
          'xyz',
        );
      });
      expect(toast.success).toHaveBeenCalledWith('Anthropic subscription connected');
      windowOpenSpy.mockRestore();
    });

    it('disconnects an Anthropic OAuth subscription from the detail view', async () => {
      const subProvider: RoutingProvider = {
        id: 'p-sub',
        provider: 'anthropic',
        is_active: true,
        has_api_key: true,
        key_prefix: 'oauth',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      mockRevokeAnthropicOAuth.mockResolvedValue({ ok: true, notifications: [] });

      openSubscription('anthropic', [subProvider]);
      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockRevokeAnthropicOAuth).toHaveBeenCalledWith('test-agent');
      });
      expect(mockDisconnectProvider).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
    });

    it('shows toggle off when an Anthropic subscription record is inactive', () => {
      // An inactive (revoked / disconnected) subscription row should present
      // the sign-in flow again, not the connected state.
      const subProvider: RoutingProvider = {
        id: 'p-sub-inactive',
        provider: 'anthropic',
        is_active: false,
        has_api_key: false,
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('anthropic', [subProvider]);
      expect(screen.getByText('Sign in with Claude')).toBeDefined();
      expect(screen.queryByText('Disconnect')).toBeNull();
    });

    it('opens the Anthropic subscription detail view header', () => {
      openSubscription('anthropic');
      expect(screen.getByText('Connect provider')).toBeDefined();
    });

    it('hides the "Get API key" link in Anthropic subscription mode', () => {
      // Anthropic subscription uses an OAuth flow, not an API key from the
      // dashboard, so the console.anthropic.com/settings/keys URL would be
      // misleading and is intentionally suppressed.
      const { container } = openSubscription('anthropic');
      const link = container.querySelector<HTMLAnchorElement>(
        'a[href="https://console.anthropic.com/settings/keys"]',
      );
      expect(link).toBeNull();
    });

    it('opens detail view for OAuth subscription provider (OpenAI)', () => {
      openSubscription('openai');
      expect(screen.getByText('Connect provider')).toBeDefined();
    });

    it("shows 'Log in with OpenAI' button for OAuth provider", () => {
      openSubscription('openai');
      expect(screen.getByText('Log in with OpenAI')).toBeDefined();
    });

    it('shows OAuth login hint text', () => {
      openSubscription('openai');
      expect(screen.getByText(/Log in with your OpenAI account/)).toBeDefined();
    });

    it('calls getOpenaiOAuthUrl and opens popup on login click', async () => {
      const mockPopup = { closed: false, close: vi.fn() };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      await waitFor(() => {
        expect(mockGetOpenaiOAuthUrl).toHaveBeenCalledWith('test-agent');
      });
      expect(window.open).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/authorize?test=1',
        'manifest-oauth',
        'width=500,height=700',
      );

      vi.restoreAllMocks();
    });

    it('shows Disconnect button for connected OAuth provider', () => {
      const subProvider: RoutingProvider = {
        id: 'p-openai-sub',
        provider: 'openai',
        is_active: true,
        has_api_key: true,
        key_prefix: '{"t":"eyJ',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('openai', [subProvider]);
      expect(screen.getByText('Disconnect')).toBeDefined();
      expect(screen.getByText(/Connected via ChatGPT Plus\/Pro\/Team/)).toBeDefined();
    });

    it('opens MiniMax device-code detail view', () => {
      openSubscription('minimax');
      expect(screen.getByText('Connect provider')).toBeDefined();
      expect(screen.getByText('Connect with MiniMax')).toBeDefined();
      expect(screen.getByLabelText('Region')).toBeDefined();
    });

    it('opens the popup synchronously then redirects it to the verification URL', async () => {
      const popup = { close: vi.fn(), opener: {}, location: { replace: vi.fn() } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      // Synchronous open with about:blank — preserves user-gesture flag.
      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
      expect(popup.opener).toBeNull();

      await waitFor(() => {
        expect(mockStartMinimaxOAuth).toHaveBeenCalledWith('test-agent', { region: 'global' });
      });
      await waitFor(() => {
        expect(popup.location.replace).toHaveBeenCalledWith('https://www.minimax.io/verify');
      });
      expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();

      vi.restoreAllMocks();
    });

    it('toasts when the popup is blocked and skips the start call', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Popup was blocked by your browser. Allow popups for this site, then try again.',
        );
      });
      expect(mockStartMinimaxOAuth).not.toHaveBeenCalled();
      expect(screen.getByText('Connect with MiniMax')).toBeDefined();

      vi.restoreAllMocks();
    });

    it('starts MiniMax device-code flow with the selected region', async () => {
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);

      openSubscription('minimax');
      fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'cn' } });
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(mockStartMinimaxOAuth).toHaveBeenCalledWith('test-agent', { region: 'cn' });
      });

      vi.restoreAllMocks();
    });

    it('shows MiniMax pending status while waiting for approval', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);
      mockPollMinimaxOAuth.mockResolvedValueOnce({
        status: 'pending',
        message: 'Waiting for MiniMax approval…',
        pollIntervalMs: 2500,
      });

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();
      });

      await vi.advanceTimersByTimeAsync(2000);

      await waitFor(() => {
        expect(mockPollMinimaxOAuth).toHaveBeenCalledWith('flow-1');
        expect(screen.getByText('Waiting for MiniMax approval…')).toBeDefined();
      });

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('stays open when MiniMax approval succeeds', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);
      mockPollMinimaxOAuth.mockResolvedValueOnce({ status: 'success' });

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();
      });

      await vi.advanceTimersByTimeAsync(2000);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('MiniMax subscription connected');
        expect(onUpdate).toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
      });

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('toasts MiniMax poll errors and resets to the connect view', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);
      mockPollMinimaxOAuth.mockResolvedValueOnce({
        status: 'error',
        message: 'MiniMax rejected the login',
      });

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();
      });

      await vi.advanceTimersByTimeAsync(2000);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('MiniMax rejected the login');
      });
      expect(screen.getByText('Connect with MiniMax')).toBeDefined();
      expect(onClose).not.toHaveBeenCalled();

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('toasts a retry message when MiniMax polling throws and resets to the connect view', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);
      mockPollMinimaxOAuth.mockRejectedValueOnce(new Error('network error'));

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();
      });

      await vi.advanceTimersByTimeAsync(2000);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Failed to check approval status. Start again to retry.',
        );
      });
      expect(screen.getByText('Connect with MiniMax')).toBeDefined();

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('toasts on expired MiniMax codes and resets to the connect view', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);
      mockStartMinimaxOAuth.mockResolvedValueOnce({
        flowId: 'expired-flow',
        userCode: 'EXPIRED-1234',
        verificationUri: 'https://www.minimax.io/verify',
        expiresAt: Date.now() - 1,
        pollIntervalMs: 1,
      });

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();
      });

      await vi.advanceTimersByTimeAsync(1);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'This verification code expired. Start again to generate a new one.',
        );
      });
      expect(screen.getByText('Connect with MiniMax')).toBeDefined();
      expect(mockPollMinimaxOAuth).not.toHaveBeenCalled();

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('keeps MiniMax in setup mode when starting the device-code flow fails', async () => {
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);
      mockStartMinimaxOAuth.mockRejectedValueOnce(new Error('MiniMax unavailable'));

      openSubscription('minimax');
      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(mockStartMinimaxOAuth).toHaveBeenCalledWith('test-agent', { region: 'global' });
      });
      expect(screen.queryByText(/A new tab opened with the MiniMax/)).toBeNull();
      expect(screen.getByText('Connect with MiniMax')).toBeDefined();
    });

    it('shows Disconnect button for connected MiniMax subscription', () => {
      const subProvider: RoutingProvider = {
        id: 'p-minimax-sub',
        provider: 'minimax',
        is_active: true,
        has_api_key: true,
        key_prefix: '{"t":"mm',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('minimax', [subProvider]);
      expect(screen.getByText('Disconnect')).toBeDefined();
      expect(screen.getByText(/Connected via MiniMax Coding Plan/)).toBeDefined();
    });

    it('disconnects MiniMax through its provider-specific cleanup endpoint', async () => {
      const subProvider: RoutingProvider = {
        id: 'p-minimax-sub',
        provider: 'minimax',
        is_active: true,
        has_api_key: true,
        key_prefix: '{"t":"mm',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('minimax', [subProvider]);

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockRevokeMinimaxOAuth).toHaveBeenCalledWith('test-agent');
      });
      expect(mockDisconnectProvider).not.toHaveBeenCalled();
      expect(mockRevokeOpenaiOAuth).not.toHaveBeenCalled();
    });

    it('shows MiniMax disconnect notifications as error toasts', async () => {
      mockRevokeMinimaxOAuth.mockResolvedValueOnce({
        ok: true,
        notifications: ['MiniMax tiers were recalculated.'],
      });
      const subProvider: RoutingProvider = {
        id: 'p-minimax-sub',
        provider: 'minimax',
        is_active: true,
        has_api_key: true,
        key_prefix: '{"t":"mm',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('minimax', [subProvider]);

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('MiniMax tiers were recalculated.');
      });
      expect(mockRevokeOpenaiOAuth).not.toHaveBeenCalled();
    });

    it('closes the popup if the modal unmounts before startMinimaxOAuth resolves', async () => {
      const popup = {
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      };
      vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      let resolveStart:
        | ((value: {
            flowId: string;
            userCode: string;
            verificationUri: string;
            expiresAt: number;
            pollIntervalMs: number;
          }) => void)
        | undefined;
      mockStartMinimaxOAuth.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStart = resolve;
          }),
      );

      const view = openSubscription('minimax');

      fireEvent.click(screen.getByText('Connect with MiniMax'));

      view.unmount();

      resolveStart?.({
        flowId: 'late-flow',
        userCode: 'L8-T8',
        verificationUri: 'https://www.minimax.io/verify',
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 2000,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(popup.close).toHaveBeenCalled();
      expect(popup.location.replace).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('stops MiniMax polling after the modal unmounts', async () => {
      vi.useFakeTimers();
      vi.spyOn(window, 'open').mockReturnValue({
        close: vi.fn(),
        opener: {},
        location: { replace: vi.fn() },
        closed: false,
      } as unknown as Window);

      let resolveFirstPoll:
        | ((value: { status: string; message?: string; pollIntervalMs?: number }) => void)
        | undefined;
      mockPollMinimaxOAuth.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstPoll = resolve;
          }),
      );

      const view = openSubscription('minimax');

      fireEvent.click(screen.getByText('Connect with MiniMax'));

      await waitFor(() => {
        expect(screen.getByText(/A new tab opened with the MiniMax/)).toBeDefined();
      });

      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => {
        expect(mockPollMinimaxOAuth).toHaveBeenCalledTimes(1);
      });

      view.unmount();
      resolveFirstPoll?.({ status: 'pending', pollIntervalMs: 2000 });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4000);

      expect(mockPollMinimaxOAuth).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('does not show paste field for OAuth provider', () => {
      openSubscription('openai');
      // Should not have a setup token input field
      const inputs = document.querySelectorAll('.provider-detail__input--masked');
      expect(inputs.length).toBe(0);
    });

    it('handles OAuth login error gracefully', async () => {
      mockGetOpenaiOAuthUrl.mockRejectedValue(new Error('Network error'));

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      await waitFor(() => {
        expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled();
      });
    });

    it('disconnects OpenAI OAuth subscription through the revoke endpoint', async () => {
      const subProvider: RoutingProvider = {
        id: 'p-openai-sub',
        provider: 'openai',
        is_active: true,
        has_api_key: true,
        key_prefix: '{"t":"eyJ',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('openai', [subProvider]);
      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockRevokeOpenaiOAuth).toHaveBeenCalledWith('test-agent');
      });
      expect(mockDisconnectProvider).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
    });

    it('does not call generic disconnect when OpenAI revoke request fails', async () => {
      mockRevokeOpenaiOAuth.mockRejectedValue(new Error('revoke failed'));
      const subProvider: RoutingProvider = {
        id: 'p-openai-sub',
        provider: 'openai',
        is_active: true,
        has_api_key: true,
        key_prefix: '{"t":"eyJ',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('openai', [subProvider]);
      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockRevokeOpenaiOAuth).toHaveBeenCalledWith('test-agent');
      });
      expect(mockDisconnectProvider).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('shows popup blocked error when window.open returns null', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          'Popup was blocked by your browser. Allow popups for this site, then try again.',
        );
      });

      vi.restoreAllMocks();
    });

    it('detects successful OAuth callback via polling', async () => {
      // Set the done URL immediately so the first poll tick picks it up
      const mockPopup = {
        closed: false,
        close: vi.fn(),
        location: { href: 'http://localhost:3000/oauth/openai/done?ok=1' },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('OpenAI subscription connected');
      });
      expect(mockPopup.close).toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('shows paste URL input immediately after clicking login', async () => {
      const mockPopup = {
        closed: false,
        close: vi.fn(),
        get location(): { href: string } {
          throw new DOMException('cross-origin');
        },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      // Paste URL field appears immediately (not after popup closes)
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
        ).toBeDefined();
      });
      expect(onUpdate).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('stops polling when popup is closed by user', async () => {
      const mockPopup = {
        closed: true,
        close: vi.fn(),
        get location(): { href: string } {
          throw new DOMException('cross-origin');
        },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      // Wait long enough for the polling to detect the closed popup
      await new Promise((r) => setTimeout(r, 500));

      // No success or error toast, just stopped polling
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('detects successful OAuth via BroadcastChannel', async () => {
      const mockPopup = {
        closed: false,
        close: vi.fn(),
        get location(): { href: string } {
          throw new DOMException('cross-origin');
        },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      // Simulate the done page sending via BroadcastChannel
      await new Promise((r) => setTimeout(r, 50));
      const bc = new BroadcastChannel('manifest-oauth');
      bc.postMessage({ type: 'manifest-oauth-success' });
      bc.close();

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('OpenAI subscription connected');
      });
      expect(onUpdate).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('BroadcastChannel still works after COOP makes popup appear closed', async () => {
      // COOP headers from auth.openai.com sever window.opener,
      // making popup.closed return true immediately in the opener.
      const mockPopup = {
        closed: true,
        close: vi.fn(),
        get location(): { href: string } {
          throw new DOMException('cross-origin');
        },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      // Poll detects popup.closed=true, but BroadcastChannel stays alive
      await new Promise((r) => setTimeout(r, 500));

      // OAuth flow completes and done page sends BroadcastChannel message
      const bc = new BroadcastChannel('manifest-oauth');
      bc.postMessage({ type: 'manifest-oauth-success' });
      bc.close();

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('OpenAI subscription connected');
      });
      expect(onUpdate).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('detects successful OAuth via postMessage', async () => {
      const mockPopup = {
        closed: false,
        close: vi.fn(),
        get location(): { href: string } {
          throw new DOMException('cross-origin');
        },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      // Simulate the done page sending a postMessage
      await new Promise((r) => setTimeout(r, 50));
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'manifest-oauth-success' } }),
      );

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('OpenAI subscription connected');
      });
      expect(mockPopup.close).toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('keeps paste URL visible after failed OAuth via postMessage', async () => {
      const mockPopup = {
        closed: false,
        close: vi.fn(),
        get location(): { href: string } {
          throw new DOMException('cross-origin');
        },
      };
      vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window);

      openSubscription('openai');
      fireEvent.click(screen.getByText('Log in with OpenAI'));

      // Paste URL field is already visible before any message
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
        ).toBeDefined();
      });

      // Error message arrives — paste field still visible, no crash
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'manifest-oauth-error' } }));
      await new Promise((r) => setTimeout(r, 50));
      expect(
        screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
      ).toBeDefined();
      expect(onUpdate).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('opens device login view for copilot instead of connecting directly', async () => {
      openSubscription('copilot');

      // Should render the GitHub device-login view (its own sign-in CTA),
      // not eagerly call connectProvider.
      await waitFor(() => {
        expect(screen.getByText('Sign in with GitHub')).toBeDefined();
      });
      expect(mockConnectProvider).not.toHaveBeenCalled();
    });

    it('opens device login detail view for connected copilot (disconnect via detail)', async () => {
      const copilotSubProvider: RoutingProvider = {
        id: 'p-copilot',
        provider: 'copilot',
        is_active: true,
        has_api_key: true,
        key_prefix: 'ghu_',
        connected_at: '2025-01-01',
        auth_type: 'subscription',
      };
      openSubscription('copilot', [copilotSubProvider]);

      // Should open device login detail view (with connected state copy)
      await waitFor(() => {
        expect(screen.getByText('Connected via GitHub device login.')).toBeDefined();
      });
    });
  });
});
