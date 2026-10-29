import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { FREE_PLAN_REQUESTS_PER_MONTH } from 'manifest-shared';

const mockNavigate = vi.fn();
let mockSearchParams: Record<string, string> = {};

vi.mock('@solidjs/router', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

const mockUpgrade = vi.fn();
vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({ data: { user: { id: 'u1' } }, isPending: false }),
    subscription: {
      upgrade: (...args: unknown[]) => mockUpgrade(...args),
    },
  },
}));

const mockGetBillingStatus = vi.fn();
vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

const mockToastError = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

import Upgrade from '../../src/pages/Upgrade';

const disabledStatus = {
  enabled: false,
  plan: 'free' as const,
  priceMonthly: { amount: null, currency: null, interval: null },
  emailPreferences: { usageAlerts: true },
  requests: { used: null, limit: FREE_PLAN_REQUESTS_PER_MONTH, periodEnd: null },
  cancelAtPeriodEnd: false,
  subscriptionPeriodEnd: null,
};

const freeStatus = {
  enabled: true,
  plan: 'free' as const,
  priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
  emailPreferences: { usageAlerts: true },
  requests: {
    used: 1250,
    limit: FREE_PLAN_REQUESTS_PER_MONTH,
    periodEnd: '2026-08-01T00:00:00.000Z',
  },
  cancelAtPeriodEnd: false,
  subscriptionPeriodEnd: null,
};

const proStatus = {
  enabled: true,
  plan: 'pro' as const,
  priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
  emailPreferences: { usageAlerts: true },
  requests: { used: null, limit: null, periodEnd: null },
  cancelAtPeriodEnd: false,
  subscriptionPeriodEnd: null,
};

describe('Upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockGetBillingStatus.mockResolvedValue(freeStatus);
    mockUpgrade.mockResolvedValue(undefined);
    window.history.pushState({}, '', '/upgrade');
  });

  it('fetches billing status without cache and renders plan choices', async () => {
    render(() => <Upgrade />);

    await screen.findByText('Self-hosted');

    expect(mockGetBillingStatus).toHaveBeenCalledWith({ cache: false });
    expect(screen.getByText('Full control over your AI routing')).toBeDefined();
    expect(screen.getByText('$0')).toBeDefined();
    expect(screen.getByText('forever')).toBeDefined();
    expect(screen.getByText('$20')).toBeDefined();
    expect(screen.getByText('All providers, including local models')).toBeDefined();
    expect(screen.getAllByText('Unlimited routed requests').length).toBe(2);
    expect(screen.getByText('365 days of dashboard history')).toBeDefined();
    expect(screen.getByText('Servers, database and uptime handled by us')).toBeDefined();
    expect(screen.queryByText(/Everything in/)).toBeNull();
    expect(screen.getByText('Manifest Cloud')).toBeDefined();
    expect(screen.getByText('Read the self-hosting guide')).toBeDefined();
    expect(screen.getByText('Enterprise')).toBeDefined();
    expect(screen.getByText("Let's Talk")).toBeDefined();
    expect(screen.getByText('Talk to sales')).toBeDefined();
    expect(screen.getByText('Subscribe')).toBeDefined();
  });

  it('shows the subscription-required entry message when the tenant has no allowance', async () => {
    mockSearchParams = { reason: 'requests' };
    render(() => <Upgrade />);

    await screen.findByText('Manifest Cloud needs a Pro subscription to route requests.');
  });

  it('shows the used-up allowance entry message when the tenant has a positive limit', async () => {
    mockSearchParams = { reason: 'requests' };
    mockGetBillingStatus.mockResolvedValue({
      ...freeStatus,
      requests: { used: 500, limit: 500, periodEnd: null },
    });
    render(() => <Upgrade />);

    await screen.findByText(/You've used all 500 requests this month/);
  });

  it('hides the request-limit entry message on the Pro plan', async () => {
    mockSearchParams = { reason: 'requests' };
    mockGetBillingStatus.mockResolvedValue(proStatus);
    render(() => <Upgrade />);

    await screen.findByText(/You're currently on the/);
    expect(screen.queryByText(/You've used all/)).toBeNull();
  });

  it('goes back when the referrer is from the same origin', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    Object.defineProperty(document, 'referrer', {
      value: `${window.location.origin}/account`,
      configurable: true,
    });
    try {
      render(() => <Upgrade />);

      fireEvent.click(await screen.findByText('Back'));

      expect(back).toHaveBeenCalled();
    } finally {
      back.mockRestore();
    }
  });

  it('falls back to the dashboard when Back has no same-origin referrer', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://example.com/account',
      configurable: true,
    });
    render(() => <Upgrade />);

    fireEvent.click(await screen.findByText('Back'));

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('continues on Free by navigating to the dashboard', async () => {
    render(() => <Upgrade />);

    const button = await screen.findByText('Continue without a subscription');
    fireEvent.click(button);

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('starts checkout with the current upgrade URL as cancel URL', async () => {
    mockSearchParams = { reason: 'requests' };
    window.history.pushState({}, '', '/upgrade?reason=requests');
    render(() => <Upgrade />);

    const button = await screen.findByText('Subscribe');
    fireEvent.click(button);

    expect(mockUpgrade).toHaveBeenCalledWith({
      plan: 'pro',
      successUrl: `${window.location.origin}/overview?upgraded=1`,
      cancelUrl: `${window.location.origin}/upgrade?reason=requests`,
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows an error toast when checkout fails', async () => {
    mockUpgrade.mockRejectedValue(new Error('stripe down'));
    render(() => <Upgrade />);

    fireEvent.click(await screen.findByText('Subscribe'));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Could not start the upgrade. Please try again.'),
    );
  });

  it('shows an error toast when checkout returns an error payload', async () => {
    mockUpgrade.mockResolvedValue({ error: { message: 'stripe down' } });
    render(() => <Upgrade />);

    fireEvent.click(await screen.findByText('Subscribe'));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Could not start the upgrade. Please try again.'),
    );
  });

  it('redirects away when billing is disabled', async () => {
    mockGetBillingStatus.mockResolvedValue(disabledStatus);
    render(() => <Upgrade />);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true }));
    expect(screen.queryByText('$20')).toBeNull();
  });

  it('shows an already-upgraded state for Pro users', async () => {
    mockGetBillingStatus.mockResolvedValue(proStatus);
    render(() => <Upgrade />);

    await screen.findByText(/You're currently on the/);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.queryByText('$20')).toBeNull();
  });

  it('shows a loading state while billing status is pending', () => {
    mockGetBillingStatus.mockReturnValue(new Promise(() => undefined));
    render(() => <Upgrade />);

    expect(screen.getByText('Loading billing status...')).toBeDefined();
  });

  it('shows a recoverable state when billing status fails', async () => {
    mockGetBillingStatus.mockRejectedValue(new Error('network'));
    render(() => <Upgrade />);

    await screen.findByText('Could not load billing status. Please try again.');
    fireEvent.click(screen.getByText('Dashboard'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
