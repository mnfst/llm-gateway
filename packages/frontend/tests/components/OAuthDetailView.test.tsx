import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const mockGetOpenaiOAuthUrl = vi.fn();
const mockSubmitOpenaiOAuthCallback = vi.fn();
const mockRevokeOpenaiOAuth = vi.fn();
const mockGetXaiOAuthUrl = vi.fn();
const mockSubmitXaiOAuthCallback = vi.fn();
const mockRevokeXaiOAuth = vi.fn();
const mockDisconnectProvider = vi.fn();
const mockRenameProviderKey = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
const mockDisposeMonitor = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  getOpenaiOAuthUrl: (...args: unknown[]) => mockGetOpenaiOAuthUrl(...args),
  submitOpenaiOAuthCallback: (...args: unknown[]) => mockSubmitOpenaiOAuthCallback(...args),
  revokeOpenaiOAuth: (...args: unknown[]) => mockRevokeOpenaiOAuth(...args),
  getXaiOAuthUrl: (...args: unknown[]) => mockGetXaiOAuthUrl(...args),
  submitXaiOAuthCallback: (...args: unknown[]) => mockSubmitXaiOAuthCallback(...args),
  revokeXaiOAuth: (...args: unknown[]) => mockRevokeXaiOAuth(...args),
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
  disconnectProvider: (...args: unknown[]) => mockDisconnectProvider(...args),
  renameProviderKey: (...args: unknown[]) => mockRenameProviderKey(...args),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock('../../src/services/oauth-popup.js', () => ({
  monitorOAuthPopup: vi.fn(() => mockDisposeMonitor),
}));

import OAuthDetailView from '../../src/components/OAuthDetailView';
import type { ProviderDef } from '../../src/services/providers.js';
import type { RoutingProvider } from '../../src/services/api.js';
import { monitorOAuthPopup } from '../../src/services/oauth-popup.js';

const provDef: ProviderDef = {
  id: 'openai',
  name: 'OpenAI',
  color: '#10a37f',
  initial: 'O',
  subtitle: '',
  models: [],
  keyPrefix: 'sk-',
  minKeyLength: 20,
  keyPlaceholder: '',
  supportsSubscription: true,
  subscriptionLabel: 'ChatGPT Plus subscription',
  subscriptionAuthMode: 'oauth',
};

const xaiProvDef: ProviderDef = {
  ...provDef,
  id: 'xai',
  name: 'xAI',
  initial: 'X',
  subscriptionLabel: 'Grok subscription',
};

const geminiProvDef: ProviderDef = {
  ...provDef,
  id: 'gemini',
  name: 'Gemini',
  initial: 'G',
  subscriptionLabel: 'Sign in with Google',
};

function makeKey(overrides: Partial<RoutingProvider> = {}): RoutingProvider {
  return {
    id: 'key-1',
    provider: 'openai',
    auth_type: 'subscription',
    is_active: true,
    has_api_key: true,
    key_prefix: null,
    label: 'Account 1',
    priority: 1,
    region: null,
    connected_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderView(
  opts: {
    connected?: boolean;
    activeKeys?: RoutingProvider[];
    addKeyOpen?: boolean;
    provId?: string;
    provDef?: ProviderDef;
  } = {},
) {
  const [busy, setBusy] = createSignal(false);
  const [addKeyOpen, setAddKeyOpen] = createSignal(opts.addKeyOpen ?? false);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const keys = opts.activeKeys ?? [];
  const providerId = opts.provId ?? 'openai';
  const result = render(() => (
    <OAuthDetailView
      provDef={opts.provDef ?? provDef}
      provId={providerId}
      agentName="test-agent"
      connected={() => opts.connected ?? false}
      selectedAuthType={() => 'subscription'}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
      onClose={onClose}
      addKeyOpen={addKeyOpen}
      setAddKeyOpen={setAddKeyOpen}
      activeKeys={() => keys}
    />
  ));
  return { ...result, onBack, onUpdate, onClose, setAddKeyOpen };
}

function renderReactiveView(opts: { connected?: boolean; activeKeys?: RoutingProvider[] } = {}) {
  const [busy, setBusy] = createSignal(false);
  const [connected, setConnected] = createSignal(opts.connected ?? false);
  const [activeKeys, setActiveKeys] = createSignal(opts.activeKeys ?? []);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const result = render(() => (
    <OAuthDetailView
      provDef={provDef}
      provId="openai"
      agentName="test-agent"
      connected={connected}
      selectedAuthType={() => 'subscription'}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
      onClose={onClose}
      activeKeys={activeKeys}
    />
  ));
  return { ...result, onBack, onUpdate, onClose, setConnected, setActiveKeys };
}

describe('OAuthDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows "Log in with" button when not connected', () => {
    renderView();
    expect(screen.getByText('Log in with OpenAI')).toBeDefined();
  });

  it('shows "Connected via" text and Disconnect button for single-key connected state', () => {
    renderView({ connected: true, activeKeys: [makeKey()] });
    expect(screen.getByText(/Connected via ChatGPT Plus subscription/)).toBeDefined();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });

  it('shows "Accounts" label and lists both keys in multi-key mode', () => {
    const keys = [
      makeKey({ id: 'k1', label: 'Work account' }),
      makeKey({ id: 'k2', label: 'Personal account' }),
    ];
    renderView({ connected: true, activeKeys: keys });
    expect(screen.getByText('Accounts')).toBeDefined();
    expect(screen.getByText('Work account')).toBeDefined();
    expect(screen.getByText('Personal account')).toBeDefined();
  });

  it('shows "Disconnect all" button in multi-key mode', () => {
    const keys = [makeKey({ id: 'k1', label: 'A' }), makeKey({ id: 'k2', label: 'B' })];
    renderView({ connected: true, activeKeys: keys });
    expect(screen.getByText('Disconnect all')).toBeDefined();
  });

  it('clicking Rename shows input and saving calls renameProviderKey', async () => {
    mockRenameProviderKey.mockResolvedValue({ id: 'k1', label: 'New name', priority: 1 });
    const keys = [makeKey({ id: 'k1', label: 'Old name' }), makeKey({ id: 'k2', label: 'Other' })];
    const { onUpdate } = renderView({ connected: true, activeKeys: keys });

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    const input = screen.getByLabelText('Rename Old name');
    fireEvent.input(input, { target: { value: 'New name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalledWith(
        'test-agent',
        'openai',
        'Old name',
        'New name',
        'subscription',
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Renamed to "New name"');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('clicking delete on a key revokes the matching labeled OAuth token', async () => {
    mockRevokeOpenaiOAuth.mockResolvedValue({ notifications: [] });
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    const { onUpdate } = renderView({ connected: true, activeKeys: keys });

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockRevokeOpenaiOAuth).toHaveBeenCalledWith('test-agent', 'Primary');
    });
    expect(mockDisconnectProvider).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('addKeyOpen effect triggers getOpenaiOAuthUrl when connected', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ connected: true, activeKeys: [makeKey()], addKeyOpen: true });

    await waitFor(() => {
      expect(mockGetOpenaiOAuthUrl).toHaveBeenCalledWith('test-agent');
    });
    expect(screen.getByPlaceholderText(/localhost:1455/)).toBeDefined();
  });

  it('cancels a connected add-account OAuth flow', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ connected: true, activeKeys: [makeKey()], addKeyOpen: true });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/localhost:1455/)).toBeDefined();
    });

    fireEvent.input(screen.getByPlaceholderText(/localhost:1455/), {
      target: { value: 'http://localhost:1455/auth/callback?code=abc&state=xyz' },
    });
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByPlaceholderText(/localhost:1455/)).toBeNull();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });

  it('shows paste URL input when adding another OAuth account while already connected', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ connected: true, activeKeys: [makeKey()], addKeyOpen: true });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
      ).toBeDefined();
    });
  });

  it('starts xAI OAuth with the xAI callback path and manual-code placeholder', async () => {
    mockGetXaiOAuthUrl.mockResolvedValue({ url: 'https://auth.x.ai/oauth2/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ provId: 'xai', provDef: xaiProvDef });
    fireEvent.click(screen.getByText('Log in with xAI'));

    await waitFor(() => {
      expect(mockGetXaiOAuthUrl).toHaveBeenCalledWith('test-agent');
    });
    expect(
      screen.getByPlaceholderText('Paste the xAI authorization code or callback URL'),
    ).toBeDefined();
    expect(monitorOAuthPopup).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/oauth/xai/done',
    );
  });

  it('submits an xAI pasted callback URL through the xAI OAuth API', async () => {
    mockGetXaiOAuthUrl.mockResolvedValue({ url: 'https://auth.x.ai/oauth2/authorize' });
    mockSubmitXaiOAuthCallback.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { onUpdate } = renderView({ provId: 'xai', provDef: xaiProvDef });
    fireEvent.click(screen.getByText('Log in with xAI'));
    const input = await waitFor(() =>
      screen.getByPlaceholderText('Paste the xAI authorization code or callback URL'),
    );
    fireEvent.input(input, {
      target: { value: 'http://127.0.0.1:56121/callback?code=xai-code&state=xai-state' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitXaiOAuthCallback).toHaveBeenCalledWith('xai-code', 'xai-state');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('xAI subscription connected');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('submits an xAI raw authorization code with the pending OAuth state', async () => {
    mockGetXaiOAuthUrl.mockResolvedValue({
      url: 'https://auth.x.ai/oauth2/authorize?state=pending-xai-state',
    });
    mockSubmitXaiOAuthCallback.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ provId: 'xai', provDef: xaiProvDef });
    fireEvent.click(screen.getByText('Log in with xAI'));
    const input = await waitFor(() =>
      screen.getByPlaceholderText('Paste the xAI authorization code or callback URL'),
    );
    fireEvent.input(input, {
      target: { value: 'raw-xai-code-from-consent-page' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitXaiOAuthCallback).toHaveBeenCalledWith(
        'raw-xai-code-from-consent-page',
        'pending-xai-state',
      );
    });
  });

  it('submits an xAI consent URL and displayed code pasted together', async () => {
    mockGetXaiOAuthUrl.mockResolvedValue({ url: 'https://auth.x.ai/oauth2/authorize' });
    mockSubmitXaiOAuthCallback.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ provId: 'xai', provDef: xaiProvDef });
    fireEvent.click(screen.getByText('Log in with xAI'));
    const input = await waitFor(() =>
      screen.getByPlaceholderText('Paste the xAI authorization code or callback URL'),
    );
    fireEvent.input(input, {
      target: {
        value:
          'https://accounts.x.ai/oauth2/consent?response_type=code&state=consent-state manual-xai-code-from-page',
      },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitXaiOAuthCallback).toHaveBeenCalledWith(
        'manual-xai-code-from-page',
        'consent-state',
      );
    });
  });

  it('asks xAI users for the displayed code when only the consent URL is pasted', async () => {
    mockGetXaiOAuthUrl.mockResolvedValue({
      url: 'https://auth.x.ai/oauth2/authorize?state=pending-xai-state',
    });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView({ provId: 'xai', provDef: xaiProvDef });
    fireEvent.click(screen.getByText('Log in with xAI'));
    const input = await waitFor(() =>
      screen.getByPlaceholderText('Paste the xAI authorization code or callback URL'),
    );
    fireEvent.input(input, {
      target: { value: 'https://accounts.x.ai/oauth2/consent?state=pending-xai-state' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(screen.getByText(/Paste the authorization code shown by xAI/)).toBeDefined();
    });
    expect(mockSubmitXaiOAuthCallback).not.toHaveBeenCalled();
  });

  it('shows popup-blocked toast when window.open returns null', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue(null);

    renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        'Popup was blocked by your browser. Allow popups for this site, then try again.',
      );
    });
  });

  it('shows the callback-URL video tutorial for OpenAI after starting OAuth', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { container } = renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));

    await waitFor(() => {
      expect(screen.getByText(/Copy the full URL/)).toBeDefined();
    });
    expect(
      container.querySelector('video[src="/images/oauth-callback-example.mp4"]'),
    ).not.toBeNull();
  });

  it('sets preload="auto" on the OAuth tutorial video so it plays immediately', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { container } = renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));

    await waitFor(() => {
      expect(screen.getByText(/Copy the full URL/)).toBeDefined();
    });
    const video = container.querySelector('video[src="/images/oauth-callback-example.mp4"]');
    expect(video).not.toBeNull();
    expect(video!.getAttribute('preload')).toBe('auto');
  });

  it('does not show the callback-URL video tutorial for non-OpenAI providers (e.g. Gemini)', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.google.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { container } = renderView({ provId: 'gemini', provDef: geminiProvDef });
    fireEvent.click(screen.getByText('Log in with Gemini'));

    await waitFor(() => {
      expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Copy the full URL/)).toBeNull();
    expect(container.querySelector('video[src="/images/oauth-callback-example.mp4"]')).toBeNull();
  });

  it('Disconnect all revokes all OpenAI OAuth tokens', async () => {
    mockRevokeOpenaiOAuth.mockResolvedValue({ ok: true, notifications: [] });
    const keys = [makeKey({ id: 'k1', label: 'A' }), makeKey({ id: 'k2', label: 'B' })];
    const { onBack, onUpdate } = renderView({ connected: true, activeKeys: keys });

    fireEvent.click(screen.getByText('Disconnect all'));

    await waitFor(() => {
      expect(mockRevokeOpenaiOAuth).toHaveBeenCalledWith('test-agent');
    });
    expect(mockDisconnectProvider).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('commitRename cancels if new label is same as old', async () => {
    const keys = [makeKey({ id: 'k1', label: 'Same' }), makeKey({ id: 'k2', label: 'Other' })];
    renderView({ connected: true, activeKeys: keys });

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    // Don't change the value, just submit
    fireEvent.click(screen.getByText('Save'));

    expect(mockRenameProviderKey).not.toHaveBeenCalled();
  });

  it('handlePasteSubmit exchanges a valid callback URL', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    mockSubmitOpenaiOAuthCallback.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { onUpdate } = renderView();
    // Click login to open popup and show the paste input
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled());

    // Now the paste input should be visible
    const input = await waitFor(() => screen.getByPlaceholderText(/localhost:1455/));
    fireEvent.input(input, {
      target: { value: 'http://localhost:1455/auth/callback?code=abc123&state=xyz789' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitOpenaiOAuthCallback).toHaveBeenCalledWith('abc123', 'xyz789');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('OpenAI subscription connected');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('polls for provider updates while OAuth flow is pending', async () => {
    vi.useFakeTimers();
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { onUpdate } = renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await Promise.resolve();
    await Promise.resolve();

    expect(
      screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
    ).toBeDefined();
    expect(onUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('uses onPollProviders instead of onUpdate for polling when provided', async () => {
    vi.useFakeTimers();
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const onPollProviders = vi.fn();
    const [busy, setBusy] = createSignal(false);
    const onBack = vi.fn();
    const onUpdate = vi.fn();
    const onClose = vi.fn();
    render(() => (
      <OAuthDetailView
        provDef={provDef}
        provId="openai"
        agentName="test-agent"
        connected={() => false}
        selectedAuthType={() => 'subscription'}
        busy={busy}
        setBusy={setBusy}
        onBack={onBack}
        onUpdate={onUpdate}
        onPollProviders={onPollProviders}
        onClose={onClose}
        activeKeys={() => []}
      />
    ));
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(2000);

    expect(onPollProviders).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clears paste flow when provider data shows local callback success', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { setConnected, onUpdate } = renderReactiveView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
      ).toBeDefined();
    });

    setConnected(true);

    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText('http://localhost:1455/auth/callback?code=...'),
      ).toBeNull();
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('OpenAI subscription connected');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('handlePasteSubmit shows error when URL is missing code or state', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled());

    const input = await waitFor(() => screen.getByPlaceholderText(/localhost:1455/));
    fireEvent.input(input, {
      target: { value: 'http://localhost:1455/auth/callback?code=abc123' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(screen.getByText(/URL is missing the authorization code/)).toBeDefined();
    });
    expect(mockSubmitOpenaiOAuthCallback).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the server message',
      new Error('Invalid or expired OAuth state'),
      /Invalid or expired OAuth state/,
    ],
    ['a generic hint when the server says nothing', new Error(''), /Failed to exchange token/],
    [
      'a generic hint on a network failure',
      new TypeError('Failed to fetch'),
      /Failed to exchange token/,
    ],
  ])('handlePasteSubmit shows %s when exchange fails', async (_case, error, expected) => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    mockSubmitOpenaiOAuthCallback.mockRejectedValue(error);
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled());

    const input = await waitFor(() => screen.getByPlaceholderText(/localhost:1455/));
    fireEvent.input(input, {
      target: { value: 'http://localhost:1455/auth/callback?code=abc&state=xyz' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(screen.getByText(expected)).toBeDefined();
    });
  });

  it('handlePasteSubmit does nothing when input is empty', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled());

    const input = await waitFor(() => screen.getByPlaceholderText(/localhost:1455/));
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Connect'));

    expect(mockSubmitOpenaiOAuthCallback).not.toHaveBeenCalled();
  });

  it('handlePasteSubmit submits on Enter key', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    mockSubmitOpenaiOAuthCallback.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled());

    const input = await waitFor(() => screen.getByPlaceholderText(/localhost:1455/));
    fireEvent.input(input, {
      target: { value: 'http://localhost:1455/auth/callback?code=abc&state=xyz' },
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockSubmitOpenaiOAuthCallback).toHaveBeenCalledWith('abc', 'xyz');
    });
  });

  it('handleDisconnect calls revokeOpenaiOAuth (single-key)', async () => {
    mockRevokeOpenaiOAuth.mockResolvedValue({ ok: true, notifications: [] });

    const { onBack, onUpdate } = renderView({ connected: true, activeKeys: [makeKey()] });
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockRevokeOpenaiOAuth).toHaveBeenCalledWith('test-agent');
    });
    expect(mockDisconnectProvider).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('handleDisconnect surfaces notifications from revokeOpenaiOAuth', async () => {
    mockRevokeOpenaiOAuth.mockResolvedValue({
      ok: true,
      notifications: ['Shared subscription warning'],
    });

    const { onBack } = renderView({ connected: true, activeKeys: [makeKey()] });
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Shared subscription warning');
    });
    expect(onBack).toHaveBeenCalled();
  });

  it('handleDisconnect catch branch when revokeOpenaiOAuth fails', async () => {
    mockRevokeOpenaiOAuth.mockRejectedValue(new Error('network'));

    const { onBack } = renderView({ connected: true, activeKeys: [makeKey()] });
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockRevokeOpenaiOAuth).toHaveBeenCalled();
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('handleDeleteKey surfaces notifications from revokeOpenaiOAuth', async () => {
    mockRevokeOpenaiOAuth.mockResolvedValue({
      ok: true,
      notifications: ['Key removal warning'],
    });
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    renderView({ connected: true, activeKeys: keys });

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Key removal warning');
    });
  });

  it('handleDeleteKey catch branch when revokeOpenaiOAuth fails', async () => {
    mockRevokeOpenaiOAuth.mockRejectedValue(new Error('network'));
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    const { onUpdate } = renderView({ connected: true, activeKeys: keys });

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockRevokeOpenaiOAuth).toHaveBeenCalled();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('commitRename catch branch when renameProviderKey fails', async () => {
    mockRenameProviderKey.mockRejectedValue(new Error('network'));
    const keys = [makeKey({ id: 'k1', label: 'Old name' }), makeKey({ id: 'k2', label: 'Other' })];
    const { onUpdate } = renderView({ connected: true, activeKeys: keys });

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    const input = screen.getByLabelText('Rename Old name');
    fireEvent.input(input, { target: { value: 'New name' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalled();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('pasteError is shown and cleared on new input', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(mockGetOpenaiOAuthUrl).toHaveBeenCalled());

    const input = await waitFor(() => screen.getByPlaceholderText(/localhost:1455/));
    // Submit invalid URL to trigger error
    fireEvent.input(input, {
      target: { value: 'http://localhost:1455/auth/callback?code=abc' },
    });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(screen.getByText(/URL is missing the authorization code/)).toBeDefined();
    });

    // Typing again should clear the error
    fireEvent.input(input, { target: { value: 'http://other' } });
    expect(screen.queryByText(/URL is missing the authorization code/)).toBeNull();
  });

  it('disposes the OAuth popup monitor when unmounted mid-flow', async () => {
    mockGetOpenaiOAuthUrl.mockResolvedValue({ url: 'https://oauth.openai.com/authorize' });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false } as unknown as Window);

    const { unmount } = renderView();
    fireEvent.click(screen.getByText('Log in with OpenAI'));
    await waitFor(() => expect(monitorOAuthPopup).toHaveBeenCalled());

    unmount();
    expect(mockDisposeMonitor).toHaveBeenCalledTimes(1);
  });
});
