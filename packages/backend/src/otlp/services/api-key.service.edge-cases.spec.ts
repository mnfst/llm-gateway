import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { ApiKeyGeneratorService } from './api-key.service';
import { Tenant } from '../../entities/tenant.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentApiKey } from '../../entities/agent-api-key.entity';
import { AgentKeyAuthGuard } from '../guards/agent-key-auth.guard';

jest.mock('uuid', () => ({ v4: jest.fn() }));
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: jest.fn(),
  };
});

const TEST_SECRET = 'a'.repeat(32);
jest.mock('../../common/utils/crypto.util', () => {
  const actual = jest.requireActual('../../common/utils/crypto.util');
  return {
    ...actual,
    getEncryptionSecret: () => TEST_SECRET,
    getDecryptionSecrets: () => [TEST_SECRET],
  };
});

import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';

const mockedUuidv4 = uuidv4 as jest.Mock;
const mockedRandomBytes = randomBytes as jest.Mock;

describe('ApiKeyGeneratorService — edge cases', () => {
  let service: ApiKeyGeneratorService;
  let mockTenantFindOne: jest.Mock;
  let mockTenantInsert: jest.Mock;
  let mockAgentInsert: jest.Mock;
  let mockKeyInsert: jest.Mock;
  let mockKeyDelete: jest.Mock;
  let mockKeyGetOne: jest.Mock;
  let mockKeyQb: Record<string, jest.Mock>;
  let mockAgentGetOne: jest.Mock;
  let mockAgentQb: Record<string, jest.Mock>;
  let mockClearCache: jest.Mock;

  beforeEach(async () => {
    mockTenantFindOne = jest.fn();
    mockTenantInsert = jest.fn().mockResolvedValue({});
    mockAgentInsert = jest.fn().mockResolvedValue({});
    mockKeyInsert = jest.fn().mockResolvedValue({});
    mockKeyDelete = jest.fn().mockResolvedValue({});
    mockKeyGetOne = jest.fn();
    mockAgentGetOne = jest.fn();
    mockClearCache = jest.fn();

    mockKeyQb = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: mockKeyGetOne,
    };

    mockAgentQb = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: mockAgentGetOne,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyGeneratorService,
        {
          provide: getRepositoryToken(Tenant),
          useValue: { findOne: mockTenantFindOne, insert: mockTenantInsert },
        },
        {
          provide: getRepositoryToken(Agent),
          useValue: {
            insert: mockAgentInsert,
            createQueryBuilder: jest.fn().mockReturnValue(mockAgentQb),
          },
        },
        {
          provide: getRepositoryToken(AgentApiKey),
          useValue: {
            insert: mockKeyInsert,
            delete: mockKeyDelete,
            createQueryBuilder: jest.fn().mockReturnValue(mockKeyQb),
          },
        },
        {
          provide: AgentKeyAuthGuard,
          useValue: { clearCache: mockClearCache },
        },
      ],
    }).compile();

    service = module.get<ApiKeyGeneratorService>(ApiKeyGeneratorService);

    mockedUuidv4.mockReset();
    mockedRandomBytes.mockReset();
    mockedRandomBytes.mockReturnValue(Buffer.from('a'.repeat(32), 'utf8'));
    mockedUuidv4
      .mockReturnValueOnce('uuid-tenant-1')
      .mockReturnValueOnce('uuid-agent-1')
      .mockReturnValueOnce('uuid-key-1');
  });

  // ──────────────────────────────────────────────
  // onboardAgent — duplicate / constraint violations
  // ──────────────────────────────────────────────

  describe('onboardAgent duplicates and constraints', () => {
    const defaultParams = { ownerUserId: 'user-42', agentName: 'my-agent' };

    it('should propagate unique constraint violation when same agent name re-onboarded', async () => {
      mockTenantFindOne.mockResolvedValue({
        id: 'existing-tenant-id',
        owner_user_id: 'user-42',
      });
      const constraintError = new Error('duplicate key value violates unique constraint');
      constraintError.name = 'QueryFailedError';
      mockAgentInsert.mockRejectedValueOnce(constraintError);

      await expect(service.onboardAgent(defaultParams)).rejects.toThrow(
        'duplicate key value violates unique constraint',
      );
    });

    it('should not insert API key when agent insert fails with unique constraint', async () => {
      mockTenantFindOne.mockResolvedValue({
        id: 'existing-tenant-id',
        owner_user_id: 'user-42',
      });
      mockAgentInsert.mockRejectedValueOnce(new Error('duplicate key'));

      await expect(service.onboardAgent(defaultParams)).rejects.toThrow();
      expect(mockKeyInsert).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // onboardAgent — agentCategory + agentPlatform
  // ──────────────────────────────────────────────

  describe('onboardAgent optional category and platform', () => {
    const defaultParams = { ownerUserId: 'user-42', agentName: 'my-agent' };

    it('should store agentCategory and agentPlatform when provided', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({
        ...defaultParams,
        agentCategory: 'coding',
        agentPlatform: 'openclaw',
      });

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_category: 'coding',
          agent_platform: 'openclaw',
        }),
      );
    });

    it('should default agent_category to null when omitted', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({ agent_category: null }),
      );
    });

    it('should default agent_platform to null when omitted', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({ agent_platform: null }),
      );
    });
  });

  // ──────────────────────────────────────────────
  // getKeyForAgent — soft-delete filter + cross-tenant
  // ──────────────────────────────────────────────

  describe('getKeyForAgent isolation and soft-delete', () => {
    it('should apply deleted_at IS NULL filter (soft-delete)', async () => {
      mockKeyGetOne.mockResolvedValue({ key_prefix: 'mnfst_xxx' });

      await service.getKeyForAgent('tenant-99', 'bot-x');

      expect(mockKeyQb.andWhere).toHaveBeenCalledWith('a.deleted_at IS NULL');
    });

    it('should throw NotFoundException when wrong tenantId for valid agent (cross-tenant)', async () => {
      // Wrong tenantId for an agent that exists under a different tenant — the
      // tenant_id filter forces a null result, never a leak.
      mockKeyGetOne.mockResolvedValue(null);

      await expect(service.getKeyForAgent('attacker-tenant', 'agent-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockKeyQb.where).toHaveBeenCalledWith('a.tenant_id = :tenantId', {
        tenantId: 'attacker-tenant',
      });
    });
  });

  // ──────────────────────────────────────────────
  // rotateKey — soft-delete + cross-tenant
  // ──────────────────────────────────────────────

  describe('rotateKey isolation and soft-delete', () => {
    it('should apply deleted_at IS NULL filter when looking up agent', async () => {
      mockAgentGetOne.mockResolvedValue({
        id: 'agent-id-1',
        name: 'my-agent',
        tenant_id: 'tenant-id-1',
      });

      await service.rotateKey('tenant-1', 'my-agent');

      expect(mockAgentQb.andWhere).toHaveBeenCalledWith('a.deleted_at IS NULL');
    });

    it('should throw NotFoundException when cross-tenant tenantId does not own the agent', async () => {
      // Wrong tenant trying to rotate someone else's agent — query returns null.
      mockAgentGetOne.mockResolvedValue(null);

      await expect(service.rotateKey('attacker-tenant', 'someone-elses-agent')).rejects.toThrow(
        NotFoundException,
      );
      // Ensure we never deleted the key for an agent we couldn't look up.
      expect(mockKeyDelete).not.toHaveBeenCalled();
      expect(mockClearCache).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // onboardAgent + rotateKey — empty / whitespace inputs
  // ──────────────────────────────────────────────

  describe('input edge cases (empty strings)', () => {
    it('should throw NotFoundException when ownerUserId is an empty string (treated as no owner)', async () => {
      // An empty ownerUserId is falsy, so the service has no tenant to resolve
      // and refuses to onboard rather than silently creating an ownerless
      // tenant. Pins this so a regression that swallowed empty owners is caught.
      mockTenantFindOne.mockResolvedValue(null);

      await expect(
        service.onboardAgent({ ownerUserId: '', agentName: 'my-agent' }),
      ).rejects.toThrow(NotFoundException);

      expect(mockTenantFindOne).not.toHaveBeenCalled();
      expect(mockTenantInsert).not.toHaveBeenCalled();
    });

    it('should pass empty agentName through to agent insert', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({ ownerUserId: 'user-42', agentName: '' });

      expect(mockAgentInsert).toHaveBeenCalledWith(expect.objectContaining({ name: '' }));
      // Label still concatenates even for empty agent name.
      expect(mockKeyInsert).toHaveBeenCalledWith(expect.objectContaining({ label: ' ingest key' }));
    });

    it('rotateKey should throw NotFoundException when called with empty agentName', async () => {
      mockAgentGetOne.mockResolvedValue(null);

      await expect(service.rotateKey('tenant-1', '')).rejects.toThrow(NotFoundException);
      expect(mockAgentQb.where).toHaveBeenCalledWith('a.name = :agentName', {
        agentName: '',
      });
    });

    it('rotateKey should throw NotFoundException when called with empty tenantId', async () => {
      mockAgentGetOne.mockResolvedValue(null);

      await expect(service.rotateKey('', 'my-agent')).rejects.toThrow(NotFoundException);
      expect(mockAgentQb.andWhere).toHaveBeenCalledWith('a.tenant_id = :tenantId', {
        tenantId: '',
      });
    });
  });
});
