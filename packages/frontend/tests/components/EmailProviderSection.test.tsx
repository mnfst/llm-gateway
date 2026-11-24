import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

// Stub the two heavy children — they have their own tests — so we can assert
// which mode the section renders in.
vi.mock('../../src/components/EmailProviderSetup.js', () => ({
  default: (props: { onConfigured: () => void }) => (
    <div data-testid="email-setup">
      <button onClick={props.onConfigured}>setup-done</button>
    </div>
  ),
}));
vi.mock('../../src/components/ProviderBanner.js', () => ({
  default: (props: { config: { provider: string }; onEdit: () => void; onRemove: () => void }) => (
    <div data-testid="provider-banner" data-provider={props.config?.provider}>
      <button onClick={props.onEdit}>edit</button>
      <button onClick={props.onRemove}>remove</button>
    </div>
  ),
}));

import EmailProviderSection from '../../src/components/EmailProviderSection';

describe('EmailProviderSection', () => {
  it('shows the setup form when not loading and no provider is configured', () => {
    const onConfigured = vi.fn();
    const { container } = render(() => (
      <EmailProviderSection
        emailProvider={null}
        loading={false}
        onConfigured={onConfigured}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    ));
    expect(container.querySelector('[data-testid="email-setup"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-testid="email-setup"] button') as HTMLElement);
    expect(onConfigured).toHaveBeenCalled();
  });

  it('shows the provider banner when a provider is configured', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(() => (
      <EmailProviderSection
        emailProvider={{ provider: 'mailgun', from_email: 'a@b' } as never}
        loading={false}
        onConfigured={vi.fn()}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    ));
    const banner = container.querySelector('[data-testid="provider-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('data-provider')).toBe('mailgun');
    const buttons = banner!.querySelectorAll('button');
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(onEdit).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalled();
  });

  it('renders the setup-choice skeleton when loading with no configured provider', () => {
    const { container } = render(() => (
      <EmailProviderSection
        emailProvider={null}
        loading={true}
        onConfigured={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    ));
    // Setup skeleton: unboxed title/subtitle lines above a grid of three
    // bordered cards, mirroring the real EmailProviderSetup layout.
    expect(container.querySelector('.provider-setup-grid')).not.toBeNull();
    expect(container.querySelectorAll('.skeleton--rect')).toHaveLength(3);
    expect(container.querySelector('[data-testid="email-setup"]')).toBeNull();
  });

  it('renders the configured-provider skeleton when loading with a provider known to exist', () => {
    const { container } = render(() => (
      <EmailProviderSection
        emailProvider={{ provider: 'mailgun' } as never}
        loading={true}
        onConfigured={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    ));
    expect(container.querySelector('.provider-card')).not.toBeNull();
    expect(container.querySelector('.provider-card__label')?.textContent).toBe('Your provider');
    expect(container.querySelector('[data-testid="provider-banner"]')).toBeNull();
  });
});
