import { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import {
  classifyMessageError,
  inferProviderFromModel,
  isSuccessStatus,
  normalizeStatus,
} from 'manifest-shared';
import { AgentMessage } from '../entities/agent-message.entity';
import { ManifestRequest } from '../entities/request.entity';

interface SeedOutcome {
  status: string;
  error_message: string | null;
  error_http_status: number | null;
  routing_reason: string | null;
  fallback_from_model: string | null;
  fallback_index: number | null;
}

/**
 * Every non-plain-success scenario the seeder draws from. A scenario is one
 * Request and contains its Provider Attempts in start order, so fallback data
 * can never be attached to an unrelated successful Attempt.
 */
const SEED_OUTCOME_SCENARIOS: SeedOutcome[][] = [
  // ── Provider errors: the provider itself threw (origin=provider) ──
  [
    wire(
      'rate_limited',
      429,
      '{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}',
      'scored',
    ),
  ],
  [
    wire(
      'error',
      500,
      '{"error":{"message":"The server had an error processing your request","code":500}}',
      'scored',
    ),
  ],
  [wire('error', 401, '{"error":{"message":"Incorrect API key provided","code":401}}', 'default')],
  [
    wire(
      'error',
      400,
      '{"error":{"message":"Invalid request: messages array too long","code":400}}',
      'scored',
    ),
  ],
  [wire('error', 404, '{"error":{"message":"The model does not exist","code":404}}', 'default')],
  // ── Transport: couldn't reach the provider (origin=transport) ──
  [wire('error', 504, 'Upstream provider request timed out', 'scored')],
  [wire('error', 503, 'Failed to reach upstream provider: ECONNRESET', 'scored')],
  // ── Manifest setup (origin=config) — hidden from the log by default ──
  [wire('error', null, 'Provider API key missing', 'no_provider_key')],
  [wire('error', null, 'No providers configured for this agent', 'no_provider')],
  // ── Manifest software limit (origin=policy) — shown, links to the limits page ──
  [wire('error', null, 'Usage limit exceeded', 'limit_exceeded')],
  // ── Manifest internal (origin=internal) ──
  [wire('error', null, 'Manifest internal error', 'friendly_error')],
  // ── Fallback RECOVERED: a failed Attempt followed by a successful fallback ──
  [
    wire(
      'fallback_error',
      529,
      '{"error":{"message":"Overloaded","type":"overloaded_error"}}',
      'scored',
    ),
    fallbackSuccess(0),
  ],
  [
    wire(
      'fallback_error',
      500,
      '{"error":{"message":"The server had an error","code":500}}',
      'scored',
    ),
    fallbackSuccess(0),
  ],
  // ── Fallback NOT HANDLED: every Attempt in the chain failed ──
  [
    wire(
      'fallback_error',
      500,
      '{"error":{"message":"The server had an error","code":500}}',
      'scored',
    ),
    fallbackWire('error', 500, '{"error":{"message":"The server had an error","code":500}}', 0),
  ],
  [
    wire(
      'fallback_error',
      429,
      '{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}',
      'scored',
    ),
    fallbackWire(
      'rate_limited',
      429,
      '{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}',
      0,
    ),
  ],
];

/** A single-shot outcome (no fallback context). */
function wire(status: string, http: number | null, message: string, reason: string): SeedOutcome {
  return {
    status,
    error_message: message,
    error_http_status: http,
    routing_reason: reason,
    fallback_from_model: null,
    fallback_index: null,
  };
}

/** An outcome that carries fallback context. Its source model is set per scenario. */
function fallbackWire(
  status: string,
  http: number | null,
  message: string,
  index: number,
): SeedOutcome {
  return {
    status,
    error_message: message,
    error_http_status: http,
    routing_reason: 'scored',
    fallback_from_model: null,
    fallback_index: index,
  };
}

function fallbackSuccess(index: number): SeedOutcome {
  return {
    status: 'ok',
    error_message: null,
    error_http_status: null,
    routing_reason: 'scored',
    fallback_from_model: null,
    fallback_index: index,
  };
}

interface SeedContext {
  tenantId: string;
  agentId: string;
  agentName: string;
}

/** Deterministic pseudo-random for reproducible seed data */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/**
 * Models the seeded messages are drawn from. Each distinct (provider,
 * auth_type) pair here becomes one seeded connection (tenant_providers row), so a
 * seeded connection-detail page shows realistic data while a freshly added key
 * — a brand-new tenant_providers id — correctly shows nothing.
 */
const SEED_MODELS: { name: string; auth_type: 'subscription' | 'api_key' }[] = [
  { name: 'claude-sonnet-4-5-20250929', auth_type: 'subscription' },
  { name: 'gpt-4o', auth_type: 'api_key' },
  { name: 'claude-haiku-4-5-20251001', auth_type: 'subscription' },
  { name: 'gemini-2.5-flash', auth_type: 'api_key' },
  { name: 'gpt-4.1', auth_type: 'subscription' },
];

export interface SeedConnection {
  id: string;
  provider: string;
  auth_type: 'subscription' | 'api_key';
}

/** Stable id for a seeded provider connection (tenant_providers row). */
export function seedConnectionId(provider: string, authType: string): string {
  return `seed-conn-${provider}-${authType}`;
}

/**
 * Distinct (provider, auth_type) connections behind the seeded messages. The
 * seeder creates one tenant_providers row per entry and stamps the matching
 * tenant_provider_id on every seeded message, so per-connection analytics resolve
 * against a real connection rather than the legacy provider/auth/label tuple.
 */
export function getSeedConnections(): SeedConnection[] {
  const seen = new Map<string, SeedConnection>();
  for (const m of SEED_MODELS) {
    const provider = inferProviderFromModel(m.name);
    if (!provider) continue;
    const key = `${provider}:${m.auth_type}`;
    if (!seen.has(key)) {
      seen.set(key, {
        id: seedConnectionId(provider, m.auth_type),
        provider,
        auth_type: m.auth_type,
      });
    }
  }
  return [...seen.values()];
}

export async function seedAgentMessages(
  messageRepo: Repository<AgentMessage>,
  userId: string,
  logger: Logger,
  ctx: SeedContext = {
    tenantId: 'seed-tenant-001',
    agentId: 'seed-agent-001',
    agentName: 'demo-agent',
  },
  requestRepo?: Repository<ManifestRequest>,
): Promise<void> {
  const count = await messageRepo.count();
  if (count > 0) return;

  const models = SEED_MODELS;
  const now = Date.now();
  const messages: Array<Partial<AgentMessage>> = [];
  const messageGroups: Array<Array<Partial<AgentMessage>>> = [];
  let idx = 0;
  let requestSlot = 0;

  // Generate ~4-8 Requests per hour over the last 7 days (168 hours)
  for (let h = 168; h >= 0; h--) {
    const hourBase = now - h * 3600000;
    // Fewer messages at night (hours 0-7 UTC), more during work hours
    const utcHour = new Date(hourBase).getUTCHours();
    const msgCount =
      utcHour >= 8 && utcHour <= 22
        ? 4 + Math.floor(seededRandom(h) * 5)
        : Math.floor(seededRandom(h + 500) * 3);

    for (let m = 0; m < msgCount; m++) {
      requestSlot++;
      const rawTs = hourBase + Math.floor(seededRandom(requestSlot) * 3500000);
      // ~15% of Requests draw a non-plain-success scenario. Multi-Attempt
      // fallback scenarios are emitted together so their outcomes stay coherent.
      const outcomes =
        seededRandom(requestSlot * 17) > 0.85
          ? SEED_OUTCOME_SCENARIOS[requestSlot % SEED_OUTCOME_SCENARIOS.length]!
          : [null];
      const primaryModel = models[(idx + 1) % models.length]!.name;
      const requestMessages: Array<Partial<AgentMessage>> = [];

      for (let attemptOffset = 0; attemptOffset < outcomes.length; attemptOffset++) {
        idx++;
        const outcome = outcomes[attemptOffset];
        const entry = models[idx % models.length]!;
        const ts = new Date(Math.min(rawTs + attemptOffset * 1000, now)).toISOString();
        // Input tokens 5-25x larger than output (realistic for LLM usage)
        const inputBase = 800 + Math.floor(seededRandom(idx * 3) * 14000);
        const outputBase = 60 + Math.floor(seededRandom(idx * 7) * 1200);
        const cacheRead = Math.floor(seededRandom(idx * 11) * inputBase * 0.4);
        const provider = inferProviderFromModel(entry.name) ?? null;
        const classification = classifyMessageError({
          status: outcome?.status ?? 'ok',
          errorHttpStatus: outcome?.error_http_status ?? null,
          routingReason: outcome?.routing_reason ?? null,
        });

        const message: Partial<AgentMessage> = {
          id: `seed-msg-${String(idx).padStart(4, '0')}`,
          tenant_id: ctx.tenantId,
          agent_id: ctx.agentId,
          user_id: userId,
          agent_name: ctx.agentName,
          timestamp: ts,
          model: entry.name,
          provider,
          auth_type: entry.auth_type,
          // Link to the seeded connection so the connection-detail page resolves
          // this message by tenant_provider_id (matches getSeedConnections()).
          tenant_provider_id: provider ? seedConnectionId(provider, entry.auth_type) : null,
          input_tokens: inputBase,
          output_tokens: outputBase,
          cache_read_tokens: cacheRead,
          cache_creation_tokens: 0,
          cost_usd:
            entry.auth_type === 'subscription' ? 0 : inputBase * 0.000003 + outputBase * 0.000015,
          duration_ms: 200 + Math.floor(seededRandom(idx * 13) * 4800),
          // Classify from the rich shape above, then store the canonical status —
          // exactly the classify-then-normalize the live recorder does.
          status: normalizeStatus(outcome?.status),
          error_message: outcome?.error_message ?? null,
          error_http_status: outcome?.error_http_status ?? null,
          routing_reason: outcome?.routing_reason ?? null,
          fallback_from_model:
            outcome?.fallback_index != null ? primaryModel : (outcome?.fallback_from_model ?? null),
          fallback_index: outcome?.fallback_index ?? null,
          error_origin: classification.error_origin,
          error_class: classification.error_class,
          superseded: classification.superseded,
          session_key: `sess-${String((requestSlot % 40) + 1).padStart(3, '0')}`,
        };
        messages.push(message);
        requestMessages.push(message);
      }
      messageGroups.push(requestMessages);
    }
  }

  if (requestRepo) {
    const requests: Array<Partial<ManifestRequest>> = [];
    let requestIndex = 0;

    for (const attempts of messageGroups) {
      requestIndex++;
      const requestId = `seed-req-${String(requestIndex).padStart(4, '0')}`;
      const traceId = `seed-trace-${String(requestIndex).padStart(4, '0')}`;
      let durationMs = 0;
      for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
        const message = attempts[attemptIndex]!;
        message.request_id = requestId;
        message.trace_id = traceId;
        message.attempt_number = attemptIndex + 1;
        durationMs += message.duration_ms ?? 0;
      }

      const firstAttempt = attempts[0]!;
      const lastAttempt = attempts.at(-1)!;
      const succeeded = isSuccessStatus(lastAttempt.status);
      requests.push({
        id: requestId,
        tenant_id: ctx.tenantId,
        agent_id: ctx.agentId,
        user_id: userId,
        agent_name: ctx.agentName,
        trace_id: traceId,
        session_key: firstAttempt.session_key ?? null,
        timestamp: firstAttempt.timestamp!,
        duration_ms: durationMs,
        status: succeeded ? 'success' : 'failed',
        error_message: succeeded ? null : (lastAttempt.error_message ?? null),
        error_http_status: succeeded ? null : (lastAttempt.error_http_status ?? null),
        error_origin: succeeded ? null : (lastAttempt.error_origin ?? null),
        error_class: succeeded ? null : (lastAttempt.error_class ?? null),
        requested_model: firstAttempt.model ?? null,
      });
    }

    for (let i = 0; i < requests.length; i += 100) {
      await requestRepo.insert(requests.slice(i, i + 100));
    }
  }

  // Bulk insert in batches of 100
  for (let i = 0; i < messages.length; i += 100) {
    await messageRepo.insert(messages.slice(i, i + 100));
  }
  logger.log(`Seeded ${messages.length} agent messages`);
}
