import {
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  HOSTED_WINGMAN_ORIGIN,
  applyPrivateNetworkAllow,
  buildCorsOptions,
  buildDevAllowedOrigins,
  buildProdAllowedOrigins,
  buildFrameSrc,
  createCorsOriginHandler,
  parseFrameAncestors,
} from './cors-csp-config';

describe('HOSTED_WINGMAN_ORIGIN', () => {
  it('points at the hosted Wingman SPA', () => {
    expect(HOSTED_WINGMAN_ORIGIN).toBe('https://wingman.manifest.build');
  });
});

describe('buildDevAllowedOrigins', () => {
  it('allows the Vite frontend, both loopback Wingman ports, and the hosted Wingman (deduped)', () => {
    expect(
      buildDevAllowedOrigins({
        configuredOrigin: 'http://localhost:3000',
        wingmanPort: 3002,
      }),
    ).toEqual([
      'http://localhost:3000',
      'http://localhost:3002',
      'http://127.0.0.1:3002',
      HOSTED_WINGMAN_ORIGIN,
    ]);
  });

  it('respects a custom Wingman port and configured origin', () => {
    const allowed = buildDevAllowedOrigins({
      configuredOrigin: 'http://localhost:38240',
      wingmanPort: 38239,
    });
    expect(allowed).toContain('http://localhost:38240');
    expect(allowed).toContain('http://localhost:38239');
    expect(allowed).toContain('http://127.0.0.1:38239');
    expect(allowed).toContain(HOSTED_WINGMAN_ORIGIN);
  });
});

describe('buildProdAllowedOrigins', () => {
  it('allows the hosted Wingman origin by default', () => {
    expect(buildProdAllowedOrigins()).toEqual([HOSTED_WINGMAN_ORIGIN]);
  });

  it('appends operator-configured extra origins, trimmed and deduped', () => {
    expect(
      buildProdAllowedOrigins({
        extraOrigins:
          ' https://wingman.acme.dev , https://wingman.manifest.build ,https://tools.acme.dev',
      }),
    ).toEqual([HOSTED_WINGMAN_ORIGIN, 'https://wingman.acme.dev', 'https://tools.acme.dev']);
  });

  it('ignores empty / whitespace-only extra origins', () => {
    expect(buildProdAllowedOrigins({ extraOrigins: '  , ,' })).toEqual([HOSTED_WINGMAN_ORIGIN]);
    expect(buildProdAllowedOrigins({ extraOrigins: '' })).toEqual([HOSTED_WINGMAN_ORIGIN]);
  });

  it('strips a trailing slash so it matches the browser Origin header', () => {
    expect(buildProdAllowedOrigins({ extraOrigins: 'https://wingman.acme.dev/' })).toEqual([
      HOSTED_WINGMAN_ORIGIN,
      'https://wingman.acme.dev',
    ]);
  });
});

describe('buildFrameSrc', () => {
  it('in production, allows only self (drawer is dev-only)', () => {
    expect(buildFrameSrc({ isDev: false, wingmanPort: 3002 })).toEqual(["'self'"]);
  });

  it('in dev, allows local Wingman ports and the hosted Wingman', () => {
    expect(buildFrameSrc({ isDev: true, wingmanPort: 3002 })).toEqual([
      "'self'",
      'http://localhost:3002',
      'http://127.0.0.1:3002',
      HOSTED_WINGMAN_ORIGIN,
    ]);
  });

  it('respects a custom Wingman port in dev', () => {
    expect(buildFrameSrc({ isDev: true, wingmanPort: 38239 })).toContain('http://localhost:38239');
  });
});

describe('parseFrameAncestors', () => {
  it("defaults to 'none' when unset", () => {
    expect(parseFrameAncestors(undefined)).toEqual(["'none'"]);
  });

  it("defaults to 'none' for an empty string", () => {
    expect(parseFrameAncestors('')).toEqual(["'none'"]);
  });

  it('keeps a single well-formed https origin', () => {
    expect(parseFrameAncestors('https://app.example.com')).toEqual(['https://app.example.com']);
  });

  it('keeps multiple valid origins in order and trims whitespace', () => {
    expect(parseFrameAncestors('https://a.example.com , http://localhost:3000')).toEqual([
      'https://a.example.com',
      'http://localhost:3000',
    ]);
  });

  it("keeps the 'self' and 'none' CSP keywords", () => {
    expect(parseFrameAncestors("'self', 'none'")).toEqual(["'self'", "'none'"]);
  });

  it('keeps a wildcard-subdomain origin', () => {
    expect(parseFrameAncestors('https://*.example.com')).toEqual(['https://*.example.com']);
  });

  it('keeps an origin with an explicit port', () => {
    expect(parseFrameAncestors('https://example.com:8443')).toEqual(['https://example.com:8443']);
  });

  it('drops the bare wildcard (would allow any site to frame the app)', () => {
    expect(parseFrameAncestors('*')).toEqual(["'none'"]);
  });

  it('drops malformed entries (scheme-only, raw CIDR) but keeps valid ones', () => {
    expect(parseFrameAncestors('https:, 192.168.1.0/24, https://good.example.com')).toEqual([
      'https://good.example.com',
    ]);
  });

  it("falls back to 'none' when every entry is malformed", () => {
    expect(parseFrameAncestors('https:, not a url, javascript:alert(1)')).toEqual(["'none'"]);
  });
});

describe('createCorsOriginHandler', () => {
  const handler = createCorsOriginHandler([HOSTED_WINGMAN_ORIGIN, 'http://localhost:3000']);

  it('allows requests with no Origin header (same-origin / curl / server-to-server)', () => {
    const cb = jest.fn();
    handler(undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('allows a listed origin', () => {
    const cb = jest.fn();
    handler(HOSTED_WINGMAN_ORIGIN, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('blocks an unlisted origin without surfacing an error', () => {
    const cb = jest.fn();
    handler('https://evil.example.com', cb);
    expect(cb).toHaveBeenCalledWith(null, false);
  });
});

describe('buildCorsOptions', () => {
  it('caches the preflight via maxAge so reloads stop re-running it', () => {
    const opts = buildCorsOptions([HOSTED_WINGMAN_ORIGIN]);
    expect(opts.maxAge).toBe(CORS_PREFLIGHT_MAX_AGE_SECONDS);
    expect(CORS_PREFLIGHT_MAX_AGE_SECONDS).toBe(7200);
  });

  it('keeps credentials off the cross-origin path (bearer keys, never cookies)', () => {
    expect(buildCorsOptions([HOSTED_WINGMAN_ORIGIN]).credentials).toBe(false);
  });

  it('wires the allow-list origin handler (allows listed, blocks unlisted)', () => {
    const { origin } = buildCorsOptions([HOSTED_WINGMAN_ORIGIN]);
    const allow = jest.fn();
    origin(HOSTED_WINGMAN_ORIGIN, allow);
    expect(allow).toHaveBeenCalledWith(null, true);
    const block = jest.fn();
    origin('https://evil.example.com', block);
    expect(block).toHaveBeenCalledWith(null, false);
  });
});

describe('applyPrivateNetworkAllow', () => {
  const allowed = [HOSTED_WINGMAN_ORIGIN, 'http://localhost:3000'];

  it('echoes the PNA allow header for OPTIONS preflight from a listed origin', () => {
    const setHeader = jest.fn();
    applyPrivateNetworkAllow(
      {
        method: 'OPTIONS',
        headers: {
          origin: HOSTED_WINGMAN_ORIGIN,
          'access-control-request-private-network': 'true',
        },
      },
      allowed,
      setHeader,
    );
    expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Private-Network', 'true');
  });

  it('does not echo for non-OPTIONS methods', () => {
    const setHeader = jest.fn();
    applyPrivateNetworkAllow(
      {
        method: 'GET',
        headers: {
          origin: HOSTED_WINGMAN_ORIGIN,
          'access-control-request-private-network': 'true',
        },
      },
      allowed,
      setHeader,
    );
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not echo when the PNA request header is missing', () => {
    const setHeader = jest.fn();
    applyPrivateNetworkAllow(
      { method: 'OPTIONS', headers: { origin: HOSTED_WINGMAN_ORIGIN } },
      allowed,
      setHeader,
    );
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not echo for unlisted origins (no free pass for arbitrary callers)', () => {
    const setHeader = jest.fn();
    applyPrivateNetworkAllow(
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-private-network': 'true',
        },
      },
      allowed,
      setHeader,
    );
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('does not echo when the Origin header is missing entirely', () => {
    const setHeader = jest.fn();
    applyPrivateNetworkAllow(
      {
        method: 'OPTIONS',
        headers: { 'access-control-request-private-network': 'true' },
      },
      allowed,
      setHeader,
    );
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('ignores duplicate-header arrays (Express normalises but Node http does not)', () => {
    const setHeader = jest.fn();
    applyPrivateNetworkAllow(
      {
        method: 'OPTIONS',
        headers: {
          origin: [HOSTED_WINGMAN_ORIGIN, HOSTED_WINGMAN_ORIGIN],
          'access-control-request-private-network': 'true',
        },
      },
      allowed,
      setHeader,
    );
    expect(setHeader).not.toHaveBeenCalled();
  });
});

describe('applyPivotClaimCors', () => {
  const { applyPivotClaimCors, PIVOT_CLAIM_PATH } = jest.requireActual('./cors-csp-config');

  function collect() {
    const headers: Record<string, string> = {};
    return { headers, set: (name: string, value: string) => (headers[name] = value) };
  }

  it('ignores other routes entirely', () => {
    const { headers, set } = collect();
    expect(applyPivotClaimCors({ method: 'POST', path: '/api/v1/overview' }, set)).toBe(false);
    expect(headers).toEqual({});
  });

  it('opens CORS on the claim POST without ending the response', () => {
    const { headers, set } = collect();
    expect(applyPivotClaimCors({ method: 'POST', path: PIVOT_CLAIM_PATH }, set)).toBe(false);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type');
  });

  it('fully answers the claim preflight', () => {
    const { headers, set } = collect();
    expect(applyPivotClaimCors({ method: 'OPTIONS', path: PIVOT_CLAIM_PATH }, set)).toBe(true);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Max-Age']).toBe('600');
  });
});
