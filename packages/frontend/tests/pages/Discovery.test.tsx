import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

const mockNavigate = vi.fn();
const mockCheckIsSelfHosted = vi.fn();
const mockIsDiscoveryRequired = vi.fn();
const mockCompleteDiscovery = vi.fn();
const mockMarkDiscoveryPending = vi.fn();
const mockClearDiscoveryPending = vi.fn();
const mockIsConfirmedNotSelfHosted = vi.fn();
let mockSearchParams: Record<string, string | string[] | undefined> = {};

vi.mock('@solidjs/router', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children: unknown }) => <title>{props.children as string}</title>,
  Meta: () => null,
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1', name: 'Test User', email: 'test@test.com' } },
      isPending: false,
    }),
  },
}));

vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: (...args: unknown[]) => mockCheckIsSelfHosted(...args),
}));

vi.mock('../../src/services/discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/discovery.js')>();
  return {
    ...actual,
    isDiscoveryRequired: (...args: unknown[]) => mockIsDiscoveryRequired(...args),
    completeDiscovery: (...args: unknown[]) => mockCompleteDiscovery(...args),
    markDiscoveryPending: (...args: unknown[]) => mockMarkDiscoveryPending(...args),
    clearDiscoveryPending: (...args: unknown[]) => mockClearDiscoveryPending(...args),
    isConfirmedNotSelfHosted: (...args: unknown[]) => mockIsConfirmedNotSelfHosted(...args),
  };
});

import Discovery from '../../src/pages/Discovery';

describe('Discovery page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockCheckIsSelfHosted.mockResolvedValue(true);
    mockIsDiscoveryRequired.mockResolvedValue(true);
    mockCompleteDiscovery.mockResolvedValue(undefined);
    mockIsConfirmedNotSelfHosted.mockResolvedValue(true);
  });

  async function renderForm() {
    const result = render(() => <Discovery />);
    await waitFor(() => {
      expect(screen.queryByText('Help us understand who uses Manifest')).not.toBeNull();
    });
    return result;
  }

  it('redirects to the dashboard on non-self-hosted deployments', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(false);
    render(() => <Discovery />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
    expect(mockIsDiscoveryRequired).not.toHaveBeenCalled();
    expect(screen.queryByText('Help us understand who uses Manifest')).toBeNull();
    // The pending marker is dropped so the guards cannot loop back here.
    expect(mockClearDiscoveryPending).toHaveBeenCalledWith('u1');
  });

  it('behaves as self-hosted when the non-self-hosted answer is unconfirmed', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(false);
    mockIsConfirmedNotSelfHosted.mockResolvedValue(false);
    await renderForm();
    // No redirect and no marker loss: leaving while the marker stands would
    // let the guards loop the user back here forever.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockClearDiscoveryPending).not.toHaveBeenCalled();
  });

  it('redirects to next when the step was already completed', async () => {
    mockSearchParams = { next: '/welcome' };
    mockIsDiscoveryRequired.mockResolvedValue(false);
    render(() => <Discovery />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/welcome', { replace: true });
    });
    expect(mockIsDiscoveryRequired).toHaveBeenCalledWith('u1');
  });

  it('falls back to the dashboard for unsafe next params', async () => {
    mockSearchParams = { next: 'https://evil.example' };
    mockIsDiscoveryRequired.mockResolvedValue(false);
    render(() => <Discovery />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('uses the first value of an array next param', async () => {
    mockSearchParams = { next: ['/welcome', '/other'] };
    mockIsDiscoveryRequired.mockResolvedValue(false);
    render(() => <Discovery />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/welcome', { replace: true });
    });
  });

  it('renders the form for a new self-hosted user', async () => {
    await renderForm();
    expect(screen.getByPlaceholderText('Your name')).toBeDefined();
    expect(screen.getByPlaceholderText('you@example.com')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'What type of project are you working on?' }),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'How big is your company?' })).toBeDefined();
    expect(screen.getByText('Continue')).toBeDefined();
    expect(screen.getByText('Skip')).toBeDefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('marks the step pending when the form is shown, so Back returns to it', async () => {
    mockSearchParams = { next: '/welcome' };
    await renderForm();
    expect(mockMarkDiscoveryPending).toHaveBeenCalledWith('u1', '/welcome');
  });

  it('creates the per-user marker after a social signup callback', async () => {
    mockSearchParams = { next: '/welcome', signup: '1' };
    await renderForm();
    expect(mockMarkDiscoveryPending).toHaveBeenCalledWith('u1', '/welcome');
    expect(mockMarkDiscoveryPending.mock.invocationCallOrder[0]!).toBeLessThan(
      mockIsDiscoveryRequired.mock.invocationCallOrder[0]!,
    );
  });

  it('does not mark the step pending when redirecting away', async () => {
    mockIsDiscoveryRequired.mockResolvedValue(false);
    render(() => <Discovery />);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
    expect(mockMarkDiscoveryPending).not.toHaveBeenCalled();
  });

  it('submits only the provided fields and redirects to next', async () => {
    mockSearchParams = { next: '/welcome' };
    const { container } = await renderForm();

    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: '  Seb  ' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'What type of project are you working on?' }),
    );
    fireEvent.click(screen.getByText('AI agent'));
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCompleteDiscovery).toHaveBeenCalledWith('u1', {
        name: 'Seb',
        projectType: 'ai_agent',
      });
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/welcome', { replace: true });
    });
  });

  it('submits every field when all are filled', async () => {
    const { container } = await renderForm();

    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: 'Seb' } });
    fireEvent.input(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'seb@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'What type of project are you working on?' }),
    );
    fireEvent.click(screen.getByText('Other'));
    fireEvent.click(screen.getByRole('button', { name: 'How big is your company?' }));
    fireEvent.click(screen.getByText('1–20'));
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCompleteDiscovery).toHaveBeenCalledWith('u1', {
        name: 'Seb',
        email: 'seb@example.com',
        projectType: 'other',
        companySize: '1-20',
      });
    });
  });

  it('submits an empty payload when nothing was filled', async () => {
    const { container } = await renderForm();
    fireEvent.input(screen.getByPlaceholderText('Your name'), { target: { value: '   ' } });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(mockCompleteDiscovery).toHaveBeenCalledWith('u1', {});
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('skips with an empty payload and redirects', async () => {
    mockSearchParams = { next: '/welcome' };
    await renderForm();
    fireEvent.click(screen.getByText('Skip'));

    await waitFor(() => {
      expect(mockCompleteDiscovery).toHaveBeenCalledWith('u1', {});
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/welcome', { replace: true });
    });
  });

  it('ignores repeated clicks while completing', async () => {
    let resolveComplete: () => void = () => {};
    mockCompleteDiscovery.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveComplete = resolve;
        }),
    );
    await renderForm();

    fireEvent.click(screen.getByText('Skip'));
    fireEvent.click(screen.getByText('Skip'));
    resolveComplete();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    expect(mockCompleteDiscovery).toHaveBeenCalledTimes(1);
  });
});
