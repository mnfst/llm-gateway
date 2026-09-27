import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import UsageLimitBanner from '../../src/components/UsageLimitBanner';

const mockGetBillingStatus = vi.fn();

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1' } },
      isPending: false,
    }),
  },
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

const freeStatus = (used: number, limit = 10_000) => ({
  enabled: true,
  plan: 'free' as const,
  requests: { used, limit, periodEnd: null },
});

describe('UsageLimitBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGetBillingStatus.mockResolvedValue(freeStatus(8_000));
  });

  it('shows and dismisses the near-limit warning for free users', async () => {
    const { container } = render(() => <UsageLimitBanner />);

    await screen.findByText("You're limited to 10,000 requests this month. Upgrade for unlimited.");
    expect(container.querySelector('.usage-limit-banner--danger')).toBeNull();
    expect(container.querySelector('a[href="/upgrade?reason=requests"]')).not.toBeNull();

    fireEvent.click(screen.getByText('Got it'));

    await waitFor(() => {
      expect(container.querySelector('.usage-limit-banner')).toBeNull();
    });
  });

  it('keeps the reached-limit warning visible and non-dismissible', async () => {
    mockGetBillingStatus.mockResolvedValue(freeStatus(10_000));
    const { container } = render(() => <UsageLimitBanner />);

    await screen.findByText("You've reached your monthly limit. Requests are being blocked.");
    expect(container.querySelector('.usage-limit-banner--danger')).not.toBeNull();
    expect(screen.queryByText('Got it')).toBeNull();
  });

  it('stays hidden when the warning was already dismissed today', async () => {
    localStorage.setItem(
      'manifest_usage_banner_dismissed:u1',
      new Date().toISOString().slice(0, 10),
    );
    const { container } = render(() => <UsageLimitBanner />);

    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());

    expect(container.querySelector('.usage-limit-banner')).toBeNull();
  });

  it('does not reuse another user dismissal', async () => {
    localStorage.setItem(
      'manifest_usage_banner_dismissed:u2',
      new Date().toISOString().slice(0, 10),
    );
    const { container } = render(() => <UsageLimitBanner />);

    await screen.findByText("You're limited to 10,000 requests this month. Upgrade for unlimited.");

    expect(container.querySelector('.usage-limit-banner')).not.toBeNull();
  });

  it('keeps working when dismissal storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    try {
      render(() => <UsageLimitBanner />);

      await screen.findByText(
        "You're limited to 10,000 requests this month. Upgrade for unlimited.",
      );
      expect(() => fireEvent.click(screen.getByText('Got it'))).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('stays hidden for pro users and billing fetch failures', async () => {
    mockGetBillingStatus.mockResolvedValueOnce({
      enabled: true,
      plan: 'pro',
      requests: { used: null, limit: null, periodEnd: null },
    });
    const pro = render(() => <UsageLimitBanner />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalledTimes(1));
    expect(pro.container.querySelector('.usage-limit-banner')).toBeNull();
    pro.unmount();

    mockGetBillingStatus.mockRejectedValueOnce(new Error('network'));
    const failed = render(() => <UsageLimitBanner />);
    await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalledTimes(2));
    expect(failed.container.querySelector('.usage-limit-banner')).toBeNull();
  });
});
