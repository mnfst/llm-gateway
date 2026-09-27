import { registerAs } from '@nestjs/config';
import { optionalPositiveInteger } from './env.util';

function resolveDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url) return url;
  if (process.env['NODE_ENV'] === 'test')
    return 'postgresql://myuser:mypassword@localhost:5432/mydatabase';
  throw new Error('DATABASE_URL is required. Set it in your .env file.');
}

export const appConfig = registerAs('app', () => ({
  port: Number(process.env['PORT'] ?? 3001),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  databaseUrl: resolveDatabaseUrl(),

  corsOrigin: process.env['CORS_ORIGIN'] ?? 'http://localhost:3000',
  betterAuthUrl: process.env['BETTER_AUTH_URL'] ?? '',
  throttleTtl: Number(process.env['THROTTLE_TTL'] ?? 60000),
  throttleLimit: Number(process.env['THROTTLE_LIMIT'] ?? 100),
  apiKey: process.env['API_KEY'] ?? '',
  bindAddress: process.env['BIND_ADDRESS'] ?? '127.0.0.1',
  // Unified email provider (used for BOTH Better Auth transactional emails
  // and threshold alerts when no per-user config exists). Supports mailgun,
  // resend, sendgrid.
  emailProvider: process.env['EMAIL_PROVIDER'] ?? '',
  emailApiKey: process.env['EMAIL_API_KEY'] ?? '',
  emailDomain: process.env['EMAIL_DOMAIN'] ?? '',
  emailFrom:
    process.env['EMAIL_FROM'] ?? process.env['NOTIFICATION_FROM_EMAIL'] ?? 'noreply@manifest.build',
  // Legacy Mailgun-only (backward compat with older deployments).
  mailgunApiKey: process.env['MAILGUN_API_KEY'] ?? '',
  mailgunDomain: process.env['MAILGUN_DOMAIN'] ?? '',
  notificationFromEmail: process.env['NOTIFICATION_FROM_EMAIL'] ?? 'noreply@manifest.build',
  // Keep the per-process pool conservative by default. Multi-replica installs
  // multiply this value, and large analytics queries can otherwise saturate a
  // pooler and execute enough concurrent hash/sort work to exhaust DB memory.
  dbPoolMax: optionalPositiveInteger(process.env['DB_POOL_MAX']) ?? 10,
  // Apply PgBouncer-safe planner defaults (jit off, larger work_mem, SSD-tuned
  // random_page_cost) as role-level defaults at boot. Set DB_TUNE_SESSION=false
  // to skip (e.g. a managed Postgres where the role lacks ALTER ROLE on itself).
  dbTuneSession: process.env['DB_TUNE_SESSION'] !== 'false',
  // Run pending migrations on app boot. Default on (safe for single-instance dev
  // and self-hosted). Set RUN_MIGRATIONS_ON_BOOT=false on multi-replica deploys
  // (Railway) where a pre-deploy step migrates once over a direct connection, so
  // replicas never migrate concurrently over PgBouncer.
  runMigrationsOnBoot: process.env['RUN_MIGRATIONS_ON_BOOT'] !== 'false',
  // Graceful-shutdown drain window (ms). On a real termination signal in
  // production the server keeps accepting traffic for this long — while the
  // health probe reports 503 — so the platform edge (Railway) deregisters this
  // replica before its socket closes, instead of refusing requests it is still
  // routing during the post-SIGTERM deregistration lag (the rolling-deploy 5xx
  // spike). Must be shorter than Railway's `drainingSeconds`. 0 disables it.
  shutdownDrainMs: Number(process.env['SHUTDOWN_DRAIN_MS'] ?? 10000),
  // When true, /api/v1/public/error-pages serves the published error pages
  // without auth. Off by default; only Manifest Cloud's marketing site uses it.
  // The variable keeps its historical name so existing deployments stay on.
  publicErrorPagesEnabled: process.env['MANIFEST_PUBLIC_STATS'] === 'true',
  // Optional instance-wide override. When unset, request recordings follow the
  // Cloud plan policy (Free 7 days, Pro 365 days); non-billing deployments use
  // the 365-day default.
  requestRecordingRetentionDays: optionalPositiveInteger(
    process.env['REQUEST_RECORDING_RETENTION_DAYS'],
  ),
  // Recording storage uses capability detection by default: complete S3
  // credentials win, otherwise self-hosted installs use their mounted
  // filesystem. The explicit selector is an escape hatch for custom setups.
  requestRecordingStorage: process.env['REQUEST_RECORDING_STORAGE'] ?? 'auto',
  requestRecordingFilesystemPath: process.env['REQUEST_RECORDING_FILESYSTEM_PATH'] ?? '',
  requestRecordingS3Bucket: process.env['REQUEST_RECORDING_S3_BUCKET'] ?? '',
  requestRecordingS3Endpoint: process.env['REQUEST_RECORDING_S3_ENDPOINT'] ?? '',
  requestRecordingS3Region: process.env['REQUEST_RECORDING_S3_REGION'] ?? '',
  requestRecordingS3AccessKeyId: process.env['REQUEST_RECORDING_S3_ACCESS_KEY_ID'] ?? '',
  requestRecordingS3SecretAccessKey: process.env['REQUEST_RECORDING_S3_SECRET_ACCESS_KEY'] ?? '',
  requestRecordingS3ForcePathStyle: process.env['REQUEST_RECORDING_S3_FORCE_PATH_STYLE'] === 'true',
  // Shared secret guarding the internal error-page push endpoint
  // (/api/v1/internal/error-pages). The Peacock CMS sends it in the
  // `x-internal-secret` header to publish/unpublish curated error pages.
  // Empty by default — the endpoint rejects all writes until it is set.
  errorPagePushSecret: process.env['ERROR_PAGE_PUSH_SECRET'] ?? '',
  // Shared secret guarding the internal CRM metrics feed
  // (/api/v1/internal/crm-metrics), which the outreach CRM polls daily. Sent in
  // the `x-internal-secret` header. Deliberately separate from
  // errorPagePushSecret: different consumer, different credential. Empty by
  // default, and anything shorter than 32 chars counts as unset — this route
  // exports user email addresses across tenants.
  crmMetricsSecret: process.env['CRM_METRICS_SECRET'] ?? '',
  // Sliding lifetime (days) of a CLI-minted management PAT. Every successful
  // authentication pushes the key's `expires_at` this far into the future, so
  // an active CLI never has to re-login and an abandoned one lapses.
  cliTokenTtlDays: optionalPositiveInteger(process.env['CLI_TOKEN_TTL_DAYS']) ?? 30,
  // Absolute ceiling for a CLI PAT, in days from issuance. The sliding window
  // renews on every use, so this is what ultimately retires a token that is in
  // constant use. Must be >= cliTokenTtlDays to be meaningful.
  cliTokenAbsoluteTtlDays:
    optionalPositiveInteger(process.env['CLI_TOKEN_ABSOLUTE_TTL_DAYS']) ?? 90,
}));
