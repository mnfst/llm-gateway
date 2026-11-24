import { Logger } from '@nestjs/common';
import {
  HealContractError,
  type HealingClient,
  type HealingRequestContext,
} from './healing-client';
import type { ConfirmResponse, HealOutcome, HealRequest, HealResponse } from './phoenix.types';

/** Resolves the install identity self-hosted calls announce to Phoenix. */
export type InstanceIdProvider = () => Promise<string>;

/**
 * HTTP client for Phoenix. Static API keys retain the cloud path unchanged.
 * Self-hosted clients announce the install's anonymous id on every call.
 *
 * The id is the *identifier* Phoenix keys an install's history on, not a
 * credential: it is not secret, and Phoenix creates the instance row the first
 * time it sees one. There is deliberately no registration handshake — it would
 * only have carried `version`, which already rides on every request as
 * `X-Manifest-Version`.
 */
export class HttpHealingClient implements HealingClient {
  private readonly logger = new Logger(HttpHealingClient.name);
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs: number,
    private readonly apiKey?: string,
    private readonly instanceId?: InstanceIdProvider,
    private readonly manifestVersion?: string,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  async heal(input: HealRequest, context: HealingRequestContext): Promise<HealResponse> {
    const res = await this.authenticatedFetch(
      '/api/heal',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      context,
    );
    if (!res.ok) {
      // Release the connection: an unconsumed error body keeps the socket
      // reserved in undici, which under a burst of 4xx/5xx replies would leak
      // connections instead of letting them return to the pool.
      await res.body?.cancel();
      const message = `Phoenix /api/heal responded ${res.status}`;
      if (res.status >= 400 && res.status < 500) {
        throw new HealContractError(res.status, message);
      }
      throw new Error(message);
    }
    return (await res.json()) as HealResponse;
  }

  async observe(observations: HealRequest[], context: HealingRequestContext): Promise<void> {
    if (observations.length === 0) return;
    try {
      const res = await this.authenticatedFetch(
        '/api/heal/observe',
        {
          method: 'POST',
          body: JSON.stringify({ observations }),
        },
        context,
      );
      await res.body?.cancel();
      if (!res.ok) {
        this.logger.warn(`Phoenix /api/heal/observe responded ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Phoenix /api/heal/observe failed: ${(err as Error).message}`);
    }
  }

  async reportOutcome(
    healAttemptId: string,
    outcome: HealOutcome,
    context: HealingRequestContext,
  ): Promise<ConfirmResponse | null> {
    try {
      const path = `/api/heal-attempts/${encodeURIComponent(healAttemptId)}`;
      const res = await this.authenticatedFetch(
        path,
        {
          method: 'PATCH',
          body: JSON.stringify(outcome),
        },
        context,
      );
      if (!res.ok) {
        await res.body?.cancel();
        this.logger.warn(`Phoenix heal-attempt ${healAttemptId} responded ${res.status}`);
        return null;
      }
      return (await res.json()) as ConfirmResponse;
    } catch (err) {
      this.logger.warn(`Phoenix heal-attempt ${healAttemptId} failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async authenticatedFetch(
    path: string,
    init: Omit<RequestInit, 'headers' | 'signal'>,
    context?: HealingRequestContext,
  ): Promise<Response> {
    if (this.apiKey) {
      return this.request(path, init, {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'X-Manifest-Version': this.manifestVersion ?? 'unknown',
      });
    }
    if (!this.instanceId) {
      return this.request(path, init, { 'content-type': 'application/json' });
    }
    // Typed callers always supply this; the guard only catches an untyped JS
    // caller, since a missing harness would otherwise reach Phoenix as
    // `undefined` and fail the header allowlist with a confusing 400.
    if (!context) {
      throw new Error('Autofix harness is required for instance-identified requests');
    }
    return this.request(path, init, this.instanceHeaders(await this.instanceId(), context));
  }

  private request(
    path: string,
    init: Omit<RequestInit, 'headers' | 'signal'>,
    headers: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private instanceHeaders(
    instanceId: string,
    context: HealingRequestContext,
  ): Record<string, string> {
    return {
      'content-type': 'application/json',
      'X-Manifest-Instance': instanceId,
      'X-Manifest-Version': this.manifestVersion ?? 'unknown',
      'X-Manifest-Harness': context.harness,
    };
  }
}
