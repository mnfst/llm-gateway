import {
  isAnthropicHost,
  MAX_CLIENT_BETA_BYTES,
  MAX_CLIENT_BETA_FLAGS,
  mergeAnthropicBeta,
  parseClientBetas,
} from './anthropic-beta';

describe('parseClientBetas', () => {
  it('returns nothing when the caller sent no header', () => {
    expect(parseClientBetas(undefined)).toEqual([]);
  });

  it('returns nothing for a non-string header value', () => {
    expect(parseClientBetas(42)).toEqual([]);
  });

  it('splits a comma-separated header and trims each flag', () => {
    expect(parseClientBetas('context-management-2025-06-27, effort-2025-11-24')).toEqual([
      'context-management-2025-06-27',
      'effort-2025-11-24',
    ]);
  });

  it('joins a repeated header arriving as an array', () => {
    expect(parseClientBetas(['one-2025-01-01', 'two-2025-01-01'])).toEqual([
      'one-2025-01-01',
      'two-2025-01-01',
    ]);
  });

  it('drops empty segments left by stray commas', () => {
    expect(parseClientBetas('one-2025-01-01,,')).toEqual(['one-2025-01-01']);
  });

  it('drops flags that are not lowercase header tokens', () => {
    // Anything outside [a-z0-9.-] could smuggle a second header or a control
    // character into the upstream request, so it never leaves Manifest.
    expect(parseClientBetas('Upper-2025-01-01')).toEqual([]);
    expect(parseClientBetas('has space')).toEqual([]);
    expect(parseClientBetas('bad\r\nx-injected: 1')).toEqual([]);
    expect(parseClientBetas('-leading-dash')).toEqual([]);
  });

  it('keeps a long flag, since only the charset makes a flag unsafe', () => {
    // A per-token length cap would silently drop a future beta whose name runs
    // long, recreating the exact bug this module exists to fix. The aggregate
    // byte budget is what bounds the header.
    const long = `a${'b'.repeat(120)}`;
    expect(parseClientBetas(`${long},good-2025-01-01`)).toEqual([long, 'good-2025-01-01']);
  });

  it('dedupes repeated flags, keeping the first occurrence', () => {
    expect(parseClientBetas('one-2025-01-01,two-2025-01-01,one-2025-01-01')).toEqual([
      'one-2025-01-01',
      'two-2025-01-01',
    ]);
  });

  it(`keeps at most ${MAX_CLIENT_BETA_FLAGS} flags`, () => {
    const flags = Array.from({ length: MAX_CLIENT_BETA_FLAGS + 5 }, (_, i) => `beta-${i}`);
    expect(parseClientBetas(flags.join(','))).toHaveLength(MAX_CLIENT_BETA_FLAGS);
  });

  it(`stops once the flags would exceed ${MAX_CLIENT_BETA_BYTES} bytes`, () => {
    const wide = Array.from(
      { length: MAX_CLIENT_BETA_FLAGS },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(62)}`,
    );

    const kept = parseClientBetas(wide.join(','));

    expect(kept.length).toBeLessThan(MAX_CLIENT_BETA_FLAGS);
    expect(kept.join(',').length).toBeLessThanOrEqual(MAX_CLIENT_BETA_BYTES);
  });
});

describe('mergeAnthropicBeta', () => {
  it('leaves the header absent when neither side has flags', () => {
    expect(mergeAnthropicBeta(undefined, undefined)).toBeUndefined();
  });

  it("keeps Manifest's flags untouched when the caller sent none", () => {
    expect(mergeAnthropicBeta('oauth-2025-04-20', undefined)).toBe('oauth-2025-04-20');
  });

  it("forwards the caller's flags when Manifest requires none", () => {
    // The api_key path sends no beta header today, so a Claude Code request
    // carrying `output_config` currently 400s as an extra input.
    expect(mergeAnthropicBeta(undefined, 'structured-outputs-2025-11-13')).toBe(
      'structured-outputs-2025-11-13',
    );
  });

  it("appends the caller's flags after Manifest's required ones", () => {
    expect(
      mergeAnthropicBeta('claude-code-20250219,oauth-2025-04-20', 'structured-outputs-2025-11-13'),
    ).toBe('claude-code-20250219,oauth-2025-04-20,structured-outputs-2025-11-13');
  });

  it('does not repeat a flag both sides asked for', () => {
    expect(mergeAnthropicBeta('oauth-2025-04-20', 'oauth-2025-04-20,new-2026-01-01')).toBe(
      'oauth-2025-04-20,new-2026-01-01',
    );
  });

  it("keeps Manifest's flags when the caller's header is entirely junk", () => {
    expect(mergeAnthropicBeta('oauth-2025-04-20', 'Bad Header')).toBe('oauth-2025-04-20');
  });
});

describe('isAnthropicHost', () => {
  it('accepts Anthropic itself', () => {
    expect(isAnthropicHost('https://api.anthropic.com')).toBe(true);
  });

  it('accepts a custom endpoint pointed at Anthropic', () => {
    // A tenant may reach Anthropic through a custom provider row; the beta
    // flags are just as necessary there.
    expect(isAnthropicHost('https://api.anthropic.com/v1')).toBe(true);
  });

  it('rejects an Anthropic-compatible third party', () => {
    expect(isAnthropicHost('https://api.moonshot.ai/anthropic')).toBe(false);
  });

  it('rejects a lookalike host', () => {
    expect(isAnthropicHost('https://api.anthropic.com.evil.test')).toBe(false);
  });

  it('rejects an unparseable base URL', () => {
    expect(isAnthropicHost('not a url')).toBe(false);
  });
});
