import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

const mockSignOut = vi.fn().mockResolvedValue(undefined);
const mockNavigate = vi.fn();
const mockGetBillingStatus = vi.fn().mockResolvedValue({ enabled: false, plan: 'free' });
const mockLocationReplace = vi.fn();
let mockPathname = '/';

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    useSession: () => () => ({
      data: { user: { id: 'u1', name: 'Alice', email: 'alice@test.com' } },
      isPending: false,
    }),
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}));

let mockAgentName: string | null = null;
vi.mock('../../src/services/routing.js', () => ({
  useAgentName: () => () => mockAgentName,
}));

vi.mock('../../src/services/api.js', () => ({
  duplicateAgent: vi.fn(),
  getDuplicatePreview: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/services/recent-agents.js', () => ({
  markAgentCreated: vi.fn(),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

let mockAgentDisplayName: string | null = null;
vi.mock('../../src/services/agent-display-name.js', () => ({
  agentDisplayName: () => mockAgentDisplayName,
}));

const mockCheckIsSelfHosted = vi.fn().mockResolvedValue(false);
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => mockCheckIsSelfHosted(),
}));

vi.mock('../../src/services/api/billing.js', () => ({
  getBillingStatus: (...args: unknown[]) => mockGetBillingStatus(...args),
}));

vi.mock('../../src/components/NotificationBell.jsx', () => ({
  default: () => null,
}));

import Header from '../../src/components/Header';
import { setConnectionBreadcrumb } from '../../src/services/connection-breadcrumb-store';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    replace: mockLocationReplace,
  });
  sessionStorage.clear();
  mockPathname = '/';
  mockAgentName = null;
  mockAgentDisplayName = null;
  mockGetBillingStatus.mockReset();
  mockGetBillingStatus.mockResolvedValue({ enabled: false, plan: 'free' });
  mockLocationReplace.mockReset();
  mockCheckIsSelfHosted.mockReset();
  mockCheckIsSelfHosted.mockResolvedValue(false);
  // The breadcrumb store is a real module-level signal; reset it so a value
  // set in one test never leaks into another.
  setConnectionBreadcrumb(null);
});

describe('Header', () => {
  it('renders logo', () => {
    const { container } = render(() => <Header />);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
  });

  it('shows user initials', () => {
    render(() => <Header />);
    expect(screen.getByText('A')).toBeDefined();
  });

  it('shows user menu button', () => {
    render(() => <Header />);
    expect(screen.getByLabelText('User menu')).toBeDefined();
  });

  it('opens dropdown on click', async () => {
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('User menu'));
    expect(screen.getByText('Alice')).toBeDefined();
    expect(screen.getByText('alice@test.com')).toBeDefined();
  });

  it('shows Account Preferences link in dropdown', async () => {
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('User menu'));
    expect(screen.getByText('Account Preferences')).toBeDefined();
  });

  it('shows Log out button in dropdown', async () => {
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('User menu'));
    expect(screen.getByText('Log out')).toBeDefined();
  });

  it('calls signOut when Log out clicked', async () => {
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('User menu'));
    await fireEvent.click(screen.getByText('Log out'));
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('navigates to login after signOut', async () => {
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('User menu'));
    await fireEvent.click(screen.getByText('Log out'));
    await vi.waitFor(() => {
      expect(mockLocationReplace).toHaveBeenCalledWith('/login');
    });
  });

  it('closes dropdown when clicking outside', async () => {
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('User menu'));
    expect(screen.getByText('Alice')).toBeDefined();
    await fireEvent.click(document.body);
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('renders the closed mobile navigation toggle', () => {
    render(() => <Header showMobileNavToggle mobileNavOpen={false} />);

    const toggle = screen.getByLabelText('Open navigation menu');
    expect(toggle.getAttribute('aria-controls')).toBe('agent-navigation');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders the open mobile navigation toggle and handles clicks', async () => {
    const onMobileNavToggle = vi.fn();

    render(() => (
      <Header showMobileNavToggle mobileNavOpen onMobileNavToggle={onMobileNavToggle} />
    ));

    const toggle = screen.getByLabelText('Close navigation menu');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await fireEvent.click(toggle);

    expect(onMobileNavToggle).toHaveBeenCalledTimes(1);
  });
});

describe('Header - GitHub star button', () => {
  it('renders the star button with link to GitHub repo', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 1234 })),
    );
    const { container } = render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('Star')).toBeDefined();
    });
    const link = container.querySelector('.header__github-star-btn') as HTMLAnchorElement;
    expect(link).toBeDefined();
    expect(link.href).toContain('github.com/mnfst/llm-gateway');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('fetches and displays the star count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 5678 })),
    );
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('5,678')).toBeDefined();
    });
  });

  it('formats large star counts with locale separators', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 12345 })),
    );
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('12,345')).toBeDefined();
    });
  });

  it('renders star button without count when API returns non-numeric value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 'not a number' })),
    );
    const { container } = render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('Star')).toBeDefined();
    });
    expect(container.querySelector('.header__github-star-count')).toBeNull();
  });

  it('renders star button without count when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    const { container } = render(() => <Header />);
    // Star label should still appear
    await vi.waitFor(() => {
      expect(screen.getByText('Star')).toBeDefined();
    });
    expect(container.querySelector('.header__github-star-count')).toBeNull();
  });

  it('shows dismiss button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 100 })),
    );
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Dismiss GitHub star button')).toBeDefined();
    });
  });

  it('hides star button when dismiss is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 100 })),
    );
    const { container } = render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('Star')).toBeDefined();
    });
    await fireEvent.click(screen.getByLabelText('Dismiss GitHub star button'));
    expect(container.querySelector('.header__github-star')).toBeNull();
  });

  it('persists dismiss state in sessionStorage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 100 })),
    );
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('Star')).toBeDefined();
    });
    await fireEvent.click(screen.getByLabelText('Dismiss GitHub star button'));
    expect(sessionStorage.getItem('github-star-dismissed')).toBe('true');
  });

  it('does not render star button if previously dismissed', async () => {
    sessionStorage.setItem('github-star-dismissed', 'true');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ stars: 100 })));
    const { container } = render(() => <Header />);
    expect(container.querySelector('.header__github-star')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch star count if dismissed', () => {
    sessionStorage.setItem('github-star-dismissed', 'true');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ stars: 100 })));
    render(() => <Header />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses cached star count from sessionStorage', async () => {
    sessionStorage.setItem('github-star-count', '9999');
    sessionStorage.setItem('github-star-ts', String(Date.now()));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('9,999')).toBeDefined();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches fresh count when cache is expired', async () => {
    sessionStorage.setItem('github-star-count', '9999');
    sessionStorage.setItem('github-star-ts', String(Date.now() - 4000000));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 5555 })),
    );
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('5,555')).toBeDefined();
    });
  });

  it('caches star count in sessionStorage after fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ stars: 4321 })),
    );
    render(() => <Header />);
    await vi.waitFor(() => {
      expect(screen.getByText('4,321')).toBeDefined();
    });
    expect(sessionStorage.getItem('github-star-count')).toBe('4321');
    expect(sessionStorage.getItem('github-star-ts')).toBeDefined();
  });
});

describe('Header - breadcrumb', () => {
  it('logo links to /', () => {
    const { container } = render(() => <Header />);
    const logoLink = container.querySelector('.header__logo') as HTMLAnchorElement;
    expect(logoLink.getAttribute('href')).toBe('/');
  });

  it('shows only the active agent breadcrumb when agent is active', () => {
    mockAgentName = 'my-agent';
    const { container } = render(() => <Header />);
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(container.querySelector('.header__breadcrumb-current')?.textContent).toContain(
      'my-agent',
    );
    expect(container.querySelectorAll('.header__separator').length).toBe(2);
  });
});

describe('Header - docs link', () => {
  const docsHref = (container: HTMLElement) =>
    container.querySelector('.header__docs-link')?.getAttribute('href');

  it('links agent routing pages to routing docs', () => {
    mockPathname = '/harnesses/my-agent/routing';
    const { container } = render(() => <Header />);
    expect(docsHref(container)).toBe('https://manifest.build/llm-gateway/docs/llm-gateway/');
  });

  it('links the current Limits route to limits docs', () => {
    mockPathname = '/harnesses/my-agent/guardrails';
    const { container } = render(() => <Header />);
    expect(docsHref(container)).toBe('https://manifest.build/llm-gateway/docs/observability/');
  });

  it('keeps the legacy Limits route mapped to limits docs', () => {
    mockPathname = '/harnesses/my-agent/limits';
    const { container } = render(() => <Header />);
    expect(docsHref(container)).toBe('https://manifest.build/llm-gateway/docs/observability/');
  });

  it('links provider pages to matching provider docs', () => {
    mockPathname = '/providers/subscriptions';
    const subscriptions = render(() => <Header />);
    expect(docsHref(subscriptions.container)).toBe(
      'https://manifest.build/llm-gateway/docs/providers/subscription-based-providers/',
    );

    mockPathname = '/providers/byok';
    const byok = render(() => <Header />);
    expect(docsHref(byok.container)).toBe(
      'https://manifest.build/llm-gateway/docs/providers/api-key-providers/',
    );

    mockPathname = '/providers/local';
    const local = render(() => <Header />);
    expect(docsHref(local.container)).toBe('https://manifest.build/llm-gateway/docs/providers/local-models/');
  });

  it('falls back to introduction docs for unmapped pages', () => {
    mockPathname = '/messages';
    const { container } = render(() => <Header />);
    expect(docsHref(container)).toBe('https://manifest.build/llm-gateway/docs/introduction/');
  });
});

describe('Header - gear dropdown', () => {
  it('shows gear button when on an agent page', () => {
    mockAgentName = 'my-agent';
    render(() => <Header />);
    expect(screen.getByLabelText('Harness actions')).toBeDefined();
  });

  it('does not show gear button when not on an agent page', () => {
    mockAgentName = null;
    render(() => <Header />);
    expect(screen.queryByLabelText('Harness actions')).toBeNull();
  });

  it('opens dropdown with Settings and Duplicate items', async () => {
    mockAgentName = 'my-agent';
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('Harness actions'));
    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.getByText('Duplicate harness')).toBeDefined();
  });

  it('Settings links to the agent settings page', async () => {
    mockAgentName = 'my-agent';
    const { container } = render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('Harness actions'));
    const settingsLink = container.querySelector('a[href="/harnesses/my-agent/settings"]');
    expect(settingsLink).not.toBeNull();
  });

  it('closes gear dropdown when clicking outside', async () => {
    mockAgentName = 'my-agent';
    render(() => <Header />);
    await fireEvent.click(screen.getByLabelText('Harness actions'));
    expect(screen.getByText('Settings')).toBeDefined();
    await fireEvent.click(document.body);
    expect(screen.queryByText('Duplicate harness')).toBeNull();
  });
});

describe('Header - self-hosted badge', () => {
  it('renders the Self-hosted badge when isSelfHosted is true', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    const { container } = render(() => <Header />);
    await new Promise((r) => setTimeout(r, 0));
    const badge = container.querySelector('.header__mode-badge:not(.header__mode-badge--dev)');
    expect(badge).not.toBeNull();
    expect(badge?.textContent?.trim()).toBe('Self-hosted');
  });

  it('does not render the Self-hosted badge in cloud mode', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(false);
    const { container } = render(() => <Header />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.header__mode-badge:not(.header__mode-badge--dev)')).toBeNull();
  });
});

describe('Header - connection breadcrumb', () => {
  it('renders the connection breadcrumb (back link, provider icon, name, label) when no agent is active', () => {
    // No :agentName route param → getAgentName() is falsy, so the agent
    // breadcrumb is hidden and the connection breadcrumb takes over.
    mockAgentName = null;
    setConnectionBreadcrumb(
      'OpenAI Default',
      '/providers/usage-based',
      'Usage-based',
      'openai',
      'Default',
    );
    const { container } = render(() => <Header />);

    // Back link points at the configured route and shows the back label.
    const backLink = container.querySelector('a[href="/providers/usage-based"]');
    expect(backLink).not.toBeNull();
    expect(backLink!.textContent).toContain('Usage-based');

    // The connection name renders.
    expect(container.textContent).toContain('OpenAI Default');

    // providerId set → the provider icon (an inline SVG for 'openai') renders.
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    // label set → the secondary label text renders.
    expect(container.textContent).toContain('Default');

    // The crumb reuses the harness breadcrumb classes so the phone breakpoint
    // can hide the parent link and truncate the name instead of wrapping it.
    expect(backLink!.classList.contains('header__breadcrumb-link')).toBe(true);
    const current = container.querySelector('.header__breadcrumb-current');
    expect(current?.textContent).toContain('OpenAI Default');
    expect(current?.querySelector('.header__breadcrumb-label')?.textContent).toBe('Default');
  });

  it('renders the connection breadcrumb name without an icon or label when those are omitted', () => {
    // providerId + label omitted → both the icon <Show> and label <Show>
    // fall through, but the name still renders.
    mockAgentName = null;
    setConnectionBreadcrumb('Anthropic', '/providers/subscriptions', 'Subscriptions');
    const { container } = render(() => <Header />);

    const backLink = container.querySelector('a[href="/providers/subscriptions"]');
    expect(backLink).not.toBeNull();
    expect(backLink!.textContent).toContain('Subscriptions');
    expect(container.textContent).toContain('Anthropic');
  });

  it('hides the connection breadcrumb when an agent IS active', () => {
    // getAgentName() truthy → the `!getAgentName()` guard fails, so even with a
    // breadcrumb set the connection block stays hidden.
    mockAgentName = 'my-agent';
    setConnectionBreadcrumb(
      'OpenAI Default',
      '/providers/usage-based',
      'Usage-based',
      'openai',
      'Default',
    );
    const { container } = render(() => <Header />);
    expect(container.querySelector('a[href="/providers/usage-based"]')).toBeNull();
  });
});
