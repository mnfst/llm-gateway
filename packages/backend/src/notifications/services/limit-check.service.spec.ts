import { LimitCheckService } from './limit-check.service';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationEmailService } from './notification-email.service';
import { EmailProviderConfigService } from './email-provider-config.service';
import { NotificationLogService } from './notification-log.service';
import { ManifestRuntimeService } from '../../common/services/manifest-runtime.service';

describe('LimitCheckService', () => {
  let service: LimitCheckService;
  let mockGetActiveBlockRules: jest.Mock;
  let mockGetConsumption: jest.Mock;
  let mockSendThresholdAlert: jest.Mock;
  let mockGetFullConfig: jest.Mock;
  let mockHasAlreadySent: jest.Mock;
  let mockInsertLog: jest.Mock;
  let mockResolveRecipientEmail: jest.Mock;
  let mockRuntime: { getAuthBaseUrl: jest.Mock };

  beforeEach(() => {
    mockGetActiveBlockRules = jest.fn().mockResolvedValue([]);
    mockGetConsumption = jest.fn().mockResolvedValue(0);

    const rulesService = {
      getActiveBlockRules: mockGetActiveBlockRules,
      getConsumption: mockGetConsumption,
    } as unknown as NotificationRulesService;

    mockSendThresholdAlert = jest.fn().mockResolvedValue(true);
    const emailService = {
      sendThresholdAlert: mockSendThresholdAlert,
    } as unknown as NotificationEmailService;

    mockGetFullConfig = jest.fn().mockResolvedValue(null);
    const emailProviderConfig = {
      getFullConfig: mockGetFullConfig,
    } as unknown as EmailProviderConfigService;
    mockRuntime = {
      getAuthBaseUrl: jest.fn().mockReturnValue('http://localhost:3001'),
    };

    mockHasAlreadySent = jest.fn().mockResolvedValue(false);
    mockInsertLog = jest.fn().mockResolvedValue(undefined);
    mockResolveRecipientEmail = jest.fn().mockResolvedValue(null);
    const notificationLog = {
      hasAlreadySent: mockHasAlreadySent,
      insertLog: mockInsertLog,
      resolveRecipientEmail: mockResolveRecipientEmail,
    } as unknown as NotificationLogService;

    service = new LimitCheckService(
      rulesService,
      emailService,
      emailProviderConfig,
      mockRuntime as unknown as ManifestRuntimeService,
      notificationLog,
    );
  });

  it('returns null when no block rules exist', async () => {
    const result = await service.checkLimits('tenant-1', 'my-agent');
    expect(result).toBeNull();
  });

  it('returns null when consumption is below threshold', async () => {
    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'r1',
        tenant_id: 'tenant-1',
        agent_name: 'my-agent',
        metric_type: 'tokens',
        threshold: 50000,
        period: 'day',
      },
    ]);
    mockGetConsumption.mockResolvedValue(30000);

    const result = await service.checkLimits('tenant-1', 'my-agent');
    expect(result).toBeNull();
  });

  it('returns LimitExceeded when consumption meets threshold', async () => {
    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'r1',
        tenant_id: 'tenant-1',
        agent_name: 'my-agent',
        metric_type: 'tokens',
        threshold: 50000,
        period: 'day',
      },
    ]);
    mockGetConsumption.mockResolvedValue(50000);

    const result = await service.checkLimits('tenant-1', 'my-agent');
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('r1');
    expect(result!.metricType).toBe('tokens');
    expect(result!.threshold).toBe(50000);
    expect(result!.actual).toBe(50000);
  });

  it('returns LimitExceeded when consumption exceeds threshold', async () => {
    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'r1',
        tenant_id: 'tenant-1',
        agent_name: 'my-agent',
        metric_type: 'cost',
        threshold: 10,
        period: 'month',
      },
    ]);
    mockGetConsumption.mockResolvedValue(15.5);

    const result = await service.checkLimits('tenant-1', 'my-agent');
    expect(result).not.toBeNull();
    expect(result!.metricType).toBe('cost');
    expect(result!.actual).toBe(15.5);
  });

  it('returns first exceeded rule when multiple rules exist', async () => {
    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'r1',
        tenant_id: 't',
        agent_name: 'a',
        metric_type: 'tokens',
        threshold: 100000,
        period: 'day',
      },
      {
        id: 'r2',
        tenant_id: 't',
        agent_name: 'a',
        metric_type: 'cost',
        threshold: 5,
        period: 'day',
      },
    ]);
    mockGetConsumption
      .mockResolvedValueOnce(50000) // below r1 threshold
      .mockResolvedValueOnce(10); // above r2 threshold

    const result = await service.checkLimits('t', 'a');
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('r2');
  });

  it('reuses consumption for rules with the same metric and period within one request', async () => {
    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'r1',
        tenant_id: 't',
        agent_name: 'a',
        metric_type: 'tokens',
        threshold: 100000,
        period: 'day',
      },
      {
        id: 'r2',
        tenant_id: 't',
        agent_name: 'a',
        metric_type: 'tokens',
        threshold: 50000,
        period: 'day',
      },
    ]);
    mockGetConsumption.mockResolvedValue(75000);

    await expect(service.checkLimits('t', 'a')).resolves.toEqual(
      expect.objectContaining({ ruleId: 'r2', actual: 75000 }),
    );
    expect(mockGetConsumption).toHaveBeenCalledTimes(1);
  });

  it('enforces a block rule created through another replica on the next request', async () => {
    await expect(service.checkLimits('tenant-1', 'my-agent')).resolves.toBeNull();

    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'new-rule',
        tenant_id: 'tenant-1',
        agent_name: 'my-agent',
        metric_type: 'tokens',
        threshold: 100,
        period: 'day',
      },
    ]);
    mockGetConsumption.mockResolvedValue(100);

    await expect(service.checkLimits('tenant-1', 'my-agent')).resolves.toEqual(
      expect.objectContaining({ ruleId: 'new-rule', actual: 100 }),
    );
    expect(mockGetActiveBlockRules).toHaveBeenCalledTimes(2);
  });

  it('uses current consumption on every request', async () => {
    mockGetActiveBlockRules.mockResolvedValue([
      {
        id: 'r1',
        tenant_id: 'tenant-1',
        agent_name: 'my-agent',
        metric_type: 'tokens',
        threshold: 100,
        period: 'day',
      },
    ]);
    mockGetConsumption.mockResolvedValueOnce(99).mockResolvedValueOnce(100);

    await expect(service.checkLimits('tenant-1', 'my-agent')).resolves.toBeNull();
    await expect(service.checkLimits('tenant-1', 'my-agent')).resolves.toEqual(
      expect.objectContaining({ ruleId: 'r1', actual: 100 }),
    );
    expect(mockGetConsumption).toHaveBeenCalledTimes(2);
  });

  describe('email notification on block', () => {
    const rule = {
      id: 'r1',
      tenant_id: 'tenant-1',
      agent_name: 'my-agent',
      metric_type: 'tokens' as const,
      threshold: 50000,
      period: 'day' as const,
    };

    beforeEach(() => {
      mockGetActiveBlockRules.mockResolvedValue([rule]);
      mockGetConsumption.mockResolvedValue(60000);
    });

    it('sends email and logs when limit exceeded first time', async () => {
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');

      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSendThresholdAlert).toHaveBeenCalledWith(
        'test@example.com',
        expect.objectContaining({
          agentName: 'my-agent',
          metricType: 'tokens',
          threshold: 50000,
          actualValue: 60000,
          period: 'day',
          alertType: 'hard',
          periodResetDate: expect.any(String),
        }),
        undefined,
      );
      expect(mockInsertLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'r1',
          actualValue: 60000,
          thresholdValue: 50000,
          metricType: 'tokens',
          agentName: 'my-agent',
        }),
      );
    });

    it('skips email when already notified for this period', async () => {
      mockHasAlreadySent.mockResolvedValue(true);
      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendThresholdAlert).not.toHaveBeenCalled();
    });

    it('logs notification even when no email is resolved', async () => {
      mockResolveRecipientEmail.mockResolvedValue(null);
      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendThresholdAlert).not.toHaveBeenCalled();
      expect(mockInsertLog).toHaveBeenCalled();
    });

    it('logs notification even when email send fails', async () => {
      mockSendThresholdAlert.mockResolvedValue(false);
      mockResolveRecipientEmail.mockResolvedValue('test@example.com');
      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendThresholdAlert).toHaveBeenCalled();
      expect(mockInsertLog).toHaveBeenCalled();
    });

    it('uses email provider config when available', async () => {
      const providerConfig = {
        provider: 'resend',
        apiKey: 'key',
        notificationEmail: 'custom@example.com',
      };
      mockGetFullConfig.mockResolvedValue(providerConfig);
      mockResolveRecipientEmail.mockResolvedValue('custom@example.com');
      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendThresholdAlert).toHaveBeenCalledWith(
        'custom@example.com',
        expect.anything(),
        providerConfig,
      );
    });

    it('suppresses email when resolveRecipientEmail returns null', async () => {
      mockResolveRecipientEmail.mockResolvedValue(null);
      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendThresholdAlert).not.toHaveBeenCalled();
    });

    it('catches and logs error in notifyLimitExceeded', async () => {
      const loggerSpy = jest.spyOn(service['logger'], 'error').mockImplementation();
      mockHasAlreadySent.mockRejectedValue(new Error('DB down'));
      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send block notification'),
      );
      loggerSpy.mockRestore();
    });

    it('includes period field in returned LimitExceeded', async () => {
      const result = await service.checkLimits('tenant-1', 'my-agent');
      expect(result).not.toBeNull();
      expect(result!.period).toBe('day');
    });

    it('passes notificationEmail from provider config to resolveRecipientEmail', async () => {
      const providerConfig = { notificationEmail: 'local-user@real.com' };
      mockGetFullConfig.mockResolvedValue(providerConfig);
      mockResolveRecipientEmail.mockResolvedValue('local-user@real.com');

      await service.checkLimits('tenant-1', 'my-agent');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockResolveRecipientEmail).toHaveBeenCalledWith('tenant-1', 'local-user@real.com');
      expect(mockSendThresholdAlert).toHaveBeenCalledWith(
        'local-user@real.com',
        expect.objectContaining({ agentName: 'my-agent' }),
        providerConfig,
      );
    });
  });
});
