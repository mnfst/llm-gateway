import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { SpecificityCategory, SPECIFICITY_CATEGORIES } from 'manifest-shared';

/**
 * Lets users mark a specificity-routed message as miscategorized. The flag
 * is aggregated per (agent, category) into a small score penalty so the
 * detector can dampen categories that keep firing on unrelated content —
 * the exact miscategorization pattern from discussion #1613.
 */
@Injectable()
export class SpecificityFeedbackService {
  private readonly logger = new Logger(SpecificityFeedbackService.name);

  /** Weight applied per prior miscategorization, capped below one strong anchor. */
  private static readonly PENALTY_PER_FLAG = 0.75;
  private static readonly PENALTY_CAP = 3;

  constructor(
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
  ) {}

  async flagMiscategorized(messageId: string, tenantId: string | null): Promise<void> {
    const message = await this.findOwnedMessage(messageId, tenantId);
    if (!message.specificity_category) {
      throw new NotFoundException('Message was not routed by specificity');
    }
    await this.messageRepo.update(message.id, { specificity_miscategorized: true });
  }

  async clearFlag(messageId: string, tenantId: string | null): Promise<void> {
    const message = await this.findOwnedMessage(messageId, tenantId);
    await this.messageRepo.update(message.id, { specificity_miscategorized: false });
  }

  /**
   * Fetch per-category score penalty for an agent. Uses the tenant/agent keys
   * directly (not session-scoped) so flagging earlier today affects routing
   * tomorrow. Capped so a single angry user doesn't fully disable a category —
   * a bad category can still win with enough current-turn signal.
   */
  async getPenaltiesForAgent(
    tenantId: string | null | undefined,
    agentId: string | null | undefined,
  ): Promise<Map<SpecificityCategory, number>> {
    const penalties = new Map<SpecificityCategory, number>();
    if (!agentId) return penalties;

    const qb = this.messageRepo
      .createQueryBuilder('m')
      .select('m.specificity_category', 'category')
      .addSelect('COUNT(*)::int', 'count')
      .where('m.specificity_miscategorized = true')
      .andWhere('m.specificity_category IS NOT NULL')
      .andWhere('m.agent_id = :agentId', { agentId })
      .groupBy('m.specificity_category');
    if (tenantId) qb.andWhere('m.tenant_id = :tenantId', { tenantId });

    const rows = await qb.getRawMany<{ category: string; count: number }>();
    for (const row of rows) {
      if (!(SPECIFICITY_CATEGORIES as readonly string[]).includes(row.category)) continue;
      const penalty = Math.min(
        row.count * SpecificityFeedbackService.PENALTY_PER_FLAG,
        SpecificityFeedbackService.PENALTY_CAP,
      );
      if (penalty > 0) {
        penalties.set(row.category as SpecificityCategory, penalty);
      }
    }
    return penalties;
  }

  private async findOwnedMessage(
    messageId: string,
    tenantId: string | null,
  ): Promise<AgentMessage> {
    // No tenant → no messages, so any id is unknown.
    if (!tenantId) throw new NotFoundException('Message not found');
    const message = await this.messageRepo
      .createQueryBuilder('m')
      .where('m.id = :id', { id: messageId })
      .andWhere('m.tenant_id = :tenantId', { tenantId })
      .getOne();
    if (message) return message;
    const requestQb = this.messageRepo.createQueryBuilder('m');
    if (!requestQb) throw new NotFoundException('Message not found');
    const requestAttempt = await requestQb
      .where('m.request_id = :requestId', { requestId: messageId })
      .andWhere('m.tenant_id = :tenantId', { tenantId })
      .andWhere('m.specificity_category IS NOT NULL')
      .getOne();
    if (!requestAttempt) throw new NotFoundException('Message not found');
    return requestAttempt;
  }
}
