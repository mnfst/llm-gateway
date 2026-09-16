import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';
import { DoctorReleaseEmail } from './doctor-release';

// Same approach as threshold-alert.spec: react-email's `render` uses dynamic
// imports that fight Jest's CJS transform, so we render the React tree to
// static markup, which is the layer carrying the content we assert on.
function renderEmail(props: Parameters<typeof DoctorReleaseEmail>[0]): string {
  return renderToStaticMarkup(React.createElement(DoctorReleaseEmail, props));
}

describe('DoctorReleaseEmail', () => {
  it('renders the announcement with the two CTAs and waitlist footer', () => {
    const html = renderEmail({
      appUrl: 'https://app.manifest.build',
      tutorialUrl: 'https://manifest.build/blog/auto-fix',
    });
    expect(html).toContain('Autofix is live on your account');
    expect(html).toContain('already running on your account');
    expect(html).toContain('https://app.manifest.build');
    expect(html).toContain('Open your dashboard');
    expect(html).toContain('How Autofix works');
    expect(html).toContain('https://manifest.build/blog/auto-fix');
    expect(html).toContain('because you joined the Autofix');
    // The header reads "New: <icon> Autofix", not the old green badge.
    expect(html).toContain('New:');
    expect(html).toContain('autofix-icon-email.png');
    // House copy rules: no em dashes in user-facing sentences.
    expect(html).not.toContain('\u2014');
  });

  it('omits the tutorial button until the article URL exists', () => {
    const html = renderEmail({ appUrl: 'https://app.manifest.build' });
    expect(html).not.toContain('How Autofix works');
    expect(html).toContain('Open your dashboard');
  });
});
