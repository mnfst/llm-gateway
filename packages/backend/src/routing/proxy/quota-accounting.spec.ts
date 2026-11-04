import 'reflect-metadata';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyAttempt,
  applyConsumed,
  applyWindowFlush,
  estimateTokens,
  normalizeProviderKey,
  normalizeUsageTokens,
  notifyWindowFlush,
  QuotaAccountingSnapshot,
  rollIfExpired,
  setQuotaAccountingHooks,
} from './quota-accounting';
import { QuotaAccountingService } from './quota-accounting.service';

// Deterministic "now" so window identity assertions stay exact.
const NOW_MS = 1_700_000_000_000;
const ISO = (ms: number) => new Date(ms).toISOString();

const emptyState = (): QuotaAccountingSnapshot => ({ providers: {} });

describe('quota-accounting — pure window core', () => {
  describe('normalizeProviderKey / estimateTokens / normalizeUsageTokens', () => {
    it('lowercases and trims provider keys', () => {
      expect(normalizeProviderKey('  OpenAI ')).toBe('openai');
      expect(normalizeProviderKey('Anthropic')).toBe('anthropic');
    });

    it('estimates tokens as ceil(chars / 4)', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('1234')).toBe(1);
      expect(estimateTokens('12345')).toBe(2);
      expect(estimateTokens('x'.repeat(9))).toBe(3);
    });

    it('normalizes usage to prompt+completion and guards non-numeric input', () => {
      expect(normalizeUsageTokens({ prompt_tokens: 10, completion_tokens: 5 })).toBe(15);
      expect(normalizeUsageTokens({ prompt_tokens: 10 })).toBe(10);
      expect(normalizeUsageTokens(null)).toBe(0);
      expect(normalizeUsageTokens({ prompt_tokens: -3, completion_tokens: 2 })).toBe(2);
    });
  });

  describe('applyAttempt / applyConsumed', () => {
    it('counts attempts keyed by lowercased provider with ceil est tokens', () => {
      const state = emptyState();
      applyAttempt(state, 'OpenAI', 'x'.repeat(9), NOW_MS);
      const entry = state.providers['openai'];
      expect(entry.attempted_requests).toBe(1);
      expect(entry.attempted_est_tokens).toBe(3);
      expect(entry.window_start).toBe(ISO(NOW_MS));
      expect(entry.window_flush_at).toBeNull();
    });

    it('counts consumed requests with normalized tokens', () => {
      const state = emptyState();
      applyConsumed(state, 'openai', { prompt_tokens: 10, completion_tokens: 5 }, NOW_MS);
      const entry = state.providers['openai'];
      expect(entry.consumed_requests).toBe(1);
      expect(entry.consumed_tokens).toBe(15);
    });

    it('rolls and zeroes when the previous halt window expired before the attempt', () => {
      const state = emptyState();
      applyAttempt(state, 'openai', 'abcd', NOW_MS);
      applyWindowFlush(state, 'openai', NOW_MS + 60_000, NOW_MS);
      applyAttempt(state, 'openai', 'abcd', NOW_MS + 10_000);
      expect(state.providers['openai'].attempted_requests).toBe(2);
      // The window flushed at NOW+60s; the next attempt lands after it.
      applyAttempt(state, 'openai', 'abcd', NOW_MS + 61_000);
      const entry = state.providers['openai'];
      expect(entry.attempted_requests).toBe(1);
      expect(entry.consumed_tokens).toBe(0);
      expect(entry.window_flush_at).toBeNull();
      expect(entry.window_start).toBe(ISO(NOW_MS + 61_000));
    });
  });

  describe('applyWindowFlush — identity adoption vs roll', () => {
    it('first adoption KEEPS counters but re-stamps window_start', () => {
      const state = emptyState();
      applyAttempt(state, 'openai', 'abcd', NOW_MS);
      applyConsumed(state, 'openai', { prompt_tokens: 7 }, NOW_MS + 1000);
      const outcome = applyWindowFlush(state, 'openai', NOW_MS + 60_000, NOW_MS + 2000);
      expect(outcome).toBe('adopted');
      const entry = state.providers['openai'];
      // Counters kept: the attempts belong to the now-identified window.
      expect(entry.attempted_requests).toBe(1);
      expect(entry.consumed_tokens).toBe(7);
      expect(entry.window_flush_at).toBe(ISO(NOW_MS + 60_000));
      expect(entry.window_start).toBe(ISO(NOW_MS + 2000));
    });

    it('identity change ROLLS and zeroes the counters', () => {
      const state = emptyState();
      applyAttempt(state, 'openai', 'abcd', NOW_MS);
      applyWindowFlush(state, 'openai', NOW_MS + 60_000, NOW_MS);
      applyAttempt(state, 'openai', 'abcd', NOW_MS + 1000);
      const outcome = applyWindowFlush(state, 'openai', NOW_MS + 120_000, NOW_MS + 2000);
      expect(outcome).toBe('rolled');
      const entry = state.providers['openai'];
      expect(entry.attempted_requests).toBe(0);
      expect(entry.attempted_est_tokens).toBe(0);
      expect(entry.consumed_requests).toBe(0);
      expect(entry.window_flush_at).toBe(ISO(NOW_MS + 120_000));
      expect(entry.window_start).toBe(ISO(NOW_MS + 2000));
    });

    it('same identity is a no-op', () => {
      const state = emptyState();
      applyAttempt(state, 'openai', 'abcd', NOW_MS);
      applyWindowFlush(state, 'openai', NOW_MS + 60_000, NOW_MS);
      const outcome = applyWindowFlush(state, 'openai', NOW_MS + 60_000, NOW_MS + 5000);
      expect(outcome).toBe('unchanged');
      expect(state.providers['openai'].attempted_requests).toBe(1);
      expect(state.providers['openai'].window_start).toBe(ISO(NOW_MS));
    });
  });

  describe('rollIfExpired', () => {
    it('does not roll a live window and rolls an expired one', () => {
      const state = emptyState();
      applyAttempt(state, 'openai', 'abcd', NOW_MS);
      expect(rollIfExpired(state, 'openai', NOW_MS + 1000)).toBe(false);
      applyWindowFlush(state, 'openai', NOW_MS + 60_000, NOW_MS);
      expect(rollIfExpired(state, 'openai', NOW_MS + 59_999)).toBe(false);
      expect(rollIfExpired(state, 'openai', NOW_MS + 60_000)).toBe(true);
      expect(state.providers['openai'].attempted_requests).toBe(0);
      expect(state.providers['openai'].window_flush_at).toBeNull();
    });
  });
});

describe('quota-accounting — service persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quota-accounting-'));
    file = join(dir, 'quota-accounting.json');
    setQuotaAccountingHooks(null);
  });

  afterEach(() => {
    setQuotaAccountingHooks(null);
  });

  it('persists atomically on flush and reloads state into a fresh service', () => {
    const svc = new QuotaAccountingService(file);
    svc.recordAttempt('OpenAI', 'x'.repeat(8));
    svc.recordConsumed('openai', { prompt_tokens: 12, completion_tokens: 3 });
    svc.flush();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(onDisk.providers)).toEqual(['openai']);
    const reloaded = new QuotaAccountingService(file);
    const snap = reloaded.snapshot();
    expect(snap.providers['openai'].attempted_requests).toBe(1);
    expect(snap.providers['openai'].attempted_est_tokens).toBe(2);
    expect(snap.providers['openai'].consumed_requests).toBe(1);
    expect(snap.providers['openai'].consumed_tokens).toBe(15);
  });

  it('keeps writes debounced (no file until flush) and flushes immediately on roll', () => {
    const svc = new QuotaAccountingService(file);
    svc.recordAttempt('openai', 'abcd');
    svc.noteWindowFlush('openai', Date.now() + 60_000);
    expect(existsSync(file)).toBe(false); // adopted: still only debounced
    svc.recordAttempt('openai', 'abcd');
    svc.noteWindowFlush('openai', Date.now() + 120_000); // identity change → roll → flush
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    // Roll zeroed the counters that were counted between the two halts.
    expect(onDisk.providers['openai'].attempted_requests).toBe(0);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('degrades warn-once to in-memory when the persistence target is unwritable', () => {
    // A regular file where a directory is needed → mkdir/write must fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a dir');
    const impossible = join(blocker, 'quota-accounting.json');
    const svc = new QuotaAccountingService(impossible);
    svc.recordAttempt('openai', 'abcd');
    svc.flush(); // must not throw
    expect(svc.snapshot().providers['openai'].attempted_requests).toBe(1);
    expect(existsSync(impossible)).toBe(false);
  });

  it('onModuleInit registers the response-handler hook and noteWindowFlush lands', () => {
    const svc = new QuotaAccountingService(file);
    svc.recordAttempt('openai', 'abcd');
    svc.onModuleInit();
    notifyWindowFlush('openai', NOW_MS + 60_000);
    const snap = svc.snapshot();
    expect(snap.providers['openai'].window_flush_at).toBe(ISO(NOW_MS + 60_000));
    // First adoption keeps the attempt counted before the halt was seen.
    expect(snap.providers['openai'].attempted_requests).toBe(1);
  });

  it('onModuleDestroy clears the hook registry and flushes state', () => {
    const svc = new QuotaAccountingService(file);
    svc.onModuleInit();
    svc.recordAttempt('openai', 'abcd');
    svc.onModuleDestroy();
    expect(existsSync(file)).toBe(true);
    notifyWindowFlush('openai', NOW_MS); // hook cleared — must be a no-op
    expect(svc.snapshot().providers['openai'].window_flush_at).toBeNull();
  });
});
