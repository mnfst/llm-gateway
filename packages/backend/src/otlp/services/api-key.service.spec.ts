import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { ApiKeyGeneratorService } from './api-key.service';
import { Tenant } from '../../entities/tenant.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentApiKey } from '../../entities/agent-api-key.entity';
import { AgentKeyAuthGuard } from '../guards/agent-key-auth.guard';
import { keyPrefix, verifyKey } from '../../common/utils/hash.util';
import { decrypt } from '../../common/utils/crypto.util';
import { API_KEY_PREFIX } from '../../common/constants/api-key.constants';

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

describe('API_KEY_PREFIX constant', () => {
  it('equals mnfst_ (catches accidental revert)', () => {
    expect(API_KEY_PREFIX).toBe('mnfst_');
  });
});

describe('ApiKeyGeneratorService', () => {
  let service: ApiKeyGeneratorService;
  let mockTenantFindOne: jest.Mock;
  let mockTenantInsert: jest.Mock;
  let mockAgentInsert: jest.Mock;
  let mockKeyInsert: jest.Mock;
  let mockKeyUpdate: jest.Mock;
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
    mockKeyUpdate = jest.fn().mockResolvedValue({});
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
          useValue: {
            findOne: mockTenantFindOne,
            insert: mockTenantInsert,
          },
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
            update: mockKeyUpdate,
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

    // Reset module-level mocks before configuring
    mockedUuidv4.mockReset();
    mockedRandomBytes.mockReset();

    // Default: randomBytes returns a deterministic buffer
    mockedRandomBytes.mockReturnValue(Buffer.from('a'.repeat(32), 'utf8'));
    // Default: sequential UUIDs for the new-tenant path
    // Order: tenantId, agentId, keyId
    mockedUuidv4
      .mockReturnValueOnce('uuid-tenant-1')
      .mockReturnValueOnce('uuid-agent-1')
      .mockReturnValueOnce('uuid-key-1');
  });

  // ──────────────────────────────────────────────
  // onboardAgent
  // ──────────────────────────────────────────────

  describe('onboardAgent', () => {
    const defaultParams = {
      ownerUserId: 'user-42',
      agentName: 'my-agent',
    };

    it('should create a new tenant when none exists for the owner', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockTenantFindOne).toHaveBeenCalledWith({
        where: { owner_user_id: 'user-42' },
      });
      expect(mockTenantInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'uuid-tenant-1',
          name: 'user-42',
          owner_user_id: 'user-42',
          is_active: true,
        }),
      );
    });

    it('should reuse the existing tenant owned by the user', async () => {
      mockTenantFindOne.mockResolvedValue({
        id: 'existing-tenant-id',
        owner_user_id: 'user-42',
      });

      const result = await service.onboardAgent(defaultParams);

      expect(mockTenantInsert).not.toHaveBeenCalled();
      expect(result.tenantId).toBe('existing-tenant-id');
    });

    it('should use a provided tenantId directly without resolving an owner', async () => {
      const result = await service.onboardAgent({
        tenantId: 'known-tenant',
        agentName: 'my-agent',
      });

      expect(mockTenantFindOne).not.toHaveBeenCalled();
      expect(mockTenantInsert).not.toHaveBeenCalled();
      expect(result.tenantId).toBe('known-tenant');
      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: 'known-tenant' }),
      );
    });

    it('should throw NotFoundException when neither tenantId nor ownerUserId is given', async () => {
      await expect(service.onboardAgent({ agentName: 'my-agent' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should create an agent linked to the tenant', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'uuid-agent-1',
          name: 'my-agent',
          is_active: true,
          tenant_id: 'uuid-tenant-1',
        }),
      );
    });
    it('writes explicit Autofix and recording choices when provided', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({
        ...defaultParams,
        autofixEnabled: false,
        recordMessages: false,
      });

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          autofix_enabled: false,
          record_messages: false,
        }),
      );
    });

    it('omits Autofix and recording when the caller made no choice', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      const inserted = mockAgentInsert.mock.calls[0][0];
      expect(inserted).not.toHaveProperty('autofix_enabled');
      expect(inserted).not.toHaveProperty('record_messages');
    });

    it('should store encrypted key, key_hash and key_prefix', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      const insertCall = mockKeyInsert.mock.calls[0][0];
      const expectedRawKey = 'mnfst_' + Buffer.from('a'.repeat(32), 'utf8').toString('base64url');

      expect(insertCall.key).not.toBeNull();
      expect(decrypt(insertCall.key, TEST_SECRET)).toBe(expectedRawKey);
      expect(verifyKey(expectedRawKey, insertCall.key_hash)).toBe(true);
      expect(insertCall.key_prefix).toBe(keyPrefix(expectedRawKey));
    });

    it('should set the key label from agent name', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockKeyInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'my-agent ingest key',
        }),
      );
    });

    it('should return tenantId, agentId, and the raw apiKey', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      const result = await service.onboardAgent(defaultParams);

      expect(result.tenantId).toBe('uuid-tenant-1');
      expect(result.agentId).toBe('uuid-agent-1');
      expect(result.apiKey).toMatch(/^mnfst_/);
    });

    it('should pass optional organization and email when creating tenant', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({
        ...defaultParams,
        organizationName: 'Acme Corp',
        email: 'admin@acme.com',
      });

      expect(mockTenantInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_name: 'Acme Corp',
          email: 'admin@acme.com',
        }),
      );
    });

    it('should default organization_name and email to null', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockTenantInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_name: null,
          email: null,
        }),
      );
    });

    it('should default agent description to null when omitted', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          description: null,
        }),
      );
    });

    it('should default display_name to null when omitted', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          display_name: null,
        }),
      );
    });

    it('should store displayName when provided', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({
        ...defaultParams,
        displayName: 'My Cool Agent',
      });

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          display_name: 'My Cool Agent',
        }),
      );
    });

    it('should pass agent description when provided', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({
        ...defaultParams,
        agentDescription: 'A helpful bot',
      });

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'A helpful bot',
        }),
      );
    });

    it('should mark the new key as active', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent(defaultParams);

      expect(mockKeyInsert).toHaveBeenCalledWith(expect.objectContaining({ is_active: true }));
    });

    it('should generate a key starting with mnfst_ prefix', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      const result = await service.onboardAgent(defaultParams);

      expect(result.apiKey).toMatch(/^mnfst_/);
      expect(result.apiKey.length).toBeGreaterThan(4);
    });

    it('should use tenant id from existing tenant for agent and key', async () => {
      mockTenantFindOne.mockResolvedValue({
        id: 'pre-existing-tenant',
        name: 'user-42',
      });

      await service.onboardAgent(defaultParams);

      expect(mockAgentInsert).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: 'pre-existing-tenant' }),
      );
      expect(mockKeyInsert).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: 'pre-existing-tenant' }),
      );
    });
  });

  // ──────────────────────────────────────────────
  // getKeyForAgent
  // ──────────────────────────────────────────────

  describe('getKeyForAgent', () => {
    it('should return keyPrefix when an active key exists', async () => {
      mockKeyGetOne.mockResolvedValue({
        key_prefix: 'mnfst_abc12345',
        key_hash: 'somehash',
      });

      const result = await service.getKeyForAgent('tenant-1', 'agent-a');

      expect(result).toEqual({ keyPrefix: 'mnfst_abc12345' });
    });

    it('should throw NotFoundException when no active key is found', async () => {
      mockKeyGetOne.mockResolvedValue(null);

      await expect(service.getKeyForAgent('tenant-1', 'agent-a')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getKeyForAgent('tenant-1', 'agent-a')).rejects.toThrow(
        'No active API key found for this agent',
      );
    });

    it('should query by tenantId and agentName with is_active filter', async () => {
      mockKeyGetOne.mockResolvedValue({ key_prefix: 'mnfst_xxx' });

      await service.getKeyForAgent('tenant-99', 'bot-x');

      expect(mockKeyQb.leftJoin).toHaveBeenCalledWith('k.agent', 'a');
      expect(mockKeyQb.where).toHaveBeenCalledWith('a.tenant_id = :tenantId', {
        tenantId: 'tenant-99',
      });
      expect(mockKeyQb.andWhere).toHaveBeenCalledWith('a.name = :agentName', {
        agentName: 'bot-x',
      });
      expect(mockKeyQb.andWhere).toHaveBeenCalledWith('a.deleted_at IS NULL');
      expect(mockKeyQb.andWhere).toHaveBeenCalledWith('k.is_active = true');
    });

    it('should return fullKey when encrypted key is stored', async () => {
      const { encrypt } = jest.requireActual('../../common/utils/crypto.util');
      const encryptedKey = encrypt('mnfst_decrypted_key', TEST_SECRET);
      mockKeyGetOne.mockResolvedValue({
        key_prefix: 'mnfst_partia',
        key_hash: 'secret-hash',
        key: encryptedKey,
      });

      const result = await service.getKeyForAgent('tenant-1', 'agent-a');

      expect(result).toEqual({ keyPrefix: 'mnfst_partia', fullKey: 'mnfst_decrypted_key' });
      expect(result).not.toHaveProperty('key');
      expect(result).not.toHaveProperty('key_hash');
    });

    it('should return only keyPrefix when key is null (legacy)', async () => {
      mockKeyGetOne.mockResolvedValue({
        key_prefix: 'mnfst_legacy_',
        key_hash: 'secret-hash',
        key: null,
      });

      const result = await service.getKeyForAgent('tenant-1', 'agent-a');

      expect(result).toEqual({ keyPrefix: 'mnfst_legacy_' });
      expect(result).not.toHaveProperty('fullKey');
    });

    it('should fall back to keyPrefix when decryption fails', async () => {
      mockKeyGetOne.mockResolvedValue({
        key_prefix: 'mnfst_broken_',
        key_hash: 'secret-hash',
        key: 'invalid-encrypted-data',
      });

      const result = await service.getKeyForAgent('tenant-1', 'agent-a');

      expect(result).toEqual({ keyPrefix: 'mnfst_broken_' });
      expect(result).not.toHaveProperty('fullKey');
    });
  });

  // ──────────────────────────────────────────────
  // rotateKey
  // ──────────────────────────────────────────────

  describe('rotateKey', () => {
    const existingAgent = {
      id: 'agent-id-1',
      name: 'my-agent',
      tenant_id: 'tenant-id-1',
    };

    it('should throw NotFoundException when agent is not found', async () => {
      mockAgentGetOne.mockResolvedValue(null);

      await expect(service.rotateKey('tenant-1', 'nonexistent-agent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.rotateKey('tenant-1', 'nonexistent-agent')).rejects.toThrow(
        'Agent not found or access denied',
      );
    });

    it('should delete existing keys for the agent before creating a new one', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      await service.rotateKey('tenant-1', 'my-agent');

      expect(mockKeyDelete).toHaveBeenCalledWith({ agent_id: 'agent-id-1' });
    });

    it('should create a new key with encrypted key, hash and prefix', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      await service.rotateKey('tenant-1', 'my-agent');

      const insertCall = mockKeyInsert.mock.calls[0][0];
      const expectedRawKey = 'mnfst_' + Buffer.from('a'.repeat(32), 'utf8').toString('base64url');

      expect(insertCall.key).not.toBeNull();
      expect(decrypt(insertCall.key, TEST_SECRET)).toBe(expectedRawKey);
      expect(verifyKey(expectedRawKey, insertCall.key_hash)).toBe(true);
      expect(insertCall.key_prefix).toBe(keyPrefix(expectedRawKey));
      expect(insertCall.is_active).toBe(true);
      expect(insertCall.tenant_id).toBe('tenant-id-1');
      expect(insertCall.agent_id).toBe('agent-id-1');
    });

    it('should label the rotated key with "(rotated)" suffix', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      await service.rotateKey('tenant-1', 'my-agent');

      expect(mockKeyInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'my-agent ingest key (rotated)',
        }),
      );
    });

    it('should return the new raw apiKey', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      const result = await service.rotateKey('tenant-1', 'my-agent');

      expect(result.apiKey).toMatch(/^mnfst_/);
      expect(result.apiKey.length).toBeGreaterThan(4);
    });

    it('should look up agent by name and tenantId via query builder', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      await service.rotateKey('tenant-7', 'bot-z');

      expect(mockAgentQb.where).toHaveBeenCalledWith('a.name = :agentName', { agentName: 'bot-z' });
      expect(mockAgentQb.andWhere).toHaveBeenCalledWith('a.tenant_id = :tenantId', {
        tenantId: 'tenant-7',
      });
      expect(mockAgentQb.andWhere).toHaveBeenCalledWith('a.deleted_at IS NULL');
    });

    it('should delete old keys before inserting the new one', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      const callOrder: string[] = [];
      mockKeyDelete.mockImplementation(() => {
        callOrder.push('delete');
        return Promise.resolve({});
      });
      mockKeyInsert.mockImplementation(() => {
        callOrder.push('insert');
        return Promise.resolve({});
      });

      await service.rotateKey('tenant-1', 'my-agent');

      expect(callOrder).toEqual(['delete', 'insert']);
    });

    it('should call clearCache after deleting the old key', async () => {
      mockAgentGetOne.mockResolvedValue(existingAgent);

      await service.rotateKey('tenant-1', 'my-agent');

      expect(mockClearCache).toHaveBeenCalledTimes(1);
    });
  });

  describe('onboardAgent does not clear cache', () => {
    it('should not call clearCache during onboarding', async () => {
      mockTenantFindOne.mockResolvedValue(null);

      await service.onboardAgent({ ownerUserId: 'user-42', agentName: 'my-agent' });

      expect(mockClearCache).not.toHaveBeenCalled();
    });
  });
});
