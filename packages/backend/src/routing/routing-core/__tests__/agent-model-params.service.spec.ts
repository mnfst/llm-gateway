import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentModelParams } from '../../../entities/agent-model-params.entity';
import { AgentModelParamsService } from '../agent-model-params.service';
import { RoutingCacheService } from '../routing-cache.service';

describe('AgentModelParamsService', () => {
  let service: AgentModelParamsService;
  // Repository<T>.create has overloaded signatures (no-arg, one-arg, array) that
  // are awkward to mock with `jest.Mocked<Pick<…>>`. Type the repo loosely so
  // the constructor accepts our test double; runtime behavior is what we care
  // about here, not the precise overload set.
  let repo: {
    find: jest.Mock;
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qbExecute: jest.Mock;
  let cache: {
    getModelParams: jest.Mock;
    setModelParams: jest.Mock;
    invalidateModelParams: jest.Mock;
  };

  beforeEach(async () => {
    // QueryBuilder mock for the atomic INSERT … ON CONFLICT path. The
    // service builds a fluent chain (.insert().into().values().orUpdate()
    // .setParameter().execute()), so every link returns the same object.
    qbExecute = jest.fn().mockResolvedValue(undefined);
    const qbChain: Record<string, jest.Mock> = {};
    qbChain.insert = jest.fn(() => qbChain);
    qbChain.into = jest.fn(() => qbChain);
    qbChain.values = jest.fn(() => qbChain);
    qbChain.orUpdate = jest.fn(() => qbChain);
    qbChain.setParameter = jest.fn(() => qbChain);
    qbChain.execute = qbExecute;

    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
      create: jest.fn((entity) => entity as AgentModelParams),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => qbChain),
    };
    cache = {
      getModelParams: jest.fn().mockReturnValue(null),
      setModelParams: jest.fn(),
      invalidateModelParams: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentModelParamsService,
        { provide: getRepositoryToken(AgentModelParams), useValue: repo },
        { provide: RoutingCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<AgentModelParamsService>(AgentModelParamsService);
  });

  describe('list', () => {
    it('returns the cached rows when present (no DB hit)', async () => {
      const cached = [{ id: '1' } as AgentModelParams];
      cache.getModelParams.mockReturnValueOnce(cached);

      const result = await service.list('agent-1');

      expect(result).toBe(cached);
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('hits the DB and caches the result on a miss', async () => {
      const rows = [{ id: '1' } as AgentModelParams];
      repo.find.mockResolvedValue(rows);

      const result = await service.list('agent-1');

      expect(repo.find).toHaveBeenCalledWith({ where: { agent_id: 'agent-1' } });
      expect(cache.setModelParams).toHaveBeenCalledWith('agent-1', rows);
      expect(result).toBe(rows);
    });
  });

  describe('get', () => {
    it('returns the matching row params (case-insensitive provider match)', async () => {
      const rows = [
        {
          scope_key: 'tier:default',
          provider: 'DeepSeek',
          auth_type: 'api_key',
          model_name: 'deepseek-v4',
          params: { thinking: { type: 'disabled' } },
        } as unknown as AgentModelParams,
      ];
      repo.find.mockResolvedValue(rows);

      const result = await service.get(
        'agent-1',
        'tier:default',
        'deepseek',
        'api_key',
        'deepseek-v4',
      );

      expect(result).toEqual({ thinking: { type: 'disabled' } });
    });

    it('returns null when no row matches (steady state for most attempts)', async () => {
      repo.find.mockResolvedValueOnce([]);
      const result = await service.get('agent-1', 'tier:default', 'openai', 'api_key', 'gpt-4o');
      expect(result).toBeNull();
    });

    it('matches on full (provider, auth_type, model_name) tuple — same model under different auth is distinct', async () => {
      const rows = [
        {
          scope_key: 'tier:default',
          provider: 'openai',
          auth_type: 'subscription',
          model_name: 'gpt-4o',
          params: { thinking: { type: 'enabled' } },
        } as unknown as AgentModelParams,
      ];
      repo.find.mockResolvedValue(rows);

      // Same model, different auth_type → no match
      expect(
        await service.get('agent-1', 'tier:default', 'openai', 'api_key', 'gpt-4o'),
      ).toBeNull();
    });

    it('finds a row saved under a dotted Anthropic id when the proxy asks for the dashed id', async () => {
      repo.find.mockResolvedValue([
        {
          scope_key: 'tier:default',
          provider: 'anthropic',
          auth_type: 'api_key',
          model_name: 'claude-sonnet-4.5',
          params: { temperature: 0.2 },
        } as unknown as AgentModelParams,
      ]);
      expect(
        await service.get('agent-1', 'tier:default', 'anthropic', 'api_key', 'claude-sonnet-4-5'),
      ).toEqual({ temperature: 0.2 });
    });

    it('prefers the exact model id when both spellings are saved', async () => {
      repo.find.mockResolvedValue([
        {
          scope_key: 'tier:default',
          provider: 'anthropic',
          auth_type: 'api_key',
          model_name: 'claude-sonnet-4.5',
          params: { temperature: 0.2 },
        },
        {
          scope_key: 'tier:default',
          provider: 'anthropic',
          auth_type: 'api_key',
          model_name: 'claude-sonnet-4-5',
          params: { temperature: 0.9 },
        },
      ] as unknown as AgentModelParams[]);
      expect(
        await service.get('agent-1', 'tier:default', 'anthropic', 'api_key', 'claude-sonnet-4-5'),
      ).toEqual({ temperature: 0.9 });
    });

    it('matches on scope so the same model can differ by route tier', async () => {
      const rows = [
        {
          scope_key: 'tier:complex',
          provider: 'openai',
          auth_type: 'api_key',
          model_name: 'gpt-5',
          params: { reasoning_effort: 'high' },
        } as unknown as AgentModelParams,
      ];
      repo.find.mockResolvedValue(rows);

      expect(await service.get('agent-1', 'tier:default', 'openai', 'api_key', 'gpt-5')).toBeNull();
      expect(await service.get('agent-1', 'tier:complex', 'openai', 'api_key', 'gpt-5')).toEqual({
        reasoning_effort: 'high',
      });
    });
  });

  describe('set', () => {
    it('runs the atomic INSERT ... ON CONFLICT upsert, invalidates the cache, then re-fetches the canonical row', async () => {
      const saved = {
        id: 'p1',
        provider: 'deepseek',
        auth_type: 'api_key',
        model_name: 'deepseek-v4',
        scope_key: 'tier:default',
        params: { thinking: { type: 'disabled' } },
      } as unknown as AgentModelParams;
      repo.findOneOrFail.mockResolvedValueOnce(saved);

      const result = await service.set(
        'agent-1',
        'tier:default',
        'DeepSeek',
        'api_key',
        'deepseek-v4',
        {
          thinking: { type: 'disabled' },
        },
      );

      // QueryBuilder upsert ran (concurrent-safe — no findOne+save race).
      expect(repo.createQueryBuilder).toHaveBeenCalled();
      expect(qbExecute).toHaveBeenCalled();
      expect(cache.invalidateModelParams).toHaveBeenCalledWith('agent-1');
      // Provider is lowercased on its way in so case differences between
      // save and lookup don't break the unique-index key.
      expect(repo.findOneOrFail).toHaveBeenCalledWith({
        where: {
          agent_id: 'agent-1',
          scope_key: 'tier:default',
          provider: 'deepseek',
          auth_type: 'api_key',
          model_name: 'deepseek-v4',
        },
      });
      expect(result).toBe(saved);
    });
  });

  describe('delete', () => {
    it('removes the row and invalidates the agent cache', async () => {
      await service.delete('agent-1', 'tier:default', 'DeepSeek', 'api_key', 'deepseek-v4');
      expect(repo.delete).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        scope_key: 'tier:default',
        provider: 'deepseek',
        auth_type: 'api_key',
        model_name: 'deepseek-v4',
      });
      expect(cache.invalidateModelParams).toHaveBeenCalledWith('agent-1');
    });
  });
});
