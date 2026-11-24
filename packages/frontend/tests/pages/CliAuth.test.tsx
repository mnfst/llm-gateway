import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

let searchParams: Record<string, string> = {};
vi.mock('@solidjs/router', () => ({
  useSearchParams: () => [searchParams, vi.fn()],
  useNavigate: () => vi.fn(),
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children?: unknown }) => <title>{String(props.children ?? '')}</title>,
  Meta: () => null,
}));

const mockFetchMutate = vi.fn();
vi.mock('../../src/services/api/core.js', () => ({
  fetchMutate: (...a: unknown[]) => mockFetchMutate(...a),
}));

import CliAuth from '../../src/pages/CliAuth';

const VALID = {
  port: '43210',
  state: 'state-abcdef1234567890',
  code_challenge: 'C'.repeat(43),
  code_challenge_method: 'S256',
};

/** Replace `window.location` with a spy-able stand-in for one test. */
function stubLocation() {
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...original, assign },
  });
  return {
    assign,
    restore: () =>
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: original,
      }),
  };
}

describe('CliAuth', () => {
  let restoreLocation: (() => void) | undefined;

  beforeEach(() => {
    mockFetchMutate.mockReset();
    searchParams = { ...VALID };
  });

  afterEach(() => {
    restoreLocation?.();
    restoreLocation = undefined;
  });

  it('shows the Authorize button for a valid request', () => {
    render(() => <CliAuth />);
    expect(screen.getByRole('button', { name: /authorize/i })).toBeTruthy();
  });

  it('states the full scope and how to revoke', () => {
    render(() => <CliAuth />);
    // The informed-consent boundary: understating the grant is a spec failure.
    expect(
      screen.getByText(/full access to your workspace\. Revoke it any time/i),
    ).toBeTruthy();
    expect(screen.getByText('mnfst logout')).toBeTruthy();
  });

  it('rejects a port below the unprivileged range', () => {
    searchParams = { ...VALID, port: '80' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
    expect(screen.getByText(/invalid/i)).toBeTruthy();
  });

  it('rejects a port above the valid range', () => {
    searchParams = { ...VALID, port: '70000' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a non-numeric port', () => {
    searchParams = { ...VALID, port: '43210abc' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a missing port', () => {
    searchParams = { state: VALID.state };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a malformed state', () => {
    searchParams = { ...VALID, state: 'bad state!' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a state shorter than 16 characters', () => {
    searchParams = { ...VALID, state: 'tooshort' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a missing state', () => {
    searchParams = { port: VALID.port };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a missing PKCE challenge', () => {
    searchParams = { port: VALID.port, state: VALID.state };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects a malformed PKCE challenge', () => {
    searchParams = { ...VALID, code_challenge: 'tooshort' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('rejects an unsupported PKCE method', () => {
    searchParams = { ...VALID, code_challenge_method: 'plain' };
    render(() => <CliAuth />);
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull();
  });

  it('authorize posts the state then navigates to the loopback callback', async () => {
    mockFetchMutate.mockResolvedValue({ code: 'the-code' });
    const { assign, restore } = stubLocation();
    restoreLocation = restore;

    render(() => <CliAuth />);
    fireEvent.click(screen.getByRole('button', { name: /authorize/i }));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(mockFetchMutate).toHaveBeenCalledWith('/cli/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: VALID.state,
        code_challenge: VALID.code_challenge,
        code_challenge_method: 'S256',
      }),
    });
    expect(assign.mock.calls[0][0]).toBe(
      'http://127.0.0.1:43210/callback?code=the-code&state=state-abcdef1234567890',
    );
  });

  it('url-encodes the code and state handed to the loopback listener', async () => {
    mockFetchMutate.mockResolvedValue({ code: 'a+b/c=' });
    const { assign, restore } = stubLocation();
    restoreLocation = restore;

    render(() => <CliAuth />);
    fireEvent.click(screen.getByRole('button', { name: /authorize/i }));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).toBe(
      'http://127.0.0.1:43210/callback?code=a%2Bb%2Fc%3D&state=state-abcdef1234567890',
    );
  });

  it('shows the close-page message after success', async () => {
    mockFetchMutate.mockResolvedValue({ code: 'the-code' });
    const { restore } = stubLocation();
    restoreLocation = restore;

    render(() => <CliAuth />);
    fireEvent.click(screen.getByRole('button', { name: /authorize/i }));

    expect(await screen.findByText(/close this page/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^authorize$/i })).toBeNull();
  });

  it('disables the button while the authorize call is in flight', async () => {
    let resolveAuthorize!: (value: { code: string }) => void;
    mockFetchMutate.mockImplementation(
      () => new Promise<{ code: string }>((resolve) => (resolveAuthorize = resolve)),
    );
    const { restore } = stubLocation();
    restoreLocation = restore;

    render(() => <CliAuth />);
    const button = screen.getByRole('button', { name: /authorize/i }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toMatch(/authorizing/i);

    resolveAuthorize({ code: 'the-code' });
    expect(await screen.findByText(/close this page/i)).toBeTruthy();
  });

  it('shows the server error when authorization fails', async () => {
    mockFetchMutate.mockRejectedValue(new Error('nope'));
    render(() => <CliAuth />);
    fireEvent.click(screen.getByRole('button', { name: /authorize/i }));
    expect(await screen.findByText(/nope/)).toBeTruthy();
  });

  it('stringifies a non-Error rejection', async () => {
    mockFetchMutate.mockRejectedValue('plain string failure');
    render(() => <CliAuth />);
    fireEvent.click(screen.getByRole('button', { name: /authorize/i }));
    expect(await screen.findByText(/plain string failure/)).toBeTruthy();
  });

  it('lets the user retry after a failure', async () => {
    mockFetchMutate.mockRejectedValueOnce(new Error('nope'));
    const { assign, restore } = stubLocation();
    restoreLocation = restore;

    render(() => <CliAuth />);
    fireEvent.click(screen.getByRole('button', { name: /authorize/i }));
    // The failure leaves a live button, not a dead end.
    const retry = (await screen.findByRole('button', { name: /try again/i })) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    mockFetchMutate.mockResolvedValue({ code: 'the-code' });
    fireEvent.click(retry);

    await waitFor(() => expect(mockFetchMutate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(await screen.findByText(/close this page/i)).toBeTruthy();
    // The error box clears once the retry is under way.
    expect(screen.queryByText(/nope/)).toBeNull();
  });
});
