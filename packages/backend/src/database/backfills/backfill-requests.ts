import { DEFAULT_BACKFILL_OPTIONS, isRetryableBackfillError } from './backfill-message-providers';

export interface RequestBackfillTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface RequestBackfillGateway {
  analyze(): Promise<void>;
  backfillFallbackGroups(
    batchSize: number,
    before: string,
    timeouts: RequestBackfillTimeouts,
    pause: () => Promise<void>,
    reportProgress?: (message: string) => void,
  ): Promise<{ requests: number; attempts: number }>;
  nextWindowEnd(afterId: string, batchSize: number, before: string): Promise<string | null>;
  backfillWindow(
    afterId: string,
    endId: string,
    before: string,
    timeouts: RequestBackfillTimeouts,
  ): Promise<{ requests: number; attempts: number; rejections: number }>;
  finalize(timeouts: RequestBackfillTimeouts): Promise<void>;
}

export interface RequestBackfillOptions {
  batchSize?: number;
  throttleMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  /** Fallback rows may match sooner than generic rows, leaving a safety gap for late terminals. */
  fallbackBefore?: string;
  /** Only generic attempts older than this boundary are linked. */
  before?: string;
  analyze?: boolean;
  finalize?: boolean;
  logger?: { log: (message: string) => void };
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestBackfillResult {
  windows: number;
  requests: number;
  attempts: number;
  rejections: number;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`request backfill ${name} must be a positive finite number`);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`request backfill ${name} must be a positive safe integer`);
  }
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`request backfill ${name} must be a non-negative finite number`);
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Regroup history after startup in short, retryable keyset windows. This is
 * deliberately not a TypeORM migration: deploy readiness must not wait for a
 * scan and rewrite of the hot agent_messages table.
 */
export async function runRequestBackfill(
  gateway: RequestBackfillGateway,
  options: RequestBackfillOptions = {},
): Promise<RequestBackfillResult> {
  const batchSize = options.batchSize ?? DEFAULT_BACKFILL_OPTIONS.batchSize;
  const throttleMs = options.throttleMs ?? DEFAULT_BACKFILL_OPTIONS.throttleMs;
  const maxRetries = options.maxRetries ?? DEFAULT_BACKFILL_OPTIONS.maxRetries;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_BACKFILL_OPTIONS.retryBackoffMs;
  const sleep = options.sleep ?? realSleep;
  const before = options.before ?? '9999-12-31 23:59:59';
  const fallbackBefore = options.fallbackBefore ?? before;
  const log = (message: string): void => options.logger?.log(message);
  const pause = (): Promise<void> => (throttleMs > 0 ? sleep(throttleMs) : Promise.resolve());
  const timeouts: RequestBackfillTimeouts = {
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_BACKFILL_OPTIONS.lockTimeoutMs,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_BACKFILL_OPTIONS.statementTimeoutMs,
  };

  assertPositiveSafeInteger('batchSize', batchSize);
  assertNonNegativeFinite('throttleMs', throttleMs);
  assertNonNegativeFinite('maxRetries', maxRetries);
  assertNonNegativeFinite('retryBackoffMs', retryBackoffMs);
  assertPositiveFinite('lockTimeoutMs', timeouts.lockTimeoutMs);
  assertPositiveFinite('statementTimeoutMs', timeouts.statementTimeoutMs);
  const beforeTime = Date.parse(before);
  const fallbackBeforeTime = Date.parse(fallbackBefore);
  if (Number.isNaN(beforeTime)) throw new Error('request backfill before must be valid');
  if (Number.isNaN(fallbackBeforeTime)) {
    throw new Error('request backfill fallbackBefore must be valid');
  }
  if (fallbackBeforeTime < beforeTime) {
    throw new Error('request backfill fallbackBefore must not precede before');
  }

  if (options.analyze !== false) await gateway.analyze();

  let afterId = '';
  const result: RequestBackfillResult = {
    windows: 0,
    requests: 0,
    attempts: 0,
    rejections: 0,
  };

  let fallbackAttempt = 0;
  for (;;) {
    try {
      log('request backfill: reconstructing legacy fallback chains');
      const grouped = await gateway.backfillFallbackGroups(
        batchSize,
        fallbackBefore,
        timeouts,
        pause,
        (message) => log(`request backfill: ${message}`),
      );
      result.requests += grouped.requests;
      result.attempts += grouped.attempts;
      if (grouped.attempts > 0) {
        log(
          `request backfill: reconstructed ${grouped.requests} legacy fallback request(s) from ${grouped.attempts} attempt(s)`,
        );
      }
      break;
    } catch (error) {
      fallbackAttempt += 1;
      if (fallbackAttempt > maxRetries || !isRetryableBackfillError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      log(
        `request backfill: fallback regrouping failed (attempt ${fallbackAttempt}/${maxRetries}: ${reason}); retrying`,
      );
      await sleep(retryBackoffMs * fallbackAttempt);
    }
  }

  for (;;) {
    const endId = await gateway.nextWindowEnd(afterId, batchSize, before);
    if (endId === null) break;

    let attempt = 0;
    for (;;) {
      try {
        const window = await gateway.backfillWindow(afterId, endId, before, timeouts);
        result.requests += window.requests;
        result.attempts += window.attempts;
        result.rejections += window.rejections;
        break;
      } catch (error) {
        attempt += 1;
        if (attempt > maxRetries || !isRetryableBackfillError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        log(
          `request backfill: window after "${afterId}" failed (attempt ${attempt}/${maxRetries}: ${reason}); retrying`,
        );
        await sleep(retryBackoffMs * attempt);
      }
    }

    result.windows += 1;
    afterId = endId;
    if (result.windows % 25 === 0) {
      log(
        `request backfill: ${result.windows} window(s), ${result.attempts} attempt(s), ${result.rejections} zero-attempt rejection(s)`,
      );
    }
    if (throttleMs > 0) await sleep(throttleMs);
  }

  if (options.finalize !== false) {
    let finalizeAttempt = 0;
    for (;;) {
      try {
        await gateway.finalize(timeouts);
        break;
      } catch (error) {
        finalizeAttempt += 1;
        if (finalizeAttempt > maxRetries || !isRetryableBackfillError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        log(
          `request backfill: finalization failed (attempt ${finalizeAttempt}/${maxRetries}: ${reason}); retrying`,
        );
        await sleep(retryBackoffMs * finalizeAttempt);
      }
    }
  }
  log(
    `request backfill: done — ${result.attempts} attempt(s) and ${result.rejections} rejection(s) across ${result.windows} window(s)`,
  );
  return result;
}
