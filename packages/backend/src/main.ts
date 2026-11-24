// Keep this first so opt-in Sentry error monitoring initializes before Nest.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import * as express from 'express';
import { AppModule } from './app.module';
import { auth, mcpDisabledReason, mcpEnabled } from './auth/auth.instance';
import { mcpOAuthResponse } from './auth/mcp-oauth-response';
import { mountMcpDiscovery, mountMcpUnavailable } from './mcp/mcp-discovery';
import { SpaFallbackFilter } from './common/filters/spa-fallback.filter';
import { httpErrorLogger } from './common/middleware/http-error-logger.middleware';
import {
  API_BODY_LIMIT,
  PROXY_BODY_LIMIT,
  bodyParserErrorHandler,
  createProxyBodyBudgetMiddleware,
} from './common/middleware/body-parser-limits';
import {
  applyPivotClaimCors,
  applyPrivateNetworkAllow,
  buildCorsOptions,
  buildDevAllowedOrigins,
  buildProdAllowedOrigins,
  buildFrameSrc,
  parseFrameAncestors,
} from './cors-csp-config';
import { createRateLimitReachedHandler } from './common/middleware/rate-limit-log';
import { shouldCompress } from './routing/proxy/compression-filter';

export async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new ConsoleLogger({ prefix: 'Manifest' }),
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new SpaFallbackFilter(process.env['BETTER_AUTH_URL']));

  const betterAuthUrl = process.env['BETTER_AUTH_URL'] || '';
  const hstsEnabled = /^https:\/\//i.test(betterAuthUrl);
  const isDev = process.env['NODE_ENV'] !== 'production';

  // The Wingman drawer is a dev-only affordance — `frame-src` only loosens
  // up when NODE_ENV !== 'production' to allow the hosted Wingman SPA
  // (https://wingman.manifest.build) and locally-running Wingman builds
  // at `WINGMAN_PORT` (defaults to backend port + 1). Docker / cloud
  // builds keep the strict 'self'-only frame policy.
  const backendPort = Number(process.env['PORT']) || 3001;
  const wingmanPort = Number(process.env['WINGMAN_PORT']) || backendPort + 1;
  const frameSrc = buildFrameSrc({ isDev, wingmanPort });

  app.use(
    helmet({
      hsts: hstsEnabled,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameSrc,
          frameAncestors: parseFrameAncestors(process.env['FRAME_ANCESTORS']),
          // Disable helmet's default `upgrade-insecure-requests`: it breaks
          // HTTP-only LAN deployments (10.x / 192.168.x / 172.16-31.x) where
          // browsers don't treat the origin as trustworthy and rewrite
          // `/assets/*.js` to https://, which the server doesn't serve.
          // HTTPS deployments should enforce upgrades via HSTS at the proxy.
          upgradeInsecureRequests: null,
        },
      },
    }),
  );

  // Exclude SSE (`text/event-stream`) from compression: gzip buffering holds
  // tokens and wrecks streaming time-to-first-token. All other responses use
  // the package's default content-type filter.
  app.use(compression({ filter: shouldCompress }));

  // CORS: the dashboard is same-origin, but the hosted Wingman gateway tester
  // (https://wingman.manifest.build) is a legitimate cross-origin caller of the
  // gateway routes, so both dev and production allow its origin. Dev also allows
  // the Vite frontend on :3000 and the local Wingman build at `WINGMAN_PORT`;
  // production allows the hosted Wingman origin plus any `WINGMAN_CORS_ORIGINS` a
  // self-hoster opts into.
  //
  // See `buildCorsOptions` for the rationale behind `credentials: false`, the
  // omitted `allowedHeaders`, and the preflight `maxAge`.
  const corsAllowedOrigins = isDev
    ? buildDevAllowedOrigins({
        configuredOrigin: process.env['CORS_ORIGIN'] || 'http://localhost:3000',
        wingmanPort,
      })
    : buildProdAllowedOrigins({ extraOrigins: process.env['WINGMAN_CORS_ORIGINS'] });
  // Legacy Private Network Access support, for browsers older than Chrome 138.
  // Newer Chrome replaced PNA with Local Network Access, a user permission that
  // no response header can satisfy — so this does *not* fix a blocked
  // public-HTTPS → loopback request on a current browser, however much the
  // browser's "CORS error" wording suggests it should. See the note on
  // `applyPrivateNetworkAllow` before reaching for it. Registered ahead of the
  // cors middleware because the preflight has to be answered before that
  // middleware ends the OPTIONS response; it only echoes the header for
  // already-allow-listed origins, so it's a no-op for a public gateway.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    applyPrivateNetworkAllow(req, corsAllowedOrigins, (name, value) => res.setHeader(name, value));
    next();
  });
  // The pivot waiting-list claim is posted from self-hosted dashboards in the
  // browser, so this one route answers CORS for any origin. Registered before
  // the allow-list cors middleware so its preflight wins; see
  // `applyPivotClaimCors` for why this is safe.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const handled = applyPivotClaimCors(req, (name, value) => res.setHeader(name, value));
    if (handled) {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.enableCors(buildCorsOptions(corsAllowedOrigins));

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // Reject requests carrying unknown fields with a 400 instead of silently
      // stripping them. `whitelist` alone drops extras without a signal, which
      // hides client/API misuse; forbidding them surfaces it and keeps the DTO
      // contract strict.
      forbidNonWhitelisted: true,
    }),
  );

  const expressApp = app.getHttpAdapter().getInstance();

  expressApp.use(httpErrorLogger);

  // Trust reverse proxy (Railway, Render, Traefik, Nginx, etc.) so Express
  // sees the real client IP from X-Forwarded-For headers. Enabled in
  // production deployments only — dev runs on loopback with no proxy.
  //
  // Restrict the trust to loopback / link-local / private subnets so a
  // remote attacker cannot forge an X-Forwarded-For value to make Express
  // think the request originated from a trusted IP. Operators with proxies
  // outside these ranges should set TRUST_PROXY explicitly.
  if (!isDev) {
    // Env values are always strings, but Express's `trust proxy` treats
    // numbers (hop count) and booleans differently from their string
    // equivalents — `"1"` is parsed as a CIDR / IP literal, not "trust
    // first hop". Coerce numeric and bool-shaped values explicitly.
    const rawTrustProxy = process.env['TRUST_PROXY'] ?? 'loopback, linklocal, uniquelocal';
    const trustProxy: string | number | boolean = /^\d+$/.test(rawTrustProxy)
      ? Number(rawTrustProxy)
      : rawTrustProxy === 'true'
        ? true
        : rawTrustProxy === 'false'
          ? false
          : rawTrustProxy;
    expressApp.set('trust proxy', trustProxy);
  }

  // Rate limit auth endpoints (Better Auth runs outside NestJS, so
  // ThrottlerGuard doesn't apply). Each endpoint gets its own limiter so
  // sign-in attempts don't share a budget with sign-up / password-reset.
  const { default: rateLimit } = await import('express-rate-limit');
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' },
    handler: createRateLimitReachedHandler('sign-in'),
  });
  const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-up attempts. Try again later.' },
    handler: createRateLimitReachedHandler('sign-up'),
  });
  // forget-password is the worst offender: each request sends an email and
  // can be used for account enumeration via timing differences. Tight cap.
  const forgetPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset requests. Try again later.' },
    handler: createRateLimitReachedHandler('password-reset'),
  });
  const verifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification requests. Try again later.' },
    handler: createRateLimitReachedHandler('verify-email'),
  });
  expressApp.use('/api/auth/sign-in', loginLimiter);
  expressApp.use('/api/auth/sign-up', signupLimiter);
  expressApp.use('/api/auth/forget-password', forgetPasswordLimiter);
  expressApp.use('/api/auth/forgot-password', forgetPasswordLimiter);
  expressApp.use('/api/auth/reset-password', forgetPasswordLimiter);
  expressApp.use('/api/auth/verify-email', verifyEmailLimiter);
  expressApp.use('/api/auth/send-verification-email', verifyEmailLimiter);

  // Mount Better Auth handler (needs raw body, before express.json)
  const { toNodeHandler } = await import('better-auth/node');
  const authHandler = (request: Request) =>
    auth.handler(request).then((response) => mcpOAuthResponse(request, response));
  expressApp.all(
    '/api/auth/*splat',
    // Better Auth's adapter checks for a handler property and delegates to it.
    toNodeHandler({ handler: authHandler } as typeof auth),
  );

  // Re-add body parsing for NestJS routes. The OpenAI-compatible proxy has a
  // separate parser because clients may legitimately send large inline image
  // payloads. Regular Manifest API/auth routes stay small.
  expressApp.use('/v1', createProxyBodyBudgetMiddleware());
  expressApp.use('/v1', express.json({ limit: PROXY_BODY_LIMIT }));
  expressApp.use('/v1', express.urlencoded({ extended: true, limit: PROXY_BODY_LIMIT }));
  expressApp.use(express.json({ limit: API_BODY_LIMIT }));
  expressApp.use(express.urlencoded({ extended: true, limit: API_BODY_LIMIT }));
  expressApp.use(bodyParserErrorHandler);

  // Both the OAuth discovery documents and the MCP module go together: with the
  // Better Auth MCP plugin unloaded there is no authorization server to
  // advertise, and publishing metadata for an endpoint that does not exist
  // sends clients into a flow that cannot complete.
  if (mcpEnabled) {
    mountMcpDiscovery(app);
  } else {
    mountMcpUnavailable(app);
    logger.warn(`Remote MCP server disabled: ${mcpDisabledReason}`);
  }

  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['BIND_ADDRESS'] ?? '127.0.0.1';
  await app.listen(port, host);
  logger.log(`Server running on http://${host}:${port}`);

  if (isDev && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    logger.warn(
      `Development mode with BIND_ADDRESS=${host} — auth guards are relaxed for loopback IPs. ` +
        'Ensure this server is not exposed to untrusted networks.',
    );
  }

  // Warn loudly when HSTS is silently disabled in production. Operators
  // running behind an HTTPS reverse proxy without setting BETTER_AUTH_URL
  // (or with an http:// value) will otherwise lose HSTS protection
  // without realizing it.
  if (
    !isDev &&
    !hstsEnabled &&
    host !== '127.0.0.1' &&
    host !== 'localhost' &&
    host !== '::1' &&
    process.env['MANIFEST_DISABLE_HSTS'] !== '1'
  ) {
    logger.warn(
      'HSTS is disabled. Set BETTER_AUTH_URL to your https:// origin to enable it, or set ' +
        'MANIFEST_DISABLE_HSTS=1 to silence this warning for HTTP-only LAN deployments.',
    );
  }

  return app;
}

// Only auto-start when run directly (not when embedded)
if (!process.env['MANIFEST_EMBEDDED']) {
  bootstrap().catch((err) => {
    // The server never came up. The most common cause is a failed database
    // migration — TypeORM logs the specific "Migration X failed, error: ..."
    // line just above this. Surface a clear, intentional fatal message and
    // exit non-zero, rather than leaving an unhandled rejection (or, before
    // the toRetry change, a misleading "Unable to connect to the database").
    new Logger('Bootstrap').fatal(
      'Manifest failed to start — see the error above. A failed database migration is the most ' +
        'common cause; if it reports provider/config rows that "cannot be re-scoped", back up your ' +
        'database and re-run with MANIFEST_MIGRATION_FORCE=1.',
      err instanceof Error ? err.stack : String(err),
    );
    process.exit(1);
  });
}
