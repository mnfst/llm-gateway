import {
  buildTelemetryConfig,
  DEFAULT_TELEMETRY_ENDPOINT,
  readManifestVersion,
} from './telemetry.config';

describe('buildTelemetryConfig', () => {
  it('is enabled in production when no disable flag is set', () => {
    const cfg = buildTelemetryConfig({ NODE_ENV: 'production' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    expect(cfg.manifestVersion).toEqual(expect.any(String));
  });

  it('is disabled outside production so dev instances never phone home', () => {
    expect(buildTelemetryConfig({ NODE_ENV: 'development' }).enabled).toBe(false);
    expect(buildTelemetryConfig({ NODE_ENV: 'test' }).enabled).toBe(false);
    expect(buildTelemetryConfig({}).enabled).toBe(false);
  });

  it('is disabled when MANIFEST_TELEMETRY_DISABLED is "1" or "true" even in production', () => {
    expect(
      buildTelemetryConfig({ NODE_ENV: 'production', MANIFEST_TELEMETRY_DISABLED: '1' }).enabled,
    ).toBe(false);
    expect(
      buildTelemetryConfig({ NODE_ENV: 'production', MANIFEST_TELEMETRY_DISABLED: 'true' }).enabled,
    ).toBe(false);
  });

  it('ignores unrecognised disable values (opt-out must be explicit)', () => {
    expect(
      buildTelemetryConfig({ NODE_ENV: 'production', MANIFEST_TELEMETRY_DISABLED: 'yes' }).enabled,
    ).toBe(true);
  });

  it('uses TELEMETRY_ENDPOINT override when set', () => {
    const cfg = buildTelemetryConfig({
      NODE_ENV: 'production',
      TELEMETRY_ENDPOINT: 'http://127.0.0.1:9999/ingest',
    });
    expect(cfg.endpoint).toBe('http://127.0.0.1:9999/ingest');
  });

  it('falls back to the default endpoint when TELEMETRY_ENDPOINT is blank', () => {
    // docker-compose forwards unset optional vars as an empty string
    // (`- TELEMETRY_ENDPOINT=${TELEMETRY_ENDPOINT:-}`). Treating `''` as a
    // deliberate override would silently POST every report to nowhere.
    for (const blank of ['', '   ']) {
      expect(
        buildTelemetryConfig({ NODE_ENV: 'production', TELEMETRY_ENDPOINT: blank }).endpoint,
      ).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    }
  });

  it('trims a padded TELEMETRY_ENDPOINT', () => {
    expect(
      buildTelemetryConfig({
        NODE_ENV: 'production',
        TELEMETRY_ENDPOINT: '  http://127.0.0.1:9999/ingest  ',
      }).endpoint,
    ).toBe('http://127.0.0.1:9999/ingest');
  });

  it('is disabled when the Manifest version cannot be read', () => {
    // Simulates a misconfigured image that ships without
    // packages/manifest/package.json. readManifestVersion() falls back to
    // "unknown", which the ingest would reject as invalid semver — better
    // to stay silent than to spam the endpoint.
    jest.isolateModules(() => {
      jest.doMock('fs', () => {
        const actual = jest.requireActual<typeof import('fs')>('fs');
        return {
          ...actual,
          readFileSync: jest.fn(() => {
            throw new Error('ENOENT');
          }),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./telemetry.config') as typeof import('./telemetry.config');
      const cfg = mod.buildTelemetryConfig({ NODE_ENV: 'production' });
      expect(cfg.manifestVersion).toBe('unknown');
      expect(cfg.enabled).toBe(false);
    });
  });
});

describe('readManifestVersion', () => {
  it('returns a semver-shaped string from the real manifest/package.json', () => {
    const version = readManifestVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns "unknown" when the package.json read fails', () => {
    jest.isolateModules(() => {
      jest.doMock('fs', () => {
        const actual = jest.requireActual<typeof import('fs')>('fs');
        return {
          ...actual,
          readFileSync: jest.fn(() => {
            throw new Error('ENOENT');
          }),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./telemetry.config') as typeof import('./telemetry.config');
      expect(mod.readManifestVersion()).toBe('unknown');
    });
  });

  it('returns "unknown" when the package.json lacks a string version field', () => {
    jest.isolateModules(() => {
      jest.doMock('fs', () => {
        const actual = jest.requireActual<typeof import('fs')>('fs');
        return { ...actual, readFileSync: jest.fn(() => '{"version":123}') };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./telemetry.config') as typeof import('./telemetry.config');
      expect(mod.readManifestVersion()).toBe('unknown');
    });
  });
});
