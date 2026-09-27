import { readFileSync } from 'fs';
import { resolve } from 'path';

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.manifest.build/v1/report';
export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_DOCS_URL = 'https://manifest.build/llm-gateway/docs/self-hosted/#telemetry';

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  manifestVersion: string;
}

/**
 * Opt-out with `MANIFEST_TELEMETRY_DISABLED=1`. Also auto-silenced outside
 * production so dev instances and test runs never report. Also silenced
 * when the Manifest version can't be read — the ingest validates
 * `manifest_version` as semver, so a misconfigured image without
 * `packages/manifest/package.json` would otherwise spam the endpoint
 * with 400s.
 */
export function buildTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const disabled = env['MANIFEST_TELEMETRY_DISABLED'];
  const isProd = (env['NODE_ENV'] ?? 'development') === 'production';
  const isDisabled = disabled === '1' || disabled === 'true';
  const manifestVersion = readManifestVersion();
  const versionReadable = manifestVersion !== UNKNOWN_VERSION;
  return {
    enabled: isProd && !isDisabled && versionReadable,
    // `||`, not `??`: docker-compose passes unset optional vars through as an
    // empty string (`- TELEMETRY_ENDPOINT=${TELEMETRY_ENDPOINT:-}`), and `??`
    // would accept `''` as a deliberate override and POST reports to nowhere.
    endpoint: env['TELEMETRY_ENDPOINT']?.trim() || DEFAULT_TELEMETRY_ENDPOINT,
    manifestVersion,
  };
}

export const UNKNOWN_VERSION = 'unknown';

export function readManifestVersion(): string {
  try {
    const path = resolve(__dirname, '../../../manifest/package.json');
    const raw = readFileSync(path, 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
    return UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}
