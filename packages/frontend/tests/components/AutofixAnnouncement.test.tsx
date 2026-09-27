import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import AutofixAnnouncement from '../../src/components/AutofixAnnouncement';

describe('AutofixAnnouncement', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders the announcement card with title and benefits', () => {
    const { container } = render(() => <AutofixAnnouncement />);
    expect(screen.getByText('Make sure your APIs no longer crash')).toBeTruthy();
    expect(screen.getByText('Fix API failures automatically')).toBeTruthy();
    expect(screen.getByText('Get notified of root cause')).toBeTruthy();
    expect(screen.getByText('Works across your entire stack')).toBeTruthy();
    expect(container.querySelector('.sidebar-autofix')).not.toBeNull();
  });

  it('renders the Use it now button', () => {
    render(() => <AutofixAnnouncement />);
    const btn = screen.getByRole('link', { name: /Use it now/i });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('href')).toBe('https://dashboard.manifest.build');
    expect(btn.getAttribute('target')).toBe('_blank');
  });

  it('hides the card when dismiss button is clicked', () => {
    const { container } = render(() => <AutofixAnnouncement />);
    const dismissBtn = container.querySelector('.sidebar-autofix__dismiss')!;
    fireEvent.click(dismissBtn);
    expect(container.querySelector('.sidebar-autofix')).toBeNull();
  });

  it('persists dismissal in sessionStorage', () => {
    const { container } = render(() => <AutofixAnnouncement />);
    const dismissBtn = container.querySelector('.sidebar-autofix__dismiss')!;
    fireEvent.click(dismissBtn);
    expect(sessionStorage.getItem('autofix-card-dismissed')).toBe('1');
  });

  it('does not render if already dismissed', () => {
    sessionStorage.setItem('autofix-card-dismissed', '1');
    const { container } = render(() => <AutofixAnnouncement />);
    expect(container.querySelector('.sidebar-autofix')).toBeNull();
  });
});
