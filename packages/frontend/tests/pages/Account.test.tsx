import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { FREE_REQUEST_LIMIT_LABEL } from '../../src/services/billing-display';
import { FREE_PLAN_REQUESTS_PER_MONTH } from 'manifest-shared';

const searchParamsState: Record<string, string | undefined> = {};
const setSearchParamsFn = vi.fn((p: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) delete searchParamsState[k];
    else searchParamsState[k] = v;
  }
});

vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [searchParamsState, setSearchParamsFn],
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

const mockUpgrade = vi.fn();
const mockBillingPortal = vi.fn();
const mockListAccounts = vi.fn();
const mockChangePassword = vi.fn();

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1', name: 'Test User', email: 'test@test.com' } },
      isPending: false,
    }),
    subscription: {
      upgrade: (...a: unknown[]) => mockUpgrade(...a),
      billingPortal: (...a: unknown[]) => mockBillingPortal(...a),
    },
    listAccounts: (...a: unknown[]) => mockListAccounts(...a),
    changePassword: (...a: unknown[]) => mockChangePassword(...a),
  },
}));

const mockGetBillingStatus = vi.fn();
const mockUpdateBillingEmailPreferences = vi.fn();
vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...a: unknown[]) => mockGetBillingStatus(...a),
  updateBillingEmailPreferences: (...a: unknown[]) => mockUpdateBillingEmailPreferences(...a),
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
    warning: vi.fn(),
  },
}));

vi.stubGlobal('navigator', {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// Stub window.matchMedia for jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

import Account from '../../src/pages/Account';

const disabledStatus = {
  enabled: false,
  plan: 'free' as const,
  priceMonthly: { amount: null, currency: null, interval: null },
  emailPreferences: { usageAlerts: true },
  requests: { used: 0, limit: FREE_PLAN_REQUESTS_PER_MONTH, periodEnd: null },
  cancelAtPeriodEnd: false,
  subscriptionPeriodEnd: null,
};

const freeStatus = {
  enabled: true,
  plan: 'free' as const,
  priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
  emailPreferences: { usageAlerts: true },
  requests: {
    used: 120,
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

describe('Account', () => {
  let fakeTab: { location: { href: string }; opener: unknown; close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    for (const key of Object.keys(searchParamsState)) delete searchParamsState[key];
    mockGetBillingStatus.mockResolvedValue(disabledStatus);
    mockUpdateBillingEmailPreferences.mockResolvedValue({ usageAlerts: true });
    mockUpgrade.mockResolvedValue(undefined);
    mockBillingPortal.mockResolvedValue({ data: { url: 'https://billing.stripe.com/session' } });
    mockListAccounts.mockResolvedValue({ data: [{ providerId: 'credential' }], error: null });
    mockChangePassword.mockResolvedValue({ data: {}, error: null });
    fakeTab = { location: { href: '' }, opener: {}, close: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(() => fakeTab as unknown as Window);
  });

  it('renders Account Preferences heading', () => {
    render(() => <Account />);
    expect(screen.getByText('Account Preferences')).toBeDefined();
  });

  it('shows display name input with user name', () => {
    render(() => <Account />);
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.value).toBe('Test User');
  });

  it('shows email input', () => {
    render(() => <Account />);
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    expect(input.value).toBe('test@test.com');
  });

  it('shows theme options', () => {
    render(() => <Account />);
    expect(screen.getByText('Light')).toBeDefined();
    expect(screen.getByText('Dark')).toBeDefined();
    expect(screen.getByText('System')).toBeDefined();
  });

  it('shows workspace section', () => {
    render(() => <Account />);
    expect(screen.getByText('Workspace')).toBeDefined();
  });

  it('shows Back button', () => {
    render(() => <Account />);
    expect(screen.getByText('Back')).toBeDefined();
  });

  it('shows profile information section', () => {
    render(() => <Account />);
    expect(screen.getByText('Profile information')).toBeDefined();
  });

  it('shows Security section for a credential account', async () => {
    mockListAccounts.mockResolvedValue({ data: [{ providerId: 'credential' }], error: null });
    render(() => <Account />);
    expect(await screen.findByText('Security')).toBeDefined();
    expect(screen.getByLabelText('Current password')).toBeDefined();
    expect(screen.getByLabelText('New password')).toBeDefined();
    expect(screen.getByLabelText('Confirm new password')).toBeDefined();
  });

  it('hides Security section for an OAuth-only account', async () => {
    mockListAccounts.mockResolvedValue({ data: [{ providerId: 'google' }], error: null });
    render(() => <Account />);
    await screen.findByText('Profile information');
    expect(screen.queryByText('Security')).toBeNull();
  });

  it('hides Security section when listAccounts returns no data', async () => {
    mockListAccounts.mockResolvedValue({ data: null, error: { message: 'boom' } });
    render(() => <Account />);
    await screen.findByText('Profile information');
    expect(screen.queryByText('Security')).toBeNull();
  });

  const fillPw = (current: string, next: string, confirm: string) => {
    fireEvent.input(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.input(screen.getByLabelText('New password'), { target: { value: next } });
    fireEvent.input(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
  };

  it('rejects when new and confirm do not match', async () => {
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('oldpass1', 'newpass12', 'different12');
    fireEvent.click(screen.getByText('Change password'));
    expect(await screen.findByText('New passwords do not match')).toBeDefined();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('rejects a new password shorter than 8 characters', async () => {
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('oldpass1', 'short', 'short');
    fireEvent.click(screen.getByText('Change password'));
    expect(await screen.findByText('New password must be at least 8 characters')).toBeDefined();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('rejects when the new password equals the current password', async () => {
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('samepass1', 'samepass1', 'samepass1');
    fireEvent.click(screen.getByText('Change password'));
    expect(
      await screen.findByText('New password must differ from the current password'),
    ).toBeDefined();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('changes the password and revokes other sessions on success', async () => {
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('oldpass1', 'newpass12', 'newpass12');
    fireEvent.click(screen.getByText('Change password'));
    await waitFor(() =>
      expect(mockChangePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpass1',
        newPassword: 'newpass12',
        revokeOtherSessions: true,
      }),
    );
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Password changed. Other devices have been signed out.',
      ),
    );
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Confirm new password') as HTMLInputElement).value).toBe('');
  });

  it('shows an inline error when changePassword fails', async () => {
    mockChangePassword.mockResolvedValue({ data: null, error: { message: 'Invalid password' } });
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('wrongpass1', 'newpass12', 'newpass12');
    fireEvent.click(screen.getByText('Change password'));
    expect(await screen.findByText('Invalid password')).toBeDefined();
    expect(mockToastSuccess).not.toHaveBeenCalledWith(
      'Password changed. Other devices have been signed out.',
    );
  });

  it('falls back to a generic error message when changePassword error has no message', async () => {
    mockChangePassword.mockResolvedValue({ data: null, error: {} });
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('wrongpass1', 'newpass12', 'newpass12');
    fireEvent.click(screen.getByText('Change password'));
    expect(await screen.findByText('Failed to change password')).toBeDefined();
  });

  it('recovers and re-enables the button when changePassword rejects', async () => {
    mockChangePassword.mockRejectedValue(new Error('network down'));
    render(() => <Account />);
    await screen.findByText('Security');
    fillPw('oldpass1', 'newpass12', 'newpass12');
    const button = screen.getByText('Change password') as HTMLButtonElement;
    fireEvent.click(button);
    expect(await screen.findByText('Failed to change password')).toBeDefined();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('shows appearance section', () => {
    render(() => <Account />);
    expect(screen.getByText('Appearance')).toBeDefined();
  });

  it('shows workspace ID', () => {
    const { container } = render(() => <Account />);
    expect(container.textContent).toContain('u1');
  });

  it('applies light theme when Light clicked', () => {
    render(() => <Account />);
    fireEvent.click(screen.getByText('Light'));
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('applies dark theme when Dark clicked', () => {
    render(() => <Account />);
    fireEvent.click(screen.getByText('Dark'));
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('removes theme from storage when System clicked', () => {
    localStorage.setItem('theme', 'dark');
    render(() => <Account />);
    fireEvent.click(screen.getByText('System'));
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('copies user ID to clipboard when copy button clicked', () => {
    const { container } = render(() => <Account />);
    const copyBtn = container.querySelector('.settings-card__copy-btn')!;
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('u1');
  });

  it('reads stored theme on mount', () => {
    localStorage.setItem('theme', 'dark');
    render(() => <Account />);
    // Component should read and apply stored theme
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  describe('Billing', () => {
    it('hides the Billing section when billing is not enabled', async () => {
      const { container } = render(() => <Account />);
      await waitFor(() => expect(mockGetBillingStatus).toHaveBeenCalled());
      expect(screen.queryByText('Billing')).toBeNull();
      expect(screen.queryByText('Email preferences')).toBeNull();
      expect(container.querySelector('#billing')).toBeNull();
    });

    it('shows plan, usage, and comparison footer on the free plan', async () => {
      mockGetBillingStatus.mockResolvedValue(freeStatus);
      const { container } = render(() => <Account />);
      await screen.findByText('Billing');
      expect(container.querySelector('#billing')).not.toBeNull();
      expect(screen.getByText('Current plan')).toBeDefined();
      expect(screen.getByText('Free')).toBeDefined();
      expect(screen.getByText(`120 / ${FREE_REQUEST_LIMIT_LABEL}`)).toBeDefined();
      expect(screen.getByText(/Resets/)).toBeDefined();
      expect(
        screen.getByText(`Free: ${FREE_REQUEST_LIMIT_LABEL} requests/mo · Pro: unlimited requests`),
      ).toBeDefined();
      expect(screen.getByText('Email preferences')).toBeDefined();
      expect(
        (screen.getByLabelText('Receive usage alert emails') as HTMLInputElement).checked,
      ).toBe(true);
    });

    it('saves usage alert email preferences', async () => {
      mockGetBillingStatus
        .mockResolvedValueOnce(freeStatus)
        .mockResolvedValue({ ...freeStatus, emailPreferences: { usageAlerts: false } });
      mockUpdateBillingEmailPreferences.mockResolvedValue({ usageAlerts: false });
      render(() => <Account />);
      const checkbox = (await screen.findByLabelText(
        'Receive usage alert emails',
      )) as HTMLInputElement;

      fireEvent.click(checkbox);

      await waitFor(() =>
        expect(mockUpdateBillingEmailPreferences).toHaveBeenCalledWith({ usageAlerts: false }),
      );
      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Email preferences saved'));
      await waitFor(() => expect(checkbox.checked).toBe(false));
    });

    it('restores the usage alert toggle when saving fails', async () => {
      mockGetBillingStatus.mockResolvedValue(freeStatus);
      mockUpdateBillingEmailPreferences.mockRejectedValue(new Error('network'));
      render(() => <Account />);
      const checkbox = (await screen.findByLabelText(
        'Receive usage alert emails',
      )) as HTMLInputElement;

      fireEvent.click(checkbox);

      await waitFor(() =>
        expect(mockUpdateBillingEmailPreferences).toHaveBeenCalledWith({ usageAlerts: false }),
      );
      await waitFor(() => expect(checkbox.checked).toBe(true));
    });
    it('falls back to the included label when a limited plan has no usage count yet', async () => {
      mockGetBillingStatus.mockResolvedValue({
        ...freeStatus,
        requests: { used: null, limit: FREE_PLAN_REQUESTS_PER_MONTH, periodEnd: null },
      });
      render(() => <Account />);
      await screen.findByText('Billing');
      expect(screen.getByText(FREE_REQUEST_LIMIT_LABEL)).toBeDefined();
    });

    it('calls subscription.upgrade with checkout URLs when Upgrade to Pro is clicked', async () => {
      mockGetBillingStatus.mockResolvedValue(freeStatus);
      render(() => <Account />);
      const button = await screen.findByText(/Upgrade to Pro/);
      expect(button.textContent).toContain('$20/mo');
      fireEvent.click(button);
      expect(mockUpgrade).toHaveBeenCalledWith({
        plan: 'pro',
        successUrl: `${window.location.origin}/account?upgraded=1`,
        cancelUrl: `${window.location.origin}/account`,
      });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    });

    it('disables the upgrade button while the checkout call is in flight', async () => {
      mockGetBillingStatus.mockResolvedValue(freeStatus);
      let resolveUpgrade!: () => void;
      mockUpgrade.mockImplementation(
        () => new Promise<void>((resolve) => (resolveUpgrade = resolve)),
      );
      render(() => <Account />);
      const button = (await screen.findByText(/Upgrade to Pro/)) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() => expect(button.disabled).toBe(true));
      resolveUpgrade();
      await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('shows an error toast and re-enables the button when the upgrade call rejects', async () => {
      mockGetBillingStatus.mockResolvedValue(freeStatus);
      mockUpgrade.mockRejectedValue(new Error('network'));
      render(() => <Account />);
      const button = (await screen.findByText(/Upgrade to Pro/)) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          'Could not start the upgrade. Please try again.',
        ),
      );
      await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('shows an error toast and re-enables the button when the upgrade call returns an error payload', async () => {
      mockGetBillingStatus.mockResolvedValue(freeStatus);
      mockUpgrade.mockResolvedValue({ error: { message: 'network' } });
      render(() => <Account />);
      const button = (await screen.findByText(/Upgrade to Pro/)) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          'Could not start the upgrade. Please try again.',
        ),
      );
      await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('shows an error toast when the billing portal call rejects', async () => {
      mockGetBillingStatus.mockResolvedValue(proStatus);
      mockBillingPortal.mockRejectedValue(new Error('network'));
      render(() => <Account />);
      const button = (await screen.findByText('Manage subscription')) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          'Could not open the billing portal. Please try again.',
        ),
      );
      await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('shows an error toast when the portal returns no url', async () => {
      mockGetBillingStatus.mockResolvedValue(proStatus);
      mockBillingPortal.mockResolvedValue({ data: null });
      render(() => <Account />);
      const button = (await screen.findByText('Manage subscription')) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          'Could not open the billing portal. Please try again.',
        ),
      );
      // Placeholder tab was opened synchronously, then closed when no url came back.
      expect(fakeTab.close).toHaveBeenCalled();
      await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('falls back to a direct window.open when the placeholder tab is blocked', async () => {
      mockGetBillingStatus.mockResolvedValue(proStatus);
      // Popup blocker: the synchronous placeholder open returns null.
      (window.open as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
      render(() => <Account />);
      const button = await screen.findByText('Manage subscription');
      fireEvent.click(button);
      await waitFor(() =>
        expect(window.open).toHaveBeenCalledWith(
          'https://billing.stripe.com/session',
          '_blank',
          'noopener,noreferrer',
        ),
      );
    });

    it('hides the upgrade price when Stripe price is unavailable', async () => {
      mockGetBillingStatus.mockResolvedValue({
        ...freeStatus,
        priceMonthly: { amount: null, currency: null, interval: null },
      });
      render(() => <Account />);
      const button = await screen.findByText(/Upgrade to Pro/);
      expect(button.textContent).not.toContain('$');
    });

    it('shows Manage subscription on the pro plan and opens the billing portal', async () => {
      mockGetBillingStatus.mockResolvedValue(proStatus);
      render(() => <Account />);
      const button = await screen.findByText('Manage subscription');
      expect(screen.getByText('Pro · $20/mo')).toBeDefined();
      expect(screen.getByText('Unlimited')).toBeDefined();
      expect(
        screen.queryByText(new RegExp(`Free: ${FREE_REQUEST_LIMIT_LABEL} requests`)),
      ).toBeNull();
      fireEvent.click(button);
      expect(mockBillingPortal).toHaveBeenCalledWith({
        returnUrl: `${window.location.origin}/account`,
        disableRedirect: true,
      });
      // A placeholder tab opens synchronously (keeps user activation), then gets
      // pointed at the portal URL once it resolves. opener is cleared for isolation.
      expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
      expect(fakeTab.opener).toBeNull();
      await waitFor(() => expect(fakeTab.location.href).toBe('https://billing.stripe.com/session'));
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    });

    it('shows the scheduled cancellation access date for Pro users', async () => {
      mockGetBillingStatus.mockResolvedValue({
        ...proStatus,
        cancelAtPeriodEnd: true,
        subscriptionPeriodEnd: '2026-08-15T00:00:00.000Z',
      });

      render(() => <Account />);

      await screen.findByText(/You'll keep Pro access until/);
      expect(screen.getByText(/August 15, 2026/)).toBeDefined();
    });

    it('shows unlimited labels when pro limits are null', async () => {
      mockGetBillingStatus.mockResolvedValue({
        ...proStatus,
        priceMonthly: { amount: null, currency: null, interval: null },
        requests: { used: 5000, limit: null, periodEnd: null },
      });
      render(() => <Account />);
      await screen.findByText('Manage subscription');
      expect(screen.getByText('Pro')).toBeDefined();
      expect(screen.getByText('Unlimited')).toBeDefined();
    });

    it('shows a success toast and clears the param when ?upgraded=1 is present', async () => {
      searchParamsState['upgraded'] = '1';
      render(() => <Account />);
      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Welcome to Pro!'));
      expect(setSearchParamsFn).toHaveBeenCalledWith({ upgraded: undefined }, { replace: true });
      expect(searchParamsState['upgraded']).toBeUndefined();
    });
  });
});
