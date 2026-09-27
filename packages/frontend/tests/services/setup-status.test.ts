import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkNeedsSetup,
  checkSocialProviders,
  checkIsSelfHosted,
  checkIsOllamaAvailable,
  checkLocalLlmHost,
  checkEmailConfigured,
  checkMcpEnabled,
  resetSetupStatus,
  createFirstAdmin,
} from '../../src/services/setup-status';

describe('setup-status service', () => {
  beforeEach(() => {
    resetSetupStatus();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('checkNeedsSetup', () => {
    it('returns true when backend reports needsSetup=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: true }),
        }),
      );
      expect(await checkNeedsSetup()).toBe(true);
    });

    it('returns false when backend reports needsSetup=false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkNeedsSetup()).toBe(false);
    });

    it('returns false on HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          json: async () => ({}),
        }),
      );
      expect(await checkNeedsSetup()).toBe(false);
    });

    it('returns false on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkNeedsSetup()).toBe(false);
    });

    it('caches the result across calls', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ needsSetup: true }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await checkNeedsSetup();
      await checkNeedsSetup();
      await checkNeedsSetup();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after resetSetupStatus()', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ needsSetup: true }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await checkNeedsSetup();
      resetSetupStatus();
      await checkNeedsSetup();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkSocialProviders', () => {
    it('returns social providers from backend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, socialProviders: ['google', 'github'] }),
        }),
      );
      expect(await checkSocialProviders()).toEqual(['google', 'github']);
    });

    it('returns empty array when backend omits socialProviders', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkSocialProviders()).toEqual([]);
    });

    it('returns empty array on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkSocialProviders()).toEqual([]);
    });
  });

  describe('checkIsSelfHosted', () => {
    it('returns true when backend reports isSelfHosted=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, isSelfHosted: true }),
        }),
      );
      expect(await checkIsSelfHosted()).toBe(true);
    });

    it('returns false when backend reports isSelfHosted=false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, isSelfHosted: false }),
        }),
      );
      expect(await checkIsSelfHosted()).toBe(false);
    });

    it('returns false when backend omits isSelfHosted', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkIsSelfHosted()).toBe(false);
    });

    it('returns false on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkIsSelfHosted()).toBe(false);
    });

    it('shares cache with checkNeedsSetup (single fetch)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          needsSetup: true,
          isSelfHosted: true,
          socialProviders: ['google'],
          ollamaAvailable: true,
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const [needs, selfHosted, social, ollama] = await Promise.all([
        checkNeedsSetup(),
        checkIsSelfHosted(),
        checkSocialProviders(),
        checkIsOllamaAvailable(),
      ]);

      expect(needs).toBe(true);
      expect(selfHosted).toBe(true);
      expect(social).toEqual(['google']);
      expect(ollama).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkIsOllamaAvailable', () => {
    it('returns true when backend reports ollamaAvailable=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, ollamaAvailable: true }),
        }),
      );
      expect(await checkIsOllamaAvailable()).toBe(true);
    });

    it('returns false when backend reports ollamaAvailable=false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, ollamaAvailable: false }),
        }),
      );
      expect(await checkIsOllamaAvailable()).toBe(false);
    });

    it('returns false when backend omits ollamaAvailable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkIsOllamaAvailable()).toBe(false);
    });

    it('returns false on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkIsOllamaAvailable()).toBe(false);
    });
  });

  describe('checkLocalLlmHost', () => {
    it('returns the backend-reported host', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, localLlmHost: 'host.docker.internal' }),
        }),
      );
      expect(await checkLocalLlmHost()).toBe('host.docker.internal');
    });

    it("defaults to 'localhost' when the backend omits the field", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkLocalLlmHost()).toBe('localhost');
    });

    it("defaults to 'localhost' on fetch failure", async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkLocalLlmHost()).toBe('localhost');
    });

    it("defaults to 'localhost' when the backend returns a non-ok response", async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      expect(await checkLocalLlmHost()).toBe('localhost');
    });
  });

  describe('checkEmailConfigured', () => {
    it('returns true when backend reports emailConfigured=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, emailConfigured: true }),
        }),
      );
      expect(await checkEmailConfigured()).toBe(true);
    });

    it('returns false when backend reports emailConfigured=false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, emailConfigured: false }),
        }),
      );
      expect(await checkEmailConfigured()).toBe(false);
    });

    it('defaults to true when backend omits emailConfigured', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkEmailConfigured()).toBe(true);
    });

    it('defaults to true on a non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      expect(await checkEmailConfigured()).toBe(true);
    });

    it('defaults to true on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkEmailConfigured()).toBe(true);
    });
  });

  describe('checkMcpEnabled', () => {
    it('returns true when backend reports mcpEnabled=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, mcpEnabled: true }),
        }),
      );
      expect(await checkMcpEnabled()).toBe(true);
    });

    it('returns false when backend reports mcpEnabled=false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false, mcpEnabled: false }),
        }),
      );
      expect(await checkMcpEnabled()).toBe(false);
    });

    it('defaults to true when backend omits mcpEnabled (older backend)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: false }),
        }),
      );
      expect(await checkMcpEnabled()).toBe(true);
    });

    it('defaults to true on a non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      expect(await checkMcpEnabled()).toBe(true);
    });

    it('defaults to true on fetch failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      expect(await checkMcpEnabled()).toBe(true);
    });
  });

  describe('createFirstAdmin', () => {
    it('POSTs the admin payload as JSON', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
      vi.stubGlobal('fetch', fetchMock);

      await createFirstAdmin({
        email: 'founder@example.com',
        name: 'Founder',
        password: 'secretpassword',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/setup/admin',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({
        email: 'founder@example.com',
        name: 'Founder',
        password: 'secretpassword',
      });
    });

    it('throws with server message when request fails with JSON body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ message: 'Setup already completed' }),
        }),
      );
      await expect(
        createFirstAdmin({ email: 'a@b.com', name: 'X', password: '12345678' }),
      ).rejects.toThrow('Setup already completed');
    });

    it('flattens array error messages', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: async () => ({ message: ['email must be valid', 'name is required'] }),
        }),
      );
      await expect(
        createFirstAdmin({ email: 'bad', name: '', password: '12345678' }),
      ).rejects.toThrow('email must be valid, name is required');
    });

    it('falls back to generic error when body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('not json');
          },
        }),
      );
      await expect(
        createFirstAdmin({ email: 'a@b.com', name: 'X', password: '12345678' }),
      ).rejects.toThrow('Setup failed (500)');
    });

    it('resets cached setup status after success', async () => {
      // Prime the cache
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ needsSetup: true }),
        }),
      );
      await checkNeedsSetup();

      // Swap fetch mock for create
      const createMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
      vi.stubGlobal('fetch', createMock);

      await createFirstAdmin({ email: 'a@b.com', name: 'X', password: '12345678' });

      // Next check should re-fetch
      const statusMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ needsSetup: false }),
      });
      vi.stubGlobal('fetch', statusMock);

      expect(await checkNeedsSetup()).toBe(false);
      expect(statusMock).toHaveBeenCalled();
    });
  });
});
