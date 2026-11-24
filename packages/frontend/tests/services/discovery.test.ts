import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  COMPANY_SIZE_OPTIONS,
  PROJECT_TYPE_OPTIONS,
  clearDiscoveryPending,
  completeDiscovery,
  isConfirmedNotSelfHosted,
  getDiscoveryPendingNext,
  hasDiscoveryBeenDoneLocally,
  isDiscoveryRequired,
  markDiscoveryDoneLocally,
  markDiscoveryPending,
} from '../../src/services/discovery';

const mockFetch = vi.fn();

describe('discovery service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes the form option lists', () => {
    expect(PROJECT_TYPE_OPTIONS.map((o) => o.label)).toEqual([
      'AI product or application',
      'AI agent',
      'Internal AI tool or automation',
      'AI workflow / automation platform',
      'Personal project / experimentation',
      'Other',
    ]);
    expect(COMPANY_SIZE_OPTIONS.map((o) => o.label)).toEqual([
      "I'm not using Manifest for work",
      '1–20',
      '21–100',
      '101–500',
      '501–1,000',
      '1,000+',
    ]);
  });

  it('persists and reads the per-user local flag', () => {
    expect(hasDiscoveryBeenDoneLocally('u1')).toBe(false);
    markDiscoveryDoneLocally('u1');
    expect(hasDiscoveryBeenDoneLocally('u1')).toBe(true);
    expect(hasDiscoveryBeenDoneLocally('u2')).toBe(false);
  });

  it('swallows storage write errors', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => markDiscoveryDoneLocally('u1')).not.toThrow();
  });

  it('treats storage read errors as not done', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(hasDiscoveryBeenDoneLocally('u1')).toBe(false);
  });

  describe('pending marker', () => {
    it('stores and returns the pending next destination per user', () => {
      expect(getDiscoveryPendingNext('u1')).toBeNull();
      markDiscoveryPending('u1', '/welcome');
      expect(getDiscoveryPendingNext('u1')).toBe('/welcome');
      expect(getDiscoveryPendingNext('u2')).toBeNull();
    });

    it('returns null once the step is done, and completion clears the marker', () => {
      markDiscoveryPending('u1', '/welcome');
      markDiscoveryDoneLocally('u1');
      expect(getDiscoveryPendingNext('u1')).toBeNull();
      expect(localStorage.getItem('manifest_discovery_pending_u1')).toBeNull();
    });

    it('ignores an empty user id', () => {
      markDiscoveryPending('', '/welcome');
      expect(getDiscoveryPendingNext('')).toBeNull();
      expect(() => clearDiscoveryPending('')).not.toThrow();
    });

    it('clearDiscoveryPending drops the marker without recording completion', () => {
      markDiscoveryPending('u1', '/welcome');
      clearDiscoveryPending('u1');
      expect(getDiscoveryPendingNext('u1')).toBeNull();
      expect(hasDiscoveryBeenDoneLocally('u1')).toBe(false);
    });

    it('swallows storage errors', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('unavailable');
      });
      expect(() => markDiscoveryPending('u1', '/welcome')).not.toThrow();
      expect(getDiscoveryPendingNext('u1')).toBeNull();
    });
  });

  describe('isDiscoveryRequired', () => {
    it('returns false without a network call when the local flag is set', async () => {
      markDiscoveryDoneLocally('u1');
      expect(await isDiscoveryRequired('u1')).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('trusts the backend when it answers required: true', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ required: true }) });
      expect(await isDiscoveryRequired('u1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/discovery/status', {
        credentials: 'include',
        cache: 'no-store',
      });
    });

    it('caches a required: false answer as local completion, killing redirect loops', async () => {
      markDiscoveryPending('u1', '/welcome');
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ required: false }) });
      expect(await isDiscoveryRequired('u1')).toBe(false);
      expect(hasDiscoveryBeenDoneLocally('u1')).toBe(true);
      expect(getDiscoveryPendingNext('u1')).toBeNull();
    });

    it('treats an unexpected response shape as not required', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await isDiscoveryRequired('u1')).toBe(false);
    });

    it('falls back to the pending marker when the endpoint is not deployed (non-2xx)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      expect(await isDiscoveryRequired('u1')).toBe(false);
      markDiscoveryPending('u1', '/welcome');
      expect(await isDiscoveryRequired('u1')).toBe(true);
    });

    it('falls back to the pending marker when the request throws', async () => {
      mockFetch.mockRejectedValue(new Error('network down'));
      expect(await isDiscoveryRequired('u1')).toBe(false);
      markDiscoveryPending('u1', '/welcome');
      expect(await isDiscoveryRequired('u1')).toBe(true);
    });

    it('falls back to the pending marker when the response body is not JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('bad json');
        },
      });
      markDiscoveryPending('u1', '/welcome');
      expect(await isDiscoveryRequired('u1')).toBe(true);
    });
  });

  describe('isConfirmedNotSelfHosted', () => {
    it('confirms only on an explicit non-self-hosted answer', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ isSelfHosted: false }) });
      expect(await isConfirmedNotSelfHosted()).toBe(true);
    });

    it('denies on a self-hosted answer', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ isSelfHosted: true }) });
      expect(await isConfirmedNotSelfHosted()).toBe(false);
    });

    it('denies on a success body without the isSelfHosted field', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await isConfirmedNotSelfHosted()).toBe(false);
    });

    it('denies on a non-2xx response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      expect(await isConfirmedNotSelfHosted()).toBe(false);
    });

    it('denies when the request throws', async () => {
      mockFetch.mockRejectedValue(new Error('network down'));
      expect(await isConfirmedNotSelfHosted()).toBe(false);
    });
  });

  describe('completeDiscovery', () => {
    it('marks the local flag and posts the submission', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await completeDiscovery('u1', { name: 'Seb', projectType: 'ai_agent' });

      expect(hasDiscoveryBeenDoneLocally('u1')).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/discovery/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: 'Seb', projectType: 'ai_agent' }),
      });
    });

    it('posts an empty body for a skip', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      await completeDiscovery('u1', {});
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/discovery/complete',
        expect.objectContaining({ body: '{}' }),
      );
    });

    it('still resolves and keeps the local flag when the endpoint is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('network down'));
      await expect(completeDiscovery('u1', {})).resolves.toBeUndefined();
      expect(hasDiscoveryBeenDoneLocally('u1')).toBe(true);
    });
  });
});
