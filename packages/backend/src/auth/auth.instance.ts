import { betterAuth } from 'better-auth';
import type { Auth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { stripe as stripePlugin } from '@better-auth/stripe';
import { render } from '@react-email/render';
import { VerifyEmailEmail } from '../notifications/emails/verify-email';
import { ResetPasswordEmail } from '../notifications/emails/reset-password';
import { sendEmail } from '../notifications/services/email-providers/send-email';
import { isBillingEnabled, getStripeClient } from '../billing/billing.config';
import { optionalPositiveInteger } from '../config/env.util';
import {
  previousPlanFromEvent,
  sendPlanChangedEmail,
  sendSubscriptionCanceledEmail,
  sendSubscriptionConfirmedEmail,
} from '../billing/subscription-webhook-emails';
import { fetchClientMetadataResource } from './cimd-client-metadata-fetch';
import { authOriginFromEnv, mcpAvailability } from './mcp-availability';
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE, MCP_SCOPES } from './mcp-scopes';

const port = process.env['PORT'] ?? '3001';
const isDev = (process.env['NODE_ENV'] ?? '') !== 'production';
const hasEmailProvider = !!(
  (process.env['EMAIL_PROVIDER'] && process.env['EMAIL_API_KEY']) ||
  (process.env['MAILGUN_API_KEY'] && process.env['MAILGUN_DOMAIN'])
);

/**
 * OAuth 2.1 identity for the remote MCP server.
 *
 * The MCP resource and the authorization-server issuer must derive from the
 * same normalized origin (trailing slashes stripped) or a later change to one
 * silently splits them — MCP clients validate the advertised `resource`
 * against the URL they connected to, so a divergence breaks connection.
 */
export const authOrigin = authOriginFromEnv();
export const authIssuer = `${authOrigin}/api/auth`;
export const mcpResource = `${authOrigin}/api/v1/mcp`;

/**
 * The remote MCP server only exists when its resource URL can be served. An
 * install on plain HTTP behind a LAN or tailnet hostname runs without it
 * rather than refusing to boot — see `mcp-availability.ts`.
 */
const mcpDecision = mcpAvailability();
export const mcpEnabled = mcpDecision.enabled;
export const mcpDisabledReason = mcpDecision.reason;
export { MCP_READ_SCOPE, MCP_WRITE_SCOPE, MCP_SCOPES } from './mcp-scopes';

const CLOUD_ORIGINS = ['https://app.manifest.build', 'https://gateway.manifest.build'];
const cloudOrigins = CLOUD_ORIGINS.includes(authOrigin) ? CLOUD_ORIGINS : [];
export const mcpResources = (cloudOrigins.length ? cloudOrigins : [authOrigin]).map(
  (origin) => `${origin}/api/v1/mcp`,
);

/** Keep each Cloud MCP endpoint bound to the host the client connected to. */
export function authOriginForHost(host: string | undefined): string {
  const normalizedHost = parseOriginHost(host);
  return (
    (cloudOrigins.length ? cloudOrigins : [authOrigin]).find(
      (origin) => new URL(origin).host === normalizedHost,
    ) ?? authOrigin
  );
}

export function authIssuerForHost(host: string | undefined): string {
  return `${authOriginForHost(host)}/api/auth`;
}

export function mcpResourceForHost(host: string | undefined): string {
  return `${authOriginForHost(host)}/api/v1/mcp`;
}

/** Host (with optional port) of an origin or bare hostname, or null when junk. */
function parseOriginHost(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.host || null;
  } catch {
    return null;
  }
}

/**
 * Better Auth pins the OAuth callback and the session cookie to its `baseURL`.
 * The dashboard and the API can answer on more than one host — the hosted
 * Cloud serves app.manifest.build and gateway.manifest.build from the same
 * service — so a single static origin sends a user who started on host A
 * through a callback on host B, where the session cookie lands on an origin
 * the dashboard cannot read. When a second host is configured, resolve the
 * base URL from the request host instead, restricted to an allow-list.
 *
 * Hosts come from `BETTER_AUTH_URL` (canonical), both Cloud domains,
 * `CORS_ORIGIN` (the dashboard origin already trusted for cross-origin calls),
 * and the optional
 * `BETTER_AUTH_ALLOWED_HOSTS` (comma-separated patterns, `*.` wildcards
 * allowed). Unknown hosts fall back to the canonical origin, and dev keeps the
 * static origin so the Vite proxy on :3000 doesn't move the callback off the
 * registered :3001 URL.
 */
function buildAuthBaseURL():
  string | { allowedHosts: string[]; fallback: string; protocol: 'http' | 'https' } {
  if (isDev) return authOrigin;
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const host = parseOriginHost(value);
    if (host) hosts.add(host);
  };
  add(process.env['BETTER_AUTH_URL']);
  add(process.env['CORS_ORIGIN']);
  for (const origin of cloudOrigins) add(origin);
  for (const entry of (process.env['BETTER_AUTH_ALLOWED_HOSTS'] ?? '').split(',')) add(entry);
  if (hosts.size <= 1) return authOrigin;
  return {
    allowedHosts: [...hosts],
    fallback: authOrigin,
    protocol: authOrigin.startsWith('https://') ? 'https' : 'http',
  };
}

export const authBaseURL = buildAuthBaseURL();

function createDatabaseConnection() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg');
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase';
  // Cap Better Auth's own pool (separate from the TypeORM pool) so the two
  // connection pools don't jointly exhaust Postgres's max_connections. Auth
  // traffic is light relative to ingest, hence a smaller default than the app
  // pool. Idle connections are reaped after 30s to free server-side slots.
  const max = optionalPositiveInteger(process.env['AUTH_DB_POOL_MAX']) ?? 5;
  return new Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 30000 });
}

const database = createDatabaseConnection();

const betterAuthSecret = process.env['BETTER_AUTH_SECRET'] ?? '';
const nodeEnv = process.env['NODE_ENV'] ?? '';

if (nodeEnv !== 'test' && (!betterAuthSecret || betterAuthSecret.length < 32)) {
  throw new Error('BETTER_AUTH_SECRET must be set to a value of at least 32 characters');
}

function buildTrustedOrigins(): string[] {
  const origins: string[] = [];
  if (process.env['BETTER_AUTH_URL']) {
    origins.push(process.env['BETTER_AUTH_URL']);
  }
  if (process.env['CORS_ORIGIN']) {
    origins.push(process.env['CORS_ORIGIN']);
  }
  origins.push(...cloudOrigins);
  if (isDev) {
    origins.push(
      `http://localhost:3000`,
      `http://127.0.0.1:3000`,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    );
  }
  if (process.env['FRONTEND_PORT']) {
    origins.push(
      `http://localhost:${process.env['FRONTEND_PORT']}`,
      `http://127.0.0.1:${process.env['FRONTEND_PORT']}`,
    );
  }
  return origins;
}

function buildPlugins() {
  // JWT access tokens are what the MCP resource route verifies: signature,
  // issuer, audience, and expiry, all against the plugin's JWKS. It stays on
  // unconditionally — it is not MCP-specific.
  //
  // The MCP plugin is the OAuth 2.1 authorization server behind the remote MCP
  // endpoint, and CIMD gives modern MCP clients a verified identity document
  // instead of anonymous dynamic registration. Both are skipped when MCP is
  // unavailable: `mcp()` validates its resource URL as it is constructed, so
  // building it on an HTTP-only install throws here and takes down the whole
  // process, and CIMD exists only to serve MCP clients.
  const base = [jwt(), ...(mcpEnabled ? buildMcpPlugins() : [])];
  if (!isBillingEnabled()) return base;
  const plans = [{ name: 'pro', priceId: process.env['STRIPE_PRO_PRICE_ID']! }];
  const priceToPlan = new Map(plans.map((plan) => [plan.priceId, plan.name]));
  return [
    ...base,
    stripePlugin({
      stripeClient: getStripeClient(),
      stripeWebhookSecret: process.env['STRIPE_WEBHOOK_SECRET']!,
      subscription: {
        enabled: true,
        plans,
        onSubscriptionComplete: async ({ event, subscription }) => {
          await sendSubscriptionConfirmedEmail(database, event, subscription);
        },
        onSubscriptionCreated: async ({ event, subscription }) => {
          await sendSubscriptionConfirmedEmail(database, event, subscription);
        },
        onSubscriptionUpdate: async ({ event, subscription }) => {
          const previousPlan = previousPlanFromEvent(event, priceToPlan);
          await sendPlanChangedEmail(database, event, subscription, previousPlan);
        },
        onSubscriptionCancel: async ({ event, subscription }) => {
          if (event) await sendSubscriptionCanceledEmail(database, event, subscription);
        },
        onSubscriptionDeleted: async ({ event, subscription }) => {
          await sendSubscriptionCanceledEmail(database, event, subscription);
        },
      },
    }),
  ];
}

function buildMcpPlugins() {
  return [
    mcp({
      loginPage: '/login',
      consentPage: '/consent',
      resource: mcpResource,
      scopes: [...MCP_SCOPES, 'offline_access'],
      resources: mcpResources.map((identifier) => ({
        identifier,
        name: 'Manifest MCP',
        // Short-lived bearer tokens; the refresh token (offline_access) is
        // how an editor stays connected across a session.
        accessTokenTtl: 15 * 60,
        allowedScopes: [...MCP_SCOPES, 'offline_access'],
      })),
      clientRegistrationDefaultResources: mcpResources,
      resourceSeedMode: 'overwrite',
      clientRegistrationDefaultScopes: [MCP_READ_SCOPE],
      clientRegistrationAllowedScopes: [MCP_WRITE_SCOPE, 'offline_access'],
      // DCR stays available to signed-in users, but anonymous registration is
      // off: a client that can point a URL at a verified metadata document
      // (CIMD) identifies itself, and everyone else must be added by an
      // operator. This is the MCP 2026-07-28 posture.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: false,
      clientRegistrationRequirePKCE: true,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: 'mcp-2026-07-28',
    }),
  ];
}

const pluginAuth = betterAuth({
  database,
  baseURL: authBaseURL,
  basePath: '/api/auth',
  secret: betterAuthSecret,
  logger: { level: 'debug' },
  telemetry: { enabled: false },
  plugins: buildPlugins(),
  session: {
    // Validate sessions from a signed cookie instead of the database. The two
    // statements behind a lookup take 0.3 ms, but on the production path they
    // cost ~0.5 s per call, paid by the browser's get-session probe and by
    // every SessionGuard cache miss, before any page can load. A revoked
    // session stays valid for at most maxAge; sign-out clears the cookie.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ['google', 'github', 'discord'],
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: !isDev && hasEmailProvider,
    sendResetPassword: async ({ user, url }) => {
      const element = ResetPasswordEmail({
        userName: user.name,
        resetUrl: url,
      });
      const html = await render(element);
      const text = await render(element, { plainText: true });
      void sendEmail({
        to: user.email,
        subject: 'Reset your password',
        html,
        text,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: hasEmailProvider,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const element = VerifyEmailEmail({
        userName: user.name,
        verificationUrl: url,
      });
      const html = await render(element);
      const text = await render(element, { plainText: true });
      void sendEmail({
        to: user.email,
        subject: 'Verify your email address',
        html,
        text,
      });
    },
  },
  socialProviders: {
    google: {
      clientId: process.env['GOOGLE_CLIENT_ID'] ?? '',
      clientSecret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
      enabled: !!(process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET']),
    },
    github: {
      clientId: process.env['GITHUB_CLIENT_ID'] ?? '',
      clientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
      enabled: !!(process.env['GITHUB_CLIENT_ID'] && process.env['GITHUB_CLIENT_SECRET']),
      scope: ['user:email'],
    },
    discord: {
      clientId: process.env['DISCORD_CLIENT_ID'] ?? '',
      clientSecret: process.env['DISCORD_CLIENT_SECRET'] ?? '',
      enabled: !!(process.env['DISCORD_CLIENT_ID'] && process.env['DISCORD_CLIENT_SECRET']),
      scope: ['identify', 'email'],
    },
  },
  trustedOrigins: buildTrustedOrigins(),
});

// `auth` stays typed as the generic `Auth` for the many existing consumers that
// only need the common surface (session, api). The concrete instance is exported
// separately because plugin-aware helpers (OAuth discovery, MCP auth) need the
// plugin-augmented API types that the generic widens away.
export type AuthInstance = typeof pluginAuth;
export const authInstance = pluginAuth;
export const auth = pluginAuth as unknown as Auth;

export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = typeof auth.$Infer.Session.user;
