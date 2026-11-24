/**
 * Kept in sync with package.json — pinned by the "matches package.json" test in
 * index.spec.ts. Do not hand-edit for a release: `npm run set-version -- <v>`
 * rewrites this file and package.json together, and CI runs it before packing.
 */
export const VERSION = '6.24.0';

/**
 * The one User-Agent every CLI-originated HTTP request carries — management
 * API and gateway alike — so the server's caller attribution sees one client.
 *
 * Deliberately NOT the npm package name (mnfst-gateway-cli). This string is
 * user-visible in request details and nothing server-side matches on it, so
 * renaming the package must not silently split one client into two in the
 * caller attribution history.
 */
export const CLI_USER_AGENT = `mnfst-cli/${VERSION}`;
