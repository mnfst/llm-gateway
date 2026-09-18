import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Tier } from '../../scoring/types';
import type { SpecificityCategory } from 'manifest-shared';

interface MomentumEntry {
  tiers: Tier[];
  categories: SpecificityCategory[];
  lastUpdated: number;
}

const MAX_ENTRIES = 5;
export const SESSION_MOMENTUM_MAX_SESSIONS = 10_000;
export const SESSION_MOMENTUM_MAX_KEY_LENGTH = 512;
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class SessionMomentumService implements OnModuleDestroy {
  private readonly sessions = new Map<string, MomentumEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictStale(), CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  getRecentTiers(sessionKey: string): Tier[] | undefined {
    if (!this.isCacheableKey(sessionKey)) return undefined;
    const entry = this.readFresh(sessionKey);
    return entry?.tiers;
  }

  getRecentCategories(sessionKey: string): SpecificityCategory[] | undefined {
    if (!this.isCacheableKey(sessionKey)) return undefined;
    const entry = this.readFresh(sessionKey);
    if (!entry || entry.categories.length === 0) return undefined;
    return entry.categories;
  }

  recordTier(sessionKey: string, tier: Tier): void {
    if (!this.isCacheableKey(sessionKey)) return;
    const entry = this.getOrCreate(sessionKey);
    entry.tiers = [tier, ...entry.tiers].slice(0, MAX_ENTRIES);
    entry.lastUpdated = Date.now();
    this.touch(sessionKey, entry);
  }

  recordCategory(sessionKey: string, category: SpecificityCategory): void {
    if (!this.isCacheableKey(sessionKey)) return;
    const entry = this.getOrCreate(sessionKey);
    entry.categories = [category, ...entry.categories].slice(0, MAX_ENTRIES);
    entry.lastUpdated = Date.now();
    this.touch(sessionKey, entry);
  }

  private readFresh(sessionKey: string): MomentumEntry | undefined {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUpdated > TTL_MS) {
      this.sessions.delete(sessionKey);
      return undefined;
    }
    this.touch(sessionKey, entry);
    return entry;
  }

  private getOrCreate(sessionKey: string): MomentumEntry {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    if (this.sessions.size >= SESSION_MOMENTUM_MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.sessions.delete(oldestKey);
    }

    const entry: MomentumEntry = {
      tiers: [],
      categories: [],
      lastUpdated: Date.now(),
    };
    this.sessions.set(sessionKey, entry);
    return entry;
  }

  private touch(sessionKey: string, entry: MomentumEntry): void {
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, entry);
  }

  private isCacheableKey(sessionKey: string): boolean {
    return sessionKey.length <= SESSION_MOMENTUM_MAX_KEY_LENGTH;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUpdated > TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }
}
