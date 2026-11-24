import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';

const TTL_MS = 120_000; // 2 minutes
const MAX_ENTRIES = 5_000;

interface CachedAgent {
  agent: Agent;
  expiresAt: number;
}

export interface ResolveOptions {
  /** When true, playground agents (is_playground = true) are returned to the caller.
   * By default playground agents are rejected with a NotFoundException so that
   * generic mutation/config endpoints cannot target the reserved "Playground"
   * agent. Only pass true for read-only endpoints that legitimately need to
   * serve the Playground agent (e.g. available-models, providers list). */
  allowPlayground?: boolean;
}

@Injectable()
export class ResolveAgentService {
  private readonly cache = new Map<string, CachedAgent>();

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
  ) {}

  async resolve(
    tenantId: string | null,
    agentName: string,
    options: ResolveOptions = {},
  ): Promise<Agent> {
    if (!tenantId) throw new NotFoundException('Tenant not found');

    const cacheKey = `${tenantId}:${agentName}`;
    const cached = this.cache.get(cacheKey);

    // If we have a live cache entry, validate is_playground before returning it.
    // This ensures the check runs on cache hits as well as fresh DB loads.
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.agent.is_playground && !options.allowPlayground) {
        throw new NotFoundException(`Agent "${agentName}" not found`);
      }
      return cached.agent;
    }
    if (cached) this.cache.delete(cacheKey);

    const agent = await this.agentRepo.findOne({
      where: { tenant_id: tenantId, name: agentName, deleted_at: IsNull() },
    });
    if (!agent) throw new NotFoundException(`Agent "${agentName}" not found`);

    // Reject playground agents unless the caller explicitly opted in.
    if (agent.is_playground && !options.allowPlayground) {
      throw new NotFoundException(`Agent "${agentName}" not found`);
    }

    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(cacheKey)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(cacheKey, { agent, expiresAt: Date.now() + TTL_MS });
    return agent;
  }

  invalidate(tenantId: string, agentName: string): void {
    this.cache.delete(`${tenantId}:${agentName}`);
  }

  /** Invalidate every agent of a tenant (used after a workspace-wide backfill). */
  invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}
