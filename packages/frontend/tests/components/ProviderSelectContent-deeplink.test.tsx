import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

vi.mock('../../src/services/api.js', () => ({
  connectProvider: vi.fn(),
  disconnectProvider: vi.fn().mockResolvedValue({ notifications: [] }),
  probeCustomProvider: vi.fn().mockResolvedValue({ models: [{ model_name: 'llama-3.1-8b' }] }),
  createCustomProvider: vi.fn().mockResolvedValue({ id: 'cp-1' }),
  deleteCustomProvider: vi.fn().mockResolvedValue({}),
  updateCustomProvider: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: vi.fn().mockResolvedValue(true),
  checkIsOllamaAvailable: vi.fn().mockResolvedValue(false),
  checkLocalLlmHost: vi.fn().mockResolvedValue('localhost'),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/components/ProviderIcon.js', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/services/oauth-popup.js', () => ({
  monitorOAuthPopup: vi.fn(),
}));

import ProviderSelectContent from '../../src/components/ProviderSelectContent';
import type { CustomProviderData } from '../../src/services/api.js';

const customProvider: CustomProviderData = {
  id: 'cp-1',
  name: 'My Custom Endpoint',
  base_url: 'https://api.example.com/v1',
  api_kind: 'openai',
  models: [{ model_name: 'my-model' }],
} as unknown as CustomProviderData;

describe('ProviderSelectContent — providerDeepLink', () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens directly to the provider detail view when providerDeepLink is set', () => {
    const { container } = render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        providerDeepLink={{ providerId: 'anthropic' }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    // The detail view should be visible (provider-modal__view--from-right)
    const detailView = container.querySelector('.provider-modal__view--from-right');
    expect(detailView).not.toBeNull();
    // The tab list (part of provider list view) should not be visible
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('shows the correct provider name in the detail view', () => {
    render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        providerDeepLink={{ providerId: 'anthropic' }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    expect(screen.getByText('Anthropic')).toBeDefined();
  });

  it('closes the modal when back is clicked (deep-link entry has no list view to return to)', async () => {
    // The list view was removed; ProviderSelectContent now only renders detail
    // views. A deep-link entry has no list to go back to, so the Back button
    // calls onClose (dismissing the modal) instead of returning to a list.
    const onClose = vi.fn();
    const { container } = render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        providerDeepLink={{ providerId: 'gemini' }}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    ));
    // Should start in detail view
    expect(container.querySelector('.provider-modal__view--from-right')).not.toBeNull();

    // Click the back button
    const backBtn = container.querySelector('.modal-back-btn');
    expect(backBtn).not.toBeNull();
    fireEvent.click(backBtn!);

    // Back dismisses the modal via onClose (no list view exists).
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('renders no detail view when providerDeepLink is null', () => {
    const { container } = render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        providerDeepLink={null}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    // Without a deep link there is nothing to render — the list view is gone.
    expect(container.querySelector('.provider-modal__view--from-right')).toBeNull();
  });

  it('renders no detail view when providerDeepLink is undefined', () => {
    const { container } = render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    // Without a deep link there is nothing to render — the list view is gone.
    expect(container.querySelector('.provider-modal__view--from-right')).toBeNull();
  });

  it('opens detail view for gemini with correct auth type', () => {
    render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        providerDeepLink={{ providerId: 'gemini' }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    expect(screen.getByText('Google')).toBeDefined();
  });

  it('opens the custom-provider editor for a custom: deep link', async () => {
    // A `custom:<id>` deep link cannot resolve to a standard provider; the modal
    // must open the custom-provider editor for the matching custom provider.
    render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        customProviders={[customProvider]}
        providerDeepLink={{ providerId: 'custom:cp-1', authType: 'api_key' }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    await waitFor(() => expect(screen.getByText('Edit custom provider')).toBeDefined());
    // The provider list view is not shown.
    expect(screen.queryByText('Connect providers')).toBeNull();
  });

  it('resolves a custom: deep link once its custom providers load asynchronously', async () => {
    // The custom provider list can arrive after the modal mounts (resource still
    // resolving). The effect-based opener fires once the matching id appears.
    const [providersList, setProvidersList] = (await import('solid-js')).createSignal<
      CustomProviderData[]
    >([]);
    render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        customProviders={providersList()}
        providerDeepLink={{ providerId: 'custom:cp-1' }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    // Initially no match → the editor has not opened yet.
    expect(screen.queryByText('Edit custom provider')).toBeNull();
    setProvidersList([customProvider]);
    await waitFor(() => expect(screen.getByText('Edit custom provider')).toBeDefined());
  });

  it('opens no editor for a custom: deep link with no matching provider', () => {
    render(() => (
      <ProviderSelectContent
        agentName="test-agent"
        providers={[]}
        customProviders={[]}
        providerDeepLink={{ providerId: 'custom:missing' }}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    ));
    // No custom provider matches → the editor never opens (nothing renders).
    expect(screen.queryByText('Edit custom provider')).toBeNull();
  });
});
