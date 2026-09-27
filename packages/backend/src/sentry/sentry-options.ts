import type { NodeOptions } from '@sentry/nestjs';

/**
 * Build Sentry error-monitoring options, or return `null` when disabled.
 *
 * Sentry is opt-in on every deployment. No client is initialized unless the
 * process environment provides `SENTRY_DSN`.
 */
export function buildSentryInitOptions(env: NodeJS.ProcessEnv): NodeOptions | null {
  const dsn = env['SENTRY_DSN']?.trim();
  if (!dsn) return null;

  return {
    dsn,
    environment: env['SENTRY_ENVIRONMENT']?.trim() || env['NODE_ENV'] || 'development',
    release: env['SENTRY_RELEASE']?.trim() || undefined,
    maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 5,
    },
  };
}
