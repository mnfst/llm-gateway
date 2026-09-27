import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const mockStartAnthropicOAuth = vi.fn();
const mockSubmitAnthropicOAuth = vi.fn();
const mockRevokeAnthropicOAuth = vi.fn();
const mockGetAnthropicOAuthPending = vi.fn();
const mockDisconnectProvider = vi.fn();
const mockRenameProviderKey = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  startAnthropicOAuth: (...args: unknown[]) => mockStartAnthropicOAuth(...args),
  submitAnthropicOAuth: (...args: unknown[]) => mockSubmitAnthropicOAuth(...args),
  revokeAnthropicOAuth: (...args: unknown[]) => mockRevokeAnthropicOAuth(...args),
  getAnthropicOAuthPending: (...args: unknown[]) => mockGetAnthropicOAuthPending(...args),
  disconnectProvider: (...args: unknown[]) => mockDisconnectProvider(...args),
  renameProviderKey: (...args: unknown[]) => mockRenameProviderKey(...args),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

import AnthropicOAuthDetailView from '../../src/components/AnthropicOAuthDetailView';
import type { ProviderDef } from '../../src/services/providers.js';
import type { RoutingProvider } from '../../src/services/api.js';

const provDef: ProviderDef = {
  id: 'anthropic',
  name: 'Anthropic',
  color: '#000',
  initial: 'A',
  subtitle: '',
  models: [],
  keyPrefix: 'sk-ant-',
  minKeyLength: 50,
  keyPlaceholder: '',
  supportsSubscription: true,
  subscriptionLabel: 'Claude Max / Pro subscription',
  subscriptionAuthMode: 'popup_paste',
};

function renderView(connectedValue = false) {
  const [busy, setBusy] = createSignal(false);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const result = render(() => (
    <AnthropicOAuthDetailView
      provDef={provDef}
      provId="anthropic"
      agentName="test-agent"
      connected={() => connectedValue}
      selectedAuthType={() => 'subscription'}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
      onClose={onClose}
    />
  ));
  return { ...result, onBack, onUpdate, onClose };
}

const OAUTH_PAYLOAD = 'auth-code-123#state-xyz';

function mockOpenPopup() {
  const replace = vi.fn();
  const close = vi.fn();
  const popup = {
    closed: false,
    opener: window,
    close,
    location: { replace },
  } as unknown as Window;
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup);
  return { popup, openSpy, replace, close };
}

describe('AnthropicOAuthDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: null });
  });

  it('renders the sign-in button and the paste-code input', () => {
    renderView();
    expect(screen.getByText('Sign in with Claude')).toBeDefined();
    expect(screen.getByLabelText('Anthropic authorization code')).toBeDefined();
  });

  it('shows a toast without starting OAuth when the popup is blocked', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    renderView();
    fireEvent.click(screen.getByText('Sign in with Claude'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/Popup was blocked/));
    });
    expect(mockStartAnthropicOAuth).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('starts the OAuth flow and opens a popup', async () => {
    mockStartAnthropicOAuth.mockResolvedValue({ url: 'https://x', state: 'abc' });
    const { popup, openSpy, replace } = mockOpenPopup();

    renderView();
    fireEvent.click(screen.getByText('Sign in with Claude'));

    await waitFor(() => {
      expect(mockStartAnthropicOAuth).toHaveBeenCalledWith('test-agent');
    });
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    expect(popup.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith('https://x');
    openSpy.mockRestore();
  });

  it('exchanges a pasted authorization code', async () => {
    mockStartAnthropicOAuth.mockResolvedValue({ url: 'https://x', state: 'state-xyz' });
    mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });
    mockOpenPopup();

    const { onClose, onUpdate } = renderView();
    fireEvent.click(screen.getByText('Sign in with Claude'));
    await waitFor(() => expect(mockStartAnthropicOAuth).toHaveBeenCalled());

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: OAUTH_PAYLOAD } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitAnthropicOAuth).toHaveBeenCalledWith(
        'test-agent',
        OAUTH_PAYLOAD,
        'state-xyz',
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Anthropic subscription connected');
    expect(onUpdate).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rejects input that does not look like an authorization code', () => {
    renderView();
    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'sk-ant-oat01-some-token' } });
    fireEvent.click(screen.getByText('Connect'));

    expect(screen.getByText(/doesn't look like an authorization code/)).toBeDefined();
    expect(mockSubmitAnthropicOAuth).not.toHaveBeenCalled();
  });

  it('hydrates pending state on mount so a code can be pasted after a modal close', async () => {
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: 'persisted-state' });
    mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });

    renderView();
    await waitFor(() => expect(mockGetAnthropicOAuthPending).toHaveBeenCalled());

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'fresh-code#persisted-state' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitAnthropicOAuth).toHaveBeenCalledWith(
        'test-agent',
        'fresh-code#persisted-state',
        'persisted-state',
      );
    });
  });

  it('uses the pasted state when the local signal was lost', async () => {
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: null });
    mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });

    renderView();
    await waitFor(() => expect(mockGetAnthropicOAuthPending).toHaveBeenCalledTimes(1));

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'code#whatever' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitAnthropicOAuth).toHaveBeenCalledWith(
        'test-agent',
        'code#whatever',
        'whatever',
      );
    });
  });

  it('submits the full pasted payload even when no pending state hydrates locally', async () => {
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: null });
    mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });

    renderView();
    await waitFor(() => expect(mockGetAnthropicOAuthPending).toHaveBeenCalled());

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'orphan-code#orphan-state' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitAnthropicOAuth).toHaveBeenCalledWith(
        'test-agent',
        'orphan-code#orphan-state',
        'orphan-state',
      );
    });
  });

  it('rejects payloads missing the state suffix', () => {
    renderView();
    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'auth-code#' } });
    fireEvent.click(screen.getByText('Connect'));

    expect(screen.getByText(/doesn't look like an authorization code/)).toBeDefined();
    expect(mockSubmitAnthropicOAuth).not.toHaveBeenCalled();
  });

  it('shows an error if the OAuth exchange fails', async () => {
    mockStartAnthropicOAuth.mockResolvedValue({ url: 'https://x', state: 's1' });
    mockSubmitAnthropicOAuth.mockRejectedValue(new Error('boom'));
    mockOpenPopup();

    renderView();
    fireEvent.click(screen.getByText('Sign in with Claude'));
    await waitFor(() => expect(mockStartAnthropicOAuth).toHaveBeenCalled());

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'code#s1' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeDefined();
    });
  });

  it('shows the generic exchange error when the failure is not an Error object', async () => {
    mockStartAnthropicOAuth.mockResolvedValue({ url: 'https://x', state: 's1' });
    mockSubmitAnthropicOAuth.mockRejectedValue('boom');
    mockOpenPopup();

    renderView();
    fireEvent.click(screen.getByText('Sign in with Claude'));
    await waitFor(() => expect(mockStartAnthropicOAuth).toHaveBeenCalled());

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'code#s1' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Failed to exchange code. The code may have expired. Sign in again to retry.',
        ),
      ).toBeDefined();
    });
  });

  it('falls back gracefully when the pending lookup throws on mount', async () => {
    mockGetAnthropicOAuthPending.mockRejectedValue(new Error('network'));
    renderView();
    await waitFor(() => expect(mockGetAnthropicOAuthPending).toHaveBeenCalled());
    expect(screen.getByText('Sign in with Claude')).toBeDefined();
  });

  it('skips the pending lookup when already connected', () => {
    renderView(true);
    expect(screen.getByText('Disconnect')).toBeDefined();
    expect(mockGetAnthropicOAuthPending).not.toHaveBeenCalled();
  });

  it('does not need a submit-time pending lookup when the pasted payload contains state', async () => {
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: null });
    mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });

    renderView();
    await waitFor(() => expect(mockGetAnthropicOAuthPending).toHaveBeenCalledTimes(1));

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'code#whatever' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(mockSubmitAnthropicOAuth).toHaveBeenCalledWith(
        'test-agent',
        'code#whatever',
        'whatever',
      );
    });
    expect(mockGetAnthropicOAuthPending).toHaveBeenCalledTimes(1);
  });

  it('submits on Enter inside the paste input', async () => {
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: 's' });
    mockSubmitAnthropicOAuth.mockResolvedValue({ ok: true });
    renderView();
    await waitFor(() => expect(mockGetAnthropicOAuthPending).toHaveBeenCalled());

    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: 'code#s' } });
    fireEvent.keyDown(codeInput, { key: 'Enter' });

    await waitFor(() => expect(mockSubmitAnthropicOAuth).toHaveBeenCalled());
  });

  it('does not submit when the input is whitespace', () => {
    renderView();
    const codeInput = screen.getByLabelText('Anthropic authorization code');
    fireEvent.input(codeInput, { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Connect'));
    expect(mockSubmitAnthropicOAuth).not.toHaveBeenCalled();
  });

  it('surfaces server-side notifications when disconnect returns them', async () => {
    mockRevokeAnthropicOAuth.mockResolvedValue({
      ok: true,
      notifications: ['Subscription is shared with another agent'],
    });

    const { onBack } = renderView(true);
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Subscription is shared with another agent');
    });
    expect(onBack).toHaveBeenCalled();
  });

  it('does not call generic disconnect when revoke request fails', async () => {
    mockRevokeAnthropicOAuth.mockRejectedValue(new Error('revoke failed'));

    const { onBack, onUpdate } = renderView(true);
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => expect(mockRevokeAnthropicOAuth).toHaveBeenCalledWith('test-agent'));
    expect(mockDisconnectProvider).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not navigate back when revoke request fails', async () => {
    mockRevokeAnthropicOAuth.mockRejectedValue(new Error('network'));

    const { onBack } = renderView(true);
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => expect(mockRevokeAnthropicOAuth).toHaveBeenCalledWith('test-agent'));
    expect(onBack).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by startAnthropicOAuth', async () => {
    mockStartAnthropicOAuth.mockRejectedValue(new Error('network'));
    const { close } = mockOpenPopup();
    renderView();
    fireEvent.click(screen.getByText('Sign in with Claude'));
    await waitFor(() => expect(mockStartAnthropicOAuth).toHaveBeenCalled());
    expect(close).toHaveBeenCalled();
    expect(screen.getByText('Sign in with Claude')).toBeDefined();
  });
});

function makeKey(overrides: Partial<RoutingProvider> = {}): RoutingProvider {
  return {
    id: 'key-1',
    provider: 'anthropic',
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

function renderMultiKeyView(keys: RoutingProvider[]) {
  const [busy, setBusy] = createSignal(false);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const result = render(() => (
    <AnthropicOAuthDetailView
      provDef={provDef}
      provId="anthropic"
      agentName="test-agent"
      connected={() => true}
      selectedAuthType={() => 'subscription'}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
      onClose={onClose}
      activeKeys={() => keys}
    />
  ));
  return { ...result, onBack, onUpdate, onClose };
}

describe('AnthropicOAuthDetailView — multi-key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: null });
  });

  it('renders the multi-key list when activeKeys has 2+ items', () => {
    const keys = [makeKey({ id: 'k1', label: 'Work' }), makeKey({ id: 'k2', label: 'Personal' })];
    renderMultiKeyView(keys);
    expect(screen.getByText('Accounts')).toBeDefined();
    expect(screen.getByText('Work')).toBeDefined();
    expect(screen.getByText('Personal')).toBeDefined();
  });

  it('rename flow: clicking Rename shows input and saving calls renameProviderKey', async () => {
    mockRenameProviderKey.mockResolvedValue({ id: 'k1', label: 'New', priority: 1 });
    const keys = [makeKey({ id: 'k1', label: 'Old' }), makeKey({ id: 'k2', label: 'Other' })];
    const { onUpdate } = renderMultiKeyView(keys);

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    const input = screen.getByLabelText('Rename Old');
    fireEvent.input(input, { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalledWith(
        'test-agent',
        'anthropic',
        'Old',
        'New',
        'subscription',
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Renamed to "New"');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('delete individual key calls revokeAnthropicOAuth with label', async () => {
    mockRevokeAnthropicOAuth.mockResolvedValue({ ok: true, notifications: [] });
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    const { onUpdate } = renderMultiKeyView(keys);

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockRevokeAnthropicOAuth).toHaveBeenCalledWith('test-agent', 'Primary');
    });
    expect(mockDisconnectProvider).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows "Disconnect all" button in multi-key mode', () => {
    const keys = [makeKey({ id: 'k1', label: 'A' }), makeKey({ id: 'k2', label: 'B' })];
    renderMultiKeyView(keys);
    expect(screen.getByText('Disconnect all')).toBeDefined();
  });

  it('handleDeleteKey surfaces notifications from revokeAnthropicOAuth', async () => {
    mockRevokeAnthropicOAuth.mockResolvedValue({
      ok: true,
      notifications: ['Key still in use by another agent'],
    });
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    renderMultiKeyView(keys);

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Key still in use by another agent');
    });
  });

  it('handleDeleteKey catch branch when revokeAnthropicOAuth fails', async () => {
    mockRevokeAnthropicOAuth.mockRejectedValue(new Error('network'));
    const keys = [
      makeKey({ id: 'k1', label: 'Primary' }),
      makeKey({ id: 'k2', label: 'Secondary' }),
    ];
    const { onUpdate } = renderMultiKeyView(keys);

    fireEvent.click(screen.getByLabelText('Delete account Primary'));

    await waitFor(() => {
      expect(mockRevokeAnthropicOAuth).toHaveBeenCalledWith('test-agent', 'Primary');
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('commitRename catch branch when renameProviderKey fails', async () => {
    mockRenameProviderKey.mockRejectedValue(new Error('network'));
    const keys = [makeKey({ id: 'k1', label: 'Old' }), makeKey({ id: 'k2', label: 'Other' })];
    const { onUpdate } = renderMultiKeyView(keys);

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);

    const input = screen.getByLabelText('Rename Old');
    fireEvent.input(input, { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockRenameProviderKey).toHaveBeenCalled();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('commitRename cancels if the label did not change', () => {
    const keys = [makeKey({ id: 'k1', label: 'Same' }), makeKey({ id: 'k2', label: 'Other' })];
    renderMultiKeyView(keys);

    const renameButtons = screen.getAllByText('Rename');
    fireEvent.click(renameButtons[0]);
    fireEvent.click(screen.getByText('Save'));

    expect(mockRenameProviderKey).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Rename Same')).toBeNull();
  });
});

function renderViewWithAddKeyOpen() {
  const [busy, setBusy] = createSignal(false);
  const [addKeyOpen, setAddKeyOpen] = createSignal(true);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const onClose = vi.fn();
  const keys = [makeKey()];
  const result = render(() => (
    <AnthropicOAuthDetailView
      provDef={provDef}
      provId="anthropic"
      agentName="test-agent"
      connected={() => true}
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

describe('AnthropicOAuthDetailView — addKeyOpen effect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnthropicOAuthPending.mockResolvedValue({ state: null });
  });

  it('auto-launches handleSignIn when addKeyOpen is true and connected', async () => {
    mockStartAnthropicOAuth.mockResolvedValue({ url: 'https://x', state: 'abc' });
    mockOpenPopup();

    renderViewWithAddKeyOpen();

    await waitFor(() => {
      expect(mockStartAnthropicOAuth).toHaveBeenCalledWith('test-agent');
    });
    expect(screen.getByLabelText('Anthropic authorization code')).toBeDefined();
  });

  it('opens the add-account popup before the OAuth start request resolves', async () => {
    let resolveStart: (value: { url: string; state: string }) => void = () => {};
    mockStartAnthropicOAuth.mockReturnValue(
      new Promise<{ url: string; state: string }>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const { popup, openSpy, replace } = mockOpenPopup();

    renderViewWithAddKeyOpen();

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    });
    expect(mockStartAnthropicOAuth).toHaveBeenCalledWith('test-agent');
    expect(popup.opener).toBeNull();
    expect(replace).not.toHaveBeenCalled();

    resolveStart({ url: 'https://x', state: 'abc' });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('https://x');
    });
  });

  it('does not navigate a popup closed while the OAuth start request is pending', async () => {
    let resolveStart: (value: { url: string; state: string }) => void = () => {};
    mockStartAnthropicOAuth.mockReturnValue(
      new Promise<{ url: string; state: string }>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const { popup, replace, close } = mockOpenPopup();

    renderViewWithAddKeyOpen();
    await waitFor(() => {
      expect(mockStartAnthropicOAuth).toHaveBeenCalledWith('test-agent');
    });

    Object.defineProperty(popup, 'closed', { value: true });
    resolveStart({ url: 'https://x', state: 'abc' });

    await waitFor(() => {
      expect(screen.getByText('Sign in with Claude')).toBeDefined();
    });
    expect(replace).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Anthropic authorization code')).toBeDefined();
  });

  it('cancels a connected add-account Claude OAuth flow', async () => {
    mockStartAnthropicOAuth.mockResolvedValue({ url: 'https://x', state: 'abc' });
    mockOpenPopup();

    renderViewWithAddKeyOpen();

    await waitFor(() => {
      expect(screen.getByLabelText('Anthropic authorization code')).toBeDefined();
    });
    fireEvent.input(screen.getByLabelText('Anthropic authorization code'), {
      target: { value: 'code#abc' },
    });
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByLabelText('Anthropic authorization code')).toBeNull();
    expect(screen.getByText('Disconnect')).toBeDefined();
  });
});
