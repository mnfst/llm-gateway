import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import RoutingDeprecationNotice from '../../src/components/RoutingDeprecationNotice';

describe('RoutingDeprecationNotice', () => {
  it('renders the title and body', () => {
    render(() => (
      <RoutingDeprecationNotice title="Complexity routing is going away.">
        Some explanatory body text.
      </RoutingDeprecationNotice>
    ));
    expect(screen.getByText('Complexity routing is going away.')).toBeDefined();
    expect(screen.getByText('Some explanatory body text.')).toBeDefined();
  });

  it('exposes a note role for assistive technology', () => {
    render(() => <RoutingDeprecationNotice title="T">B</RoutingDeprecationNotice>);
    expect(screen.getByRole('note')).toBeDefined();
  });

  it('renders a "View more" link to the deprecation blog post in a new tab', () => {
    render(() => <RoutingDeprecationNotice title="T">B</RoutingDeprecationNotice>);
    const link = screen.getByRole('link', { name: 'View more' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      'https://manifest.build/blog/deprecating-rule-based-routing/',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
