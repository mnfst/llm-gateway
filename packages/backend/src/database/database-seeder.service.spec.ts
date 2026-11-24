const ORIGINAL_ENCRYPTION_KEY = process.env['MANIFEST_ENCRYPTION_KEY'];
process.env['MANIFEST_ENCRYPTION_KEY'] ??= 'test-recording-secret-at-least-32-characters';
afterAll(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env['MANIFEST_ENCRYPTION_KEY'];
  else process.env['MANIFEST_ENCRYPTION_KEY'] = ORIGINAL_ENCRYPTION_KEY;
});

import { keyPrefix, verifyKey } from '../common/utils/hash.util';
import { decodeRequestRecording } from '../common/utils/request-recording-codec';
import { DatabaseSeederService } from './database-seeder.service';
import { getSeedConnections } from './seed-messages';

// Mock auth.instance before importing the service
jest.mock('../auth/auth.instance', () => ({
  auth: {
    $context: Promise.resolve({ runMigrations: jest.fn() }),
    api: { signUpEmail: jest.fn() },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { auth } = require('../auth/auth.instance');

function makeMockRepo() {
  return {
    count: jest.fn().mockResolvedValue(0),
    insert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

describe('DatabaseSeederService', () => {
  let service: DatabaseSeederService;
  let mockDataSource: { query: jest.Mock };
  let mockConfigService: { get: jest.Mock };
  let mockTenantRepo: ReturnType<typeof makeMockRepo>;
  let mockAgentRepo: ReturnType<typeof makeMockRepo>;
  let mockAgentKeyRepo: ReturnType<typeof makeMockRepo>;
  let mockApiKeyRepo: ReturnType<typeof makeMockRepo>;
  let mockMessageRepo: ReturnType<typeof makeMockRepo>;
  let mockRequestRepo: ReturnType<typeof makeMockRepo>;
  let mockProviderRepo: ReturnType<typeof makeMockRepo>;
  let mockEnabledProviderRepo: ReturnType<typeof makeMockRepo>;
  let mockTierRepo: ReturnType<typeof makeMockRepo>;
  let mockSpecificityRepo: ReturnType<typeof makeMockRepo>;
  let mockRecordingStorage: {
    backend: 'filesystem';
    objectKey: jest.Mock;
    put: jest.Mock;
  };
  let configValues: Record<string, string | undefined>;

  beforeEach(() => {
    mockDataSource = { query: jest.fn() };
    configValues = { 'app.nodeEnv': 'development', SEED_DATA: 'true' };
    mockConfigService = {
      get: jest
        .fn()
        .mockImplementation((key: string, fallback?: string) => configValues[key] ?? fallback),
    };
    mockTenantRepo = makeMockRepo();
    mockAgentRepo = makeMockRepo();
    mockAgentKeyRepo = makeMockRepo();
    mockApiKeyRepo = makeMockRepo();
    mockMessageRepo = makeMockRepo();
    mockRequestRepo = makeMockRepo();
    mockProviderRepo = makeMockRepo();
    mockEnabledProviderRepo = makeMockRepo();
    mockTierRepo = makeMockRepo();
    mockSpecificityRepo = makeMockRepo();
    mockRecordingStorage = {
      backend: 'filesystem',
      objectKey: jest
        .fn()
        .mockReturnValue(
          'request-recordings/v1/tenants/seed-tenant-001/requests/' +
            'seed-req-recording-001/attempts/seed-msg-recording-001.json.gz',
        ),
      put: jest.fn().mockResolvedValue(undefined),
    };

    service = new DatabaseSeederService(
      mockDataSource as never,
      mockConfigService as never,
      mockTenantRepo as never,
      mockAgentRepo as never,
      mockAgentKeyRepo as never,
      mockApiKeyRepo as never,
      mockMessageRepo as never,
      mockRequestRepo as never,
      mockProviderRepo as never,
      mockEnabledProviderRepo as never,
      mockTierRepo as never,
      mockSpecificityRepo as never,
      mockRecordingStorage as never,
    );

    jest.clearAllMocks();

    // Re-apply default mock after clearAllMocks
    mockConfigService.get.mockImplementation(
      (key: string, fallback?: string) => configValues[key] ?? fallback,
    );

    // Default: admin user exists
    mockDataSource.query.mockResolvedValue([{ id: 'admin-user-id' }]);

    // The routing-cohort seed is keyed on the clean agent already existing;
    // default it to "already seeded" so the existing seeder tests are
    // unaffected. The seedDemoCohorts tests below flip this to 0 to exercise
    // the cohort-seeding path.
    mockAgentRepo.count.mockResolvedValue(1);
  });

  describe('onModuleInit', () => {
    it('should run Better Auth migrations', async () => {
      const ctx = await auth.$context;
      await service.onModuleInit();
      expect(ctx.runMigrations).toHaveBeenCalled();
    });

    it('should seed demo data when env is development and SEED_DATA is true', async () => {
      configValues['app.nodeEnv'] = 'development';
      configValues['SEED_DATA'] = 'true';

      await service.onModuleInit();

      // seedApiKey was called
      expect(mockApiKeyRepo.count).toHaveBeenCalledWith({
        where: { id: 'seed-api-key-001' },
      });
      // seedTenantAndAgent was called
      expect(mockTenantRepo.count).toHaveBeenCalledWith({
        where: { id: 'seed-tenant-001' },
      });
    });

    it('should seed demo data when env is test and SEED_DATA is true', async () => {
      configValues['app.nodeEnv'] = 'test';
      configValues['SEED_DATA'] = 'true';

      await service.onModuleInit();

      expect(mockApiKeyRepo.count).toHaveBeenCalledWith({
        where: { id: 'seed-api-key-001' },
      });
    });

    it('seeds a realistic attempt-level recording preview', async () => {
      await service.onModuleInit();

      expect(mockRequestRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'seed-req-recording-001',
          status: 'success',
          requested_model: 'auto',
        }),
      );
      expect(mockMessageRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'seed-msg-recording-001',
          request_id: 'seed-req-recording-001',
          attempt_number: 1,
          model: 'gpt-4o-mini',
          provider: 'openai',
          recording_key: null,
        }),
      );

      const [storageKey, encoded] = mockRecordingStorage.put.mock.calls[0];
      expect(storageKey).toContain(
        'tenants/seed-tenant-001/requests/seed-req-recording-001/attempts/' +
          'seed-msg-recording-001.json.gz',
      );
      await expect(decodeRequestRecording(encoded)).resolves.toEqual(
        expect.objectContaining({
          version: 1,
          wire_format: 'openai_chat_completions',
          request_body: expect.objectContaining({
            model: 'gpt-4o-mini',
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: 'user',
                content: expect.stringContaining('umbrella'),
              }),
              expect.objectContaining({ role: 'tool' }),
            ]),
            tools: expect.arrayContaining([
              expect.objectContaining({
                function: expect.objectContaining({ name: 'get_weather' }),
              }),
            ]),
          }),
        }),
      );
      expect(mockMessageRepo.update).toHaveBeenCalledWith(
        {
          id: 'seed-msg-recording-001',
          tenant_id: 'seed-tenant-001',
          request_id: 'seed-req-recording-001',
        },
        {
          recording_key:
            'request-recordings/v1/tenants/seed-tenant-001/requests/' +
            'seed-req-recording-001/attempts/seed-msg-recording-001.json.gz',
        },
      );
    });

    it('should NOT seed demo data in production even with SEED_DATA=true (use setup wizard instead)', async () => {
      configValues['app.nodeEnv'] = 'production';
      configValues['SEED_DATA'] = 'true';

      await service.onModuleInit();

      // Production first-run uses the /setup wizard to create the admin;
      // demo data is dev/test only. See database-seeder.service.ts.
      expect(mockApiKeyRepo.count).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'seed-api-key-001' } }),
      );
      expect(mockTenantRepo.count).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'seed-tenant-001' } }),
      );
    });

    it('should not seed demo data when SEED_DATA is not true', async () => {
      configValues['app.nodeEnv'] = 'development';
      delete configValues['SEED_DATA'];

      await service.onModuleInit();

      expect(mockApiKeyRepo.count).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'seed-api-key-001' } }),
      );
    });

    it('should not seed demo data when SEED_DATA is a non-true string', async () => {
      configValues['app.nodeEnv'] = 'development';
      configValues['SEED_DATA'] = 'false';

      await service.onModuleInit();

      expect(mockApiKeyRepo.count).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'seed-api-key-001' } }),
      );
    });
  });

  describe('seedApiKey', () => {
    it('should check idempotency by id, not by key value', async () => {
      await service.onModuleInit();

      expect(mockApiKeyRepo.count).toHaveBeenCalledWith({
        where: { id: 'seed-api-key-001' },
      });
    });

    it('should skip insert when api key already exists', async () => {
      mockApiKeyRepo.count.mockResolvedValue(1);

      await service.onModuleInit();

      expect(mockApiKeyRepo.insert).not.toHaveBeenCalled();
    });

    it('should store hashed key with null plaintext', async () => {
      mockApiKeyRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      const insertCall = mockApiKeyRepo.insert.mock.calls[0][0];
      expect(insertCall.id).toBe('seed-api-key-001');
      expect(insertCall.key).toBeNull();
      expect(verifyKey('dev-api-key-manifest-001', insertCall.key_hash)).toBe(true);
      expect(insertCall.key_prefix).toBe(keyPrefix('dev-api-key-manifest-001'));
      expect(insertCall.created_by_user_id).toBe('admin-user-id');
      expect(insertCall.tenant_id).toBe('seed-tenant-001');
      expect(insertCall.name).toBe('Development API Key');
    });

    it('should store the correct hashKey hash value', async () => {
      mockApiKeyRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      const insertCall = mockApiKeyRepo.insert.mock.calls[0][0];
      expect(insertCall.key_hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
      expect(verifyKey('dev-api-key-manifest-001', insertCall.key_hash)).toBe(true);
    });

    it('should store the correct key prefix (first 12 chars)', async () => {
      mockApiKeyRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      const insertCall = mockApiKeyRepo.insert.mock.calls[0][0];
      expect(insertCall.key_prefix).toBe('dev-api-key-');
    });

    it('should skip insert when admin user is not found', async () => {
      mockApiKeyRepo.count.mockResolvedValue(0);
      mockDataSource.query.mockResolvedValue([]);

      await service.onModuleInit();

      expect(mockApiKeyRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('seedTenantAndAgent', () => {
    it('should check idempotency by tenant id', async () => {
      await service.onModuleInit();

      expect(mockTenantRepo.count).toHaveBeenCalledWith({
        where: { id: 'seed-tenant-001' },
      });
    });

    it('should skip all inserts when tenant already exists', async () => {
      mockTenantRepo.count.mockResolvedValue(1);

      await service.onModuleInit();

      expect(mockTenantRepo.insert).not.toHaveBeenCalled();
      expect(mockAgentRepo.insert).not.toHaveBeenCalled();
      expect(mockAgentKeyRepo.insert).not.toHaveBeenCalled();
    });

    it('should create tenant, agent, and agent api key when none exist', async () => {
      mockTenantRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      expect(mockTenantRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'seed-tenant-001',
          name: 'admin-user-id',
          email: 'admin@manifest.build',
          is_active: true,
        }),
      );
      expect(mockAgentRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'seed-agent-001',
          name: 'demo-agent',
          tenant_id: 'seed-tenant-001',
          is_active: true,
          record_messages: true,
        }),
      );
      expect(mockAgentKeyRepo.insert).toHaveBeenCalled();
    });

    it('should store agent api key with hashed value and null plaintext', async () => {
      mockTenantRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      const insertCall = mockAgentKeyRepo.insert.mock.calls[0][0];
      expect(insertCall.id).toBe('seed-otlp-key-001');
      expect(insertCall.key).toBeNull();
      expect(verifyKey('mnfst_dev-otlp-key-001', insertCall.key_hash)).toBe(true);
      expect(insertCall.key_prefix).toBe(keyPrefix('mnfst_dev-otlp-key-001'));
      expect(insertCall.label).toBe('Demo OTLP ingest key');
      expect(insertCall.tenant_id).toBe('seed-tenant-001');
      expect(insertCall.agent_id).toBe('seed-agent-001');
      expect(insertCall.is_active).toBe(true);
    });

    it('should store the correct OTLP key prefix', async () => {
      mockTenantRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      const insertCall = mockAgentKeyRepo.insert.mock.calls[0][0];
      expect(insertCall.key_prefix).toBe('mnfst_dev-ot');
    });

    it('should skip inserts when admin user is not found', async () => {
      mockTenantRepo.count.mockResolvedValue(0);
      mockDataSource.query.mockResolvedValue([]);

      await service.onModuleInit();

      expect(mockTenantRepo.insert).not.toHaveBeenCalled();
      expect(mockAgentRepo.insert).not.toHaveBeenCalled();
      expect(mockAgentKeyRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('seedTenantProviders', () => {
    it('seeds one connection per distinct (provider, auth_type) behind the seed messages', async () => {
      await service.onModuleInit();

      const connections = getSeedConnections();
      expect(connections.length).toBeGreaterThan(0);
      expect(mockProviderRepo.insert).toHaveBeenCalledTimes(connections.length);
      for (const conn of connections) {
        expect(mockProviderRepo.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            id: conn.id,
            tenant_id: 'seed-tenant-001',
            created_by_user_id: 'admin-user-id',
            provider: conn.provider,
            auth_type: conn.auth_type,
            label: 'Default',
            is_active: true,
          }),
        );
      }
    });

    it('is idempotent — skips connections that already exist', async () => {
      mockProviderRepo.findOne.mockResolvedValue({ id: 'seed-conn-existing' });

      await service.onModuleInit();

      expect(mockProviderRepo.insert).not.toHaveBeenCalled();
    });

    it('skips seeding connections when the admin user is not found', async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.onModuleInit();

      expect(mockProviderRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('seedAdminUser', () => {
    it('should skip creation when admin user already exists', async () => {
      // query returns a row (user exists)
      mockDataSource.query.mockResolvedValue([{ id: 'existing-id' }]);

      await service.onModuleInit();

      expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    });

    it('should create admin user when not found', async () => {
      // First call (checkBetterAuthUser): no rows
      // Subsequent calls (getAdminUserId): return the user
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkBetterAuthUser
        .mockResolvedValueOnce({}) // UPDATE emailVerified
        .mockResolvedValue([{ id: 'new-admin-id' }]); // getAdminUserId

      await service.onModuleInit();

      expect(auth.api.signUpEmail).toHaveBeenCalledWith({
        body: {
          email: 'admin@manifest.build',
          password: 'manifest',
          name: 'Admin',
        },
      });
    });

    it('should mark email as verified after creating admin user', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkBetterAuthUser
        .mockResolvedValueOnce({}) // UPDATE emailVerified
        .mockResolvedValue([{ id: 'new-admin-id' }]);

      await service.onModuleInit();

      expect(mockDataSource.query).toHaveBeenCalledWith(
        `UPDATE "user" SET "emailVerified" = true WHERE email = $1`,
        ['admin@manifest.build'],
      );
    });
  });

  describe('getAdminUserId edge cases', () => {
    it('should handle checkBetterAuthUser failure gracefully', async () => {
      // checkBetterAuthUser catches DB errors and returns false,
      // which causes seedAdminUser to proceed with signUpEmail.
      // The subsequent UPDATE query also needs a mock.
      mockDataSource.query
        .mockRejectedValueOnce(new Error('DB down')) // checkBetterAuthUser
        .mockResolvedValueOnce({}) // UPDATE emailVerified
        .mockResolvedValue([{ id: 'admin-id' }]); // getAdminUserId calls

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      // signUpEmail was called because checkBetterAuthUser returned false
      expect(auth.api.signUpEmail).toHaveBeenCalled();
    });

    it('should handle non-Error thrown by checkBetterAuthUser', async () => {
      // When a non-Error value is thrown, the ternary falls through to `err`
      mockDataSource.query
        .mockRejectedValueOnce('string error') // checkBetterAuthUser
        .mockResolvedValueOnce({}) // UPDATE emailVerified
        .mockResolvedValue([{ id: 'admin-id' }]); // getAdminUserId calls

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(auth.api.signUpEmail).toHaveBeenCalled();
    });

    it('catches errors from the demo-data seed sequence so boot is not aborted', async () => {
      // Demo-data seeding is best-effort dev-only convenience: a signup hiccup
      // (or any other seed insert failure) must be logged and swallowed, NOT
      // rejected up through onModuleInit where it would crash app bootstrap.
      // checkBetterAuthUser returns false, signUpEmail throws.
      mockDataSource.query.mockResolvedValueOnce([]); // checkBetterAuthUser: no user
      auth.api.signUpEmail.mockRejectedValueOnce(new Error('signup failed'));
      const errorSpy = jest
        .spyOn((service as unknown as { logger: { error: jest.Mock } }).logger, 'error')
        .mockImplementation(() => undefined);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('signup failed'));

      errorSpy.mockRestore();
    });

    it('keeps the Better Auth migration fatal — its failure still aborts boot', async () => {
      // The migration that creates Better Auth's own tables runs BEFORE the
      // guarded demo-data block and must remain fatal: without those tables the
      // app cannot authenticate at all, so a failure here should propagate.
      const ctx = await auth.$context;
      (ctx.runMigrations as jest.Mock).mockRejectedValueOnce(new Error('migration boom'));

      await expect(service.onModuleInit()).rejects.toThrow('migration boom');
    });

    it('should skip api key insert when getAdminUserId returns null', async () => {
      // checkBetterAuthUser: user exists (skip signUpEmail)
      mockDataSource.query.mockResolvedValueOnce([{ id: 'x' }]);
      // Every subsequent getAdminUserId call (seedTenantAndAgent, seedApiKey,
      // seedAgentMessages) returns no rows → null.
      mockDataSource.query.mockResolvedValue([]);

      mockApiKeyRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      expect(mockApiKeyRepo.insert).not.toHaveBeenCalled();
    });

    it('should handle getAdminUserId query failure with Error and return null', async () => {
      // checkBetterAuthUser: user exists (skip signUpEmail)
      mockDataSource.query.mockResolvedValueOnce([{ id: 'x' }]);
      // Every subsequent getAdminUserId query throws an Error → caught → null.
      mockDataSource.query.mockRejectedValue(new Error('connection lost'));
      mockApiKeyRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      // seedApiKey should skip insert because getAdminUserId returned null
      expect(mockApiKeyRepo.insert).not.toHaveBeenCalled();
    });

    it('should handle getAdminUserId query failure with non-Error and return null', async () => {
      // checkBetterAuthUser: user exists (skip signUpEmail)
      mockDataSource.query.mockResolvedValueOnce([{ id: 'x' }]);
      // Every subsequent getAdminUserId query throws a non-Error → caught → null.
      mockDataSource.query.mockRejectedValue('string rejection');
      mockApiKeyRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      // seedApiKey should skip insert because getAdminUserId returned null
      expect(mockApiKeyRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('seedDemoCohorts', () => {
    it('seeds the clean + legacy cohorts when the legacy agent does not yet exist', async () => {
      mockAgentRepo.count.mockResolvedValue(0);

      await service.onModuleInit();

      // The new legacy (olduser) agent is flipped to complexity-on so the
      // deprecated surfaces stay visible.
      expect(mockAgentRepo.update).toHaveBeenCalledWith(
        { id: 'seed-agent-old-001' },
        { complexity_routing_enabled: true },
      );
      // A brand-new legacy "old" user is signed up.
      expect(auth.api.signUpEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ email: 'olduser@manifest.build' }),
        }),
      );
      // The legacy cohort tenant is created.
      expect(mockTenantRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'seed-tenant-old-001' }),
      );
    });

    it('skips cohort seeding when the legacy agent already exists', async () => {
      // mockAgentRepo.count defaults to 1 (set in beforeEach) → cohort is a no-op,
      // while the normal admin/demo-agent seed still runs.
      await service.onModuleInit();

      expect(mockAgentRepo.update).not.toHaveBeenCalled();
      expect(mockTenantRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'seed-tenant-001' }),
      );
    });
  });
});
