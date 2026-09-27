import { AUTOFIX_URL, resolveHealingUrl } from '../autofix-healing-config';

describe('resolveHealingUrl', () => {
  it('sends production at hosted Phoenix regardless of deployment mode', () => {
    // Cloud and self-hosted heal against the same service; only the auth
    // header differs, and that is decided in the module, not here.
    expect(resolveHealingUrl('production')).toBe(AUTOFIX_URL);
  });

  it('resolves no URL outside production so dev/test reach the in-process mock', () => {
    // A developer running the stack locally must never post real failures at
    // the production healer, and a test must never depend on the network.
    expect(resolveHealingUrl('development')).toBeUndefined();
    expect(resolveHealingUrl('test')).toBeUndefined();
    expect(resolveHealingUrl(undefined)).toBeUndefined();
  });

  it('pins the only production healer origin', () => {
    // The URL is a constant with no override, so this literal is the whole
    // contract. Demo and Railway-generated hostnames are not valid here.
    expect(AUTOFIX_URL).toBe('https://autofix.manifest.build');
    expect(new URL(AUTOFIX_URL).hostname).toBe('autofix.manifest.build');
    expect(new URL(AUTOFIX_URL).pathname).toBe('/');
  });
});
