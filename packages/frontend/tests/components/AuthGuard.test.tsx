import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';

const mockNavigate = vi.fn();
const mockGetBillingPlan = vi.fn().mockResolvedValue({ enabled: false, plan: 'free' });
let mockLocation = { pathname: '/', search: '' };
let mockSessionData: any = {
  data: { user: { id: 'u1', name: 'Test' } },
  isPending: false,
};

vi.mock('@solidjs/router', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => mockSessionData,
  },
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingPlan: (...args: unknown[]) => mockGetBillingPlan(...args),
}));

import AuthGuard from '../../src/components/AuthGuard';
import { resetPlanStore } from '../../src/services/plan-store';

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetPlanStore();
    mockGetBillingPlan.mockResolvedValue({ enabled: false, plan: 'free' });
    mockSessionData = {
      data: { user: { id: 'u1', name: 'Test' } },
      isPending: false,
    };
    mockLocation = { pathname: '/', search: '' };
  });

  it('redirects to the discovery step when it is still pending for the user', async () => {
    localStorage.setItem('manifest_discovery_pending_u1', '/welcome');
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/discovery?next=%2Fwelcome', { replace: true });
    });
  });

  it('does not redirect away from the discovery page itself while pending', async () => {
    localStorage.setItem('manifest_discovery_pending_u1', '/welcome');
    mockLocation = { pathname: '/discovery', search: '?next=%2Fwelcome' };
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    expect(await screen.findByText('Protected content')).toBeDefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('lets the MCP consent page through even while onboarding is pending', async () => {
    localStorage.setItem('manifest_discovery_pending_u1', '/welcome');
    mockLocation = { pathname: '/consent', search: '?client_id=c' };
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    expect(await screen.findByText('Protected content')).toBeDefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders children when session exists', async () => {
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    expect(await screen.findByText('Protected content')).toBeDefined();
  });

  it('skips the upgrade redirect when the user already chose a plan', async () => {
    localStorage.setItem('manifest_plan_chosen_u1', '1');
    localStorage.setItem('manifest_onboarding_done_u1', '1');
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'free' });
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    expect(await screen.findByText('Protected content')).toBeDefined();
    // The plan store still resolves at bootstrap (range locks read it), but a
    // chosen plan never redirects to /register?step=plan again.
    expect(mockGetBillingPlan).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('redirects authenticated free users to /register?step=plan after onboarding', async () => {
    localStorage.setItem('manifest_onboarding_done_u1', '1');
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'free' });
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/register?step=plan', { replace: true });
    });
  });

  it('marks the plan chosen and renders children for a pro user after onboarding', async () => {
    localStorage.setItem('manifest_onboarding_done_u1', '1');
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'pro' });
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    expect(await screen.findByText('Protected content')).toBeDefined();
    expect(localStorage.getItem('manifest_plan_chosen_u1')).toBe('1');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('skips the upgrade redirect and renders children when onboarding is not done', async () => {
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'free' });
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    expect(await screen.findByText('Protected content')).toBeDefined();
    // The plan store still resolves (bootstrap), but no redirect fires before
    // onboarding completes.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('skips the redirect and renders children when on /register', async () => {
    localStorage.setItem('manifest_onboarding_done_u1', '1');
    mockLocation = { pathname: '/register', search: '?step=plan' };
    mockGetBillingPlan.mockResolvedValue({ enabled: true, plan: 'free' });
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    expect(await screen.findByText('Protected content')).toBeDefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('fails open when the plan cannot be loaded', async () => {
    mockGetBillingPlan.mockRejectedValue(new Error('network'));
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));

    expect(await screen.findByText('Protected content')).toBeDefined();
  });

  it('starts resolving the plan while the session is still pending', async () => {
    // The plan lookup only needs the cookie jar, not the resolved session, so
    // it must not wait behind the session probe: in production that probe is
    // ~0.5 s and the plan another 0.3–0.9 s, paid serially before any page.
    mockSessionData = { data: null, isPending: true };
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    await vi.waitFor(() => expect(mockGetBillingPlan).toHaveBeenCalledTimes(1));
  });

  it('shows loading state when session is pending', () => {
    mockSessionData = { data: null, isPending: true };
    const { container } = render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    expect(container.textContent).toContain('Loading...');
  });

  it('shows loading state when no session data', () => {
    mockSessionData = { data: null, isPending: false };
    const { container } = render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    expect(container.textContent).toContain('Loading...');
  });

  it('navigates to login when no session', async () => {
    mockSessionData = { data: null, isPending: false };
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login?redirect=%2F', { replace: true });
    });
  });

  it('preserves the protected path and query when redirecting to login', async () => {
    mockSessionData = { data: null, isPending: false };
    mockLocation = { pathname: '/upgrade', search: '?reason=requests' };
    render(() => (
      <AuthGuard>
        <span>Protected content</span>
      </AuthGuard>
    ));
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login?redirect=%2Fupgrade%3Freason%3Drequests', {
        replace: true,
      });
    });
  });
});
