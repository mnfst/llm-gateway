import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { entities, migrations } from './data-source-definitions';
// Entities referenced directly below via TypeOrmModule.forFeature(); the full
// registry for the DataSource lives in ./data-source-definitions.
import { Tenant } from '../entities/tenant.entity';
import { Agent } from '../entities/agent.entity';
import { AgentApiKey } from '../entities/agent-api-key.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';
import { ApiKey } from '../entities/api-key.entity';
import { TenantProvider } from '../entities/tenant-provider.entity';
import { TierAssignment } from '../entities/tier-assignment.entity';
import { CustomProvider } from '../entities/custom-provider.entity';
import { SpecificityAssignment } from '../entities/specificity-assignment.entity';
import { HeaderTier } from '../entities/header-tier.entity';
import { AgentModelParams } from '../entities/agent-model-params.entity';
import { ReasoningContentCacheEntry } from '../entities/reasoning-content-cache-entry.entity';
import { AgentEnabledProvider } from '../entities/agent-enabled-provider.entity';
import { DatabaseSeederService } from './database-seeder.service';
import { DbTuningService } from './db-tuning.service';
import { ModelPricesModule } from '../model-prices/model-prices.module';
import { shouldRetryDbConnection } from '../common/utils/db-retry';
import { RequestRecordingRetentionService } from './request-recording-retention.service';
import { SecretReencryptionService } from './secret-reencryption.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('app.databaseUrl'),
        entities,
        synchronize: false,
        // Run migrations on boot by default. `synchronize: false` is permanent,
        // so committed migrations are the only source of schema changes, and a
        // single instance (dev, self-hosted) must boot with the schema applied
        // (the dashboard 500s on missing tables). On multi-replica deploys this
        // is turned off (RUN_MIGRATIONS_ON_BOOT=false) so replicas don't migrate
        // concurrently over PgBouncer — a pre-deploy step migrates once over a
        // direct connection instead. Previously this was hardcoded true, which
        // deadlocked when several replicas migrated at once on the same deploy.
        migrationsRun: config.get<boolean>('app.runMigrationsOnBoot'),
        // 'each' (per-migration transaction), not 'all': the agent_messages index
        // migrations run CONCURRENTLY and declare `transaction = false`, which
        // TypeORM forbids under 'all'. CONCURRENTLY avoids the ACCESS EXCLUSIVE
        // lock that deadlocks against live writes during a deploy.
        migrationsTransactionMode: 'each' as const,
        migrations,
        // A failed migration must not go through the connection-retry loop:
        // @nestjs/typeorm checks toRetry before logging, so returning false
        // here suppresses the misleading "Unable to connect to the database.
        // Retrying" line and fails fast with the real migration error. Genuine
        // connectivity failures (DB not ready yet) still retry.
        toRetry: shouldRetryDbConnection,
        logging: false,
        extra: {
          // app.config.ts always resolves dbPoolMax (default 10), so there is no
          // undefined case to fall back from — keep that file the single source
          // of truth for the pool size.
          max: config.get<number>('app.dbPoolMax'),
          idleTimeoutMillis: 30000,
          // statement_timeout / idle_in_transaction_session_timeout were tried
          // here (#1745) and via the `options` connection string (#1749), but
          // Railway's PgBouncer rejects both forms — its
          // `ignore_startup_parameters` allowlist only includes
          // `extra_float_digits`. If we need per-query timeouts later, set
          // them with `SET LOCAL` inside the relevant transaction instead.
        },
      }),
    }),
    TypeOrmModule.forFeature([
      Tenant,
      Agent,
      AgentApiKey,
      AgentMessage,
      ManifestRequest,
      ApiKey,
      TenantProvider,
      TierAssignment,
      CustomProvider,
      SpecificityAssignment,
      HeaderTier,
      AgentModelParams,
      ReasoningContentCacheEntry,
      AgentEnabledProvider,
    ]),
    ModelPricesModule,
  ],
  providers: [
    DatabaseSeederService,
    DbTuningService,
    RequestRecordingRetentionService,
    SecretReencryptionService,
  ],
  exports: [DatabaseSeederService],
})
export class DatabaseModule {}
