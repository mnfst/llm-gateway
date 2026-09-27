import { buildSentryInitOptions } from '../sentry-options';

describe('buildSentryInitOptions', () => {
  it('returns null when SENTRY_DSN is unset', () => {
    expect(buildSentryInitOptions({})).toBeNull();
  });

  it('returns null when SENTRY_DSN is only whitespace', () => {
    expect(buildSentryInitOptions({ SENTRY_DSN: '   ' })).toBeNull();
  });

  it('builds error-only options without request-derived data', () => {
    const opts = buildSentryInitOptions({
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
      NODE_ENV: 'production',
    });

    expect(opts).not.toBeNull();
    expect(opts!.dsn).toBe('https://key@o1.ingest.sentry.io/1');
    expect(opts!.environment).toBe('production');
    expect(opts!.release).toBeUndefined();
    expect(opts!.tracesSampleRate).toBeUndefined();
    expect(opts!.maxBreadcrumbs).toBe(0);
    expect(opts!.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 5,
    });
  });

  it('falls back to "development" environment when NODE_ENV is unset', () => {
    const opts = buildSentryInitOptions({ SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1' });
    expect(opts!.environment).toBe('development');
  });

  it('honors environment and release overrides', () => {
    const opts = buildSentryInitOptions({
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
      NODE_ENV: 'production',
      SENTRY_ENVIRONMENT: 'staging',
      SENTRY_RELEASE: 'v1.2.3',
    });

    expect(opts!.environment).toBe('staging');
    expect(opts!.release).toBe('v1.2.3');
  });
});
