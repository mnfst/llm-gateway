import {
  extractManifestErrorCode,
  formatManifestError,
  MANIFEST_ERRORS,
  MANIFEST_ERRORS_DOCS_BASE,
  ManifestErrorCode,
} from '../error-codes';

describe('MANIFEST_ERRORS registry', () => {
  it('exposes the public docs base URL', () => {
    expect(MANIFEST_ERRORS_DOCS_BASE).toBe('https://manifest.build/llm-gateway/docs/errors');
  });

  it('every code has a non-empty title and template', () => {
    for (const [code, entry] of Object.entries(MANIFEST_ERRORS)) {
      expect(entry.title).toBeTruthy();
      expect(entry.template).toBeTruthy();
      expect(code).toMatch(/^M\d{3}$/);
    }
  });

  it('every code is unique', () => {
    const codes = Object.keys(MANIFEST_ERRORS);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('formatManifestError', () => {
  it('wraps a static template with the peacock prefix and docs URL', () => {
    const out = formatManifestError('M001');
    expect(out).toContain('[🦚 Manifest M001]');
    expect(out).toContain('Missing the Authorization header');
    expect(out).toContain('https://manifest.build/llm-gateway/docs/errors/M001/');
  });

  it('interpolates {var} placeholders from the vars object', () => {
    const out = formatManifestError('M100', {
      provider: 'anthropic',
      dashboardUrl: 'https://dash.example/x',
    });
    expect(out).toContain('No anthropic API key yet');
    expect(out).toContain('https://dash.example/x');
    expect(out).not.toContain('{provider}');
    expect(out).not.toContain('{dashboardUrl}');
  });

  it('leaves placeholders untouched when a var is missing', () => {
    const out = formatManifestError('M100', { provider: 'openai' });
    expect(out).toContain('No openai API key yet');
    expect(out).toContain('{dashboardUrl}');
  });

  it('renders M101 as a missing default model, not missing providers (#2942)', () => {
    const out = formatManifestError('M101', { dashboardUrl: 'https://dash.example/routing' });
    expect(out).toContain('[🦚 Manifest M101]');
    expect(out).toContain('This harness has no model to route to yet. Pick a default model here');
    expect(out).toContain('https://dash.example/routing');
  });

  it('renders M102 for unusable subscription credentials', () => {
    const out = formatManifestError('M102', {
      provider: 'openai',
      dashboardUrl: 'https://dash.example/routing',
    });
    expect(out).toContain('[🦚 Manifest M102]');
    expect(out).toContain('openai subscription credentials could not be refreshed');
    expect(out).toContain('https://dash.example/routing');
  });

  it('appends the docs URL exactly once', () => {
    const out = formatManifestError('M500');
    const matches =
      out.match(/https:\/\/manifest\.build\/llm-gateway\/docs\/errors\/M500\//g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('produces a stable output for every registered code', () => {
    for (const code of Object.keys(MANIFEST_ERRORS) as ManifestErrorCode[]) {
      const out = formatManifestError(code);
      expect(out.startsWith(`[🦚 Manifest ${code}]`)).toBe(true);
      expect(out.endsWith(`See ${MANIFEST_ERRORS_DOCS_BASE}/${code}/`)).toBe(true);
    }
  });
});

describe('extractManifestErrorCode', () => {
  it('returns null for empty or non-Manifest text', () => {
    expect(extractManifestErrorCode(null)).toBeNull();
    expect(extractManifestErrorCode(undefined)).toBeNull();
    expect(extractManifestErrorCode('')).toBeNull();
    expect(extractManifestErrorCode('upstream 500')).toBeNull();
    expect(extractManifestErrorCode('[Manifest M999] unknown')).toBeNull();
    // A provider body that echoes the code text without the peacock must NOT
    // be mistaken for a Manifest error (guards against provider-error mislabeling).
    expect(extractManifestErrorCode('[Manifest M100] echoed by an upstream')).toBeNull();
    expect(extractManifestErrorCode('provider said: Manifest M102 somewhere')).toBeNull();
  });

  it('extracts the code from a formatted peacock message', () => {
    expect(extractManifestErrorCode(formatManifestError('M102', { provider: 'openai' }))).toBe(
      'M102',
    );
    expect(
      extractManifestErrorCode('[🦚 Manifest M100] No openai API key yet. Add one here: https://x'),
    ).toBe('M100');
  });

  it('finds the code when nested inside a JSON error body', () => {
    const body = JSON.stringify({
      error: {
        message: formatManifestError('M102', {
          provider: 'openai',
          dashboardUrl: 'https://dash/routing',
        }),
      },
    });
    expect(extractManifestErrorCode(body)).toBe('M102');
  });

  it('round-trips every registered code', () => {
    for (const code of Object.keys(MANIFEST_ERRORS) as ManifestErrorCode[]) {
      expect(extractManifestErrorCode(formatManifestError(code))).toBe(code);
    }
  });
});
