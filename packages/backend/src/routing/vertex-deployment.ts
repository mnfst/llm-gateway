/**
 * Vertex AI addressing.
 *
 * Vertex needs two coordinates a normal provider does not: a Google Cloud
 * project and a location. `tenant_provider` has one free-form `region` column
 * and no place for a second value, so a Vertex connection stores both in it as
 * `project/location` — the same column Bedrock and Qwen already use to carry
 * "where does this connection point".
 *
 * A connection with no region uses express mode, where the API key resolves the
 * project on Google's side and no coordinates are needed at all.
 */

/** Project ids: 6-30 chars, lowercase letter first, letters/digits/hyphens. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/**
 * Locations look like `us-central1`, `europe-west4`, or `global`. The region
 * number is multi-digit: `europe-west12` is real, and a single-digit pattern
 * would silently demote such a connection back to express mode.
 */
const LOCATION = /^(?:global|[a-z]+-[a-z]+\d+)$/;

export interface VertexDeployment {
  project: string;
  location: string;
}

/**
 * Parse a stored `region` value into Vertex coordinates.
 * Returns null for empty input (express mode) and for anything malformed, so a
 * bad value falls back to express rather than building a broken URL.
 */
export function parseVertexDeployment(region?: string | null): VertexDeployment | null {
  if (!region) return null;
  const [project, location, ...rest] = region.trim().split('/');
  if (rest.length > 0 || !project || !location) return null;
  if (!PROJECT_ID.test(project) || !LOCATION.test(location)) return null;
  return { project, location };
}

/** The inverse, for persisting what the UI collected. */
export function formatVertexDeployment(deployment: VertexDeployment): string {
  return `${deployment.project}/${deployment.location}`;
}

/**
 * Project-scoped base URL. `global` is served from the unprefixed host; every
 * other location has its own regional host.
 */
export function getVertexBaseUrl(deployment: VertexDeployment): string {
  const host =
    deployment.location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${deployment.location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${deployment.project}/locations/${deployment.location}`;
}
