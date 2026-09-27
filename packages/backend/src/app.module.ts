import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { appConfig } from './config/app.config';
import { resolveFrontendDir } from './common/utils/frontend-path';
import { DASHBOARD_CACHE_TTL_MS } from './common/constants/cache.constants';
import { buildDashboardCacheStore } from './common/cache/dashboard-cache.factory';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { ApiKey } from './entities/api-key.entity';
import { SessionGuard } from './auth/session.guard';
import { DatabaseModule } from './database/database.module';
import { BackfillModule } from './database/backfills/backfill.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { OtlpModule } from './otlp/otlp.module';
import { ModelPricesModule } from './model-prices/model-prices.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RoutingModule } from './routing/routing.module';
import { PlaygroundModule } from './playground/playground.module';
import { CommonModule } from './common/common.module';
import { SseModule } from './sse/sse.module';
import { GithubModule } from './github/github.module';
import { VersionModule } from './version/version.module';
import { ErrorPagesModule } from './error-pages/error-pages.module';
import { SetupModule } from './setup/setup.module';
import { FreeModelsModule } from './free-models/free-models.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { BillingModule } from './billing/billing.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { CrmMetricsModule } from './crm-metrics/crm-metrics.module';
import { McpModule } from './mcp/mcp.module';
import { mcpAvailability } from './auth/mcp-availability';
import { isSelfHosted } from './common/utils/detect-self-hosted';
import { DebugSentryController } from './sentry/debug-sentry.controller';

const frontendPath = resolveFrontendDir();
const ONE_YEAR_S = 365 * 24 * 60 * 60;
const serveStaticImports = frontendPath
  ? [
      ServeStaticModule.forRoot({
        rootPath: frontendPath,
        renderPath: '/__serve_static_never_match',
        exclude: ['/api/{*path}', '/v1/{*path}'],
        serveStaticOptions: {
          maxAge: ONE_YEAR_S * 1000,
          immutable: true,
          setHeaders: (res: { setHeader: (name: string, value: string) => void }, path: string) => {
            // index.html must never be cached (SPA entry point)
            if (path.endsWith('.html') || path.endsWith('/index.html')) {
              res.setHeader('Cache-Control', 'no-cache');
            }
          },
        },
      }),
    ]
  : [];

const sentryEnabled = Boolean(process.env['SENTRY_DSN']?.trim());
const sentryImports = sentryEnabled ? [SentryModule.forRoot()] : [];
const sentryProviders = sentryEnabled
  ? [{ provide: APP_FILTER, useClass: SentryGlobalFilter }]
  : [];
const sentryDebugControllers =
  sentryEnabled && process.env['NODE_ENV'] !== 'production' ? [DebugSentryController] : [];

// The CRM metrics feed drives Cloud outreach. Leaving it unregistered on
// self-hosted means the routes do not exist there at all, rather than existing
// and answering 401 forever, and pairs with migration 1802200000000 skipping
// its index so a self-hosted install sees no trace of this feature.
const crmMetricsImports = isSelfHosted() ? [] : [CrmMetricsModule];

// The remote MCP server is off on installs whose origin cannot carry an MCP
// resource, and on installs that set MCP_ENABLED=false. Leaving the module
// unregistered means `/api/v1/mcp` does not exist rather than answering an
// unauthenticated 401 that no client could ever satisfy — the OAuth
// authorization server behind it is not running either.
const mcpImports = mcpAvailability().enabled ? [McpModule] : [];

@Module({
  imports: [
    ...sentryImports,
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    CacheModule.register({
      isGlobal: true,
      ttl: DASHBOARD_CACHE_TTL_MS,
      stores: [buildDashboardCacheStore()],
    }),
    ...serveStaticImports,
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env['THROTTLE_TTL'] ?? 60000),
        limit: Number(process.env['THROTTLE_LIMIT'] ?? 100),
      },
    ]),
    CommonModule,
    DatabaseModule,
    TypeOrmModule.forFeature([ApiKey]),
    AuthModule,
    HealthModule,
    AnalyticsModule,
    OtlpModule,
    ModelPricesModule,
    NotificationsModule,
    RoutingModule,
    PlaygroundModule,
    SseModule,
    GithubModule,
    VersionModule,
    ErrorPagesModule,
    SetupModule,
    FreeModelsModule,
    TelemetryModule,
    BackfillModule,
    WaitlistModule,
    BillingModule,
    DiscoveryModule,
    ...mcpImports,
    ...crmMetricsImports,
  ],
  providers: [
    ...sentryProviders,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  controllers: [...sentryDebugControllers],
})
export class AppModule {}
