import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { ErrorsController } from './errors.controller';
import { ErrorBreakdownService } from '../services/error-breakdown.service';

describe('ErrorsController', () => {
  let controller: ErrorsController;
  let getBreakdown: jest.Mock;

  const RESULT = {
    range: '30d',
    successful: 80,
    total_errors: 20,
    provider_errors: 15,
    transport_errors: 2,
    manifest_errors: 3,
    by_origin: { provider: 15, transport: 2, config: 3, policy: 0, internal: 0 },
    by_class: { rate_limit: 10, server_error: 5 },
    provider_error_rate: 0.1578,
  };

  beforeEach(async () => {
    getBreakdown = jest.fn().mockResolvedValue(RESULT);
    const module: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [ErrorsController],
      providers: [{ provide: ErrorBreakdownService, useValue: { getBreakdown } }],
    }).compile();

    controller = module.get<ErrorsController>(ErrorsController);
  });

  const ctx = { tenantId: 'tenant-1', userId: 'u1' };

  it('delegates to the breakdown service with the tenant + range and returns its result', async () => {
    const result = await controller.getBreakdown({ range: '7d' }, ctx as never);

    expect(getBreakdown).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      range: '7d',
      agentName: undefined,
    });
    expect(result).toBe(RESULT);
  });

  it('passes agent_name through as agentName', async () => {
    await controller.getBreakdown({ range: '30d', agent_name: 'bot' }, ctx as never);

    expect(getBreakdown).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      range: '30d',
      agentName: 'bot',
    });
  });

  it('forwards undefined range/agent when the query omits them', async () => {
    await controller.getBreakdown({}, ctx as never);

    expect(getBreakdown).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      range: undefined,
      agentName: undefined,
    });
  });
});
