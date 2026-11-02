import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import SubscriptionRequiredModal from '../../src/components/SubscriptionRequiredModal';
import { SELF_HOSTING_GUIDE_URL } from '../../src/components/PlanPicker';

const mockGetBillingStatus = vi.fn();
const mockNavigate = vi.fn();
let mockPathname = '/';
let mockSessionId: string | null = 's1';

vi.mock('@solidjs/router', () => ({
  useLocation: () => ({
    get pathname() {
      return mockPathname;
    },
  }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: mockSessionId ? { user: { id: 'u1' }, session: { id: mockSessionId } } : null,
      isPending: false,
    }),
  },
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

const status = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  plan: 'free' as const,
  priceMonthly: { amount: 19, currency: 'USD', interval: 'month' },
  requests: { used: 0, limit: 0, periodEnd: null },
  ...overrides,
});

const dialog = () => document.querySelector('.subscription-required-modal');

describe('SubscriptionRequiredModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPathname = '/';
    mockSessionId = 's1';
    mockGetBillingStatus.mockResolvedValue(status());
  });

  it('opens for a workspace without a subscription and links to self-hosting', async () => {
    render(() => <SubscriptionRequiredModal />);

    await screen.findByText('Your requests are paused');
    expect(screen.getByText('Subscribe for $19/month')).toBeDefined();
    const guide = screen.getByText('Self-host for free') as HTMLAnchorElement;
    expect(guide.getAttribute('href')).toBe(SELF_HOSTING_GUIDE_URL);
    expect(guide.getAttribute('target')).toBe('_blank');
  });

  it('falls back to $19 when Stripe returns no price', async () => {
    mockGetBillingStatus.mockResolvedValue(
      status({ priceMonthly: { amount: null, currency: null, interval: null } }),
    );
    render(() => <SubscriptionRequiredModal />);

    await screen.findByText('Subscribe for $19/month');
  });

  it('closes on "Not now" and stays closed for the same session', async () => {
    const first = render(() => <SubscriptionRequiredModal />);
    await screen.findByText('Your requests are paused');

    fireEvent.click(screen.getByText('Not now'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(localStorage.getItem('manifest_subscription_modal_dismissed:s1')).toBe('1');
    first.unmount();

    render(() => <SubscriptionRequiredModal />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalledTimes(2));
    expect(dialog()).toBeNull();
  });

  it('opens again on a new sign-in', async () => {
    localStorage.setItem('manifest_subscription_modal_dismissed:s1', '1');
    mockSessionId = 's2';
    render(() => <SubscriptionRequiredModal />);

    await screen.findByText('Your requests are paused');
  });

  it('closes on Escape and on a backdrop click', async () => {
    const first = render(() => <SubscriptionRequiredModal />);
    await screen.findByText('Your requests are paused');
    fireEvent.click(dialog()!);
    expect(dialog()).not.toBeNull();
    fireEvent.keyDown(document.querySelector('.modal-backdrop')!, { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
    first.unmount();

    mockSessionId = 's3';
    render(() => <SubscriptionRequiredModal />);
    await screen.findByText('Your requests are paused');
    fireEvent.keyDown(document.querySelector('.modal-backdrop')!, { key: 'Enter' });
    expect(dialog()).not.toBeNull();
    fireEvent.click(document.querySelector('.modal-backdrop')!);
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('closes and opens the Upgrade page on Subscribe', async () => {
    render(() => <SubscriptionRequiredModal />);
    await screen.findByText('Your requests are paused');

    fireEvent.click(screen.getByText('Subscribe for $19/month'));

    expect(mockNavigate).toHaveBeenCalledWith('/upgrade?reason=requests');
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('stays closed on the Upgrade page', async () => {
    mockPathname = '/upgrade';
    render(() => <SubscriptionRequiredModal />);

    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());
    expect(dialog()).toBeNull();
  });

  it('stays closed without a session id', async () => {
    mockSessionId = null;
    render(() => <SubscriptionRequiredModal />);

    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());
    expect(dialog()).toBeNull();
  });

  it.each([
    ['Pro', status({ plan: 'pro', requests: { used: 0, limit: null, periodEnd: null } })],
    ['an allowance', status({ requests: { used: 0, limit: 500, periodEnd: null } })],
    ['billing disabled', status({ enabled: false })],
  ])('stays closed with %s', async (_label, value) => {
    mockGetBillingStatus.mockResolvedValue(value);
    render(() => <SubscriptionRequiredModal />);

    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());
    expect(dialog()).toBeNull();
  });

  it('stays closed when the billing call fails', async () => {
    mockGetBillingStatus.mockRejectedValue(new Error('down'));
    render(() => <SubscriptionRequiredModal />);

    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());
    expect(dialog()).toBeNull();
  });

  it('survives a storage that throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(() => <SubscriptionRequiredModal />);
    await screen.findByText('Your requests are paused');

    fireEvent.click(screen.getByText('Not now'));
    await waitFor(() => expect(dialog()).toBeNull());
    get.mockRestore();
    set.mockRestore();
  });
});
