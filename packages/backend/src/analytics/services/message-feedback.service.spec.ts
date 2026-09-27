import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { MessageFeedbackService } from './message-feedback.service';
import { AgentMessage } from '../../entities/agent-message.entity';

function mockQb(result: unknown = null) {
  const qb: Record<string, jest.Mock> = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  };
  return qb;
}

describe('MessageFeedbackService', () => {
  let service: MessageFeedbackService;
  let mockUpdate: jest.Mock;
  let msgQb: ReturnType<typeof mockQb>;

  const baseMessage = {
    id: 'msg-1',
    tenant_id: 'tenant-123',
  };

  beforeEach(async () => {
    mockUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    msgQb = mockQb(baseMessage);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageFeedbackService,
        {
          provide: getRepositoryToken(AgentMessage),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(msgQb),
            update: mockUpdate,
          },
        },
      ],
    }).compile();

    service = module.get<MessageFeedbackService>(MessageFeedbackService);
  });

  describe('setFeedback', () => {
    it('updates feedback columns with rating only', async () => {
      await service.setFeedback('msg-1', 'tenant-123', 'like');

      expect(mockUpdate).toHaveBeenCalledWith('msg-1', {
        feedback_rating: 'like',
        feedback_tags: null,
        feedback_details: null,
      });
    });

    it('updates feedback with tags and details', async () => {
      await service.setFeedback(
        'msg-1',
        'tenant-123',
        'dislike',
        ['Too slow', 'Buggy'],
        'Very slow',
      );

      expect(mockUpdate).toHaveBeenCalledWith('msg-1', {
        feedback_rating: 'dislike',
        feedback_tags: 'Too slow,Buggy',
        feedback_details: 'Very slow',
      });
    });

    it('stores null tags when empty array provided', async () => {
      await service.setFeedback('msg-1', 'tenant-123', 'dislike', [], 'No tags');

      expect(mockUpdate).toHaveBeenCalledWith('msg-1', {
        feedback_rating: 'dislike',
        feedback_tags: null,
        feedback_details: 'No tags',
      });
    });

    it('filters by tenantId when tenant exists', async () => {
      await service.setFeedback('msg-1', 'tenant-123', 'like');

      expect(msgQb.andWhere).toHaveBeenCalledWith('m.tenant_id = :tenantId', {
        tenantId: 'tenant-123',
      });
    });

    it('throws NotFoundException when tenant is null (no tenant scope)', async () => {
      await expect(service.setFeedback('msg-1', null, 'like')).rejects.toThrow(NotFoundException);
      expect(msgQb.andWhere).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when message not found', async () => {
      msgQb.getOne.mockResolvedValue(null);

      await expect(service.setFeedback('not-found', 'tenant-123', 'like')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('clearFeedback', () => {
    it('sets all feedback columns to null', async () => {
      await service.clearFeedback('msg-1', 'tenant-123');

      expect(mockUpdate).toHaveBeenCalledWith('msg-1', {
        feedback_rating: null,
        feedback_tags: null,
        feedback_details: null,
      });
    });

    it('throws NotFoundException when message not found', async () => {
      msgQb.getOne.mockResolvedValue(null);

      await expect(service.clearFeedback('not-found', 'tenant-123')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('verifies ownership before clearing', async () => {
      await service.clearFeedback('msg-1', 'tenant-123');

      expect(msgQb.where).toHaveBeenCalledWith('m.id = :id', { id: 'msg-1' });
      expect(msgQb.andWhere).toHaveBeenCalled();
    });
  });

  describe('request-first storage', () => {
    it('stores feedback on an explicit request', async () => {
      const requestUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      const requestRepo = {
        findOne: jest.fn().mockResolvedValue({ id: 'req-1', tenant_id: 'tenant-123' }),
        update: requestUpdate,
      };
      const messageRepo = {
        createQueryBuilder: jest.fn(),
        update: jest.fn(),
      };
      const requestService = new MessageFeedbackService(messageRepo as never, requestRepo as never);

      await requestService.setFeedback('req-1', 'tenant-123', 'like');

      expect(requestUpdate).toHaveBeenCalledWith('req-1', {
        feedback_rating: 'like',
        feedback_tags: null,
        feedback_details: null,
      });
      expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('stores feedback on an unlinked attempt exposed as a synthetic request', async () => {
      const attemptQb = mockQb({ id: 'attempt-1', tenant_id: 'tenant-123', request_id: null });
      const attemptUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      const requestRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      };
      const messageRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(attemptQb),
        update: attemptUpdate,
      };
      const requestService = new MessageFeedbackService(messageRepo as never, requestRepo as never);

      await requestService.setFeedback('attempt-1', 'tenant-123', 'dislike', ['Too slow']);

      expect(attemptUpdate).toHaveBeenCalledWith('attempt-1', {
        feedback_rating: 'dislike',
        feedback_tags: 'Too slow',
        feedback_details: null,
      });
    });

    it('resolves a linked attempt detail id to its parent request', async () => {
      const attemptQb = mockQb({
        id: 'attempt-1',
        tenant_id: 'tenant-123',
        request_id: 'req-1',
      });
      const requestUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      const requestRepo = {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'req-1', tenant_id: 'tenant-123' }),
        update: requestUpdate,
      };
      const messageRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(attemptQb),
        update: jest.fn(),
      };
      const requestService = new MessageFeedbackService(messageRepo as never, requestRepo as never);

      await requestService.setFeedback('attempt-1', 'tenant-123', 'like');

      expect(requestRepo.findOne).toHaveBeenLastCalledWith({
        where: { id: 'req-1', tenant_id: 'tenant-123' },
      });
      expect(requestUpdate).toHaveBeenCalledWith('req-1', {
        feedback_rating: 'like',
        feedback_tags: null,
        feedback_details: null,
      });
      expect(messageRepo.update).not.toHaveBeenCalled();
    });

    it('clears feedback on an explicit request', async () => {
      const requestUpdate = jest.fn().mockResolvedValue({ affected: 1 });
      const requestService = new MessageFeedbackService(
        { createQueryBuilder: jest.fn(), update: jest.fn() } as never,
        {
          findOne: jest.fn().mockResolvedValue({ id: 'req-1', tenant_id: 'tenant-123' }),
          update: requestUpdate,
        } as never,
      );

      await requestService.clearFeedback('req-1', 'tenant-123');

      expect(requestUpdate).toHaveBeenCalledWith('req-1', {
        feedback_rating: null,
        feedback_tags: null,
        feedback_details: null,
      });
    });

    it('rejects a linked attempt whose parent is outside the tenant', async () => {
      const attemptQb = mockQb({
        id: 'attempt-1',
        tenant_id: 'tenant-123',
        request_id: 'req-missing',
      });
      const requestService = new MessageFeedbackService(
        { createQueryBuilder: jest.fn(() => attemptQb), update: jest.fn() } as never,
        { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() } as never,
      );

      await expect(requestService.setFeedback('attempt-1', 'tenant-123', 'like')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does not query request ownership without a tenant', async () => {
      const requestRepo = { findOne: jest.fn(), update: jest.fn() };
      const requestService = new MessageFeedbackService({} as never, requestRepo as never);

      await expect((requestService as any).findOwnedRequest('req-1', null)).resolves.toBeNull();
      expect(requestRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
