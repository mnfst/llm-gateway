import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ResolveAgentService } from './resolve-agent.service';
import { RoutingCacheSyncService } from './routing-cache-sync.service';
import { Agent } from '../../entities/agent.entity';

function makeAgentRepo(findOne: jest.Mock): Repository<Agent> {
  return { findOne } as unknown as Repository<Agent>;
}

describe('ResolveAgentService', () => {
  let findOne: jest.Mock;
  let catchUp: jest.Mock;
  let svc: ResolveAgentService;

  beforeEach(() => {
    findOne = jest.fn();
    catchUp = jest.fn().mockResolvedValue(undefined);
    svc = new ResolveAgentService(makeAgentRepo(findOne), {
      catchUp,
    } as unknown as RoutingCacheSyncService);
  });

  it('throws NotFoundException when the tenant is null', async () => {
    await expect(svc.resolve(null, 'demo-agent')).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the agent does not exist for the tenant', async () => {
    findOne.mockResolvedValue(null);
    await expect(svc.resolve('tenant-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1', name: 'missing', deleted_at: expect.anything() },
    });
  });

  it('reads the agent from the database on every call', async () => {
    const before = { id: 'agent-1', complexity_routing_enabled: false } as Agent;
    const after = { id: 'agent-1', complexity_routing_enabled: true } as Agent;
    findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    expect(await svc.resolve('tenant-1', 'demo-agent')).toBe(before);
    // A write made through another instance is visible on the next call.
    expect(await svc.resolve('tenant-1', 'demo-agent')).toBe(after);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('applies other instances’ routing-cache invalidations before returning', async () => {
    const agent = { id: 'agent-1', is_playground: false } as Agent;
    findOne.mockResolvedValue(agent);

    await svc.resolve('tenant-1', 'demo-agent');
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  it('waits for the catch-up to finish before returning', async () => {
    const agent = { id: 'agent-1', is_playground: false } as Agent;
    findOne.mockResolvedValue(agent);
    let release!: () => void;
    catchUp.mockReturnValue(new Promise<void>((r) => (release = r)));

    let settled = false;
    const pending = svc.resolve('tenant-1', 'demo-agent').then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects a playground agent unless allowPlayground is set', async () => {
    const playgroundAgent = { id: 'sys-1', name: 'Playground', is_playground: true } as Agent;
    findOne.mockResolvedValue(playgroundAgent);

    // Same not-found shape, so callers cannot tell a playground agent from a missing one.
    await expect(svc.resolve('tenant-1', 'Playground')).rejects.toThrow(
      'Agent "Playground" not found',
    );
    await expect(svc.resolve('tenant-1', 'Playground', { allowPlayground: true })).resolves.toBe(
      playgroundAgent,
    );
  });
});
