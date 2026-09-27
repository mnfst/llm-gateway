/**
 * Endpoints derived from the origin this dashboard is served from.
 *
 * The dashboard and API ship as one service. Cloud has two working domains,
 * but new setup instructions use app.manifest.build. Self-hosted installs use
 * the browser origin.
 *
 * Under the Vite dev server the dashboard runs on its own port, so these read as
 * the dev server's origin rather than the backend's. That is a dev-only artifact
 * and matches the behaviour of the snippets mentioned above.
 */
export function setupOrigin(origin: string): string {
  return origin === 'https://app.manifest.build' || origin === 'https://gateway.manifest.build'
    ? 'https://app.manifest.build'
    : origin;
}

export function installOrigin(): string {
  return setupOrigin(window.location.origin);
}

/** Where an MCP client should be pointed. */
export function mcpEndpoint(): string {
  return `${installOrigin()}/api/v1/mcp`;
}
