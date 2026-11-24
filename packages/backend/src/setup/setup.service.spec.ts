import { ConflictException } from '@nestjs/common';

jest.mock('../auth/auth.instance', () => ({
  auth: {
    api: {
      signUpEmail: jest.fn(),
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { auth } = require('../auth/auth.instance');

import { SetupService } from './setup.service';

interface MockQueryRunner {
  connect: jest.Mock;
  release: jest.Mock;
  query: jest.Mock;
}

function buildMockDataSource(runnerQuery: jest.Mock) {
  const queryRunner: MockQueryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: runnerQuery,
  };
  return {
    query: jest.fn(),
    createQueryRunner: jest.fn(() => queryRunner),
    _queryRunner: queryRunner,
  };
}

import { resetMcpAvailability } from '../auth/mcp-availability';

describe('SetupService', () => {
  let runnerQuery: jest.Mock;
  let ds: ReturnType<typeof buildMockDataSource>;
  let service: SetupService;

  beforeEach(() => {
    runnerQuery = jest.fn();
    ds = buildMockDataSource(runnerQuery);
    service = new SetupService(ds as never);
    jest.clearAllMocks();
  });

  describe('getLocalLlmHost', () => {
    let originalExistsSync: typeof import('fs').existsSync;
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      originalExistsSync = require('fs').existsSync;
    });
    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').existsSync = originalExistsSync;
    });

    it("returns 'host.docker.internal' when /.dockerenv exists", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').existsSync = (p: string) => p === '/.dockerenv';
      expect(service.getLocalLlmHost()).toBe('host.docker.internal');
    });

    it("returns 'host.containers.internal' under Podman (/run/.containerenv only)", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').existsSync = (p: string) => p === '/run/.containerenv';
      expect(service.getLocalLlmHost()).toBe('host.containers.internal');
    });

    it("returns 'localhost' when /.dockerenv is absent", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').existsSync = () => false;
      expect(service.getLocalLlmHost()).toBe('localhost');
    });

    it("returns 'localhost' when existsSync throws", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').existsSync = () => {
        throw new Error('EACCES');
      };
      expect(service.getLocalLlmHost()).toBe('localhost');
    });
  });

  describe('isSelfHosted', () => {
    const originalMode = process.env['MANIFEST_MODE'];

    afterEach(() => {
      if (originalMode === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = originalMode;
    });

    it('returns true when MANIFEST_MODE is selfhosted', () => {
      process.env['MANIFEST_MODE'] = 'selfhosted';
      expect(service.isSelfHosted()).toBe(true);
    });

    it('returns true for legacy MANIFEST_MODE=local', () => {
      process.env['MANIFEST_MODE'] = 'local';
      expect(service.isSelfHosted()).toBe(true);
    });

    it('returns false when MANIFEST_MODE is cloud', () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      expect(service.isSelfHosted()).toBe(false);
    });

    it('returns false when MANIFEST_MODE is not set', () => {
      delete process.env['MANIFEST_MODE'];
      expect(service.isSelfHosted()).toBe(false);
    });
  });

  describe('isOllamaAvailable', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns true when Ollama responds OK', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
      expect(await service.isOllamaAvailable()).toBe(true);
    });

    it('returns false when Ollama responds with error status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
      expect(await service.isOllamaAvailable()).toBe(false);
    });

    it('returns false when fetch throws (Ollama unreachable)', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      expect(await service.isOllamaAvailable()).toBe(false);
    });

    it('returns false when fetch is aborted (timeout)', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new DOMException('aborted', 'AbortError')) as unknown as typeof fetch;
      expect(await service.isOllamaAvailable()).toBe(false);
    });

    it('aborts via AbortController when the 3s timeout fires', async () => {
      // Capture the timeout callback registered by the service so we can
      // invoke it explicitly rather than trying to coordinate jest's fake
      // timers with async AbortController listeners.
      const realSetTimeout = global.setTimeout;
      let fired: (() => void) | null = null;
      global.setTimeout = ((cb: () => void) => {
        fired = cb;
        return 0 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout;

      try {
        global.fetch = jest.fn().mockImplementation((_url, init) => {
          return new Promise((_resolve, reject) => {
            (init as RequestInit).signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }) as unknown as typeof fetch;

        const pending = service.isOllamaAvailable();
        expect(fired).not.toBeNull();
        fired!(); // trigger controller.abort() from setup.service.ts:49
        expect(await pending).toBe(false);
      } finally {
        global.setTimeout = realSetTimeout;
      }
    });
  });

  describe('getEnabledSocialProviders', () => {
    const envKeys = [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
    ];

    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const k of envKeys) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it('returns empty array when no providers are configured', () => {
      expect(service.getEnabledSocialProviders()).toEqual([]);
    });

    it('returns google when both Google env vars are set', () => {
      process.env['GOOGLE_CLIENT_ID'] = 'id';
      process.env['GOOGLE_CLIENT_SECRET'] = 'secret';
      expect(service.getEnabledSocialProviders()).toEqual(['google']);
    });

    it('returns all three when all providers are configured', () => {
      for (const k of envKeys) process.env[k] = 'val';
      expect(service.getEnabledSocialProviders()).toEqual(['google', 'github', 'discord']);
    });

    it('omits providers with only CLIENT_ID set (no secret)', () => {
      process.env['GOOGLE_CLIENT_ID'] = 'id';
      process.env['GITHUB_CLIENT_ID'] = 'id';
      process.env['GITHUB_CLIENT_SECRET'] = 'secret';
      expect(service.getEnabledSocialProviders()).toEqual(['github']);
    });
  });

  describe('isEmailConfigured', () => {
    const envKeys = [
      'EMAIL_PROVIDER',
      'EMAIL_API_KEY',
      'EMAIL_DOMAIN',
      'MAILGUN_API_KEY',
      'MAILGUN_DOMAIN',
    ];

    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const k of envKeys) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it('returns false when no email provider is configured', () => {
      expect(service.isEmailConfigured()).toBe(false);
    });

    it('returns true when the unified EMAIL_* scheme is configured', () => {
      process.env['EMAIL_PROVIDER'] = 'resend';
      process.env['EMAIL_API_KEY'] = 're_key';
      expect(service.isEmailConfigured()).toBe(true);
    });

    it('returns true when legacy Mailgun env vars are configured', () => {
      process.env['MAILGUN_API_KEY'] = 'key';
      process.env['MAILGUN_DOMAIN'] = 'mg.example.com';
      expect(service.isEmailConfigured()).toBe(true);
    });
  });

  describe('isMcpEnabled', () => {
    const envKeys = ['BETTER_AUTH_URL', 'MCP_ENABLED'];
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const k of envKeys) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
      resetMcpAvailability();
    });

    afterEach(() => {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      resetMcpAvailability();
    });

    it('returns true on an HTTPS origin', () => {
      process.env['BETTER_AUTH_URL'] = 'https://mnfst.example.com';
      expect(service.isMcpEnabled()).toBe(true);
    });

    it('returns false on a plain-HTTP non-loopback origin', () => {
      process.env['BETTER_AUTH_URL'] = 'http://manifest.example.internal';
      expect(service.isMcpEnabled()).toBe(false);
    });

    it('returns false when MCP_ENABLED opts out', () => {
      process.env['BETTER_AUTH_URL'] = 'https://mnfst.example.com';
      process.env['MCP_ENABLED'] = 'false';
      expect(service.isMcpEnabled()).toBe(false);
    });
  });

  describe('needsSetup', () => {
    it('returns true when user table is empty', async () => {
      ds.query.mockResolvedValueOnce([{ count: '0' }]);
      expect(await service.needsSetup()).toBe(true);
      expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'));
    });

    it('returns false when at least one user exists', async () => {
      ds.query.mockResolvedValueOnce([{ count: '1' }]);
      expect(await service.needsSetup()).toBe(false);
    });

    it('handles multi-user count', async () => {
      ds.query.mockResolvedValueOnce([{ count: '42' }]);
      expect(await service.needsSetup()).toBe(false);
    });

    it('treats missing count row as empty', async () => {
      ds.query.mockResolvedValueOnce([]);
      expect(await service.needsSetup()).toBe(true);
    });
  });

  describe('createFirstAdmin', () => {
    const dto = { email: 'founder@example.com', name: 'Founder', password: 'secret-password' };

    function mockHappyPath(): void {
      runnerQuery
        .mockResolvedValueOnce(undefined) // pg_advisory_lock
        .mockResolvedValueOnce([{ count: '0' }]) // count check
        .mockResolvedValueOnce(undefined) // UPDATE emailVerified
        .mockResolvedValueOnce(undefined); // pg_advisory_unlock
    }

    it('acquires and releases a session-level advisory lock around the flow', async () => {
      mockHappyPath();
      (auth.api.signUpEmail as jest.Mock).mockResolvedValueOnce({});

      await service.createFirstAdmin(dto);

      const lockCall = runnerQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('pg_advisory_lock'),
      );
      const unlockCall = runnerQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('pg_advisory_unlock'),
      );
      expect(lockCall).toBeDefined();
      expect(unlockCall).toBeDefined();
      expect(ds._queryRunner.connect).toHaveBeenCalledTimes(1);
      expect(ds._queryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('calls Better Auth signUpEmail with the DTO', async () => {
      mockHappyPath();
      (auth.api.signUpEmail as jest.Mock).mockResolvedValueOnce({});

      await service.createFirstAdmin(dto);

      expect(auth.api.signUpEmail).toHaveBeenCalledWith({
        body: {
          email: 'founder@example.com',
          password: 'secret-password',
          name: 'Founder',
        },
      });
    });

    it('marks the new user as emailVerified', async () => {
      mockHappyPath();
      (auth.api.signUpEmail as jest.Mock).mockResolvedValueOnce({});

      await service.createFirstAdmin(dto);

      const updateCall = runnerQuery.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('UPDATE "user"') &&
          c[0].includes('emailVerified'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall?.[1]).toEqual(['founder@example.com']);
    });

    it('throws ConflictException when a user already exists and is verified', async () => {
      runnerQuery
        .mockResolvedValueOnce(undefined) // lock
        .mockResolvedValueOnce([{ count: '1' }]) // count
        .mockResolvedValueOnce([]) // unverified check returns none
        .mockResolvedValueOnce(undefined); // unlock

      await expect(service.createFirstAdmin(dto)).rejects.toThrow(ConflictException);
      expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    });

    it('throws ConflictException when multiple users already exist', async () => {
      runnerQuery
        .mockResolvedValueOnce(undefined) // lock
        .mockResolvedValueOnce([{ count: '3' }]) // count
        .mockResolvedValueOnce(undefined); // unlock

      await expect(service.createFirstAdmin(dto)).rejects.toThrow('already completed');
      expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    });

    it('releases the advisory lock even when the flow throws', async () => {
      runnerQuery
        .mockResolvedValueOnce(undefined) // lock
        .mockResolvedValueOnce([{ count: '5' }]) // count — triggers 409
        .mockResolvedValueOnce(undefined); // unlock

      await expect(service.createFirstAdmin(dto)).rejects.toThrow(ConflictException);

      const unlockCalls = runnerQuery.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('pg_advisory_unlock'),
      );
      expect(unlockCalls).toHaveLength(1);
      expect(ds._queryRunner.release).toHaveBeenCalledTimes(1);
    });

    describe('recovery branch', () => {
      it('completes verification when the only existing user is unverified and matches the DTO email', async () => {
        runnerQuery
          .mockResolvedValueOnce(undefined) // lock
          .mockResolvedValueOnce([{ count: '1' }]) // count = 1
          .mockResolvedValueOnce([{ email: 'founder@example.com' }]) // unverified match
          .mockResolvedValueOnce(undefined) // UPDATE emailVerified
          .mockResolvedValueOnce(undefined); // unlock

        await service.createFirstAdmin(dto);

        expect(auth.api.signUpEmail).not.toHaveBeenCalled();
        const updateCall = runnerQuery.mock.calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('UPDATE "user"') &&
            c[0].includes('emailVerified'),
        );
        expect(updateCall).toBeDefined();
        expect(updateCall?.[1]).toEqual(['founder@example.com']);
      });

      it('throws ConflictException when count=1 but the existing user is already verified', async () => {
        runnerQuery
          .mockResolvedValueOnce(undefined) // lock
          .mockResolvedValueOnce([{ count: '1' }]) // count = 1
          .mockResolvedValueOnce([]) // no unverified users
          .mockResolvedValueOnce(undefined); // unlock

        await expect(service.createFirstAdmin(dto)).rejects.toThrow(ConflictException);
        expect(auth.api.signUpEmail).not.toHaveBeenCalled();
      });

      it('throws ConflictException when count=1 but email does not match', async () => {
        runnerQuery
          .mockResolvedValueOnce(undefined) // lock
          .mockResolvedValueOnce([{ count: '1' }]) // count = 1
          .mockResolvedValueOnce([]) // unverified query with matching email returns none
          .mockResolvedValueOnce(undefined); // unlock

        await expect(service.createFirstAdmin(dto)).rejects.toThrow(ConflictException);
        expect(auth.api.signUpEmail).not.toHaveBeenCalled();
      });

      it('throws ConflictException when count=1 but unverified SELECT returns 2+ rows', async () => {
        // Defensive: count check says one user, but the unverified+email
        // SELECT returns multiple rows (e.g., race with another insert or
        // schema corruption). The recovery branch only fires when
        // unverified.length === 1, so this MUST fall through to 409 —
        // never silently mark all matches verified.
        runnerQuery
          .mockResolvedValueOnce(undefined) // lock
          .mockResolvedValueOnce([{ count: '1' }]) // count = 1
          .mockResolvedValueOnce([
            { email: 'founder@example.com' },
            { email: 'founder@example.com' },
          ]) // unverified SELECT returns 2 rows — length !== 1
          .mockResolvedValueOnce(undefined); // unlock

        const caught = await service.createFirstAdmin(dto).catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect((caught as Error).message).toMatch(/already completed/i);
        expect(auth.api.signUpEmail).not.toHaveBeenCalled();
        // No UPDATE emailVerified statement should have been issued.
        const updateCall = runnerQuery.mock.calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('UPDATE "user"') &&
            c[0].includes('emailVerified'),
        );
        expect(updateCall).toBeUndefined();
      });
    });

    it('treats an empty count result as count=0 and proceeds with signup', async () => {
      runnerQuery
        .mockResolvedValueOnce(undefined) // pg_advisory_lock
        .mockResolvedValueOnce([]) // COUNT query returns no rows → rows[0] is undefined
        .mockResolvedValueOnce(undefined) // UPDATE emailVerified
        .mockResolvedValueOnce(undefined); // pg_advisory_unlock
      (auth.api.signUpEmail as jest.Mock).mockResolvedValueOnce({});

      await service.createFirstAdmin(dto);

      expect(auth.api.signUpEmail).toHaveBeenCalled();
    });

    it('does not wrap the flow in a TypeORM transaction', async () => {
      // If we ever revert to this.dataSource.transaction(), a rollback
      // would leave the Better Auth user insert committed on its own
      // pool while the emailVerified update gets reverted. The current
      // implementation uses a session-level advisory lock instead.
      mockHappyPath();
      (auth.api.signUpEmail as jest.Mock).mockResolvedValueOnce({});

      await service.createFirstAdmin(dto);

      expect(ds.createQueryRunner).toHaveBeenCalledTimes(1);
    });
  });
});
