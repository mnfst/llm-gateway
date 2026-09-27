import { HttpException, HttpStatus } from '@nestjs/common';
import { ProxyRateLimiter } from '../proxy-rate-limiter';

describe('ProxyRateLimiter', () => {
  let limiter: ProxyRateLimiter;
  const originalConcurrencyMax = process.env.MANIFEST_CONCURRENCY_MAX;

  beforeEach(() => {
    delete process.env.MANIFEST_CONCURRENCY_MAX;
    limiter = new ProxyRateLimiter();
  });

  afterEach(() => {
    limiter.onModuleDestroy();
    if (originalConcurrencyMax === undefined) {
      delete process.env.MANIFEST_CONCURRENCY_MAX;
    } else {
      process.env.MANIFEST_CONCURRENCY_MAX = originalConcurrencyMax;
    }
  });

  describe('checkLimit', () => {
    it('allows requests within the limit', () => {
      for (let i = 0; i < 200; i++) {
        expect(() => limiter.checkLimit('user-1')).not.toThrow();
      }
    });

    it('throws 429 when rate exceeded', () => {
      for (let i = 0; i < 200; i++) {
        limiter.checkLimit('user-1');
      }

      expect(() => limiter.checkLimit('user-1')).toThrow(HttpException);
    });

    it('throws with correct status and message on rate exceeded', () => {
      for (let i = 0; i < 200; i++) {
        limiter.checkLimit('user-1');
      }

      try {
        limiter.checkLimit('user-1');
        fail('Expected HttpException');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect((err as HttpException).message).toContain('[🦚 Manifest M201]');
        expect((err as HttpException).message).toContain(
          'Too many requests — wait a few seconds and retry.',
        );
      }
    });

    it('resets after window expires', () => {
      jest.useFakeTimers();

      for (let i = 0; i < 200; i++) {
        limiter.checkLimit('user-1');
      }
      expect(() => limiter.checkLimit('user-1')).toThrow(HttpException);

      jest.advanceTimersByTime(60_001);

      expect(() => limiter.checkLimit('user-1')).not.toThrow();
      jest.useRealTimers();
    });

    it('isolates different users', () => {
      for (let i = 0; i < 200; i++) {
        limiter.checkLimit('user-1');
      }

      expect(() => limiter.checkLimit('user-1')).toThrow(HttpException);
      expect(() => limiter.checkLimit('user-2')).not.toThrow();
    });

    it('counts all requests including those that will fail upstream', () => {
      // All 200 calls should succeed (not just "successful" ones)
      for (let i = 0; i < 200; i++) {
        limiter.checkLimit('user-1');
      }
      // 201st request should be blocked
      expect(() => limiter.checkLimit('user-1')).toThrow(HttpException);
    });

    it('increments count across calls within the same window', () => {
      jest.useFakeTimers();

      for (let i = 0; i < 100; i++) {
        limiter.checkLimit('user-1');
      }

      // Advance time but stay within window
      jest.advanceTimersByTime(30_000);

      for (let i = 0; i < 100; i++) {
        limiter.checkLimit('user-1');
      }

      // 201st request should be blocked
      expect(() => limiter.checkLimit('user-1')).toThrow(HttpException);

      jest.useRealTimers();
    });

    it('resets window after expiry', () => {
      jest.useFakeTimers();

      for (let i = 0; i < 200; i++) {
        limiter.checkLimit('user-1');
      }
      expect(() => limiter.checkLimit('user-1')).toThrow(HttpException);

      jest.advanceTimersByTime(60_001);

      limiter.checkLimit('user-1');
      expect(() => limiter.checkLimit('user-1')).not.toThrow();

      jest.useRealTimers();
    });
  });

  describe('LRU eviction', () => {
    it('evicts the oldest entry when map exceeds 50K entries', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rates = (limiter as any).rates as Map<string, { count: number; windowStart: number }>;

      for (let i = 0; i < 50_000; i++) {
        rates.set(`old-user-${i}`, { count: 1, windowStart: Date.now() });
      }

      expect(rates.size).toBe(50_000);

      limiter.checkLimit('new-user');

      expect(rates.size).toBeLessThanOrEqual(50_000);
      expect(rates.has('old-user-0')).toBe(false);
      expect(rates.has('new-user')).toBe(true);
    });
  });

  describe('evictExpired', () => {
    it('removes expired entries when cleanup timer fires', () => {
      jest.useFakeTimers();

      limiter.checkLimit('user-1');
      limiter.checkLimit('user-2');

      jest.advanceTimersByTime(120_001);

      limiter.checkLimit('user-3');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rates = (limiter as any).rates as Map<string, unknown>;
      expect(rates.has('user-3')).toBe(true);

      jest.useRealTimers();
    });

    it('evicts expired entries when evictExpired is called directly', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rates = (limiter as any).rates as Map<string, { count: number; windowStart: number }>;

      // Insert entries with old timestamps (expired)
      rates.set('old-user', { count: 5, windowStart: Date.now() - 120_000 });
      rates.set('fresh-user', { count: 2, windowStart: Date.now() });

      expect(rates.size).toBe(2);

      // Call evictExpired directly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (limiter as any).evictExpired();

      expect(rates.has('old-user')).toBe(false);
      expect(rates.has('fresh-user')).toBe(true);
      expect(rates.size).toBe(1);
    });

    it('does not evict entries within the rate window', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rates = (limiter as any).rates as Map<string, { count: number; windowStart: number }>;

      rates.set('recent-user', { count: 3, windowStart: Date.now() - 30_000 }); // 30s ago, within 60s window

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (limiter as any).evictExpired();

      expect(rates.has('recent-user')).toBe(true);
    });
  });

  describe('checkIpLimit', () => {
    it('allows requests within the IP limit', () => {
      for (let i = 0; i < 500; i++) {
        expect(() => limiter.checkIpLimit('192.168.1.1')).not.toThrow();
      }
    });

    it('throws 429 when IP rate exceeded', () => {
      for (let i = 0; i < 500; i++) {
        limiter.checkIpLimit('192.168.1.1');
      }

      expect(() => limiter.checkIpLimit('192.168.1.1')).toThrow(HttpException);
    });

    it('throws with correct status and message on IP rate exceeded', () => {
      for (let i = 0; i < 500; i++) {
        limiter.checkIpLimit('192.168.1.1');
      }

      try {
        limiter.checkIpLimit('192.168.1.1');
        fail('Expected HttpException');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect((err as HttpException).message).toContain('[🦚 Manifest M202]');
        expect((err as HttpException).message).toContain(
          'Too many requests from this IP — wait a few seconds and retry.',
        );
      }
    });

    it('resets after window expires', () => {
      jest.useFakeTimers();

      for (let i = 0; i < 500; i++) {
        limiter.checkIpLimit('192.168.1.1');
      }
      expect(() => limiter.checkIpLimit('192.168.1.1')).toThrow(HttpException);

      jest.advanceTimersByTime(60_001);

      expect(() => limiter.checkIpLimit('192.168.1.1')).not.toThrow();
      jest.useRealTimers();
    });

    it('isolates different IPs', () => {
      for (let i = 0; i < 500; i++) {
        limiter.checkIpLimit('192.168.1.1');
      }

      expect(() => limiter.checkIpLimit('192.168.1.1')).toThrow(HttpException);
      expect(() => limiter.checkIpLimit('10.0.0.1')).not.toThrow();
    });
  });

  describe('evictExpired cleans ipRates', () => {
    it('removes expired IP entries when evictExpired is called', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ipRates = (limiter as any).ipRates as Map<
        string,
        { count: number; windowStart: number }
      >;

      ipRates.set('old-ip', { count: 5, windowStart: Date.now() - 120_000 });
      ipRates.set('fresh-ip', { count: 2, windowStart: Date.now() });

      expect(ipRates.size).toBe(2);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (limiter as any).evictExpired();

      expect(ipRates.has('old-ip')).toBe(false);
      expect(ipRates.has('fresh-ip')).toBe(true);
      expect(ipRates.size).toBe(1);
    });
  });

  describe('acquireSlot / releaseSlot', () => {
    it('uses MANIFEST_CONCURRENCY_MAX when it is a positive integer', () => {
      limiter.onModuleDestroy();
      process.env.MANIFEST_CONCURRENCY_MAX = '40';
      limiter = new ProxyRateLimiter();

      for (let i = 0; i < 40; i++) {
        expect(() => limiter.acquireSlot('tenant-1')).not.toThrow();
      }
      expect(() => limiter.acquireSlot('tenant-1')).toThrow(HttpException);
    });

    it.each([
      '',
      '0',
      '-1',
      '1.5',
      'not-a-number',
      '9007199254740992',
      '0x10',
      '0b101',
      '2e1',
      ' 40 ',
    ])('falls back to 10 when MANIFEST_CONCURRENCY_MAX is %p', (configuredValue) => {
      limiter.onModuleDestroy();
      process.env.MANIFEST_CONCURRENCY_MAX = configuredValue;
      limiter = new ProxyRateLimiter();

      for (let i = 0; i < 10; i++) {
        expect(() => limiter.acquireSlot('tenant-1')).not.toThrow();
      }
      expect(() => limiter.acquireSlot('tenant-1')).toThrow(HttpException);
    });

    it('allows up to 10 concurrent slots', () => {
      for (let i = 0; i < 10; i++) {
        expect(() => limiter.acquireSlot('user-1')).not.toThrow();
      }
    });

    it('throws 429 when concurrency limit reached', () => {
      for (let i = 0; i < 10; i++) {
        limiter.acquireSlot('user-1');
      }

      expect(() => limiter.acquireSlot('user-1')).toThrow(HttpException);
    });

    it('throws with correct status and message on concurrency exceeded', () => {
      for (let i = 0; i < 10; i++) {
        limiter.acquireSlot('user-1');
      }

      try {
        limiter.acquireSlot('user-1');
        fail('Expected HttpException');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect((err as HttpException).message).toContain('[🦚 Manifest M203]');
        expect((err as HttpException).message).toContain(
          'Too many concurrent requests. Give it a moment.',
        );
      }
    });

    it('allows new slot after release', () => {
      for (let i = 0; i < 10; i++) {
        limiter.acquireSlot('user-1');
      }

      limiter.releaseSlot('user-1');

      expect(() => limiter.acquireSlot('user-1')).not.toThrow();
    });

    it('isolates concurrency between users', () => {
      for (let i = 0; i < 10; i++) {
        limiter.acquireSlot('user-1');
      }

      expect(() => limiter.acquireSlot('user-1')).toThrow(HttpException);
      expect(() => limiter.acquireSlot('user-2')).not.toThrow();
    });

    it('cleans up map entry when count reaches zero', () => {
      limiter.acquireSlot('user-1');
      limiter.releaseSlot('user-1');

      for (let i = 0; i < 10; i++) {
        expect(() => limiter.acquireSlot('user-1')).not.toThrow();
      }
    });

    it('handles release for unknown user gracefully', () => {
      expect(() => limiter.releaseSlot('unknown-user')).not.toThrow();
    });

    it('does not go negative on double release', () => {
      limiter.acquireSlot('user-1');
      limiter.releaseSlot('user-1');
      limiter.releaseSlot('user-1');

      for (let i = 0; i < 10; i++) {
        expect(() => limiter.acquireSlot('user-1')).not.toThrow();
      }
      expect(() => limiter.acquireSlot('user-1')).toThrow(HttpException);
    });
  });

  describe('cleanup timer callback', () => {
    it('fires the interval callback to evict expired entries', () => {
      jest.useFakeTimers();

      const timedLimiter = new ProxyRateLimiter();

      // Record some entries
      timedLimiter.checkLimit('user-old');

      // Manually expire the entry by manipulating the internal map
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rates = (timedLimiter as any).rates as Map<
        string,
        { count: number; windowStart: number }
      >;
      rates.get('user-old')!.windowStart = Date.now() - 120_000;

      timedLimiter.checkLimit('user-new');
      // Set user-new's windowStart so it survives the 60001ms time advance.
      rates.get('user-new')!.windowStart = Date.now() + 2;

      // Advance past the cleanup interval (60s)
      jest.advanceTimersByTime(60_001);

      // The interval callback should have triggered evictExpired
      expect(rates.has('user-old')).toBe(false);
      expect(rates.has('user-new')).toBe(true);

      timedLimiter.onModuleDestroy();
      jest.useRealTimers();
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the cleanup interval timer', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      limiter.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      clearIntervalSpy.mockRestore();
    });
  });
});
