import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

const mockSignInSocial = vi.fn();
let mockSearchParams: Record<string, string> = {};
let mockLocationSearch = '';

vi.mock('@solidjs/router', () => ({
  useSearchParams: () => [mockSearchParams],
  useLocation: () => ({ search: mockLocationSearch }),
}));

vi.mock('../../src/services/auth-client.js', () => ({
  authClient: {
    signIn: { social: (...args: any[]) => mockSignInSocial(...args) },
  },
}));

import SocialButtons from '../../src/components/SocialButtons';
import { getLastAuthMethod } from '../../src/services/last-auth-method';

describe('SocialButtons', () => {
  beforeEach(() => {
    mockSignInSocial.mockClear();
    mockSearchParams = {};
    mockLocationSearch = '';
    localStorage.clear();
  });

  it('renders all 3 social buttons when no enabledProviders prop', () => {
    render(() => <SocialButtons />);
    expect(screen.getByText('Continue with Google')).toBeDefined();
    expect(screen.getByText('Continue with GitHub')).toBeDefined();
    expect(screen.getByText('Continue with Discord')).toBeDefined();
  });

  it('renders only enabled providers', () => {
    render(() => <SocialButtons enabledProviders={['google']} />);
    expect(screen.getByText('Continue with Google')).toBeDefined();
    expect(screen.queryByText('Continue with GitHub')).toBeNull();
    expect(screen.queryByText('Continue with Discord')).toBeNull();
  });

  it('renders nothing when enabledProviders is empty', () => {
    const { container } = render(() => <SocialButtons enabledProviders={[]} />);
    expect(container.querySelector('.auth-social-group')).toBeNull();
  });

  it('calls signIn.social on Google click', async () => {
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with Google'));
    expect(mockSignInSocial).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google' }));
  });

  it('calls signIn.social on GitHub click', async () => {
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with GitHub'));
    expect(mockSignInSocial).toHaveBeenCalledWith(expect.objectContaining({ provider: 'github' }));
  });

  it('calls signIn.social on Discord click', async () => {
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with Discord'));
    expect(mockSignInSocial).toHaveBeenCalledWith(expect.objectContaining({ provider: 'discord' }));
  });

  it('renders the Last used badge only on the matching provider', () => {
    const { container } = render(() => <SocialButtons lastUsed="github" />);
    const badges = container.querySelectorAll('.auth-last-used');
    expect(badges.length).toBe(1);
    const githubBtn = container.querySelector('.auth-social-btn--github')!;
    expect(githubBtn.querySelector('.auth-last-used')).not.toBeNull();
  });

  it('renders no badge when lastUsed does not match a social provider', () => {
    const { container } = render(() => <SocialButtons lastUsed="email" />);
    expect(container.querySelector('.auth-last-used')).toBeNull();
  });

  it('persists the chosen provider before redirecting', async () => {
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with Google'));
    expect(getLastAuthMethod()).toBe('google');
  });

  it('routes pro-intent social auth to upgrade', async () => {
    mockSearchParams = { plan: 'pro' };
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with Google'));
    expect(mockSignInSocial).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: '/upgrade',
      errorCallbackURL: '/login?plan=pro&oauth=failed',
    });
  });

  it('preserves safe redirect intent for social auth', async () => {
    mockSearchParams = { redirect: '/upgrade?reason=requests' };
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with GitHub'));
    expect(mockSignInSocial).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/upgrade?reason=requests',
      errorCallbackURL: '/login?redirect=%2Fupgrade%3Freason%3Drequests&oauth=failed',
    });
  });

  it('resumes signed MCP authorization after social sign-in', async () => {
    mockLocationSearch =
      '?client_id=client&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&ba_param=client_id&ba_param=redirect_uri&sig=abc';
    render(() => <SocialButtons />);
    await fireEvent.click(screen.getByText('Continue with Google'));
    expect(mockSignInSocial).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: `/api/auth/oauth2/authorize${mockLocationSearch}`,
      errorCallbackURL: `/login?${mockLocationSearch.slice(1)}&oauth=failed`,
    });
  });

  it('accepts a signup-specific callback override', async () => {
    render(() => <SocialButtons callbackURL="/discovery?next=%2Fwelcome&signup=1" />);
    await fireEvent.click(screen.getByText('Continue with GitHub'));
    expect(mockSignInSocial).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/discovery?next=%2Fwelcome&signup=1',
      errorCallbackURL: '/login?oauth=failed',
    });
  });
});
