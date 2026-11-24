import { Logger } from '@nestjs/common';
import { AgentListCacheService } from './agent-list-cache.service';
import { IngestEventBusService, IngestEvent } from './ingest-event-bus.service';

describe('IngestEventBusService', () => {
  let service: IngestEventBusService;
  let invalidate: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    invalidate = jest.fn().mockResolvedValue(undefined);
    service = new IngestEventBusService({ invalidate } as unknown as AgentListCacheService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('emits to the correct tenant after debounce', async () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((e) => received.push(e));

    service.emit('tenant-1');
    expect(received).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(250);
    expect(received).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: undefined }]);
  });

  it('debounces rapid emissions for the same tenant/kind', async () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((e) => received.push(e));

    service.emit('tenant-1');
    jest.advanceTimersByTime(100);
    service.emit('tenant-1');
    jest.advanceTimersByTime(100);
    service.emit('tenant-1');
    jest.advanceTimersByTime(100);

    expect(received).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(150);
    expect(received).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: undefined }]);
  });

  it('forwards the optional userId attribution', async () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((e) => received.push(e));

    service.emit('tenant-1', 'message', 'user-9');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: 'user-9' }]);
  });

  it('different kinds for the same tenant fire independently', async () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((e) => received.push(e));

    service.emit('tenant-1', 'message');
    service.emit('tenant-1', 'agent');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toEqual([
      { tenantId: 'tenant-1', kind: 'message', userId: undefined },
      { tenantId: 'tenant-1', kind: 'agent', userId: undefined },
    ]);
  });

  it('does not deliver events for other tenants', async () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((e) => received.push(e));

    service.emit('tenant-2');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toHaveLength(0);
  });

  it('emits independently for different tenants', async () => {
    const tenant1: IngestEvent[] = [];
    const tenant2: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((e) => tenant1.push(e));
    service.forTenant('tenant-2').subscribe((e) => tenant2.push(e));

    service.emit('tenant-1');
    service.emit('tenant-2', 'routing');
    await jest.advanceTimersByTimeAsync(250);

    expect(tenant1).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: undefined }]);
    expect(tenant2).toEqual([{ tenantId: 'tenant-2', kind: 'routing', userId: undefined }]);
  });

  it('null tenantId matches no events', async () => {
    const received: IngestEvent[] = [];
    service.forTenant(null).subscribe((e) => received.push(e));

    service.emit('tenant-1');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toHaveLength(0);
  });

  it('all() observes every event regardless of tenant', async () => {
    const received: IngestEvent[] = [];
    service.all().subscribe((e) => received.push(e));

    service.emit('a');
    service.emit('b', 'agent');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toHaveLength(2);
    expect(received).toContainEqual({ tenantId: 'a', kind: 'message', userId: undefined });
    expect(received).toContainEqual({ tenantId: 'b', kind: 'agent', userId: undefined });
  });

  it('cleans up timers on module destroy', () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe({
      next: (e) => received.push(e),
      complete: () => received.push({ tenantId: 'COMPLETE', kind: 'message' }),
    });

    service.emit('tenant-1');
    service.onModuleDestroy();
    jest.advanceTimersByTime(2000);

    expect(received).toEqual([{ tenantId: 'COMPLETE', kind: 'message' }]);
  });
});

describe('IngestEventBusService message cache invalidation', () => {
  let service: IngestEventBusService;
  let invalidate: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    invalidate = jest.fn().mockResolvedValue(undefined);
    service = new IngestEventBusService({ invalidate } as unknown as AgentListCacheService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('waits for cache invalidation before publishing a message event', async () => {
    const received: IngestEvent[] = [];
    let finishInvalidation!: () => void;
    const invalidationFinished = new Promise<void>((resolve) => {
      finishInvalidation = resolve;
    });
    invalidate.mockReturnValue(invalidationFinished);
    const eventPublished = new Promise<void>((resolve) => {
      service.forTenant('tenant-1').subscribe((event) => {
        received.push(event);
        resolve();
      });
    });

    service.emit('tenant-1', 'message');
    await jest.advanceTimersByTimeAsync(250);

    expect(invalidate).toHaveBeenCalledWith('tenant-1');
    expect(received).toEqual([]);

    finishInvalidation();
    await eventPublished;

    expect(received).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: undefined }]);
  });

  it('publishes the event even when invalidation fails, so no dashboard is left waiting', async () => {
    const received: IngestEvent[] = [];
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    invalidate.mockRejectedValue(new Error('cache unavailable'));
    service.forTenant('tenant-1').subscribe((event) => received.push(event));

    service.emit('tenant-1', 'message');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: undefined }]);
    expect(logger).toHaveBeenCalledWith(
      'Failed to invalidate the agent-list cache for tenant tenant-1',
      expect.any(String),
    );
    logger.mockRestore();
  });

  it('logs a non-Error invalidation failure', async () => {
    const received: IngestEvent[] = [];
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    invalidate.mockRejectedValue('boom');
    service.forTenant('tenant-1').subscribe((event) => received.push(event));

    service.emit('tenant-1', 'message');
    await jest.advanceTimersByTimeAsync(250);

    expect(received).toHaveLength(1);
    expect(logger).toHaveBeenCalledWith(expect.any(String), 'boom');
    logger.mockRestore();
  });

  it('does not touch the agent-list cache for non-message events', async () => {
    service.emit('tenant-1', 'agent');
    await jest.advanceTimersByTimeAsync(250);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('keeps the response-cache generation fresh for automatic fallback', async () => {
    const received: IngestEvent[] = [];
    service.forTenant('tenant-1').subscribe((event) => received.push(event));

    service.emit('tenant-1', 'message');
    await jest.advanceTimersByTimeAsync(250);

    expect(invalidate).toHaveBeenCalledWith('tenant-1');
    expect(received).toEqual([{ tenantId: 'tenant-1', kind: 'message', userId: undefined }]);
  });
});
