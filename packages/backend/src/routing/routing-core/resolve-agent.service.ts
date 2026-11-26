import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { RoutingCacheSyncService } from './routing-cache-sync.service';

export interface ResolveOptions {
  /** When true, playground agents (is_playground = true) are returned to the caller.
   * By default playground agents are rejected with a NotFoundException so that
   * generic mutation/config endpoints cannot target the reserved "Playground"
   * agent. Only pass true for read-only endpoints that legitimately need to
   * serve the Playground agent (e.g. available-models, providers list). */
  allowPlayground?: boolean;
}

/**
 * Resolves an agent name to its row for the management surfaces (dashboard,
 * CLI, MCP). Deliberately uncached: callers read mutable settings off the row
 * (complexity routing, Autofix), and a per-process copy went stale on every
 * other instance after a write. The lookup is one indexed query.
 */
@Injectable()
export class ResolveAgentService {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    private readonly cacheSync: RoutingCacheSyncService,
  ) {}

  async resolve(
    tenantId: string | null,
    agentName: string,
    options: ResolveOptions = {},
  ): Promise<Agent> {
    if (!tenantId) throw new NotFoundException('Tenant not found');

    // Every routing read on these surfaces starts here, so this is where the
    // instance applies invalidations published by the others: the routing
    // caches it reads next reflect writes made on any instance.
    const [agent] = await Promise.all([
      this.agentRepo.findOne({
        where: { tenant_id: tenantId, name: agentName, deleted_at: IsNull() },
      }),
      this.cacheSync.catchUp(),
    ]);
    if (!agent) throw new NotFoundException(`Agent "${agentName}" not found`);

    // Reject playground agents unless the caller explicitly opted in.
    if (agent.is_playground && !options.allowPlayground) {
      throw new NotFoundException(`Agent "${agentName}" not found`);
    }
    return agent;
  }
}
