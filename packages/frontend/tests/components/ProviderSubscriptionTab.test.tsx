import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

import ProviderSubscriptionTab from '../../src/components/ProviderSubscriptionTab';
import type { ProviderDef } from '../../src/services/providers';

const provider = (overrides: Partial<ProviderDef> & { id: string; name: string }): ProviderDef =>
  ({
    color: '#333',
    initial: overrides.name.charAt(0),
    supportsSubscription: true,
    subtitle: '',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: '',
    models: [],
    ...overrides,
  }) as ProviderDef;

const baseProps = {
  busy: () => false,
  isSubscriptionConnected: () => false,
  isSubscriptionWithToken: () => false,
  onOpenDetail: vi.fn(),
  onAddKey: vi.fn(),
  onToggle: vi.fn(),
};

const renderTab = (
  subs: ProviderDef[],
  overrides: Partial<typeof baseProps> = {},
) =>
  render(() => (
    <ProviderSubscriptionTab
      {...baseProps}
      {...overrides}
      subscriptionProviders={subs}
    />
  ));

describe('ProviderSubscriptionTab', () => {
  it('renders the hint, link, and falls back to default "Subscription" label', () => {
    const { container } = renderTab([provider({ id: 'p1', name: 'Provider One' })]);
    expect(container.querySelector('.provider-modal__tab-hint')?.textContent).toContain(
      'subscription',
    );
    const link = container.querySelector('.provider-modal__add-custom-chip') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/mnfst/llm-gateway/discussions/973');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('.provider-toggle__name')?.textContent).toBe('Provider One');
    expect(container.querySelector('.provider-toggle__local-only')?.textContent).toBe(
      'Subscription',
    );
  });

  it('uses subscriptionLabel when provided', () => {
    const { container } = renderTab([
      provider({ id: 'sub', name: 'SubProvider', subscriptionLabel: 'Pro Plan' }),
    ]);
    expect(container.querySelector('.provider-toggle__local-only')?.textContent).toBe('Pro Plan');
  });

  it('renders a letter badge when providerIcon returns null', () => {
    const { container } = renderTab([
      provider({ id: 'unknown-prov', name: 'Unknown', initial: 'U', color: '#abcdef' }),
    ]);
    expect(container.querySelector('.provider-card__logo-letter')?.textContent).toBe('U');
  });

  // ── hasDetailView() branch coverage ─────────────────────────────────

  it.each([
    ['subscriptionKeyPlaceholder', { subscriptionKeyPlaceholder: 'sk-...' }],
    ['subscriptionCommand', { subscriptionCommand: 'manifest auth login cmd' }],
    ['subscriptionAuthMode=popup_oauth', { subscriptionAuthMode: 'popup_oauth' as const }],
    ['subscriptionAuthMode=device_code', { subscriptionAuthMode: 'device_code' as const }],
    ['subscriptionAuthMode=popup_paste', { subscriptionAuthMode: 'popup_paste' as const }],
    ['subscriptionAuthMode=token', { subscriptionAuthMode: 'token' as const }],
  ])('opens detail view when provider has %s', (_, extra) => {
    const onOpenDetail = vi.fn();
    const onToggle = vi.fn();
    const { container } = renderTab(
      [provider({ id: 'dv', name: 'DV', ...extra })],
      { onOpenDetail, onToggle },
    );
    fireEvent.click(container.querySelector('button.provider-toggle') as HTMLButtonElement);
    expect(onOpenDetail).toHaveBeenCalledWith('dv', 'subscription');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('calls onToggle (not onOpenDetail) when provider has no detail-view fields', () => {
    const onOpenDetail = vi.fn();
    const onToggle = vi.fn();
    const { container } = renderTab(
      // No subscriptionKeyPlaceholder, no subscriptionCommand, no subscriptionAuthMode.
      [provider({ id: 'plain', name: 'Plain' })],
      { onOpenDetail, onToggle },
    );
    fireEvent.click(container.querySelector('button.provider-toggle') as HTMLButtonElement);
    expect(onToggle).toHaveBeenCalledWith('plain');
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  // ── connected() / requiresStoredToken() branches ────────────────────

  it('uses isSubscriptionWithToken for explicit token-mode providers', () => {
    const isSubscriptionWithToken = vi.fn(() => true);
    const isSubscriptionConnected = vi.fn(() => false);
    const { container } = renderTab(
      [
        provider({
          id: 'tk',
          name: 'TokenMode',
          subscriptionAuthMode: 'token',
          subscriptionKeyPlaceholder: 'sk-...',
        }),
      ],
      { isSubscriptionWithToken, isSubscriptionConnected },
    );
    expect(isSubscriptionWithToken).toHaveBeenCalledWith('tk');
    expect(isSubscriptionConnected).not.toHaveBeenCalled();
    expect(container.querySelector('.provider-toggle__switch--on')).not.toBeNull();
  });

  it('uses isSubscriptionWithToken when token mode is inferred via subscriptionKeyPlaceholder', () => {
    // No explicit subscriptionAuthMode but has subscriptionKeyPlaceholder
    // → getSubscriptionAuthMode falls back to 'token'.
    const isSubscriptionWithToken = vi.fn(() => true);
    const isSubscriptionConnected = vi.fn(() => false);
    renderTab(
      [provider({ id: 'inf', name: 'Inferred', subscriptionKeyPlaceholder: 'paste-token' })],
      { isSubscriptionWithToken, isSubscriptionConnected },
    );
    expect(isSubscriptionWithToken).toHaveBeenCalledWith('inf');
    expect(isSubscriptionConnected).not.toHaveBeenCalled();
  });

  it('uses isSubscriptionConnected for non-token (oauth/device_code) providers', () => {
    const isSubscriptionWithToken = vi.fn(() => false);
    const isSubscriptionConnected = vi.fn(() => true);
    const { container } = renderTab(
      [provider({ id: 'oa2', name: 'OAuthOther', subscriptionAuthMode: 'popup_oauth' })],
      { isSubscriptionWithToken, isSubscriptionConnected },
    );
    expect(isSubscriptionConnected).toHaveBeenCalledWith('oa2');
    expect(isSubscriptionWithToken).not.toHaveBeenCalled();
    expect(container.querySelector('.provider-toggle__switch--on')).not.toBeNull();
  });

  it('uses isSubscriptionConnected for providers with no auth mode (undefined)', () => {
    const isSubscriptionWithToken = vi.fn(() => false);
    const isSubscriptionConnected = vi.fn(() => false);
    renderTab(
      [provider({ id: 'plain2', name: 'Plain2' })],
      { isSubscriptionWithToken, isSubscriptionConnected },
    );
    expect(isSubscriptionConnected).toHaveBeenCalledWith('plain2');
    expect(isSubscriptionWithToken).not.toHaveBeenCalled();
  });

  it('omits the provider-toggle__switch--on class when disconnected', () => {
    const { container } = renderTab(
      [provider({ id: 'p', name: 'P', subscriptionAuthMode: 'popup_oauth' })],
      { isSubscriptionConnected: () => false },
    );
    expect(container.querySelector('.provider-toggle__switch--on')).toBeNull();
  });

  // ── Add connection button ───────────────────────────────────────────

  it('shows add-connection button only when connected (token mode)', () => {
    const tokenProv = provider({
      id: 'tok',
      name: 'TokenProv',
      subscriptionAuthMode: 'token',
      subscriptionKeyPlaceholder: 'sk-...',
    });
    const { container: connectedC } = renderTab([tokenProv], {
      isSubscriptionWithToken: () => true,
    });
    expect(connectedC.querySelector('.provider-toggle__add-btn')).not.toBeNull();

    const { container: disconnectedC } = renderTab([tokenProv], {
      isSubscriptionWithToken: () => false,
    });
    expect(disconnectedC.querySelector('.provider-toggle__add-btn')).toBeNull();
  });

  it('shows add-connection button for non-token providers iff isSubscriptionConnected is true', () => {
    const oauthProv = provider({
      id: 'oa3',
      name: 'OAuthProv',
      subscriptionAuthMode: 'popup_oauth',
    });
    const { container: c1 } = renderTab([oauthProv], {
      isSubscriptionConnected: () => false,
    });
    expect(c1.querySelector('.provider-toggle__add-btn')).toBeNull();

    const { container: c2 } = renderTab([oauthProv], {
      isSubscriptionConnected: () => true,
    });
    expect(c2.querySelector('.provider-toggle__add-btn')).not.toBeNull();
  });

  it('calls onAddKey when add-connection button is clicked and stops propagation', () => {
    const onAddKey = vi.fn();
    const onOpenDetail = vi.fn();
    const onToggle = vi.fn();
    const { container } = renderTab(
      [
        provider({
          id: 'tok',
          name: 'TokenProv',
          subscriptionAuthMode: 'token',
          subscriptionKeyPlaceholder: 'sk-...',
        }),
      ],
      {
        isSubscriptionWithToken: () => true,
        onAddKey,
        onOpenDetail,
        onToggle,
      },
    );
    fireEvent.click(container.querySelector('.provider-toggle__add-btn') as HTMLButtonElement);
    expect(onAddKey).toHaveBeenCalledWith('tok', 'subscription');
    // stopPropagation: parent button should NOT have been invoked.
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('exposes an accessible label on the add-connection button', () => {
    const { container } = renderTab(
      [
        provider({
          id: 'tok',
          name: 'NamedProv',
          subscriptionAuthMode: 'token',
          subscriptionKeyPlaceholder: 'sk-...',
        }),
      ],
      { isSubscriptionWithToken: () => true },
    );
    const addBtn = container.querySelector('.provider-toggle__add-btn') as HTMLButtonElement;
    expect(addBtn.getAttribute('aria-label')).toBe('Add connection for NamedProv');
  });

  // ── busy / multi-provider rendering ─────────────────────────────────

  it('disables the provider tile button when busy() is true', () => {
    const { container } = renderTab(
      [provider({ id: 'p', name: 'P', subscriptionAuthMode: 'popup_oauth' })],
      { busy: () => true },
    );
    const btn = container.querySelector('button.provider-toggle') as HTMLButtonElement;
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('renders multiple subscription providers in a single list', () => {
    const { container } = renderTab([
      provider({ id: 'a', name: 'Alpha', subscriptionAuthMode: 'token' }),
      provider({ id: 'b', name: 'Beta', subscriptionAuthMode: 'popup_oauth' }),
      provider({ id: 'c', name: 'Gamma' }),
    ]);
    expect(container.querySelectorAll('button.provider-toggle').length).toBe(3);
    const names = Array.from(container.querySelectorAll('.provider-toggle__name')).map(
      (n) => n.textContent?.trim() ?? '',
    );
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
