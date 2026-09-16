import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

const mockSignInEmail = vi.fn().mockResolvedValue({});
const mockSendVerificationEmail = vi.fn().mockResolvedValue({});

let mockSearchParams: Record<string, string> = {};
let mockLocationSearch = '';
vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
  useLocation: () => ({ search: mockLocationSearch }),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => mockSignInEmail(...args), social: vi.fn() },
    sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
  },
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const mockCheckSocialProviders = vi.fn().mockResolvedValue([]);
vi.mock('../../src/services/setup-status.js', () => ({
  checkSocialProviders: (...args: unknown[]) => mockCheckSocialProviders(...args),
}));

import Login from '../../src/pages/Login';
import { getLastAuthMethod, setLastAuthMethod } from '../../src/services/last-auth-method';

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockLocationSearch = '';
    mockSignInEmail.mockResolvedValue({});
    mockCheckSocialProviders.mockResolvedValue([]);
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('renders welcome message', () => {
    render(() => <Login />);
    expect(screen.getByText('Welcome back')).toBeDefined();
  });

  it('renders email and password inputs', () => {
    render(() => <Login />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeDefined();
    expect(screen.getByPlaceholderText('Enter your password')).toBeDefined();
  });

  it('renders sign in button', () => {
    render(() => <Login />);
    expect(screen.getByText('Sign in')).toBeDefined();
  });

  it('dev-only button signs in with the seed admin credentials', async () => {
    mockSignInEmail.mockResolvedValue({ error: null });
    render(() => <Login />);
    fireEvent.click(screen.getByRole('button', { name: /sign in as dev/i }));
    await vi.waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: 'admin@manifest.build',
        password: 'manifest',
      });
    });
    expect(getLastAuthMethod()).toBe('email');
  });

  it('dev-only button surfaces an error when sign-in fails', async () => {
    mockSignInEmail.mockResolvedValue({ error: {} });
    const { container } = render(() => <Login />);
    fireEvent.click(screen.getByRole('button', { name: /sign in as dev/i }));
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Dev sign-in failed');
    });
  });

  it('has link to register', () => {
    render(() => <Login />);
    expect(screen.getByText('Sign up')).toBeDefined();
  });

  it('preserves the query string on the register link', () => {
    mockLocationSearch = '?plan=pro';
    const { container } = render(() => <Login />);
    expect(container.querySelector('a[href="/register?plan=pro"]')).not.toBeNull();
  });

  it('has forgot password link', () => {
    render(() => <Login />);
    expect(screen.getByText('Forgot password?')).toBeDefined();
  });

  it('shows or divider when social providers are available', async () => {
    mockCheckSocialProviders.mockResolvedValue(['google']);
    const { container } = render(() => <Login />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('or');
    });
  });

  it('hides or divider when no social providers are available', async () => {
    mockCheckSocialProviders.mockResolvedValue([]);
    const { container } = render(() => <Login />);
    await vi.waitFor(() => {
      expect(container.querySelector('.auth-divider')).toBeNull();
    });
  });

  it('submits login form', async () => {
    mockSignInEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(emailInput, { target: { value: 'test@test.com' } });
    fireEvent.input(passwordInput, { target: { value: 'password123' } });
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    await vi.waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: 'test@test.com',
        password: 'password123',
      });
    });
  });

  it('shows error on failed login', async () => {
    mockSignInEmail.mockResolvedValue({ error: { message: 'Invalid credentials' } });
    const { container } = render(() => <Login />);
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(emailInput, { target: { value: 'bad@test.com' } });
    fireEvent.input(passwordInput, { target: { value: 'wrong' } });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Invalid credentials');
    });
  });

  it('shows loading state during submission', async () => {
    mockSignInEmail.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(btn.querySelector('.spinner')).not.toBeNull();
    });
  });

  it('shows email verification prompt', async () => {
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('verify your email');
    });
  });

  it('shows resend verification button after email not verified', async () => {
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'user@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
  });

  it('calls sendVerificationEmail when resend clicked', async () => {
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'user@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send verification email'),
    )!;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(mockSendVerificationEmail).toHaveBeenCalledWith({
        email: 'user@test.com',
        callbackURL: '/',
      });
    });
  });

  it('redirects to upgrade after successful pro-intent login', async () => {
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '',
    });
    const hrefSetter = vi.fn();
    Object.defineProperty(window.location, 'href', { set: hrefSetter, configurable: true });

    mockSearchParams = { plan: 'pro' };
    mockSignInEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'password123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('/upgrade');
    });

    locationSpy.mockRestore();
  });

  it('uses a safe redirect before pro intent after successful login', async () => {
    const locationSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      href: '',
    });
    const hrefSetter = vi.fn();
    Object.defineProperty(window.location, 'href', { set: hrefSetter, configurable: true });

    mockSearchParams = { redirect: '/upgrade?reason=requests', plan: 'pro' };
    mockSignInEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'password123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(hrefSetter).toHaveBeenCalledWith('/upgrade?reason=requests');
    });

    locationSpy.mockRestore();
  });

  it('resends unverified pro logins with an upgrade callback', async () => {
    mockSearchParams = { plan: 'pro' };
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'user@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send verification email'),
    )!;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(mockSendVerificationEmail).toHaveBeenCalledWith({
        email: 'user@test.com',
        callbackURL: '/upgrade',
      });
    });
  });

  it('shows default error when authError has no message', async () => {
    mockSignInEmail.mockResolvedValue({ error: { message: '' } });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Invalid email or password');
    });
  });

  it('shows error from search params on mount', async () => {
    mockSearchParams = { error: 'oauth_failed' };
    const { container } = render(() => <Login />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Login failed');
    });
  });

  it('offers email verification after an unlinked social login', async () => {
    mockSearchParams = { oauth: 'failed', error: 'account_not_linked', redirect: '/upgrade' };
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('This email already has an account');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send verification email' }));
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();

    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'user@test.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification email' }));
    await vi.waitFor(() => {
      expect(mockSendVerificationEmail).toHaveBeenCalledWith({
        email: 'user@test.com',
        callbackURL: '/upgrade',
      });
      expect(container.textContent).toContain('Verification email sent');
    });
  });

  it('shows a generic error when social login has no error code', async () => {
    mockSearchParams = { oauth: 'failed' };
    const { container } = render(() => <Login />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Login failed');
    });
  });

  it('starts cooldown timer after resending verification email', async () => {
    vi.useFakeTimers();
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'user@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send verification email'),
    )!;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Resend in');
    });
    // Advance timer to tick down cooldown
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Resend in');
    });
    // Advance to expire cooldown
    vi.advanceTimersByTime(60000);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
    vi.useRealTimers();
  });

  it('stores email as last auth method on successful sign-in', async () => {
    mockSignInEmail.mockResolvedValue({ error: null });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'password123' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(getLastAuthMethod()).toBe('email');
    });
  });

  it('does not store last auth method when sign-in fails', async () => {
    mockSignInEmail.mockResolvedValue({ error: { message: 'nope' } });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 't@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'wrong' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('nope');
    });
    expect(getLastAuthMethod()).toBeNull();
  });

  it('forwards lastUsed to SocialButtons when previous method was a provider', async () => {
    mockCheckSocialProviders.mockResolvedValue(['github']);
    setLastAuthMethod('github');
    const { container } = render(() => <Login />);
    await vi.waitFor(() => {
      const githubBtn = container.querySelector('.auth-social-btn--github');
      expect(githubBtn).not.toBeNull();
      expect(githubBtn!.querySelector('.auth-last-used')).not.toBeNull();
    });
  });

  it('shows resend error when sendVerificationEmail fails', async () => {
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    mockSendVerificationEmail.mockResolvedValue({ error: { message: 'Rate limited' } });
    const { container } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'user@test.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send verification email'),
    )!;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Rate limited');
    });
  });

  it('clears the cooldown interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    mockSignInEmail.mockResolvedValue({
      error: { message: 'Email is not verified', code: 'EMAIL_NOT_VERIFIED' },
    });
    mockSendVerificationEmail.mockResolvedValue({ error: null });
    const { container, unmount } = render(() => <Login />);
    fireEvent.input(container.querySelector('input[type="email"]')!, {
      target: { value: 'u@t.com' },
    });
    fireEvent.input(container.querySelector('input[type="password"]')!, {
      target: { value: 'pass' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Send verification email');
    });
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Send verification email'),
    )!;
    fireEvent.click(resendBtn);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Resend in');
    });
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
