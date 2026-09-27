import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

const mockSignUpEmail = vi.fn().mockResolvedValue({});
const mockSignInSocial = vi.fn().mockResolvedValue({});
const mockSendVerificationEmail = vi.fn().mockResolvedValue({});
const mockSubscriptionUpgrade = vi.fn().mockResolvedValue({});
const mockGetBillingStatus = vi.fn().mockResolvedValue({ enabled: false, plan: 'free' });
const mockCheckIsSelfHosted = vi.fn().mockResolvedValue(false);
const mockCheckSocialProviders = vi.fn().mockResolvedValue([]);
const mockNavigate = vi.fn();
const mockToastError = vi.fn();
let mockLocationSearch = '';
let mockSearchParams: Record<string, string | undefined> = {};

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
  useLocation: () => ({ search: mockLocationSearch }),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1', name: 'Test User', email: 'test@test.com' } },
      isPending: false,
    }),
    signUp: { email: (...args: unknown[]) => mockSignUpEmail(...args) },
    signIn: { social: (...args: unknown[]) => mockSignInSocial(...args) },
    sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
    subscription: { upgrade: (...args: unknown[]) => mockSubscriptionUpgrade(...args) },
  },
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../src/services/setup-status.js', () => ({
  checkSocialProviders: (...args: unknown[]) => mockCheckSocialProviders(...args),
  checkIsSelfHosted: (...args: unknown[]) => mockCheckIsSelfHosted(...args),
}));

import Register from '../../src/pages/Register';
import { getLastAuthMethod } from '../../src/services/last-auth-method';

describe('Register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignUpEmail.mockResolvedValue({});
    mockSignInSocial.mockResolvedValue({});
    mockSubscriptionUpgrade.mockResolvedValue({});
    mockGetBillingStatus.mockResolvedValue({ enabled: false, plan: 'free' });
    mockCheckIsSelfHosted.mockResolvedValue(false);
    mockCheckSocialProviders.mockResolvedValue([]);
    mockLocationSearch = '';
    mockSearchParams = {};
    localStorage.clear();
  });

  it('renders create account heading', () => {
    render(() => <Register />);
    expect(screen.getByText('Create an account')).toBeDefined();
  });

  it('renders name, email, and password inputs', () => {
    render(() => <Register />);
    expect(screen.getByPlaceholderText('Your name')).toBeDefined();
    expect(screen.getByPlaceholderText('you@example.com')).toBeDefined();
    expect(screen.getByPlaceholderText('Create a password')).toBeDefined();
  });

  it('renders create account button', () => {
    render(() => <Register />);
    expect(screen.getByText('Create account')).toBeDefined();
  });

  it('has link to sign in', () => {
    render(() => <Register />);
    expect(screen.getByText('Sign in')).toBeDefined();
  });

  it('preserves the query string on sign-in links', () => {
    mockLocationSearch = '?plan=pro';
    const { container } = render(() => <Register />);
    expect(container.querySelector('a[href="/login?plan=pro"]')).not.toBeNull();
  });

  it('shows terms and privacy links', () => {
    render(() => <Register />);
    expect(screen.getByText('Terms')).toBeDefined();
    expect(screen.getByText('Privacy Policy')).toBeDefined();
  });

  it('submits registration form', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalled();
    });
  });

  it('passes the upgrade callback to signup', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledWith({
        name: 'Test',
        email: 'test@test.com',
        password: 'pass123',
        callbackURL: '/welcome',
      });
    });
  });

  it('shows email verification after successful signup', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Check your email');
    });
  });

  it('shows error on failed registration', async () => {
    mockSignUpEmail.mockResolvedValue({ error: { message: 'Something went wrong' } });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'exists@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Something went wrong');
    });
    // Should NOT show the "already exists" variant
    expect(container.textContent).not.toContain('An account with this email already exists');
  });

  it('shows already-exists error with sign-in and reset links', async () => {
    mockSignUpEmail.mockResolvedValue({
      error: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists' },
    });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'exists@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('An account with this email already exists');
    });
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
    expect(container.querySelector('a[href="/reset-password"]')).not.toBeNull();
  });

  it('redirects directly to /welcome when signup returns a token', async () => {
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '',
    });
    const hrefSetter = vi.fn();
    Object.defineProperty(window.location, 'href', { set: hrefSetter, configurable: true });

    mockSignUpEmail.mockResolvedValue({
      data: { token: 'tok', user: { id: 'u1' } },
      error: null,
    });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'new@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('/welcome');
    });

    locationSpy.mockRestore();
  });

  it('routes self-hosted email signups through the discovery step', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    // Let onMount resolve checkIsSelfHosted before submitting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledWith({
        name: 'Test',
        email: 'test@test.com',
        password: 'pass123',
        callbackURL: '/discovery?next=%2Fwelcome',
      });
    });
  });

  it('routes self-hosted social signups through the discovery step', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    mockCheckSocialProviders.mockResolvedValue(['github']);
    render(() => <Register />);

    await fireEvent.click(await screen.findByText('Continue with GitHub'));

    expect(mockSignInSocial).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/discovery?next=%2Fwelcome&signup=1',
      errorCallbackURL: '/login?oauth=failed',
    });
  });

  it('redirects self-hosted token signups to the discovery step', async () => {
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '',
    });
    const hrefSetter = vi.fn();
    Object.defineProperty(window.location, 'href', { set: hrefSetter, configurable: true });

    mockCheckIsSelfHosted.mockResolvedValue(true);
    mockSignUpEmail.mockResolvedValue({
      data: { token: 'tok', user: { id: 'u1' } },
      error: null,
    });
    const { container } = render(() => <Register />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'new@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('/discovery?next=%2Fwelcome');
    });
    // The pending marker lets the guards route Back presses to the form.
    expect(localStorage.getItem('manifest_discovery_pending_u1')).toBe('/welcome');

    locationSpy.mockRestore();
  });

  it('redirects already-Pro users away from the plan step', async () => {
    mockSearchParams = { step: 'plan' };
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: 'pro',
      priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
    });

    render(() => <Register />);

    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('lets users choose the free plan from the plan step', async () => {
    const replace = vi.fn();
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      replace,
    });
    mockSearchParams = { step: 'plan' };
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: 'free',
      priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
    });

    const { container } = render(() => <Register />);
    await screen.findByText('Choose your plan');

    const freeCard = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.plan-picker__card'),
    ).find((card) => card.textContent?.includes('Free'));
    if (!freeCard) throw new Error('Free plan card not found');
    fireEvent.click(freeCard);
    fireEvent.click(container.querySelector('.plan-picker__cta')!);

    expect(replace).toHaveBeenCalledWith('/');
    locationSpy.mockRestore();
  });

  it('starts Pro checkout from the plan step', async () => {
    mockSearchParams = { step: 'plan' };
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: 'free',
      priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
    });

    const { container } = render(() => <Register />);
    await screen.findByText('Choose your plan');
    fireEvent.click(container.querySelector('.plan-picker__cta')!);

    await vi.waitFor(() => {
      expect(mockSubscriptionUpgrade).toHaveBeenCalledWith({
        plan: 'pro',
        successUrl: `${window.location.origin}/overview?upgraded=1`,
        cancelUrl: `${window.location.origin}/register?step=plan`,
      });
    });
  });

  it('shows an error toast when Pro checkout returns an error payload from the plan step', async () => {
    mockSearchParams = { step: 'plan' };
    mockSubscriptionUpgrade.mockResolvedValue({ error: { message: 'stripe down' } });
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: 'free',
      priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
    });

    const { container } = render(() => <Register />);
    await screen.findByText('Choose your plan');
    fireEvent.click(container.querySelector('.plan-picker__cta')!);

    await vi.waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Could not start the upgrade. Please try again.'),
    );
  });

  it('shows loading state during submission', async () => {
    mockSignUpEmail.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(btn.querySelector('.spinner')).not.toBeNull();
    });
  });

  it('shows resend button after successful signup', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Click the link in your email');
    });
    // Resend button should be present (with cooldown since startCooldown was called)
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Resend in'),
    );
    expect(resendBtn).not.toBeUndefined();
  });

  it('calls sendVerificationEmail on resend click after cooldown', async () => {
    vi.useFakeTimers();
    mockSignUpEmail.mockResolvedValue({ error: null });
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Check your email');
    });
    // Fast-forward past cooldown
    vi.advanceTimersByTime(61000);
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Resend verification email'),
    );
    if (resendBtn) {
      fireEvent.click(resendBtn);
      await vi.waitFor(() => {
        expect(mockSendVerificationEmail).toHaveBeenCalledWith({
          email: 'test@test.com',
          callbackURL: '/welcome',
        });
      });
    }
    vi.useRealTimers();
  });

  it('shows error when resend fails', async () => {
    vi.useFakeTimers();
    mockSignUpEmail.mockResolvedValue({ error: null });
    mockSendVerificationEmail.mockResolvedValue({ error: { message: 'Too many requests' } });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Check your email');
    });
    vi.advanceTimersByTime(61000);
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Resend verification email'),
    );
    if (resendBtn) {
      fireEvent.click(resendBtn);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('Too many requests');
      });
    }
    vi.useRealTimers();
  });

  it('stores email as last auth method on successful signup', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(getLastAuthMethod()).toBe('email');
    });
  });

  it('does not store last auth method when signup fails', async () => {
    mockSignUpEmail.mockResolvedValue({ error: { message: 'boom' } });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('boom');
    });
    expect(getLastAuthMethod()).toBeNull();
  });

  it('shows back to sign in link on verification screen', async () => {
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      const link = container.querySelector('a[href="/login"]');
      expect(link).not.toBeNull();
    });
  });

  it('shows "Choose your plan" title when context=login (existing/OAuth user)', async () => {
    mockSearchParams = { step: 'plan', context: 'login' };
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: 'free',
      priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
    });

    render(() => <Register />);
    await vi.waitFor(() => {
      expect(screen.getByText('Choose your plan')).toBeDefined();
    });
    expect(screen.getByText(/Manifest now offers Free and Pro plans/)).toBeDefined();
  });

  it('shows "Create an account" title without context=login (email signup)', async () => {
    mockSearchParams = { step: 'plan' };
    mockGetBillingStatus.mockResolvedValue({
      enabled: true,
      plan: 'free',
      priceMonthly: { amount: 20, currency: 'USD', interval: 'month' },
    });

    render(() => <Register />);
    await vi.waitFor(() => {
      expect(screen.getByText('Create an account')).toBeDefined();
    });
  });

  it('clears the cooldown interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    mockSignUpEmail.mockResolvedValue({ error: null });
    const { container, unmount } = render(() => <Register />);
    fireEvent.input(container.querySelector('input[type="text"]')!, { target: { value: 'Test' } });
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'test@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass12345' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Resend in');
    });
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
