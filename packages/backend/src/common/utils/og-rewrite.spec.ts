import { rewriteOgTags } from './og-rewrite';

const SAMPLE_HTML = `<!doctype html>
<html>
  <head>
    <meta property="og:url" content="https://app.manifest.build" />
    <meta property="og:image" content="https://app.manifest.build/og-image.png" />
    <meta name="twitter:image" content="https://app.manifest.build/og-image.png" />
  </head>
</html>`;

describe('rewriteOgTags', () => {
  it('returns the input unchanged when baseUrl is empty', () => {
    expect(rewriteOgTags(SAMPLE_HTML, '')).toBe(SAMPLE_HTML);
  });

  it('returns the input unchanged when baseUrl matches the default', () => {
    expect(rewriteOgTags(SAMPLE_HTML, 'https://app.manifest.build')).toBe(SAMPLE_HTML);
  });

  it('returns the input unchanged when baseUrl matches the default with a trailing slash', () => {
    expect(rewriteOgTags(SAMPLE_HTML, 'https://app.manifest.build/')).toBe(SAMPLE_HTML);
  });

  it('rewrites all occurrences of the default base to the custom base', () => {
    const result = rewriteOgTags(SAMPLE_HTML, 'https://manifest.example.com');
    expect(result).toContain('content="https://manifest.example.com"');
    expect(result).toContain('content="https://manifest.example.com/og-image.png"');
    expect(result).not.toContain('https://app.manifest.build');
  });

  it('strips trailing slashes from the custom base', () => {
    const result = rewriteOgTags(SAMPLE_HTML, 'https://manifest.example.com//');
    expect(result).toContain('content="https://manifest.example.com"');
    expect(result).toContain('content="https://manifest.example.com/og-image.png"');
  });

  it('preserves the og:image path suffix', () => {
    const result = rewriteOgTags(SAMPLE_HTML, 'http://localhost:3001');
    expect(result).toContain('content="http://localhost:3001/og-image.png"');
  });

  it('handles a string with no occurrences gracefully', () => {
    expect(rewriteOgTags('<html></html>', 'https://manifest.example.com')).toBe('<html></html>');
  });

  it('trims whitespace from baseUrl', () => {
    const result = rewriteOgTags(SAMPLE_HTML, '  https://manifest.example.com  ');
    expect(result).toContain('content="https://manifest.example.com"');
  });
});
