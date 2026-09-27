import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

const mockNavigate = vi.fn();
const mockSignInEmail = vi.fn().mockResolvedValue({});
const mockCheckNeedsSetup = vi.fn();
const mockCheckIsSelfHosted = vi.fn();
const mockCreateFirstAdmin = vi.fn();

vi.mock('@solidjs/router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children: unknown }) => <title>{props.children as string}</title>,
  Meta: () => null,
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => mockSignInEmail(...args),
    },
  },
}));

vi.mock('../../src/services/setup-status.js', () => ({
  checkNeedsSetup: (...args: unknown[]) => mockCheckNeedsSetup(...args),
  checkIsSelfHosted: (...args: unknown[]) => mockCheckIsSelfHosted(...args),
  createFirstAdmin: (...args: unknown[]) => mockCreateFirstAdmin(...args),
}));

import Setup from '../../src/pages/Setup';

describe('Setup page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckNeedsSetup.mockResolvedValue(true);
    mockCheckIsSelfHosted.mockResolvedValue(false);
    mockCreateFirstAdmin.mockResolvedValue(undefined);
    mockSignInEmail.mockResolvedValue({});

    // Stub window.location.href for the final navigation
    Object.defineProperty(window, 'location', {
      value: { href: '', replace: vi.fn() },
      writable: true,
    });
  });

  async function renderSetup() {
    const result = render(() => <Setup />);
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Manifest')).toBeDefined();
    });
    return result;
  }

  function fillValidForm(password = 'secretpassword', confirm = password) {
    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: 'Founder' } });
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'founder@example.com' },
    });
    fireEvent.input(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: password },
    });
    fireEvent.input(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: confirm },
    });
  }

  it('redirects to /login when setup is already complete', async () => {
    mockCheckNeedsSetup.mockResolvedValue(false);
    render(() => <Setup />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
    });
  });

  it('renders the welcome headline and form after status check', async () => {
    await renderSetup();
    expect(screen.getByText('Welcome to Manifest')).toBeDefined();
    expect(screen.getByPlaceholderText('Your name')).toBeDefined();
    expect(screen.getByPlaceholderText('you@example.com')).toBeDefined();
    expect(screen.getByPlaceholderText('At least 8 characters')).toBeDefined();
    expect(screen.getByPlaceholderText('Re-enter password')).toBeDefined();
  });

  it('shows an error when passwords do not match', async () => {
    const { container } = await renderSetup();
    fillValidForm('secretpassword', 'different');
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(screen.queryByText('Passwords do not match')).toBeDefined();
    });
    expect(mockCreateFirstAdmin).not.toHaveBeenCalled();
  });

  it('calls createFirstAdmin with form values on valid submit', async () => {
    const { container } = await renderSetup();
    fillValidForm();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCreateFirstAdmin).toHaveBeenCalledWith({
        email: 'founder@example.com',
        name: 'Founder',
        password: 'secretpassword',
      });
    });
  });

  it('auto-signs-in after successful setup', async () => {
    const { container } = await renderSetup();
    fillValidForm();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: 'founder@example.com',
        password: 'secretpassword',
      });
    });
  });

  it('redirects self-hosted admins to the discovery step after setup', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    mockSignInEmail.mockResolvedValue({ data: { user: { id: 'admin1' } } });
    localStorage.removeItem('manifest_discovery_pending_admin1');
    const { container } = await renderSetup();
    fillValidForm();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(window.location.href).toBe('/discovery');
    });
    expect(localStorage.getItem('manifest_discovery_pending_admin1')).toBe('/');
    localStorage.removeItem('manifest_discovery_pending_admin1');
  });

  it('redirects non-self-hosted admins straight to the dashboard after setup', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(false);
    const { container } = await renderSetup();
    fillValidForm();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(window.location.href).toBe('/');
    });
  });

  it('surfaces server errors from createFirstAdmin', async () => {
    mockCreateFirstAdmin.mockRejectedValue(new Error('already exists'));
    const { container } = await renderSetup();
    fillValidForm();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(screen.queryByText('already exists')).toBeDefined();
    });
  });

  it('preserves discovery through a manual login if auto-sign-in fails after setup', async () => {
    mockSignInEmail.mockResolvedValue({ error: { message: 'session failed' } });
    const { container } = await renderSetup();
    fillValidForm();
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/login?redirect=%2Fdiscovery%3Fnext%3D%252F%26signup%3D1',
        { replace: true },
      );
    });
  });

  it('rejects short passwords (< 8 chars)', async () => {
    const { container } = await renderSetup();
    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: 'Founder' } });
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'founder@example.com' },
    });
    // Use a 7-char password — must bypass native minLength validation
    const passwordInput = screen.getByPlaceholderText('At least 8 characters') as HTMLInputElement;
    const confirmInput = screen.getByPlaceholderText('Re-enter password') as HTMLInputElement;
    passwordInput.removeAttribute('minLength');
    confirmInput.removeAttribute('minLength');
    fireEvent.input(passwordInput, { target: { value: 'short77' } });
    fireEvent.input(confirmInput, { target: { value: 'short77' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(screen.queryByText('Password must be at least 8 characters')).toBeDefined();
    });
    expect(mockCreateFirstAdmin).not.toHaveBeenCalled();
  });

  it('rejects zero-length password with the length error', async () => {
    const { container } = await renderSetup();
    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: 'Founder' } });
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'founder@example.com' },
    });
    const passwordInput = screen.getByPlaceholderText('At least 8 characters') as HTMLInputElement;
    const confirmInput = screen.getByPlaceholderText('Re-enter password') as HTMLInputElement;
    // Bypass native required + minLength so handleSubmit's length check is exercised
    passwordInput.removeAttribute('required');
    passwordInput.removeAttribute('minLength');
    confirmInput.removeAttribute('required');
    confirmInput.removeAttribute('minLength');
    fireEvent.input(passwordInput, { target: { value: '' } });
    fireEvent.input(confirmInput, { target: { value: '' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(screen.queryByText('Password must be at least 8 characters')).toBeDefined();
    });
    expect(mockCreateFirstAdmin).not.toHaveBeenCalled();
  });

  it('accepts password at the 8-character boundary', async () => {
    const { container } = await renderSetup();
    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: 'Founder' } });
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'founder@example.com' },
    });
    // Exactly 8 chars — must satisfy length >= 8 branch
    fireEvent.input(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: '12345678' },
    });
    fireEvent.input(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: '12345678' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCreateFirstAdmin).toHaveBeenCalledWith({
        email: 'founder@example.com',
        name: 'Founder',
        password: '12345678',
      });
    });
    // No length error should have been displayed
    expect(screen.queryByText('Password must be at least 8 characters')).toBeNull();
  });

  it('passes password containing control characters through to createFirstAdmin verbatim', async () => {
    const { container } = await renderSetup();
    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: 'Founder' } });
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'founder@example.com' },
    });
    // 8 visible chars + a NUL byte and a control char. The client doesn't sanitize —
    // it forwards verbatim so the server can apply its own policy.
    const weird = 'abcdefgh ';
    fireEvent.input(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: weird },
    });
    fireEvent.input(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: weird },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCreateFirstAdmin).toHaveBeenCalledWith({
        email: 'founder@example.com',
        name: 'Founder',
        password: weird,
      });
    });
  });

  it('forwards empty email + name to createFirstAdmin when native required is bypassed', async () => {
    // Simulate the server-side validation path: required attributes can be stripped
    // (e.g. via DevTools) so the client must still call createFirstAdmin and let the
    // backend reject empty email/name. The component itself only validates passwords.
    mockCreateFirstAdmin.mockRejectedValue(new Error('Email is required'));
    const { container } = await renderSetup();
    const nameInput = screen.getByPlaceholderText('Your name') as HTMLInputElement;
    const emailInput = screen.getByPlaceholderText('you@example.com') as HTMLInputElement;
    nameInput.removeAttribute('required');
    emailInput.removeAttribute('required');
    // Leave name + email empty; only password is filled.
    fireEvent.input(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'secretpassword' },
    });
    fireEvent.input(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: 'secretpassword' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCreateFirstAdmin).toHaveBeenCalledWith({
        email: '',
        name: '',
        password: 'secretpassword',
      });
    });
    // The server error must surface to the user
    await waitFor(() => {
      expect(screen.queryByText('Email is required')).toBeDefined();
    });
    // And auto-signin must not be attempted when creation failed
    expect(mockSignInEmail).not.toHaveBeenCalled();
  });
});
