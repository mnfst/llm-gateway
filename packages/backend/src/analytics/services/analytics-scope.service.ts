import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';

/** Undefined means tenant-wide; a null ID means the selected harness is missing. */
export interface AgentScope {
  readonly tenantId: string | null;
  readonly agentName: string;
  readonly agentId: string | null;
}

/** Distinguish an empty selection from the tenant-wide cache entry. */
export function agentScopeCacheKey(scope?: AgentScope): string {
  return scope ? (scope.agentId ?? `missing:${scope.agentName}`) : '';
}

@Injectable()
export class AnalyticsScopeService {
  constructor(@InjectRepository(Agent) private readonly agentRepo: Repository<Agent>) {}

  async resolve(tenantId: string | null, agentName?: string): Promise<AgentScope | undefined> {
    if (!agentName) return undefined;
    if (!tenantId) return { tenantId, agentName, agentId: null };
    // Resolve before building aggregates so PostgreSQL can estimate from the
    // actual agent ID, rather than an unknown scalar-subquery result.
    const rows = (await this.agentRepo.query(
      'SELECT id FROM agents WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1',
      [tenantId, agentName],
    )) as Array<{ id: string }>;
    return { tenantId, agentName, agentId: rows[0]?.id ?? null };
  }
}
