import { NotFoundException } from '@nestjs/common';
import { SpecificityFeedbackService } from './specificity-feedback.service';
import type { Repository } from 'typeorm';
import type { AgentMessage } from '../../entities/agent-message.entity';

describe('SpecificityFeedbackService', () => {
  let service: SpecificityFeedbackService;
  let messageRepo: {
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
  };

  function setOwnedMessage(message: Partial<AgentMessage> | null) {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(message),
    };
    messageRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  beforeEach(() => {
    messageRepo = {
      createQueryBuilder: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    service = new SpecificityFeedbackService(messageRepo as unknown as Repository<AgentMessage>);
  });

  describe('flagMiscategorized', () => {
    it('sets the flag on a specificity-routed owned message', async () => {
      setOwnedMessage({ id: 'msg-1', specificity_category: 'web_browsing' });

      await service.flagMiscategorized('msg-1', 'tenant-1');

      expect(messageRepo.update).toHaveBeenCalledWith('msg-1', {
        specificity_miscategorized: true,
      });
    });

    it('rejects messages that were not routed by specificity', async () => {
      setOwnedMessage({ id: 'msg-1', specificity_category: null });

      await expect(service.flagMiscategorized('msg-1', 'tenant-1')).rejects.toThrow(
        'Message was not routed by specificity',
      );
      expect(messageRepo.update).not.toHaveBeenCalled();
    });

    it('throws 404 when the message is not owned by the tenant', async () => {
      setOwnedMessage(null);

      await expect(service.flagMiscategorized('msg-1', 'tenant-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('accepts a request id by resolving one of its specificity attempts', async () => {
      setOwnedMessage(null);
      setOwnedMessage({
        id: 'attempt-1',
        request_id: 'request-1',
        specificity_category: 'coding',
      });

      await service.flagMiscategorized('request-1', 'tenant-1');

      expect(messageRepo.update).toHaveBeenCalledWith('attempt-1', {
        specificity_miscategorized: true,
      });
    });

    it('throws when neither a message nor a request attempt exists', async () => {
      setOwnedMessage(null);
      setOwnedMessage(null);

      await expect(service.flagMiscategorized('missing', 'tenant-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('scopes the ownership lookup by tenant_id', async () => {
      const qb = setOwnedMessage({ id: 'msg-1', specificity_category: 'coding' });

      await service.flagMiscategorized('msg-1', 'tenant-1');

      expect(qb.andWhere).toHaveBeenCalledWith('m.tenant_id = :tenantId', { tenantId: 'tenant-1' });
    });

    it('throws 404 without querying when the tenant is null', async () => {
      await expect(service.flagMiscategorized('msg-1', null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('clearFlag', () => {
    it('clears the flag on an owned message', async () => {
      setOwnedMessage({ id: 'msg-1', specificity_category: 'web_browsing' });

      await service.clearFlag('msg-1', 'tenant-1');

      expect(messageRepo.update).toHaveBeenCalledWith('msg-1', {
        specificity_miscategorized: false,
      });
    });
  });

  describe('getPenaltiesForAgent', () => {
    function setRawMany(rows: { category: string; count: number }[]) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      messageRepo.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    it('aggregates flag counts into per-category penalties', async () => {
      setRawMany([
        { category: 'web_browsing', count: 2 },
        { category: 'coding', count: 1 },
      ]);

      const penalties = await service.getPenaltiesForAgent('tenant-1', 'agent-1');

      expect(penalties.get('web_browsing')).toBeCloseTo(1.5);
      expect(penalties.get('coding')).toBeCloseTo(0.75);
    });

    it('caps penalties so a category can never be fully disabled', async () => {
      setRawMany([{ category: 'web_browsing', count: 100 }]);

      const penalties = await service.getPenaltiesForAgent('tenant-1', 'agent-1');

      expect(penalties.get('web_browsing')).toBe(3);
    });

    it('ignores unknown category values', async () => {
      setRawMany([{ category: 'not_a_category', count: 10 }]);

      const penalties = await service.getPenaltiesForAgent('tenant-1', 'agent-1');

      expect(penalties.size).toBe(0);
    });

    it('returns empty when no agentId is supplied', async () => {
      const penalties = await service.getPenaltiesForAgent('tenant-1', null);

      expect(penalties.size).toBe(0);
      expect(messageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
