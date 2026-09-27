import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const mockNavigate = vi.fn();
const mockCheckNeedsSetup = vi.fn();
const mockLocationAssign = vi.fn();
let mockSessionData: any = { data: null, isPending: false };
let mockSearchParams: Record<string, string | string[]> = {};
let mockLocation = { search: '' };
let setMockSession: ((v: any) => void) | undefined;

vi.mock('@solidjs/router', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => mockLocation,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => mockSessionData,
  },
}));

vi.mock('../../src/services/setup-status.js', () => ({
  checkNeedsSetup: (...args: unknown[]) => mockCheckNeedsSetup(...args),
}));

import GuestGuard from '../../src/components/GuestGuard';

describe('GuestGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockSessionData = { data: null, isPending: false };
    mockSearchParams = {};
    mockLocation = { search: '' };
    mockCheckNeedsSetup.mockResolvedValue(false);
  });

  it('renders children when no session and setup is complete', async () => {
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(screen.getByText('Guest content')).not.toBeNull();
    });
  });

  it('redirects to the discovery step when it is still pending for the user', async () => {
    localStorage.setItem('manifest_discovery_pending_u1', '/welcome');
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/discovery?next=%2Fwelcome', { replace: true });
    });
  });

  it('ignores a pending discovery step already marked done', async () => {
    localStorage.setItem('manifest_discovery_pending_u1', '/welcome');
    localStorage.setItem('manifest_discovery_done_u1', '1');
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('redirects to home when session exists', async () => {
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('redirects authenticated pro-intent guests to upgrade', async () => {
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    mockSearchParams = { plan: 'pro' };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/upgrade', { replace: true });
    });
  });

  it('redirects authenticated guests to a safe return path first', async () => {
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    mockSearchParams = { redirect: '/upgrade?reason=requests', plan: 'pro' };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/upgrade?reason=requests', {
        replace: true,
      });
    });
  });

  it('preserves signed MCP authorization during the authenticated redirect', async () => {
    vi.stubGlobal('location', { assign: mockLocationAssign });
    localStorage.setItem('manifest_discovery_pending_u1', '/welcome');
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    mockSearchParams = {
      client_id: 'client',
      redirect_uri: 'http://127.0.0.1/callback',
      ba_param: ['client_id', 'redirect_uri'],
      sig: 'abc',
    };
    mockLocation = {
      search:
        '?client_id=client&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&ba_param=client_id&ba_param=redirect_uri&sig=abc',
    };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockLocationAssign).toHaveBeenCalledWith(
        '/api/auth/oauth2/authorize?client_id=client&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&ba_param=client_id&ba_param=redirect_uri&sig=abc',
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('lets authenticated users finish the plan step before redirecting', async () => {
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    mockSearchParams = { step: ['plan'] };
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));

    await vi.waitFor(() => {
      expect(screen.getByText('Guest content')).not.toBeNull();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('redirects to /setup when setup is incomplete', async () => {
    mockCheckNeedsSetup.mockResolvedValue(true);
    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/setup', { replace: true });
    });
  });

  it('does not render children while setup check is pending', () => {
    // checkNeedsSetup hangs — we should see no content rendered yet
    mockCheckNeedsSetup.mockReturnValue(new Promise(() => undefined));
    const { container } = render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));
    expect(container.textContent).not.toContain('Guest content');
  });

  it('keeps children mounted when session briefly goes pending after initial render', async () => {
    // Use a reactive signal so we can change session state mid-test
    const [sessionSig, setSession] = createSignal<any>({
      data: null,
      isPending: false,
    });
    setMockSession = setSession;

    // Override the mock to use reactive signal for this test
    const origMock = vi.mocked(await import('../../src/services/auth-client.js'));
    origMock.authClient.useSession = () => sessionSig;

    render(() => (
      <GuestGuard>
        <span>Guest content</span>
      </GuestGuard>
    ));

    // Wait for children to appear (setup check resolves, session not pending)
    await vi.waitFor(() => {
      expect(screen.getByText('Guest content')).not.toBeNull();
    });

    // Simulate Better Auth triggering a session refetch (isPending goes true)
    setSession({ data: null, isPending: true });
    // Children should still be mounted
    expect(screen.getByText('Guest content')).not.toBeNull();

    // Session refetch completes with no data
    setSession({ data: null, isPending: false });
    // Children should still be mounted
    expect(screen.getByText('Guest content')).not.toBeNull();
  });
});
