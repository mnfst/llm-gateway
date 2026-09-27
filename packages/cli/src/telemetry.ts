import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CliIo } from './context';
import { DEFAULT_URL, configFilePath, loadConfig, normalizeOrigin } from './config';
import { VERSION } from './version';
import { detectAgentRuntime } from './agent-runtime';

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.manifest.build/v1/cli-report';
/** Send once per install per day, like the backend's install report. */
export const FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed send, leave the endpoint alone for this long. */
export const RETRY_BACKOFF_MS = 60 * 60 * 1000;
/** Spool safety valve: flush early rather than let a scripted loop pile up. */
export const FLUSH_AT_EVENTS = 200;
/** Hard cap on what is kept between flushes; oldest events are dropped first. */
export const MAX_SPOOL_EVENTS = 500;
const SEND_TIMEOUT_MS = 1500;
/** A lock older than this belongs to a process that died mid-flush; reclaim it. */
export const LOCK_STALE_MS = 60 * 1000;

export interface CliUsageEvent {
  command: string;
  ok: boolean;
  duration_ms: number;
  /** ISO-8601 UTC, minute precision — enough for "commands per day". */
  at: string;
  agent_runtime?: string;
  /**
   * Spool-only: the Manifest class this command targeted, resolved at record
   * time so a `--url` flag counts. Hoisted to the envelope at flush and
   * stripped from the wire events.
   */
  target?: TelemetryTarget;
}

export type TelemetryTarget = 'cloud' | 'self-hosted';

/**
 * Which class of Manifest a command targets — Cloud or a self-hosted server —
 * never the URL itself. Same precedence as command resolution (`--url`, then
 * MANIFEST_URL, then the active config host, then Cloud). A corrupt config
 * falls through to that default; an unparsable URL is not Cloud.
 */
export function telemetryTarget(io: CliIo, flagUrl?: string): TelemetryTarget {
  let activeHost: string | undefined;
  try {
    activeHost = loadConfig(configFilePath(io.env)).activeHost;
  } catch {
    /* corrupt config: the login command reports it; here it just means "default" */
  }
  try {
    const origin = normalizeOrigin(flagUrl ?? io.env['MANIFEST_URL'] ?? activeHost ?? DEFAULT_URL);
    return origin === normalizeOrigin(DEFAULT_URL) || origin === 'https://gateway.manifest.build'
      ? 'cloud'
      : 'self-hosted';
  } catch {
    return 'self-hosted';
  }
}

/**
 * The value of a `--url <x>` / `--url=<x>` flag in a command's argv, resolved
 * the way parseArgs does: the last occurrence wins, and an occurrence with no
 * value (or a flag where the value should be) does not count.
 */
export function urlFlagOf(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break; // everything after is the child command (mnfst run)
    if (arg === '--url') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      }
    } else if (arg.startsWith('--url=')) {
      // A bare `--url=` is an empty value, as parseArgs records it; the command
      // then fails resolution, and here an unparsable URL classifies as not Cloud.
      value = arg.slice('--url='.length);
    }
  }
  return value;
}

interface FlushState {
  last_flush_at?: string;
  last_attempt_at?: string;
}

/**
 * Anonymous usage telemetry, following the product's install-telemetry
 * doctrine: on by default, opt-out via MANIFEST_TELEMETRY_DISABLED=1, and
 * ONE request per install per day. Each command appends a small event to a
 * local spool (0600, next to the config); the first command that runs 24h
 * after the last flush — or the first command ever, so a new install shows
 * up the same day — ships the spool in one POST. Nothing is sent per
 * command, so a scripted loop never hammers the endpoint and never pays the
 * network on every call. The payload is the registry command key ("agent
 * create" — NEVER arguments, URLs, agent names, or keys), the CLI version,
 * the platform, success/failure, duration, and the anon install id: a random
 * UUID persisted next to the config that identifies an install, not a person
 * or tenant.
 */
export function telemetryAnonId(io: CliIo): string {
  const idPath = path.join(telemetryDir(io), 'telemetry-id');
  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch {
    /* first run — mint below */
  }
  const fresh = randomUUID();
  try {
    fs.mkdirSync(path.dirname(idPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(idPath, fresh + '\n', { mode: 0o600 });
  } catch {
    /* unwritable config dir — still return a (per-process) id */
  }
  return fresh;
}

export function telemetryDisabled(io: CliIo): boolean {
  const v = io.env['MANIFEST_TELEMETRY_DISABLED'];
  return v === '1' || v === 'true';
}

function telemetryDir(io: CliIo): string {
  return path.dirname(configFilePath(io.env));
}

export function spoolPath(io: CliIo): string {
  return path.join(telemetryDir(io), 'telemetry-spool.jsonl');
}

function statePath(io: CliIo): string {
  return path.join(telemetryDir(io), 'telemetry-state.json');
}

function lockPath(io: CliIo): string {
  return path.join(telemetryDir(io), 'telemetry.lock');
}

/**
 * Per-install mutex around read-modify-write of the spool and the flush, so
 * two `mnfst` processes finishing together cannot both pass the due check and
 * send the day's batch twice, or interleave spool rewrites. `wx` makes the
 * create-or-fail atomic; a stale lock (crash mid-flush) is reclaimed.
 */
/**
 * Returns an ownership token on success, null when another run holds the
 * lock. The token is written into the lock file and checked again on release,
 * so a holder that was paused past the stale window (and whose lock was
 * reclaimed) can no longer delete the new owner's lock on its way out. Two
 * flushes in that pathological case are harmless: the ingest rejects a second
 * batch from the same install within minutes.
 */
function acquireLock(io: CliIo, now: number): string | null {
  const file = lockPath(io);
  const token = randomUUID();
  if (tryCreateLock(file, token)) return token;
  if (!isStaleLock(file, now)) return null;
  try {
    fs.unlinkSync(file);
  } catch {
    return null; // not a plain file, or gone already: not ours to reclaim
  }
  // A racer may re-take it between the unlink and this create; then it is theirs.
  return tryCreateLock(file, token) ? token : null;
}

function tryCreateLock(file: string, token: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isStaleLock(file: string, now: number): boolean {
  try {
    return now - fs.statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // unreadable: neither ours nor safely reclaimable
  }
}

/** Remove the lock only while it still carries our token — never a successor's. */
function releaseLock(io: CliIo, token: string): void {
  const file = lockPath(io);
  try {
    if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function readSpool(io: CliIo): CliUsageEvent[] {
  try {
    return fs
      .readFileSync(spoolPath(io), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return typeof parsed === 'object' && parsed !== null ? [parsed as CliUsageEvent] : [];
        } catch {
          return []; // a torn line from a crashed write — skip it, keep the rest
        }
      });
  } catch {
    return [];
  }
}

/**
 * Full rewrite through a temp file + rename, so a crash or a full disk mid-write
 * leaves the previous spool intact instead of a truncated one.
 */
function writeSpool(io: CliIo, events: CliUsageEvent[]): void {
  const file = spoolPath(io);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Lock-free fallback for a concurrent run: one small append, no rewrite, no flush. */
function appendSpool(io: CliIo, event: CliUsageEvent): void {
  const file = spoolPath(io);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
}

function readState(io: CliIo): FlushState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath(io), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as FlushState) : {};
  } catch {
    return {};
  }
}

function writeState(io: CliIo, state: FlushState): void {
  const file = statePath(io);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state) + '\n', { mode: 0o600 });
}

function msSince(iso: string | undefined, now: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
}

/** Record one command in the spool, then ship the spool if it is due. */
export async function reportUsage(
  io: CliIo,
  command: string,
  ok: boolean,
  durationMs: number,
  flagUrl?: string,
): Promise<void> {
  if (telemetryDisabled(io)) return;
  const now = Date.now();
  // Which coding agent is driving the CLI, when one is — a coarse runtime id
  // ("claude-code"), never a version, path, or anything about the session.
  // Omitted for human/script runs.
  const runtime = detectAgentRuntime(io.env);
  const event: CliUsageEvent = {
    command,
    ok,
    duration_ms: Math.max(0, Math.min(600_000, Math.round(durationMs))),
    at: new Date(now).toISOString().slice(0, 16) + ':00.000Z',
    ...(runtime ? { agent_runtime: runtime.id } : {}),
    target: telemetryTarget(io, flagUrl),
  };
  const token = acquireLock(io, now);
  if (token === null) {
    // Another mnfst is mid-flush (or the dir is unwritable): just record the
    // event; the holder — or the next command — ships it.
    try {
      appendSpool(io, event);
    } catch {
      /* unwritable config dir: no spool, no send — telemetry stays invisible */
    }
    return;
  }
  try {
    let spool: CliUsageEvent[];
    try {
      spool = [...readSpool(io), event].slice(-MAX_SPOOL_EVENTS);
      writeSpool(io, spool);
    } catch {
      return; // unwritable config dir: no spool, no send — telemetry stays invisible
    }

    const state = readState(io);
    const due =
      msSince(state.last_flush_at, now) >= FLUSH_INTERVAL_MS || spool.length >= FLUSH_AT_EVENTS;
    const backingOff = msSince(state.last_attempt_at, now) < RETRY_BACKOFF_MS;
    if (!due || backingOff) return;
    await flush(io, spool, state, now);
  } finally {
    releaseLock(io, token);
  }
}

async function flush(io: CliIo, events: CliUsageEvent[], state: FlushState, now: number) {
  const endpoint = io.env['MANIFEST_CLI_TELEMETRY_ENDPOINT'] ?? DEFAULT_TELEMETRY_ENDPOINT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let sent = false;
  try {
    const response = await io.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: 1,
        anon_id: telemetryAnonId(io),
        cli_version: VERSION,
        os: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other',
        // One class per batch (the ingest contract): the most recent command's.
        // A spool written before the field shipped falls back to the current
        // resolution.
        target: events[events.length - 1]?.target ?? telemetryTarget(io),
        events: events.map(({ target: _target, ...wire }) => wire),
      }),
      signal: controller.signal,
    });
    // Drain the body: an unread response keeps the socket alive and can delay
    // process exit past the command's own work — telemetry must be invisible.
    await (response.body?.cancel() ?? response.arrayBuffer());
    sent = response.ok;
  } catch {
    /* telemetry must never affect the command */
  } finally {
    clearTimeout(timer);
  }
  try {
    const attemptedAt = new Date(now).toISOString();
    if (sent) {
      // Keep only what arrived after the snapshot we just shipped.
      writeSpool(io, readSpool(io).slice(events.length));
      writeState(io, { last_flush_at: attemptedAt });
    } else {
      writeState(io, { ...state, last_attempt_at: attemptedAt });
    }
  } catch {
    /* state unwritable: the next command simply tries again */
  }
}
