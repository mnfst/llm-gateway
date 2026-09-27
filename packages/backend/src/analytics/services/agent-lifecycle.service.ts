import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { ResolveAgentService } from '../../routing/routing-core/resolve-agent.service';
import { RoutingCacheService } from '../../routing/routing-core/routing-cache.service';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';

@Injectable()
export class AgentLifecycleService {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    private readonly dataSource: DataSource,
    private readonly resolveAgent: ResolveAgentService,
    private readonly routingCache: RoutingCacheService,
    private readonly otlpAuthGuard: AgentKeyAuthGuard,
  ) {}

  async findAgentInfo(
    tenantId: string | null,
    agentName: string,
  ): Promise<{
    agent_name: string;
    display_name: string;
    agent_category: string | null;
    agent_platform: string | null;
  } | null> {
    const agent = await this.findAgentByTenant(tenantId, agentName);
    if (!agent) return null;
    return {
      agent_name: agent.name,
      display_name: agent.display_name ?? agent.name,
      agent_category: agent.agent_category ?? null,
      agent_platform: agent.agent_platform ?? null,
    };
  }

  async deleteAgent(tenantId: string | null, agentName: string): Promise<void> {
    const agent = await this.findAgentByTenant(tenantId, agentName);

    if (!agent) {
      throw new NotFoundException(`Agent "${agentName}" not found`);
    }

    const { id: agentId, tenant_id: agentTenantId } = agent;

    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update('agents')
        .set({ deleted_at: () => 'NOW()', is_active: false })
        .where('id = :id', { id: agentId })
        .execute();

      // Disable the OTLP key so old credentials stop ingesting against the
      // soft-deleted agent (decision: reject 401 on deleted-agent keys).
      await manager
        .createQueryBuilder()
        .update('agent_api_keys')
        .set({ is_active: false })
        .where('agent_id = :id', { id: agentId })
        .execute();
    });

    this.resolveAgent.invalidate(agentTenantId, agentName);
    this.routingCache.invalidateAgent(agentId);
    this.otlpAuthGuard.clearCache();
  }

  private async findAgentByTenant(tenantId: string | null, agentName: string) {
    // No tenant yet (fresh account) → no agents.
    if (!tenantId) return null;
    return this.agentRepo
      .createQueryBuilder('a')
      .where('a.tenant_id = :tenantId', { tenantId })
      .andWhere('a.name = :agentName', { agentName })
      .andWhere('a.deleted_at IS NULL')
      .andWhere('a.is_playground = false')
      .getOne();
  }

  async updateAgentType(
    tenantId: string | null,
    agentName: string,
    fields: { agent_category?: string; agent_platform?: string },
  ): Promise<void> {
    const agent = await this.findAgentByTenant(tenantId, agentName);
    if (!agent) throw new NotFoundException(`Agent "${agentName}" not found`);

    const update: Record<string, unknown> = {};
    if (fields.agent_category !== undefined) update['agent_category'] = fields.agent_category;
    if (fields.agent_platform !== undefined) update['agent_platform'] = fields.agent_platform;
    if (Object.keys(update).length === 0) return;

    await this.agentRepo
      .createQueryBuilder()
      .update('agents')
      .set(update)
      .where('id = :id', { id: agent.id })
      .execute();
  }

  async renameAgent(
    tenantId: string | null,
    currentName: string,
    newName: string,
    displayName?: string,
  ): Promise<void> {
    const agent = await this.findAgentByTenant(tenantId, currentName);

    if (!agent) {
      throw new NotFoundException(`Agent "${currentName}" not found`);
    }

    // If only display_name changes (same slug), short-circuit
    if (newName === currentName) {
      if (displayName !== undefined) {
        await this.agentRepo
          .createQueryBuilder()
          .update('agents')
          .set({ display_name: displayName })
          .where('id = :id', { id: agent.id })
          .execute();
      }
      return;
    }

    const duplicate = await this.agentRepo
      .createQueryBuilder('a')
      .where('a.tenant_id = :tenantId', { tenantId: agent.tenant_id })
      .andWhere('a.name = :newName', { newName })
      .andWhere('a.deleted_at IS NULL')
      .getOne();

    if (duplicate) {
      throw new ConflictException(`Agent "${newName}" already exists`);
    }

    await this.dataSource.transaction(async (manager) => {
      const agentUpdate: Record<string, unknown> = { name: newName };
      if (displayName !== undefined) agentUpdate['display_name'] = displayName;

      await manager
        .createQueryBuilder()
        .update('agents')
        .set(agentUpdate)
        .where('id = :id', { id: agent.id })
        .execute();

      // Scope all denormalised agent_name columns by tenant_id so we don't
      // rewrite rows belonging to other tenants that happen to share the slug.
      const tenantScoped = ['agent_messages', 'requests', 'notification_rules'] as const;
      await Promise.all(
        tenantScoped.map((table) =>
          manager
            .createQueryBuilder()
            .update(table)
            .set({ agent_name: newName })
            .where('tenant_id = :tenantId AND agent_name = :currentName', {
              tenantId: agent.tenant_id,
              currentName,
            })
            .execute(),
        ),
      );

      // notification_logs has no tenant_id; scope by rule_id of rules that
      // belong to this tenant. notification_rules were already renamed above,
      // so we still match the target rules via tenant_id + the NEW name.
      await manager.query(
        `UPDATE notification_logs SET agent_name = $1
         WHERE rule_id IN (
           SELECT id FROM notification_rules
           WHERE tenant_id = $2 AND agent_name = $1
         )`,
        [newName, agent.tenant_id],
      );
    });
  }
}
