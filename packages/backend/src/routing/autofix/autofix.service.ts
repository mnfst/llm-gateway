import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import {
  coerceAgentPlatform,
  isAnthropicExtraUsageError,
  type AgentPlatform,
  type AuthType,
} from 'manifest-shared';
import { Agent } from '../../entities/agent.entity';
import { isSelfHosted } from '../../common/utils/detect-self-hosted';
import type { ForwardResult } from '../proxy/provider-client';
import type { ProxyApiMode } from '../proxy/proxy-types';
import {
  HEALING_CLIENT,
  HealContractError,
  type HealingClient,
  type HealingRequestContext,
} from './healing-client';
import { normalizeProviderError } from './provider-error-normalizer';
import { scrubSecrets } from '../../common/utils/secret-scrub';
import { scrubProviderUrl } from './observation-payload';
import type { AutofixChainEntry, AutofixRecord } from './autofix.types';
import type { HealOutcome, HealResponse } from './phoenix.types';
import { recordingResponseFromText } from '../proxy/attempt-recording-capture';

export interface MaybeHealParams {
  forward: ForwardResult;
  agentId: string;
  tenantId: string;
  provider: string;
  /** Logical model identity when the provider encodes it outside the JSON body. */
  model: string;
  authType: AuthType;
  apiMode: ProxyApiMode;
  /** The request body that was actually forwarded and failed. */
  requestBody: Record<string, unknown>;
  /** Optional endpoint URL, forwarded to Phoenix as readability context. */
  url?: string;
  /** Re-send a patched body to the provider and return the fresh forward. */
  reforward: (healedBody: Record<string, unknown>) => Promise<ForwardResult>;
}

export interface AutofixAttempt {
  /** Forward to continue with: the latest provider response, rebuilt if consumed. */
  forward: ForwardResult;
  record: AutofixRecord;
}

interface AgentAutofixConfig {
  enabled: boolean;
  harness: AgentPlatform;
}

interface AgentConfigLoad {
  generation: number;
  promise: Promise<AgentAutofixConfig>;
}

const DEFAULT_REPAIRABLE_STATUSES = '400,404,422';

// Circuit breaker for the healing service. After this many consecutive heal-call
// transport failures (timeout / unreachable), stop calling Phoenix for the
// cooldown window so a slow or down healer stops adding latency to every
// repairable 4xx BEFORE the fallback chain (the next safety net) gets to run.
const HEAL_FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
/**
 * Delays between outcome-report resends. A lost report leaves the heal attempt
 * dangling `pending` on Phoenix until a sweeper expires it an hour later — the
 * adjudication evidence is gone for good — so a transient failure gets spaced
 * resends before we give up.
 */
const OUTCOME_RESEND_DELAYS_MS = [1_000, 5_000];

function parseStatuses(raw: string | undefined): Set<number> {
  const source = raw && raw.trim().length > 0 ? raw : DEFAULT_REPAIRABLE_STATUSES;
  const parsed = source
    .split(',')
    .map((s) => s.trim())
    // Digits-only: reject malformed tokens like `'404abc'` (which `parseInt` would
    // silently accept as `404`) so a typo can't quietly enable/disable a status.
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => n >= 400 && n < 500);
  return new Set(parsed.length > 0 ? parsed : DEFAULT_REPAIRABLE_STATUSES.split(',').map(Number));
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function parseProviderBody(raw: string): unknown {
  const scrubbed = scrubSecrets(raw);
  try {
    return JSON.parse(scrubbed) as unknown;
  } catch {
    return scrubbed;
  }
}

function rebuildForward(base: ForwardResult, body: string, status: number): ForwardResult {
  return {
    ...base,
    response: new Response(body, { status, headers: headersToObject(base.response.headers) }),
  };
}

/**
 * Autofix: heal a repairable request-side 4xx by handing the failed request and
 * its provider error to Phoenix and resending the patched body ONCE — all BEFORE
 * the fallback chain runs. A no-op unless the forward already failed with a
 * repairable status AND the agent opted in, so successful traffic is never
 * touched. Any unexpected failure inside the flow degrades to the original
 * provider error — healing never makes a request worse.
 */
@Injectable()
export class AutofixService {
  private readonly logger = new Logger(AutofixService.name);
  private readonly globalEnabled: boolean;
  // Effective default when an agent has no explicit choice (autofix_enabled NULL):
  // ON in cloud, OFF in self-hosted. Computed once at boot.
  private readonly defaultAgentEnabled: boolean;
  private readonly repairableStatuses: Set<number>;
  private readonly configLoads = new Map<string, AgentConfigLoad>();
  private configLoadGeneration = 0;
  // Circuit-breaker state (process-local). `breakerOpenUntil` is an epoch-ms
  // deadline; while it is in the future, heal calls are skipped.
  private healFailureStreak = 0;
  private breakerOpenUntil = 0;

  constructor(
    @Inject(HEALING_CLIENT) private readonly client: HealingClient,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    config: ConfigService,
  ) {
    this.globalEnabled = config.get<string>('AUTOFIX_GLOBAL_ENABLED') !== 'false';
    this.defaultAgentEnabled = !isSelfHosted();
    this.repairableStatuses = parseStatuses(config.get<string>('AUTOFIX_REPAIRABLE_STATUSES'));
    // Boot-time snapshot of the resolved configuration. Logged once so an operator can
    // confirm what the process actually loaded — e.g. whether the global kill
    // switch is off, or self-hosted detection flipped the per-agent default off
    // — straight from the deploy logs, without shell access. This is the first
    // thing to check when "Autofix never runs".
    this.logger.log(
      `config: globalEnabled=${this.globalEnabled} ` +
        `defaultAgentEnabled=${this.defaultAgentEnabled} ` +
        `repairableStatuses=[${[...this.repairableStatuses].join(',')}]`,
    );
  }

  /**
   * Resolve an agent's stored Autofix flag to an effective on/off value. A
   * NULL/undefined flag means "no explicit choice" and inherits the
   * deployment-mode default: ON in cloud, OFF in self-hosted.
   */
  resolveEnabled(stored: boolean | null | undefined): boolean {
    return stored ?? this.defaultAgentEnabled;
  }

  /** Whether a status is one Autofix will try to heal. */
  isRepairable(status: number): boolean {
    return this.repairableStatuses.has(status);
  }

  /**
   * Is Autofix active for this agent — deployment-wide and for the agent itself?
   * These are exactly the gates {@link maybeHeal} clears before
   * it hands a request to Phoenix (it checks them inline so it can log *which*
   * one short-circuited; keep the two in lockstep).
   *
   * Excludes the two checks that aren't about the agent's opt-in: the repairable
   * status set (scope) and the circuit breaker (availability).
   *
   * This is the **consent boundary** for anything that ships a caller's request to
   * the healing service. Turning Autofix on is what agrees to that; the evidence
   * reporter must not send a body for an agent that never did. Rejects rather than
   * resolves false on a DB hiccup, so callers fail closed on purpose.
   */
  async isActiveFor(tenantId: string, agentId: string): Promise<boolean> {
    return (await this.getHealingContext(tenantId, agentId)) !== null;
  }

  /** Resolve consent and the bounded per-agent metadata needed by Phoenix. */
  async getHealingContext(
    tenantId: string,
    agentId: string,
  ): Promise<HealingRequestContext | null> {
    if (!this.globalEnabled) return null;
    const cfg = await this.loadAgentConfig(agentId, tenantId);
    return cfg.enabled ? { harness: cfg.harness } : null;
  }

  /** A heal call reached the healer (any decision) — clear the failure streak. */
  private recordHealSuccess(): void {
    this.healFailureStreak = 0;
  }

  /**
   * A heal call failed at the transport layer (timeout / unreachable). Once the
   * streak crosses the threshold, open the breaker for the cooldown window so
   * subsequent failures stop adding latency to the request path.
   */
  private recordHealFailure(): void {
    this.healFailureStreak += 1;
    if (this.healFailureStreak >= HEAL_FAILURE_THRESHOLD) {
      this.breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      this.healFailureStreak = 0;
      this.logger.warn(
        `autofix: healing service unreachable — circuit breaker open for ${BREAKER_COOLDOWN_MS}ms`,
      );
    }
  }

  async maybeHeal(params: MaybeHealParams): Promise<AutofixAttempt | null> {
    const { forward } = params;
    // Hot path: successful forwards never enter healing — return silently so we
    // don't emit a log line on every request.
    if (forward.response.ok) return null;

    // Everything below runs ONLY for failed forwards, so these diagnostics stay
    // low-volume. They make "why didn't Autofix run?" answerable from logs
    // alone: one line per failed request stamped with the resolved configuration,
    // then a single reason whenever a check short-circuits the heal.
    const status = forward.response.status;
    this.logger.log(
      `maybeHeal: failed forward status=${status} agent=${params.agentId} ` +
        `tenant=${params.tenantId} globalEnabled=${this.globalEnabled}`,
    );
    if (!this.globalEnabled) {
      this.logger.warn(`skip status=${status}: globally disabled (AUTOFIX_GLOBAL_ENABLED=false)`);
      return null;
    }
    if (!this.isRepairable(status)) {
      this.logger.log(
        `skip status=${status}: not in repairable set [${[...this.repairableStatuses].join(',')}]`,
      );
      return null;
    }
    if (status === 400 && params.provider.trim().toLowerCase() === 'anthropic') {
      try {
        const errorBody = await forward.response.clone().text();
        if (
          isAnthropicExtraUsageError({
            provider: params.provider,
            httpStatus: status,
            errorBody,
          })
        ) {
          this.logger.log(`skip status=${status}: Anthropic subscription billing exhaustion`);
          return null;
        }
      } catch (err) {
        // Classification is best-effort. If the cloned body cannot be read, keep
        // the existing status-based behavior and leave the original response intact.
        this.logger.warn(
          `could not inspect Anthropic 400 for billing semantics: ${(err as Error).message}`,
        );
      }
    }

    // Circuit breaker: while the healing service is tripped, skip healing
    // entirely and hand the forward back untouched, so a slow/unreachable
    // Phoenix never delays the fallback chain (the next safety net).
    if (this.breakerOpenUntil > Date.now()) {
      this.logger.warn(`skip status=${status}: circuit breaker open`);
      return null;
    }

    let cfg: AgentAutofixConfig;
    try {
      cfg = await this.loadAgentConfig(params.agentId, params.tenantId);
    } catch (err) {
      // A config-load failure (DB hiccup) must never turn a recoverable provider
      // error into a crash — skip healing; the forward is still intact.
      this.logger.warn(`autofix config load failed, skipping: ${(err as Error).message}`);
      return null;
    }
    if (!cfg.enabled) {
      this.logger.log(
        `skip status=${status}: agent ${params.agentId} tenant ${params.tenantId} ` +
          `disabled (defaultAgentEnabled=${this.defaultAgentEnabled})`,
      );
      return null;
    }

    // Include tenant + agent so a healing event is self-contained for
    // tenant-scoped log filtering (the entry line above can interleave across
    // requests once the two awaited gate checks run between them).
    this.logger.log(
      `healing status=${status} agent=${params.agentId} ` +
        `tenant=${params.tenantId} provider=${params.provider}`,
    );

    // Read the original error once, then rebuild it so it stays readable
    // downstream (fallback / recorder) whether or not we heal.
    const originalText = await forward.response.text();
    await forward.attempt?.finishRecording?.(recordingResponseFromText(originalText));
    const originalForward = rebuildForward(forward, originalText, status);

    try {
      return await this.runHealOnce(params, cfg, status, originalText, originalForward);
    } catch (err) {
      // Defensive backstop: the common reforward failure is handled inside
      // runHealOnce (which preserves the chain), so this only fires on a truly
      // unexpected throw (e.g. reading the failed retry body). Degrade to the
      // original provider error — never a Manifest 500.
      this.logger.warn(`autofix failed, using original error: ${(err as Error).message}`);
      return {
        forward: originalForward,
        record: { groupId: uuid(), outcome: 'exhausted', original_http_status: status, chain: [] },
      };
    }
  }

  /**
   * One heal attempt: ask Phoenix, and if it hands out a patch, resend the
   * patched body exactly once. There is no retry budget — a patch that doesn't
   * clear the error is reported to Phoenix and then we give up (the fallback
   * chain is the next safety net).
   */
  private async runHealOnce(
    params: MaybeHealParams,
    config: AgentAutofixConfig,
    status: number,
    originalText: string,
    originalForward: ForwardResult,
  ): Promise<AutofixAttempt> {
    const groupId = uuid();
    const normalized = normalizeProviderError(originalText);

    const entry: AutofixChainEntry = {
      attempt: 0,
      origin: 'original',
      request: params.requestBody,
      http_status: status,
      error: normalized,
    };
    const chain: AutofixChainEntry[] = [entry];

    let heal: HealResponse;
    try {
      heal = await this.client.heal(
        {
          traceId: groupId,
          tenantId: params.tenantId,
          provider: params.provider,
          model: params.model,
          authType: params.authType,
          api: params.apiMode,
          url: params.url,
          request: params.requestBody,
          response: { statusCode: status, error: normalized },
          ...(originalForward.wireFormat
            ? {
                providerExchange: {
                  format: originalForward.wireFormat,
                  ...(originalForward.wireRequestUrl
                    ? { url: scrubProviderUrl(originalForward.wireRequestUrl) }
                    : {}),
                  request: { body: params.requestBody, redactedFields: [] },
                  response: {
                    statusCode: status,
                    body: parseProviderBody(originalText),
                  },
                },
              }
            : {}),
        },
        { harness: config.harness },
      );
    } catch (err) {
      if (err instanceof HealContractError) {
        // Phoenix is reachable but rejected the request (4xx) — a contract or
        // API-key bug on our side, not an outage. Don't trip the breaker (that
        // would just mask it); surface it loudly so it gets fixed.
        this.logger.error(
          `autofix: Phoenix rejected the heal request (HTTP ${err.status}) — check the ` +
            `wire contract and AUTOFIX_HEALING_API_KEY: ${err.message}`,
        );
      } else {
        this.recordHealFailure();
        this.logger.warn(`heal call failed: ${(err as Error).message}`);
      }
      return {
        forward: originalForward,
        record: { groupId, outcome: 'exhausted', original_http_status: status, chain },
      };
    }
    // The healer answered (any decision) — it is alive, so clear the streak.
    this.recordHealSuccess();

    entry.phoenix_status = heal.status;
    entry.issue_id = heal.issueId;
    entry.patch_id = heal.patchId ?? null;
    entry.heal_attempt_id = heal.healAttemptId ?? null;
    entry.operations = heal.operations ?? null;
    entry.explanation = heal.explanation ?? null;

    // Phoenix is still authoring a patch for this novel error — nothing to resend.
    if (heal.status === 'resolving') {
      return {
        forward: originalForward,
        record: { groupId, outcome: 'resolving', original_http_status: status, chain },
      };
    }
    // No patch available (or a malformed patch response) — give up cleanly.
    if (heal.status === 'no_patch' || !heal.healedBody || !heal.healAttemptId) {
      return {
        forward: originalForward,
        record: { groupId, outcome: 'unfixable', original_http_status: status, chain },
      };
    }

    // A patch to apply: reached on `patched` (already verified) or `unverified`
    // (a fresh patch) — and any future patch-bearing status — because the guard
    // above keys off the presence of healedBody + healAttemptId, not a status
    // allow-list. Keep it that way so a new Phoenix status never silently no-ops.
    const healAttemptId = heal.healAttemptId;
    const healedBody = heal.healedBody;
    let next: ForwardResult;
    try {
      next = await params.reforward(healedBody);
    } catch (err) {
      // The patched resend threw (a provider transport error or the caller
      // aborting mid-retry, NOT a Phoenix failure — so it must not trip the
      // heal breaker). Preserve the audit chain (the original error plus the
      // Phoenix issue/patch ids already stamped on `entry`) instead of dropping
      // it, and degrade to the original provider error; the fallback chain is
      // the next safety net. Still close the evidence loop: without a report
      // the served attempt dangles `pending` until Phoenix's sweeper expires
      // it, so the death is reported as a synthetic 499 (retry never completed
      // — no provider status exists to send).
      this.logger.warn(`autofix reforward failed, using original error: ${(err as Error).message}`);
      entry.patch_worked = false;
      this.reportOutcome(
        healAttemptId,
        {
          retryStatusCode: 499,
          error: {
            message: `patched retry never completed: ${(err as Error).message}`,
            type: 'retry_not_completed',
          },
        },
        config.harness,
      );
      return {
        forward: originalForward,
        record: { groupId, outcome: 'unfixable', original_http_status: status, chain },
      };
    }
    const ok = next.response.ok;
    entry.patch_worked = ok;

    if (ok) {
      // Report the cleared retry so Phoenix can promote the patch.
      this.reportOutcome(healAttemptId, { retryStatusCode: next.response.status }, config.harness);
      chain.push({
        attempt: 1,
        origin: 'autofix',
        request: healedBody,
        http_status: next.response.status,
      });
      return {
        forward: next,
        record: { groupId, outcome: 'healed', original_http_status: status, chain },
      };
    }

    // The patch didn't clear the error. Preserve that retry as its own provider
    // attempt, report it to Phoenix, and continue with its rebuilt response so
    // fallback and terminal recording see what actually happened last.
    const retryText = await next.response.text();
    const retryError = normalizeProviderError(retryText);
    chain.push({
      attempt: 1,
      origin: 'autofix',
      request: healedBody,
      http_status: next.response.status,
      error: retryError,
    });
    this.reportOutcome(
      healAttemptId,
      {
        retryStatusCode: next.response.status,
        error: retryError,
      },
      config.harness,
    );
    return {
      forward: rebuildForward(next, retryText, next.response.status),
      record: { groupId, outcome: 'exhausted', original_http_status: status, chain },
    };
  }

  private async loadAgentConfig(agentId: string, tenantId: string): Promise<AgentAutofixConfig> {
    // Autofix enablement is the consent boundary for sending request bodies to
    // Phoenix. Read it from the database on every repairable failure so a toggle
    // handled by one replica takes effect immediately on every other replica.
    const key = `${tenantId}:${agentId}`;
    const existing = this.configLoads.get(key);
    // A request that arrives during an older read waits for the next generation.
    // This prevents a post-toggle request from joining a query that began before
    // the toggle, while all requests queued behind that query share one new read.
    const minimumGeneration = existing ? existing.generation + 1 : 0;
    return this.loadAgentConfigGeneration(agentId, tenantId, key, minimumGeneration);
  }

  private async loadAgentConfigGeneration(
    agentId: string,
    tenantId: string,
    key: string,
    minimumGeneration: number,
  ): Promise<AgentAutofixConfig> {
    const existing = this.configLoads.get(key);
    if (existing) {
      if (existing.generation >= minimumGeneration) return existing.promise;

      // The caller arrived after this generation started. Wait for it to leave
      // the slot, then create or join the next generation. Its result is ignored.
      try {
        await existing.promise;
      } catch {
        // A fresh generation below gets its own database result or error.
      }
      if (this.configLoads.get(key) === existing) this.configLoads.delete(key);
      return this.loadAgentConfigGeneration(agentId, tenantId, key, minimumGeneration);
    }

    const promise = (async (): Promise<AgentAutofixConfig> => {
      const agent = await this.agentRepo.findOne({
        where: { id: agentId, tenant_id: tenantId },
        // Select the PK alongside the flag. TypeORM's entity transformer treats a
        // row whose only selected column is NULL as "no entity" and returns null,
        // so `select: ['autofix_enabled']` alone makes every NULL-flag agent (the
        // default "inherit the mode default" state) look not-found — which then
        // resolves to `enabled: false` below and silently disables Autofix for it.
        // The always-present `id` keeps the row materialized so the NULL flag is read.
        select: ['id', 'autofix_enabled', 'agent_platform'],
      });
      // Unknown agent → off. Known agent → its explicit flag, or the mode default
      // when unset (NULL).
      return {
        enabled: agent ? this.resolveEnabled(agent.autofix_enabled) : false,
        harness: coerceAgentPlatform(agent?.agent_platform),
      };
    })();
    const load = { generation: ++this.configLoadGeneration, promise };
    this.configLoads.set(key, load);
    try {
      return await promise;
    } finally {
      if (this.configLoads.get(key) === load) this.configLoads.delete(key);
    }
  }

  /** Fire-and-forget the learning signal so it never delays the client. */
  private reportOutcome(healAttemptId: string, outcome: HealOutcome, harness: AgentPlatform): void {
    void this.deliverOutcome(healAttemptId, outcome, harness);
  }

  /**
   * Deliver the outcome report, resending when it didn't land. The client
   * resolves `null` for a report that never reached Phoenix (transport failure
   * or a non-2xx), and an unreported attempt costs the adjudication evidence —
   * Phoenix can only expire it. Spaced resends ride out a blip; only a process
   * death still loses a report.
   */
  private async deliverOutcome(
    healAttemptId: string,
    outcome: HealOutcome,
    harness: AgentPlatform,
  ): Promise<void> {
    for (let send = 0; ; send++) {
      try {
        if ((await this.client.reportOutcome(healAttemptId, outcome, { harness })) !== null) return;
      } catch (err) {
        this.logger.warn(`reportOutcome ${healAttemptId} failed: ${(err as Error).message}`);
      }
      const delay = OUTCOME_RESEND_DELAYS_MS[send];
      if (delay === undefined) {
        this.logger.warn(`reportOutcome ${healAttemptId}: giving up after ${send + 1} sends`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
