import { Injectable, OnModuleDestroy, HttpStatus } from '@nestjs/common';
import { ManifestError } from '../../common/errors/manifest-error';
import { optionalPositiveInteger } from '../../config/env.util';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 200;
const IP_RATE_MAX_REQUESTS = 500;
const MAX_RATE_ENTRIES = 50_000;
const DEFAULT_CONCURRENCY_MAX = 10;
const CLEANUP_INTERVAL_MS = 60_000;

interface RateEntry {
  count: number;
  windowStart: number;
}

@Injectable()
export class ProxyRateLimiter implements OnModuleDestroy {
  private readonly rates = new Map<string, RateEntry>();
  private readonly ipRates = new Map<string, RateEntry>();
  private readonly concurrency = new Map<string, number>();
  private readonly concurrencyMax =
    optionalPositiveInteger(process.env.MANIFEST_CONCURRENCY_MAX) ?? DEFAULT_CONCURRENCY_MAX;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictExpired(), CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Check if the tenant is over the rate limit and increment the counter.
   * All requests count toward the limit (both successful and failed).
   */
  checkLimit(tenantId: string): void {
    const now = Date.now();
    let entry = this.rates.get(tenantId);

    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    if (entry.count >= RATE_MAX_REQUESTS) {
      throw new ManifestError('M201', HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count++;
    // LRU touch: delete-then-set re-inserts at tail of insertion order so
    // evictLruIfNeeded() drops genuinely-stale entries instead of arbitrary
    // long-lived ones during overflow.
    this.rates.delete(tenantId);
    this.rates.set(tenantId, entry);
    this.evictLruIfNeeded();
  }

  /**
   * Check if the IP is over the per-IP rate limit and increment the counter.
   * This catches abuse even when many requests share a single tenantId (e.g. dev).
   */
  checkIpLimit(ip: string): void {
    const now = Date.now();
    let entry = this.ipRates.get(ip);

    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    if (entry.count >= IP_RATE_MAX_REQUESTS) {
      throw new ManifestError('M202', HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count++;
    // LRU touch — see checkLimit().
    this.ipRates.delete(ip);
    this.ipRates.set(ip, entry);
    this.evictIpLruIfNeeded();
  }

  acquireSlot(tenantId: string): void {
    const current = this.concurrency.get(tenantId) ?? 0;
    if (current >= this.concurrencyMax) {
      throw new ManifestError('M203', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.concurrency.set(tenantId, current + 1);
  }

  releaseSlot(tenantId: string): void {
    const current = this.concurrency.get(tenantId) ?? 0;
    if (current <= 1) {
      this.concurrency.delete(tenantId);
    } else {
      this.concurrency.set(tenantId, current - 1);
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.rates) {
      if (now - entry.windowStart >= RATE_WINDOW_MS) {
        this.rates.delete(key);
      }
    }
    for (const [key, entry] of this.ipRates) {
      if (now - entry.windowStart >= RATE_WINDOW_MS) {
        this.ipRates.delete(key);
      }
    }
  }

  private evictLruIfNeeded(): void {
    while (this.rates.size > MAX_RATE_ENTRIES) {
      const oldest = this.rates.keys().next().value as string;
      this.rates.delete(oldest);
    }
  }

  private evictIpLruIfNeeded(): void {
    while (this.ipRates.size > MAX_RATE_ENTRIES) {
      const oldest = this.ipRates.keys().next().value as string;
      this.ipRates.delete(oldest);
    }
  }
}
