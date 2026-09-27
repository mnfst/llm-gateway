import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import AutofixBanner from '../../src/components/AutofixBanner';

describe('AutofixBanner', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders the banner with text and button', () => {
    const { container } = render(() => <AutofixBanner />);
    expect(screen.getByText(/Keep your apps up with self-healing APIs/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Get started/i })).toBeTruthy();
    expect(container.querySelector('.autofix-banner')).not.toBeNull();
  });

  it('hides the banner when close button is clicked', () => {
    const { container } = render(() => <AutofixBanner />);
    const closeBtn = container.querySelector('.autofix-banner__close')!;
    fireEvent.click(closeBtn);
    expect(container.querySelector('.autofix-banner')).toBeNull();
  });

  it('persists dismissal in sessionStorage', () => {
    const { container } = render(() => <AutofixBanner />);
    const closeBtn = container.querySelector('.autofix-banner__close')!;
    fireEvent.click(closeBtn);
    expect(sessionStorage.getItem('autofix-banner-dismissed')).toBe('1');
  });

  it('does not render if already dismissed', () => {
    sessionStorage.setItem('autofix-banner-dismissed', '1');
    const { container } = render(() => <AutofixBanner />);
    expect(container.querySelector('.autofix-banner')).toBeNull();
  });
});
