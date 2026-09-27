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

import Consent from '../../src/pages/Consent';

const mockFetch = vi.fn();

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

/** Replace `window.location` with a spy-able stand-in that keeps `search`. */
function stubLocation() {
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      assign,
      search: original.search,
      href: original.href,
      origin: original.origin,
      pathname: original.pathname,
    },
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

function setQuery(query: string): void {
  window.history.replaceState({}, '', `/consent?${query}`);
}

const VALID_QUERY =
  'client_id=c1&scope=mcp%3Aread+mcp%3Awrite&sig=s&ba_param=client_id&ba_param=scope';

describe('Consent', () => {
  let restoreLocation: (() => void) | undefined;

  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as never;
    searchParams = { client_id: 'c1', scope: 'mcp:read mcp:write' };
    setQuery(VALID_QUERY);
  });

  afterEach(() => {
    restoreLocation?.();
    restoreLocation = undefined;
    window.history.replaceState({}, '', '/');
  });

  it('shows the client, its origin, and the requested access', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ client_id: 'c1', client_name: 'Claude', client_uri: 'https://claude.ai' }),
    );
    render(() => <Consent />);
    expect(await screen.findByText('Claude')).toBeTruthy();
    expect(await screen.findByText('https://claude.ai')).toBeTruthy();
    expect(screen.getByText(/Read your harnesses/i)).toBeTruthy();
    expect(screen.getByText(/Create, change, and delete/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /allow access/i })).toBeTruthy();
  });

  it('approves and navigates to the server redirect', async () => {
    const { assign, restore } = stubLocation();
    restoreLocation = restore;
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ client_id: 'c1', client_name: 'Claude' }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://claude.ai/cb?code=1' }));

    render(() => <Consent />);
    fireEvent.click(screen.getByRole('button', { name: /allow access/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=1'));
    const consentCall = mockFetch.mock.calls.find((c) => String(c[0]).includes('/consent'));
    expect(consentCall?.[1]).toMatchObject({ method: 'POST' });
  });

  it('denies and redirects to the client callback with an error', async () => {
    const { assign, restore } = stubLocation();
    restoreLocation = restore;
    mockFetch.mockResolvedValue(jsonResponse({ url: 'https://claude.ai/cb?error=denied' }));

    render(() => <Consent />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0][0]).toContain('error=denied');
    const body = JSON.parse(mockFetch.mock.calls.at(-1)?.[1]?.body as string) as {
      accept: boolean;
    };
    expect(body.accept).toBe(false);
  });

  it('rejects a request with no signature', async () => {
    setQuery('client_id=c1&scope=mcp%3Aread');
    mockFetch.mockResolvedValue(jsonResponse({ client_id: 'c1' }));
    render(() => <Consent />);
    fireEvent.click(screen.getByRole('button', { name: /allow access/i }));
    expect(await screen.findByText(/invalid signature/i)).toBeTruthy();
  });

  it('surfaces the server error on a failed consent', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ client_id: 'c1' }))
      .mockResolvedValueOnce(jsonResponse({ error_description: 'stale request' }, false));
    render(() => <Consent />);
    fireEvent.click(screen.getByRole('button', { name: /allow access/i }));
    expect(await screen.findByText(/stale request/i)).toBeTruthy();
  });

  it('resets the busy state when the server returns no redirect', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ client_id: 'c1' }))
      .mockResolvedValueOnce(jsonResponse({}));
    render(() => <Consent />);
    const allow = screen.getByRole('button', { name: /allow access/i }) as HTMLButtonElement;
    fireEvent.click(allow);
    expect(await screen.findByText(/returned no redirect/i)).toBeTruthy();
    await waitFor(() => expect(allow.disabled).toBe(false));
  });

  it('reports a missing client id', () => {
    searchParams = {};
    render(() => <Consent />);
    expect(screen.getByText(/no client identifier/i)).toBeTruthy();
  });

  it('falls back to the raw scope for an unknown scope', async () => {
    searchParams = { client_id: 'c1', scope: 'custom:scope' };
    setQuery('client_id=c1&scope=custom%3Ascope&sig=s&ba_param=client_id&ba_param=scope');
    mockFetch.mockResolvedValue(jsonResponse({ client_id: 'c1' }));
    render(() => <Consent />);
    expect(await screen.findByText('custom:scope')).toBeTruthy();
  });

  it('reports a client lookup failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false));
    render(() => <Consent />);
    expect(await screen.findByText(/Could not load the requesting client/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /allow access/i })).toBeNull();
  });
});
