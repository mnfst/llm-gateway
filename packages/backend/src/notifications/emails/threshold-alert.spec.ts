import { renderToStaticMarkup } from 'react-dom/server';
import { ThresholdAlertEmail } from './threshold-alert';

// Rendering through react-email's `render` uses dynamic imports that don't
// play well with Jest's CJS transform. We go one layer lower and render the
// React tree to static markup here — the escaping guarantees we rely on
// belong to React itself, so that is the actual layer we want to verify.
function renderEmail(props: Parameters<typeof ThresholdAlertEmail>[0]): string {
  return renderToStaticMarkup(ThresholdAlertEmail(props));
}

describe('ThresholdAlertEmail', () => {
  it('HTML-escapes hostile agent names so injected markup is neutralised', () => {
    const html = renderEmail({
      agentName: '<img src=x onerror="alert(1)">',
      metricType: 'tokens',
      threshold: 100,
      actualValue: 150,
      period: 'day',
      timestamp: '2026-04-23 12:00',
      agentUrl: 'https://app.manifest.build/agents/attack',
    });

    // The raw `<img` tag must never appear — it would render as an element.
    expect(html).not.toMatch(/<img src=x/);
    // Instead the angle brackets are escaped.
    expect(html).toContain('&lt;img src=x');
    // The original double-quoted onerror attribute form must not survive.
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it('HTML-escapes payloads targeting attribute context', () => {
    const html = renderEmail({
      agentName: 'evil"onmouseover="alert(1)',
      metricType: 'cost',
      threshold: 1,
      actualValue: 2,
      period: 'month',
      timestamp: '2026-04-23 12:00',
      agentUrl: 'https://app.manifest.build/agents/a',
    });

    // The raw unescaped quote must never appear with the agent name's
    // payload — that would mean the `"` broke out of attribute context.
    expect(html).not.toContain('evil"onmouseover');
    // React escapes both angle brackets and quotes in text content.
    expect(html).toContain('evil&quot;onmouseover=&quot;alert(1)');
  });
});
