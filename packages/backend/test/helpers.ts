import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { RequestWithTenantContext } from '../src/common/decorators/tenant-context.decorator';
import { appConfig } from '../src/config/app.config';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { hashKey, keyPrefix } from '../src/common/utils/hash.util';
import { AgentMessage } from '../src/entities/agent-message.entity';
import { ManifestRequest } from '../src/entities/request.entity';
import { ApiKey } from '../src/entities/api-key.entity';
import { Tenant } from '../src/entities/tenant.entity';
import { Agent } from '../src/entities/agent.entity';
import { AgentApiKey } from '../src/entities/agent-api-key.entity';
import { NotificationRule } from '../src/entities/notification-rule.entity';
import { NotificationLog } from '../src/entities/notification-log.entity';
import { TenantProvider } from '../src/entities/tenant-provider.entity';
import { TierAssignment } from '../src/entities/tier-assignment.entity';
import { CustomProvider } from '../src/entities/custom-provider.entity';
import { EmailProviderConfig } from '../src/entities/email-provider-config.entity';
import { SpecificityAssignment } from '../src/entities/specificity-assignment.entity';
import { HeaderTier } from '../src/entities/header-tier.entity';
import { InstallMetadata } from '../src/entities/install-metadata.entity';
import { AgentModelParams } from '../src/entities/agent-model-params.entity';
import { PlaygroundRun } from '../src/entities/playground-run.entity';
import { PlaygroundColumn } from '../src/entities/playground-column.entity';
import { ReasoningContentCacheEntry } from '../src/entities/reasoning-content-cache-entry.entity';
import { AgentEnabledProvider } from '../src/entities/agent-enabled-provider.entity';
import { BackfillState } from '../src/entities/backfill-state.entity';
import { PublicErrorPage } from '../src/entities/public-error-page.entity';
import { WaitlistClaim } from '../src/entities/waitlist-claim.entity';
import { TenantRequestUsage } from '../src/entities/tenant-request-usage.entity';
import { CliAuthCode } from '../src/entities/cli-auth-code.entity';
import { AuthModule } from '../src/auth/auth.module';
import { HealthModule } from '../src/health/health.module';
import { AnalyticsModule } from '../src/analytics/analytics.module';
import { OtlpModule } from '../src/otlp/otlp.module';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { ModelPricesModule } from '../src/model-prices/model-prices.module';
import { ModelPricingCacheService } from '../src/model-prices/model-pricing-cache.service';
import { RoutingModule } from '../src/routing/routing.module';
import { PlaygroundModule } from '../src/playground/playground.module';
import { CommonModule } from '../src/common/common.module';
import { SetupModule } from '../src/setup/setup.module';
import { WaitlistModule } from '../src/waitlist/waitlist.module';
import { CrmMetricsModule } from '../src/crm-metrics/crm-metrics.module';
import { ProviderModelFetcherService } from '../src/model-discovery/provider-model-fetcher.service';

export const TEST_USER_ID = 'test-user-001';
export const TEST_API_KEY = 'test-api-key-001';
export const TEST_TENANT_ID = 'test-tenant-001';
export const TEST_AGENT_ID = 'test-agent-001';
export const TEST_OTLP_KEY = 'mnfst_test-otlp-key-001';

const entities = [
  AgentMessage,
  ManifestRequest,
  ApiKey,
  Tenant,
  Agent,
  AgentApiKey,
  NotificationRule,
  NotificationLog,
  TenantProvider,
  TierAssignment,
  CustomProvider,
  EmailProviderConfig,
  SpecificityAssignment,
  HeaderTier,
  InstallMetadata,
  AgentModelParams,
  PlaygroundRun,
  PlaygroundColumn,
  ReasoningContentCacheEntry,
  AgentEnabledProvider,
  BackfillState,
  PublicErrorPage,
  WaitlistClaim,
  TenantRequestUsage,
  CliAuthCode,
];
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_MODELS_FIXTURE = {
  data: [
    {
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      context_length: 128000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0.0000025',
        completion: '0.00001',
      },
    },
    {
      id: 'openai/gpt-4o-mini',
      name: 'OpenAI: GPT-4o Mini',
      context_length: 128000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0.00000015',
        completion: '0.0000006',
      },
    },
    {
      id: 'anthropic/claude-opus-4-6',
      name: 'Anthropic: Claude Opus 4.6',
      context_length: 200000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0.000015',
        completion: '0.000075',
      },
    },
    {
      id: 'z-ai/glm-5',
      name: 'Z.ai: GLM-5',
      context_length: 128000,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0.000002',
        completion: '0.000008',
      },
    },
  ],
} as const;

export interface CreateTestAppOptions {
  configureApp?: (app: INestApplication) => void;
  dropSchema?: boolean;
  seed?: boolean;
}

function buildTypeOrmConfig(options: CreateTestAppOptions): TypeOrmModuleOptions {
  return {
    type: 'postgres' as const,
    url: process.env['DATABASE_URL'] ?? 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
    entities,
    synchronize: true,
    dropSchema: options.dropSchema ?? true,
    logging: false,
  };
}

/**
 * Mimics the production SessionGuard contract: authenticates the request and
 * attaches both `request.user` and the tenant context that @TenantCtx()
 * controllers read. The tenant is resolved through `tenants.owner_user_id` —
 * the same (and only) user→tenant link production resolution uses.
 *
 * Tests exercising multiple users can impersonate another user by setting the
 * `x-test-user-id` header alongside `x-api-key`.
 */
@Injectable()
class MockSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];
    if (!apiKey) {
      throw new UnauthorizedException('Authentication required');
    }

    const userId =
      typeof request.headers['x-test-user-id'] === 'string'
        ? (request.headers['x-test-user-id'] as string)
        : TEST_USER_ID;

    request.user = { id: userId, email: 'test@test.com', name: 'Test' };
    request.session = { id: 'test-session', userId };
    // Production's SessionGuard/ApiKeyGuard stamp how the caller authenticated;
    // session-only endpoints read it. Tests impersonate API-key auth with the
    // `x-test-auth-method` header.
    request.authMethod =
      typeof request.headers['x-test-auth-method'] === 'string'
        ? request.headers['x-test-auth-method']
        : 'session';

    // Resolve the user's tenant via owner_user_id (no caching: tests create
    // tenants on the fly and must see them on the next request).
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM tenants WHERE owner_user_id = $1 LIMIT 1`,
      [userId],
    );
    (request as RequestWithTenantContext).tenantContext = {
      tenantId: rows[0]?.id ?? null,
      userId,
    };
    return true;
  }
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  process.env['API_KEY'] = TEST_API_KEY;
  process.env['NODE_ENV'] = 'test';
  process.env['BETTER_AUTH_SECRET'] =
    process.env['BETTER_AUTH_SECRET'] ?? 'test-secret-for-e2e-at-least-32chars!!';
  const restoreFetch = stubOpenRouterPricingFetch();

  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
        CacheModule.register({ isGlobal: true, ttl: 5000 }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }]),
        TypeOrmModule.forRoot(buildTypeOrmConfig(options)),
        TypeOrmModule.forFeature(entities),
        CommonModule,
        AuthModule,
        HealthModule,
        AnalyticsModule,
        OtlpModule,
        NotificationsModule,
        ModelPricesModule,
        RoutingModule,
        PlaygroundModule,
        SetupModule,
        WaitlistModule,
        CrmMetricsModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: MockSessionGuard }],
    })
      // Provider-connect tests use fake credentials. Keep model discovery
      // deterministic instead of waiting on live provider APIs to reject them.
      .overrideProvider(ProviderModelFetcherService)
      .useValue({ fetch: async () => [] })
      .compile();

    const app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        // Mirror the global pipe in main.ts so E2E exercises the real
        // strict-DTO behavior (unknown fields → 400, not silently stripped).
        forbidNonWhitelisted: true,
      }),
    );
    options.configureApp?.(app);
    await app.init();

    const ds = app.get(DataSource);
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

    if (options.seed !== false) {
      // Seed test tenant (owner_user_id is the ONLY user→tenant link), agent,
      // API key and OTLP key (hashed)
      await ds.query(
        `INSERT INTO tenants (id, name, owner_user_id, organization_name, is_active, created_at, updated_at) VALUES ($1,$2,$3,$4,true,$5,$6)`,
        [TEST_TENANT_ID, TEST_USER_ID, TEST_USER_ID, 'Test Org', now, now],
      );
      await ds.query(
        `INSERT INTO api_keys (id, key, key_hash, key_prefix, tenant_id, created_by_user_id, name, created_at) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
        [
          'test-key-id',
          hashKey(TEST_API_KEY),
          keyPrefix(TEST_API_KEY),
          TEST_TENANT_ID,
          TEST_USER_ID,
          'Test Key',
          now,
        ],
      );
      await ds.query(
        `INSERT INTO agents (id, name, display_name, description, is_active, complexity_routing_enabled, tenant_id, created_at, updated_at) VALUES ($1,$2,$3,$4,true,true,$5,$6,$7)`,
        [TEST_AGENT_ID, 'test-agent', 'Test Agent', 'Test agent', TEST_TENANT_ID, now, now],
      );
      await ds.query(
        `INSERT INTO agent_api_keys (id, key, key_hash, key_prefix, label, tenant_id, agent_id, is_active, created_at) VALUES ($1, NULL, $2, $3, $4, $5, $6, true, $7)`,
        [
          'test-otlp-key-id',
          hashKey(TEST_OTLP_KEY),
          keyPrefix(TEST_OTLP_KEY),
          'Test OTLP Key',
          TEST_TENANT_ID,
          TEST_AGENT_ID,
          now,
        ],
      );
    }

    // Reload pricing cache from deterministic fixture data to keep e2e startup fast.
    const pricingCache = app.get(ModelPricingCacheService);
    await pricingCache.reload();

    return app;
  } finally {
    restoreFetch();
  }
}

/**
 * Persistent stub for provider model-discovery calls. Provider connects run
 * live discovery against the provider's real /models API with the spec's fake
 * key; on a healthy network that is an instant 401, but a degraded network
 * turns every connect into a multi-second hang and times the suite out.
 * Answering the 401 locally keeps the exact same code path (discovery falls
 * back to the OpenRouter fixture) while making it deterministic.
 *
 * Install after createTestApp() and restore in afterAll.
 */
export function stubProviderDiscoveryFetch(): () => void {
  const originalFetch = global.fetch;
  const DISCOVERY_HOSTS = ['api.openai.com', 'api.anthropic.com'];

  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = getFetchUrl(input);
    if (DISCOVERY_HOSTS.some((host) => url.includes(host))) {
      return new Response(
        JSON.stringify({
          error: { message: 'Incorrect API key provided', type: 'invalid_request_error' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

function stubOpenRouterPricingFetch(): () => void {
  const originalFetch = global.fetch;

  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = getFetchUrl(input);
    if (url === OPENROUTER_MODELS_URL) {
      return new Response(JSON.stringify(OPENROUTER_MODELS_FIXTURE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
