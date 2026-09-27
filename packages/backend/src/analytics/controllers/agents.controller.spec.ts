import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AgentsController } from './agents.controller';
import { TimeseriesQueriesService } from '../services/timeseries-queries.service';
import { AgentLifecycleService } from '../services/agent-lifecycle.service';
import { AgentDuplicationService } from '../services/agent-duplication.service';
import { ApiKeyGeneratorService } from '../../otlp/services/api-key.service';
import { TenantCacheService } from '../../common/services/tenant-cache.service';
import { AgentListCacheService } from '../../common/services/agent-list-cache.service';
import { IngestEventBusService } from '../../common/services/ingest-event-bus.service';
import { ProviderService } from '../../routing/routing-core/provider.service';
import { AutofixStatsService } from '../services/autofix-stats.service';

// Shared no-op ProviderService stub. createAgent now auto-enables every usable
// provider on the new agent (symmetric global-providers auto-connect), so every
// testing module that instantiates AgentsController must provide it.
const providerServiceProvider = () => ({
  provide: ProviderService,
  useValue: { enableAllProvidersForAgent: jest.fn().mockResolvedValue(undefined) },
});

const autofixStatsProvider = (recordAutofixConsent = jest.fn().mockResolvedValue(undefined)) => ({
  provide: AutofixStatsService,
  useValue: { recordAutofixConsent },
});

describe('AgentsController', () => {
  let controller: AgentsController;
  let cacheManager: Cache;
  let mockGetAgentList: jest.Mock;
  let mockOnboardAgent: jest.Mock;
  let mockRecordAutofixConsent: jest.Mock;
  let mockGetKeyForAgent: jest.Mock;
  let mockRotateKey: jest.Mock;
  let mockConfigGet: jest.Mock;
  let mockDeleteAgent: jest.Mock;
  let mockRenameAgent: jest.Mock;
  let mockTenantResolve: jest.Mock;
  let mockDuplicate: jest.Mock;
  let mockGetCopySummary: jest.Mock;
  let mockSuggestName: jest.Mock;

  beforeEach(async () => {
    mockGetAgentList = jest.fn().mockResolvedValue([
      { agent_name: 'bot-1', agent_id: 'id-1', message_count: 100 },
      { agent_name: 'bot-2', agent_id: 'id-2', message_count: 50 },
    ]);
    mockOnboardAgent = jest.fn().mockResolvedValue({
      tenantId: 'tenant-123',
      agentId: 'new-agent-id',
      apiKey: 'mnfst_new_agent_key',
    });
    mockRecordAutofixConsent = jest.fn().mockResolvedValue(undefined);
    mockGetKeyForAgent = jest.fn().mockResolvedValue({ keyPrefix: 'mnfst_test1234' });
    mockRotateKey = jest.fn().mockResolvedValue({ apiKey: 'mnfst_new_key_123' });
    mockConfigGet = jest.fn().mockReturnValue('');
    mockDeleteAgent = jest.fn().mockResolvedValue(undefined);
    mockRenameAgent = jest.fn().mockResolvedValue(undefined);
    mockTenantResolve = jest.fn().mockResolvedValue('tenant-123');
    // Mirrors the real DuplicateAgentSummary shape (agent-duplication.service.ts):
    // exactly { providers, tierAssignments, specificityAssignments, modelParams } —
    // there is no `customProviders` field (custom providers are tenant-global and
    // counted under `providers` via the enabled-provider junction).
    mockDuplicate = jest.fn().mockResolvedValue({
      agentId: 'new-id',
      agentName: 'bot-copy',
      displayName: 'bot-copy',
      apiKey: 'mnfst_new',
      copied: {
        providers: 1,
        tierAssignments: 2,
        specificityAssignments: 0,
        modelParams: 0,
      },
    });
    mockGetCopySummary = jest.fn().mockResolvedValue({
      providers: 1,
      tierAssignments: 2,
      specificityAssignments: 0,
      modelParams: 0,
    });
    mockSuggestName = jest.fn().mockResolvedValue('bot-copy');

    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        {
          provide: TimeseriesQueriesService,
          useValue: { getAgentList: mockGetAgentList },
        },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: mockDeleteAgent,
            renameAgent: mockRenameAgent,
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn(async (_userId: string, agentName: string) =>
              agentName === 'bot-1'
                ? {
                    agent_name: 'bot-1',
                    display_name: 'Bot One',
                    agent_category: 'app',
                    agent_platform: 'openai-sdk',
                  }
                : null,
            ),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: {
            onboardAgent: mockOnboardAgent,
            getKeyForAgent: mockGetKeyForAgent,
            rotateKey: mockRotateKey,
          },
        },
        {
          provide: AgentDuplicationService,
          useValue: {
            duplicate: mockDuplicate,
            getCopySummary: mockGetCopySummary,
            suggestName: mockSuggestName,
          },
        },
        {
          provide: ConfigService,
          useValue: { get: mockConfigGet },
        },
        {
          provide: TenantCacheService,
          useValue: { resolve: mockTenantResolve },
        },
        {
          provide: IngestEventBusService,
          useValue: { emit: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(mockRecordAutofixConsent),
      ],
    }).compile();

    controller = module.get<AgentsController>(AgentsController);
    cacheManager = module.get<Cache>(CACHE_MANAGER);
    jest.spyOn(cacheManager, 'del').mockResolvedValue(true);
  });

  const ctx = { tenantId: 'tenant-123', userId: 'u1' };

  it('returns agent list wrapped in agents property', async () => {
    const result = await controller.getAgents(ctx as never);

    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].agent_name).toBe('bot-1');
    expect(mockGetAgentList).toHaveBeenCalledWith('tenant-123', false);
  });

  it('passes null tenantId when tenant not found', async () => {
    const nullCtx = { tenantId: null, userId: 'u1' };
    await controller.getAgents(nullCtx as never);

    expect(mockGetAgentList).toHaveBeenCalledWith(null, false);
  });

  it('passes includePlayground=true through to getAgentList (Messages filter)', async () => {
    await controller.getAgents(ctx as never, 'true');

    expect(mockGetAgentList).toHaveBeenCalledWith('tenant-123', true);
  });

  it('GET /agents/:agentName returns metadata for an existing agent', async () => {
    const result = await controller.getAgentInfo(ctx as never, 'bot-1');
    expect(result).toEqual({
      agent: {
        agent_name: 'bot-1',
        display_name: 'Bot One',
        agent_category: 'app',
        agent_platform: 'openai-sdk',
      },
    });
  });

  it('GET /agents/:agentName returns { agent: null } when not found', async () => {
    const result = await controller.getAgentInfo(ctx as never, 'missing');
    expect(result).toEqual({ agent: null });
  });

  it('returns agent key prefix', async () => {
    const result = await controller.getAgentKey(ctx as never, 'bot-1');

    expect(result).toMatchObject({ keyPrefix: 'mnfst_test1234' });
    expect(mockGetKeyForAgent).toHaveBeenCalledWith('tenant-123', 'bot-1');
  });

  it('returns full apiKey when service returns fullKey', async () => {
    mockGetKeyForAgent.mockResolvedValueOnce({
      keyPrefix: 'mnfst_test1234',
      fullKey: 'mnfst_full_decrypted',
    });
    const result = await controller.getAgentKey(ctx as never, 'bot-1');

    expect(result).toMatchObject({ keyPrefix: 'mnfst_test1234', apiKey: 'mnfst_full_decrypted' });
  });

  it('returns full apiKey when service returns fullKey (persistent mock)', async () => {
    mockGetKeyForAgent.mockResolvedValue({
      keyPrefix: 'mnfst_test1234',
      fullKey: 'mnfst_full_decrypted',
    });
    const result = await controller.getAgentKey(ctx as never, 'bot-1');

    expect(result).toMatchObject({ keyPrefix: 'mnfst_test1234', apiKey: 'mnfst_full_decrypted' });
  });

  it('does not return apiKey when service returns no fullKey', async () => {
    mockGetKeyForAgent.mockResolvedValue({ keyPrefix: 'mnfst_test1234' });
    const result = await controller.getAgentKey(ctx as never, 'bot-1');

    expect(result).toMatchObject({ keyPrefix: 'mnfst_test1234' });
    expect(result).not.toHaveProperty('apiKey');
  });

  it('returns empty agents array when no agents exist', async () => {
    mockGetAgentList.mockResolvedValue([]);

    const result = await controller.getAgents(ctx as never);

    expect(result.agents).toEqual([]);
  });

  it('rotates agent key and returns new raw key', async () => {
    const result = await controller.rotateAgentKey(ctx as never, 'bot-1');

    expect(result).toEqual({ apiKey: 'mnfst_new_key_123' });
    expect(mockRotateKey).toHaveBeenCalledWith('tenant-123', 'bot-1');
  });

  it('renames agent and returns success with slug', async () => {
    const result = await controller.updateAgent(ctx as never, 'bot-1', {
      name: 'Bot Renamed',
    } as never);

    expect(result).toEqual({ renamed: true, name: 'bot-renamed', display_name: 'Bot Renamed' });
    expect(mockRenameAgent).toHaveBeenCalledWith(
      'tenant-123',
      'bot-1',
      'bot-renamed',
      'Bot Renamed',
    );
    expect(cacheManager.del).toHaveBeenCalledWith('tenant-123:/api/v1/agents:playground=false:g0');
    // The Messages-filter variant (playground agents included) is a distinct cache
    // entry and must also be cleared so it never goes stale after a rename.
    expect(cacheManager.del).toHaveBeenCalledWith('tenant-123:/api/v1/agents:playground=true:g0');
  });

  it('rejects rename with empty slug', async () => {
    await expect(
      controller.updateAgent(ctx as never, 'bot-1', { name: '!!!' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects rename to the reserved "Playground" name', async () => {
    await expect(
      controller.updateAgent(ctx as never, 'bot-1', { name: 'Playground' } as never),
    ).rejects.toThrow(/reserved/i);
    expect(mockRenameAgent).not.toHaveBeenCalled();
  });

  it('rejects createAgent with the reserved "Playground" name', async () => {
    await expect(
      controller.createAgent(ctx as never, { name: 'Playground' } as never),
    ).rejects.toThrow(/reserved/i);
  });

  it('records install consent before creating an explicitly enabled agent', async () => {
    await controller.createAgent(
      ctx as never,
      {
        name: 'Enabled Agent',
        autofix_enabled: true,
      } as never,
    );

    expect(mockRecordAutofixConsent).toHaveBeenCalledTimes(1);
    expect(mockOnboardAgent).toHaveBeenCalledWith(
      expect.objectContaining({ autofixEnabled: true }),
    );
    expect(mockRecordAutofixConsent.mock.invocationCallOrder[0]).toBeLessThan(
      mockOnboardAgent.mock.invocationCallOrder[0],
    );
  });

  it('does not record install consent for an explicitly disabled agent', async () => {
    await controller.createAgent(
      ctx as never,
      {
        name: 'Disabled Agent',
        autofix_enabled: false,
      } as never,
    );

    expect(mockRecordAutofixConsent).not.toHaveBeenCalled();
  });

  it('deletes agent and returns success', async () => {
    const result = await controller.deleteAgent(ctx as never, 'bot-1');

    expect(result).toEqual({ deleted: true });
    expect(mockDeleteAgent).toHaveBeenCalledWith('tenant-123', 'bot-1');
    // Both canonical variants are cleared so neither the Workspace list nor the
    // Messages filter (playground agents included) goes stale after a delete.
    expect(cacheManager.del).toHaveBeenCalledWith('tenant-123:/api/v1/agents:playground=false:g0');
    expect(cacheManager.del).toHaveBeenCalledWith('tenant-123:/api/v1/agents:playground=true:g0');
  });

  it('passes agent_category and agent_platform to onboardAgent', async () => {
    const mockOnboard = jest.fn().mockResolvedValue({
      tenantId: 't1',
      agentId: 'a1',
      apiKey: 'mnfst_key',
    });
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn(),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const cm = module.get<Cache>(CACHE_MANAGER);
    jest.spyOn(cm, 'del').mockResolvedValue(true);
    const userCtx = { tenantId: null, userId: 'user-123' };
    const result = await ctrl.createAgent(
      userCtx as never,
      {
        name: 'My Agent',
        agent_category: 'personal',
        agent_platform: 'openclaw',
        autofix_enabled: false,
        record_messages: true,
      } as never,
    );

    expect(mockOnboard).toHaveBeenCalledWith(
      expect.objectContaining({
        agentCategory: 'personal',
        agentPlatform: 'openclaw',
        autofixEnabled: false,
        recordMessages: true,
      }),
    );
    expect(result.agent.agent_category).toBe('personal');
    expect(result.agent.agent_platform).toBe('openclaw');
  });

  it('returns null category/platform when not provided', async () => {
    const mockOnboard = jest.fn().mockResolvedValue({
      tenantId: 't1',
      agentId: 'a1',
      apiKey: 'mnfst_key',
    });
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn(),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const cm = module.get<Cache>(CACHE_MANAGER);
    jest.spyOn(cm, 'del').mockResolvedValue(true);
    const userCtx = { tenantId: null, userId: 'user-123' };
    const result = await ctrl.createAgent(userCtx as never, { name: 'My Agent' } as never);

    expect(result.agent.agent_category).toBeNull();
    expect(result.agent.agent_platform).toBeNull();
  });

  it('passes category/platform to updateAgentType on PATCH', async () => {
    const result = await controller.updateAgent(ctx as never, 'bot-1', {
      agent_category: 'app',
      agent_platform: 'openai-sdk',
    } as never);

    expect(result).toMatchObject({
      agent_category: 'app',
      agent_platform: 'openai-sdk',
    });
  });

  it('invalidates agent list cache after successful createAgent', async () => {
    const mockOnboard = jest.fn().mockResolvedValue({
      tenantId: 't1',
      agentId: 'a1',
      apiKey: 'mnfst_key',
    });
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn(),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const cm = module.get<Cache>(CACHE_MANAGER);
    const delSpy = jest.spyOn(cm, 'del').mockResolvedValue(true);
    const userCtx = { tenantId: null, userId: 'user-123' };
    const result = await ctrl.createAgent(userCtx as never, { name: 'My Agent' } as never);

    expect(result.agent.name).toBe('my-agent');
    // Both canonical variants are cleared so neither the Workspace list nor the
    // Messages filter (playground agents included) goes stale after a create. The
    // cache is keyed by the tenant the onboard returned (t1), not the user id.
    expect(delSpy).toHaveBeenCalledWith('t1:/api/v1/agents:playground=false:g0');
    expect(delSpy).toHaveBeenCalledWith('t1:/api/v1/agents:playground=true:g0');
    expect(delSpy).toHaveBeenCalledWith('t1:/api/v1/autofix/status');
  });

  it('rolls back the agent and clears the list cache when provider enable fails', async () => {
    const mockOnboard = jest.fn().mockResolvedValue({
      tenantId: 't1',
      agentId: 'a1',
      apiKey: 'mnfst_key',
    });
    const mockDelete = jest.fn().mockResolvedValue(undefined);
    const enableErr = new Error('enable boom');
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: mockDelete,
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        {
          provide: ProviderService,
          useValue: { enableAllProvidersForAgent: jest.fn().mockRejectedValue(enableErr) },
        },
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const cm = module.get<Cache>(CACHE_MANAGER);
    const delSpy = jest.spyOn(cm, 'del').mockResolvedValue(true);
    const ctx = { tenantId: 't1', userId: 'user-123' };

    // The original enable error surfaces to the client...
    await expect(ctrl.createAgent(ctx as never, { name: 'My Agent' } as never)).rejects.toThrow(
      'enable boom',
    );
    // ...the half-created agent is rolled back (deleteAgent is tenant-scoped, so
    // it receives the tenant id onboardAgent returned, not the user id)...
    expect(mockDelete).toHaveBeenCalledWith('t1', 'my-agent');
    // ...and the agent-list cache is cleared so the briefly-visible agent does
    // not linger in a cached list (both tenant-keyed entries).
    expect(delSpy).toHaveBeenCalledWith('t1:/api/v1/agents:playground=false:g0');
    expect(delSpy).toHaveBeenCalledWith('t1:/api/v1/agents:playground=true:g0');
    // ...along with the Autofix status entry, which would otherwise keep
    // reporting the rolled-back agent as enabled until the dashboard TTL, so
    // the sidebar contradicts a workspace the agent no longer appears in.
    expect(delSpy).toHaveBeenCalledWith('t1:/api/v1/autofix/status');
  });

  it('still re-throws the enable error when the compensating delete also fails', async () => {
    const mockOnboard = jest.fn().mockResolvedValue({
      tenantId: 't1',
      agentId: 'a1',
      apiKey: 'mnfst_key',
    });
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn().mockRejectedValue(new Error('cleanup boom')),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        {
          provide: ProviderService,
          useValue: {
            enableAllProvidersForAgent: jest.fn().mockRejectedValue(new Error('enable boom')),
          },
        },
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const ctx = { tenantId: 't1', userId: 'user-123' };
    // The compensating cleanup throwing must not mask the original failure.
    await expect(ctrl.createAgent(ctx as never, { name: 'My Agent' } as never)).rejects.toThrow(
      'enable boom',
    );
  });

  it('rejects createAgent with empty slug', async () => {
    const mockOnboard = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn(),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const userCtx = { tenantId: null, userId: 'user-123' };
    await expect(ctrl.createAgent(userCtx as never, { name: '!!!' } as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(mockOnboard).not.toHaveBeenCalled();
  });

  it('throws ConflictException when onboardAgent hits unique constraint', async () => {
    const queryError = new QueryFailedError('INSERT', [], new Error('unique constraint violation'));
    const mockOnboard = jest.fn().mockRejectedValue(queryError);
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn(),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const userCtx = { tenantId: null, userId: 'user-123' };
    await expect(ctrl.createAgent(userCtx as never, { name: 'My Agent' } as never)).rejects.toThrow(
      ConflictException,
    );
  });

  it('returns duplicate preview with copy counts and suggested name', async () => {
    const result = await controller.getDuplicatePreview(ctx as never, 'bot-1');

    expect(result).toEqual({
      copied: {
        providers: 1,
        tierAssignments: 2,
        specificityAssignments: 0,
        modelParams: 0,
      },
      suggested_name: 'bot-copy',
    });
    expect(mockGetCopySummary).toHaveBeenCalledWith('tenant-123', 'bot-1');
    expect(mockSuggestName).toHaveBeenCalledWith('tenant-123', 'bot-1');
  });

  it('duplicates agent and invalidates cache', async () => {
    const result = await controller.duplicateAgent(ctx as never, 'bot-1', {
      name: 'Bot Copy',
    } as never);

    expect(result.agent.name).toBe('bot-copy');
    expect(result.apiKey).toBe('mnfst_new');
    expect(result.copied.providers).toBe(1);
    expect(mockDuplicate).toHaveBeenCalledWith('tenant-123', 'bot-1', {
      name: 'bot-copy',
      displayName: 'Bot Copy',
    });
    expect(cacheManager.del).toHaveBeenCalledWith('tenant-123:/api/v1/agents:playground=false:g0');
    // The Messages-filter variant (playground agents included) is a distinct cache
    // entry and must also be cleared so it never goes stale after a duplicate.
    expect(cacheManager.del).toHaveBeenCalledWith('tenant-123:/api/v1/agents:playground=true:g0');
  });

  it('rejects duplicateAgent with empty slug', async () => {
    await expect(
      controller.duplicateAgent(ctx as never, 'bot-1', { name: '!!!' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('converts duplicate-name QueryFailedError into ConflictException on duplicateAgent', async () => {
    mockDuplicate.mockRejectedValueOnce(
      new QueryFailedError('INSERT', [], new Error('unique constraint violation')),
    );
    await expect(
      controller.duplicateAgent(ctx as never, 'bot-1', { name: 'bot-copy' } as never),
    ).rejects.toThrow(ConflictException);
  });

  it('re-throws non-duplicate errors from duplicate()', async () => {
    mockDuplicate.mockRejectedValueOnce(new Error('boom'));
    await expect(
      controller.duplicateAgent(ctx as never, 'bot-1', { name: 'bot-copy' } as never),
    ).rejects.toThrow('boom');
  });

  // P1-B: duplicate must honor the reserved name
  it('rejects duplicateAgent with the reserved "Playground" name', async () => {
    await expect(
      controller.duplicateAgent(ctx as never, 'bot-1', { name: 'Playground' } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.duplicateAgent(ctx as never, 'bot-1', { name: 'Playground' } as never),
    ).rejects.toThrow(/reserved/i);
    expect(mockDuplicate).not.toHaveBeenCalled();
  });

  // P1-A: key endpoints must reject the reserved "Playground" agent
  it('getAgentKey throws NotFoundException for the reserved "Playground" agent', async () => {
    // findAgentInfo returns null for playground agents (is_playground = false filter)
    // which is the same shape as a missing agent — NotFoundException is thrown.
    await expect(controller.getAgentKey(ctx as never, 'Playground')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rotateAgentKey throws NotFoundException for the reserved "Playground" agent', async () => {
    await expect(controller.rotateAgentKey(ctx as never, 'Playground')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('re-throws non-duplicate QueryFailedError from onboardAgent', async () => {
    const queryError = new QueryFailedError('INSERT', [], new Error('connection refused'));
    const mockOnboard = jest.fn().mockRejectedValue(queryError);
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AgentsController],
      providers: [
        { provide: TimeseriesQueriesService, useValue: { getAgentList: jest.fn() } },
        {
          provide: AgentLifecycleService,
          useValue: {
            deleteAgent: jest.fn(),
            renameAgent: jest.fn(),
            updateAgentType: jest.fn(),
            findAgentInfo: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ApiKeyGeneratorService,
          useValue: { onboardAgent: mockOnboard, getKeyForAgent: jest.fn(), rotateKey: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TenantCacheService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
        { provide: IngestEventBusService, useValue: { emit: jest.fn() } },
        {
          provide: AgentDuplicationService,
          useValue: { duplicate: jest.fn(), getCopySummary: jest.fn(), suggestName: jest.fn() },
        },
        providerServiceProvider(),
        AgentListCacheService,
        autofixStatsProvider(),
      ],
    }).compile();

    const ctrl = module.get<AgentsController>(AgentsController);
    const userCtx = { tenantId: null, userId: 'user-123' };
    await expect(ctrl.createAgent(userCtx as never, { name: 'My Agent' } as never)).rejects.toThrow(
      QueryFailedError,
    );
  });
});
