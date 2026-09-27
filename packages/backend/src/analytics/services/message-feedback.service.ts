import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { ManifestRequest } from '../../entities/request.entity';

@Injectable()
export class MessageFeedbackService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    @Optional()
    @InjectRepository(ManifestRequest)
    private readonly requestRepo?: Repository<ManifestRequest>,
  ) {}

  async setFeedback(
    messageId: string,
    tenantId: string | null,
    rating: string,
    tags?: string[],
    details?: string,
  ): Promise<void> {
    const target = await this.findFeedbackTarget(messageId, tenantId);
    const feedback = {
      feedback_rating: rating,
      feedback_tags: tags?.length ? tags.join(',') : null,
      feedback_details: details ?? null,
    };
    if (target.request) {
      await this.requestRepo!.update(target.request.id, feedback);
    } else {
      await this.messageRepo.update(target.message!.id, feedback);
    }
  }

  async clearFeedback(messageId: string, tenantId: string | null): Promise<void> {
    const target = await this.findFeedbackTarget(messageId, tenantId);
    const feedback = {
      feedback_rating: null,
      feedback_tags: null,
      feedback_details: null,
    };
    if (target.request) {
      await this.requestRepo!.update(target.request.id, feedback);
    } else {
      await this.messageRepo.update(target.message!.id, feedback);
    }
  }

  private async findFeedbackTarget(
    messageId: string,
    tenantId: string | null,
  ): Promise<{ request: ManifestRequest | null; message: AgentMessage | null }> {
    if (!tenantId) throw new NotFoundException('Message not found');
    if (this.requestRepo) {
      const request = await this.findOwnedRequest(messageId, tenantId);
      if (request) return { request, message: null };
    }

    const message = await this.findOwnedMessage(messageId, tenantId);
    if (this.requestRepo && message.request_id) {
      const request = await this.findOwnedRequest(message.request_id, tenantId);
      if (!request) throw new NotFoundException('Message not found');
      return { request, message: null };
    }
    return { request: null, message };
  }

  private async findOwnedRequest(
    requestId: string,
    tenantId: string | null,
  ): Promise<ManifestRequest | null> {
    if (!tenantId) return null;
    return this.requestRepo!.findOne({
      where: { id: requestId, tenant_id: tenantId },
    });
  }

  private async findOwnedMessage(
    messageId: string,
    tenantId: string | null,
  ): Promise<AgentMessage> {
    // No tenant → no messages, so any id is unknown.
    if (!tenantId) throw new NotFoundException('Message not found');
    const qb = this.messageRepo
      .createQueryBuilder('m')
      .where('m.id = :id', { id: messageId })
      .andWhere('m.tenant_id = :tenantId', { tenantId });
    const message = await qb.getOne();
    if (!message) throw new NotFoundException('Message not found');
    return message;
  }
}
