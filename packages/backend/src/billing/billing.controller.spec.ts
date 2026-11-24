import { Test, TestingModule } from '@nestjs/testing';
import { BillingController } from './billing.controller';
import { PlanService } from './plan.service';

describe('BillingController', () => {
  let controller: BillingController;
  const getBillingStatus = jest.fn();
  const getPlanStatus = jest.fn();
  const updateBillingEmailPreferences = jest.fn();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        {
          provide: PlanService,
          useValue: { getBillingStatus, getPlanStatus, updateBillingEmailPreferences },
        },
      ],
    }).compile();
    controller = module.get(BillingController);
    jest.clearAllMocks();
  });

  it('returns the billing status for the request tenant context', async () => {
    const status = { enabled: false };
    getBillingStatus.mockResolvedValue(status);
    const ctx = { tenantId: 't1', userId: 'u1' };
    const result = await controller.status(ctx as never);
    expect(getBillingStatus).toHaveBeenCalledWith(ctx);
    expect(result).toBe(status);
  });

  it('returns the light plan status for the request tenant context', async () => {
    const planStatus = { enabled: true, plan: 'pro' };
    getPlanStatus.mockResolvedValue(planStatus);
    const ctx = { tenantId: 't1', userId: 'u1' };
    const result = await controller.plan(ctx as never);
    expect(getPlanStatus).toHaveBeenCalledWith(ctx);
    expect(result).toBe(planStatus);
  });

  it('updates billing email preferences for the request tenant context', async () => {
    const preferences = { usageAlerts: false };
    updateBillingEmailPreferences.mockResolvedValue(preferences);
    const ctx = { tenantId: 't1', userId: 'u1' };

    const result = await controller.updateEmailPreferences(ctx as never, preferences);

    expect(updateBillingEmailPreferences).toHaveBeenCalledWith(ctx, preferences);
    expect(result).toBe(preferences);
  });
});
