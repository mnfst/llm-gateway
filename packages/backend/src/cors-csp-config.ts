// Single source of truth for the CORS allow-lists and the CSP `frame-src`
// directive. CORS allows the hosted Wingman gateway tester in both dev and
// production (it's a legitimate cross-origin caller of the gateway). The CSP
// `frame-src` — which governs embedding the Wingman drawer in the dashboard —
// stays dev-only, since that drawer is dead-code-eliminated from production.

export const HOSTED_WINGMAN_ORIGIN = 'https://wingman.manifest.build';

export interface DevOriginBuilderOptions {
  configuredOrigin: string;
  wingmanPort: number;
}

export interface ProdOriginBuilderOptions {
  /**
   * Comma-separated extra origins from `WINGMAN_CORS_ORIGINS` — lets an
   * operator whose self-hosted Wingman lives on a different origin than the
   * gateway opt it in without a code change.
   */
  extraOrigins?: string;
}

export interface FrameSrcOptions {
  isDev: boolean;
  wingmanPort: number;
}

export function buildDevAllowedOrigins({
  configuredOrigin,
  wingmanPort,
}: DevOriginBuilderOptions): string[] {
  return Array.from(
    new Set([
      configuredOrigin,
      `http://localhost:${wingmanPort}`,
      `http://127.0.0.1:${wingmanPort}`,
      'http://localhost:3002',
      HOSTED_WINGMAN_ORIGIN,
    ]),
  );
}

// Production CORS allow-list. The dashboard is same-origin, but the hosted
// Wingman gateway tester (https://wingman.manifest.build) is a legitimate
// cross-origin caller of the gateway routes (`/v1/chat/completions`,
// `/v1/messages`), so production must allow its origin. Exact match only, and
// `credentials: false` at the call site keeps this safe: an allow-listed origin
// still needs the user's own bearer key and no session cookie can ride along.
export function buildProdAllowedOrigins({ extraOrigins }: ProdOriginBuilderOptions = {}): string[] {
  const extras = (extraOrigins ?? '')
    .split(',')
    // Strip a trailing slash: browser `Origin` headers never carry one, so an
    // exact-match allow-list entry like `https://wingman.acme.dev/` would never
    // match otherwise.
    .map((v) => v.trim().replace(/\/+$/, ''))
    .filter((v) => v.length > 0);
  return Array.from(new Set([HOSTED_WINGMAN_ORIGIN, ...extras]));
}

export function buildFrameSrc({ isDev, wingmanPort }: FrameSrcOptions): string[] {
  if (!isDev) {
    return ["'self'"];
  }
  return [
    "'self'",
    `http://localhost:${wingmanPort}`,
    `http://127.0.0.1:${wingmanPort}`,
    HOSTED_WINGMAN_ORIGIN,
  ];
}

// Matches a well-formed CSP host-source: an http(s) origin with an optional
// `*.` subdomain wildcard, a host, and an optional port — no path, query, or
// fragment. Anything else (scheme-only `https:`, a raw CIDR like
// `192.168.1.0/24`, a bare `*`, junk) is rejected so a typo in FRAME_ANCESTORS
// can't weaken clickjacking protection or emit a malformed CSP token.
const FRAME_ANCESTOR_ORIGIN_RE = /^https?:\/\/(\*\.)?[a-zA-Z0-9.-]+(:\d+)?$/;

/**
 * Parse the operator-supplied `FRAME_ANCESTORS` env value into a validated CSP
 * `frame-ancestors` directive. Each comma-separated entry is kept only when it
 * is the `'self'` / `'none'` keyword or a well-formed http(s) origin; malformed
 * entries (and the wildcard `*`, which would allow any site to frame the app)
 * are dropped. Falls back to `'none'` when unset or when nothing valid remains,
 * so a fully-malformed value never silently disables framing protection.
 */
export function parseFrameAncestors(raw: string | undefined): string[] {
  if (!raw) return ["'none'"];
  const valid = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v === "'self'" || v === "'none'" || FRAME_ANCESTOR_ORIGIN_RE.test(v));
  return valid.length > 0 ? valid : ["'none'"];
}

export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
export type CorsOriginHandler = (origin: string | undefined, callback: CorsOriginCallback) => void;

export function createCorsOriginHandler(allowedOrigins: string[]): CorsOriginHandler {
  return (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}

// Preflight cache lifetime (seconds), shared by the dev and production CORS
// paths. Without a max-age the browser re-runs the preflight — including the
// legacy dev Private Network Access preflight — roughly every 5s, so every dashboard
// reload (dev) or burst of Wingman requests (production) re-issues one. Each
// round trip is another chance for a transient blip to surface as a spurious
// CORS error. Caching the preflight collapses those repeats. 7200s (2h) is the
// ceiling Chrome honors.
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;

export interface CorsOptions {
  origin: CorsOriginHandler;
  credentials: false;
  maxAge: number;
}

// The exact `enableCors()` options main.ts uses (both dev and production —
// only the allow-list differs), kept here so the e2e/unit tests exercise the
// real shape rather than a hand-rolled copy. `credentials: false` is
// deliberate — Wingman uses bearer keys, never cookies, so keeping credentials
// off the cross-origin path means a misconfigured allow-list can't leak session
// cookies. `allowedHeaders` is intentionally omitted so the cors middleware
// reflects the request's `Access-Control-Request-Headers` (Wingman replays real
// SDK fingerprints like the `X-Stainless-*` family; a fixed allow-list would
// fail those preflights).
export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin: createCorsOriginHandler(allowedOrigins),
    credentials: false,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}

// LEGACY — kept for old browsers only. Do not reach for this when debugging a
// blocked loopback request; it will not help, and believing it does has cost
// us the same bug more than once.
//
// Chrome's Private Network Access let a server opt in to public-HTTPS →
// loopback requests by echoing `Access-Control-Allow-Private-Network: true` on
// the preflight. Chrome ≥ 138 replaced PNA with **Local Network Access**, which
// is a *user permission* — no response header can grant it, and in a
// cross-origin iframe it's denied by permissions policy unless the embedder
// sends `allow="local-network-access"`, so the prompt never even appears.
//
// The browser still reports the block as a CORS error, which is exactly why it
// keeps being mistaken for one. Verified on Chrome 148: the request fails with
// this header present and succeeds with
// `--disable-features=LocalNetworkAccessChecks`.
//
// The fix is not to send another header — it's to not cross the address-space
// boundary. The dashboard's dev drawer serves Wingman from a loopback origin
// for that reason (see packages/frontend/wingman-dev-proxy.ts). This header
// stays because pre-138 Chrome still honours it and it costs nothing.
//
// Shape kept narrow on purpose: takes only the request fields read and
// a setHeader callback so it composes with Express middleware and unit
// tests without dragging in `Request` / `Response` types.
export interface PnaRequest {
  method: string;
  headers: {
    origin?: string | string[];
    'access-control-request-private-network'?: string | string[];
  };
}

export function applyPrivateNetworkAllow(
  req: PnaRequest,
  allowedOrigins: string[],
  setHeader: (name: string, value: string) => void,
): void {
  if (req.method !== 'OPTIONS') return;
  const pnaHeader = req.headers['access-control-request-private-network'];
  if (pnaHeader !== 'true') return;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return;
  setHeader('Access-Control-Allow-Private-Network', 'true');
}

/** Route path of the public pivot waiting-list claim. */
export const PIVOT_CLAIM_PATH = '/api/v1/waitlist/pivot/claim';

export interface PivotCorsRequest {
  method: string;
  path: string;
}

/**
 * Open CORS for the pivot waiting-list claim only. Self-hosted dashboards on
 * versions that still ship the waiting-list card post the claim straight
 * from the browser, so any origin must be allowed on
 * this one route. Safe because no credentials ride along (`fetch` sends none
 * cross-origin by default and the allow-list CORS runs with
 * `credentials: false`) and the route only accepts an email. Returns true
 * when it fully answered a preflight, so the caller ends the response.
 */
export function applyPivotClaimCors(
  req: PivotCorsRequest,
  setHeader: (name: string, value: string) => void,
): boolean {
  if (req.path !== PIVOT_CLAIM_PATH) return false;
  setHeader('Access-Control-Allow-Origin', '*');
  setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  setHeader('Access-Control-Allow-Headers', 'Content-Type');
  setHeader('Access-Control-Max-Age', '600');
  return req.method === 'OPTIONS';
}

/**
 * Origin of the cloud pivot claim endpoint. Production self-hosted dashboards
 * post the claim cross-origin from the browser, so the CSP `connect-src`
 * must allow it — CORS alone is not enough, the CSP blocks the fetch first.
 */
export const PIVOT_CLAIM_CLOUD_ORIGIN = 'https://app.manifest.build';
