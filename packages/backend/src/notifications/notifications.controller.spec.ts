import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationRulesService } from './services/notification-rules.service';
import { NotificationLogService } from './services/notification-log.service';
import { EmailProviderConfigService } from './services/email-provider-config.service';
import { NotificationCronService } from './services/notification-cron.service';

const mockCtx = { tenantId: 't-1', userId: 'user-1' } as never;

const mockRule = {
  id: 'rule-1',
  tenant_id: 't-1',
  agent_id: 'a-1',
  agent_name: 'my-agent',
  metric_type: 'tokens' as const,
  threshold: 100000,
  period: 'day' as const,
  action: 'notify' as const,
  is_active: true,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

describe('NotificationsController', () => {
  let module: TestingModule;
  let controller: NotificationsController;
  let rulesService: jest.Mocked<NotificationRulesService>;
  let emailProviderConfigService: jest.Mocked<EmailProviderConfigService>;

  beforeEach(async () => {
    const mockRulesService = {
      listRules: jest.fn().mockResolvedValue([mockRule]),
      createRule: jest.fn().mockResolvedValue(mockRule),
      updateRule: jest.fn().mockResolvedValue({ ...mockRule, is_active: false }),
      deleteRule: jest.fn().mockResolvedValue(undefined),
      getRule: jest.fn().mockResolvedValue(mockRule),
      getOwnedRule: jest.fn().mockResolvedValue(mockRule),
    };

    const mockEmailProviderConfigService = {
      getConfig: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({
        provider: 'resend',
        domain: null,
        keyPrefix: 're_test1',
        is_active: true,
        notificationEmail: null,
      }),
      remove: jest.fn().mockResolvedValue(undefined),
      testConfig: jest.fn().mockResolvedValue({ success: true }),
      testSavedConfig: jest.fn().mockResolvedValue({ success: true }),
      getNotificationEmail: jest.fn().mockResolvedValue(null),
      setNotificationEmail: jest.fn().mockResolvedValue(undefined),
    };

    const mockCronService = {
      checkThresholds: jest.fn().mockResolvedValue(2),
    };

    const mockNotificationLog = {
      getLogsForAgent: jest.fn().mockResolvedValue([]),
    };

    module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationRulesService, useValue: mockRulesService },
        { provide: NotificationLogService, useValue: mockNotificationLog },
        { provide: EmailProviderConfigService, useValue: mockEmailProviderConfigService },
        { provide: NotificationCronService, useValue: mockCronService },
      ],
    }).compile();

    controller = module.get(NotificationsController);
    rulesService = module.get(NotificationRulesService);
    emailProviderConfigService = module.get(EmailProviderConfigService);
  });

  it('returns notification logs for an agent', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        sent_at: '2026-01-01 12:00:00',
        actual_value: 60000,
        threshold_value: 50000,
        metric_type: 'tokens',
        period_start: '2026-01-01',
        period_end: '2026-01-02',
        agent_name: 'my-agent',
      },
    ];
    const logService = module.get(NotificationLogService) as jest.Mocked<NotificationLogService>;
    logService.getLogsForAgent.mockResolvedValue(mockLogs);

    const result = await controller.getLogs('my-agent', mockCtx);
    expect(logService.getLogsForAgent).toHaveBeenCalledWith('t-1', 'my-agent');
    expect(result).toEqual(mockLogs);
  });

  it('lists rules for an agent', async () => {
    const result = await controller.listRules('my-agent', mockCtx);
    expect(rulesService.listRules).toHaveBeenCalledWith('t-1', 'my-agent');
    expect(result).toEqual([mockRule]);
  });

  it('creates a rule', async () => {
    const dto = {
      agent_name: 'my-agent',
      metric_type: 'tokens' as const,
      threshold: 100000,
      period: 'day' as const,
    };
    const result = await controller.createRule(dto, mockCtx);
    expect(rulesService.createRule).toHaveBeenCalledWith('t-1', dto);
    expect(result).toEqual(mockRule);
  });

  it('updates a rule', async () => {
    const dto = { is_active: false };
    const result = await controller.updateRule('rule-1', dto, mockCtx);
    expect(rulesService.updateRule).toHaveBeenCalledWith('t-1', 'rule-1', dto);
    expect(result?.is_active).toBe(false);
  });

  it('deletes a rule', async () => {
    const result = await controller.deleteRule('rule-1', mockCtx);
    expect(rulesService.deleteRule).toHaveBeenCalledWith('t-1', 'rule-1');
    expect(result).toEqual({ deleted: true });
  });

  it('returns configured: false when no provider', async () => {
    const result = await controller.getEmailProvider(mockCtx);
    expect(emailProviderConfigService.getConfig).toHaveBeenCalledWith('t-1');
    expect(result).toEqual({ configured: false });
  });

  it('tests email provider config', async () => {
    const dto = {
      provider: 'resend',
      apiKey: 're_testkey123',
      domain: 'example.com',
      to: 'test@test.com',
    } as never;
    const result = await controller.testEmailProvider(mockCtx, dto);
    expect(emailProviderConfigService.testConfig).toHaveBeenCalledWith(
      { provider: 'resend', apiKey: 're_testkey123', domain: 'example.com' },
      'test@test.com',
    );
    expect(result).toEqual({ success: true });
  });

  it('tests sendgrid provider config without domain', async () => {
    const dto = { provider: 'sendgrid', apiKey: 'SG.testkey123456', to: 'test@test.com' } as never;
    const result = await controller.testEmailProvider(mockCtx, dto);
    expect(emailProviderConfigService.testConfig).toHaveBeenCalledWith(
      { provider: 'sendgrid', apiKey: 'SG.testkey123456', domain: undefined },
      'test@test.com',
    );
    expect(result).toEqual({ success: true });
  });

  it('triggers manual notification check', async () => {
    const cronService = module.get(NotificationCronService) as jest.Mocked<NotificationCronService>;
    const result = await controller.triggerCheck(mockCtx);
    expect(cronService.checkThresholds).toHaveBeenCalledWith('t-1');
    expect(result).toEqual({ triggered: 2, message: '2 notification(s) triggered' });
  });

  it('returns null notification email when not set', async () => {
    const result = await controller.getNotificationEmail(mockCtx);
    expect(emailProviderConfigService.getNotificationEmail).toHaveBeenCalledWith('t-1');
    expect(result).toEqual({ email: null });
  });

  it('saves notification email', async () => {
    const result = await controller.setNotificationEmail(mockCtx, { email: 'alerts@test.com' });
    expect(emailProviderConfigService.setNotificationEmail).toHaveBeenCalledWith(
      't-1',
      'alerts@test.com',
    );
    expect(result).toEqual({ saved: true });
  });

  it('saves email provider config', async () => {
    const dto = { provider: 'resend', apiKey: 're_testkey123456' } as never;
    const result = await controller.setEmailProvider(mockCtx, dto);
    expect(emailProviderConfigService.upsert).toHaveBeenCalledWith(mockCtx, dto);
    expect(result.provider).toBe('resend');
  });

  it('saves email provider config without API key (keep existing)', async () => {
    const dto = { provider: 'resend', notificationEmail: 'new@test.com' } as never;
    const result = await controller.setEmailProvider(mockCtx, dto);
    expect(emailProviderConfigService.upsert).toHaveBeenCalledWith(mockCtx, dto);
    expect(result.provider).toBe('resend');
  });

  it('removes email provider config', async () => {
    const result = await controller.removeEmailProvider(mockCtx);
    expect(emailProviderConfigService.remove).toHaveBeenCalledWith('t-1');
    expect(result).toEqual({ ok: true });
  });

  it('returns existing provider config', async () => {
    emailProviderConfigService.getConfig.mockResolvedValue({
      provider: 'sendgrid',
      domain: null,
      keyPrefix: 'SG.abcde',
      is_active: true,
      notificationEmail: 'alerts@test.com',
    });
    const result = await controller.getEmailProvider(mockCtx);
    expect(result).toEqual({
      provider: 'sendgrid',
      domain: null,
      keyPrefix: 'SG.abcde',
      is_active: true,
      notificationEmail: 'alerts@test.com',
    });
  });

  it('tests saved email provider config', async () => {
    const result = await controller.testSavedEmailProvider(mockCtx, { to: 'test@test.com' });
    expect(emailProviderConfigService.testSavedConfig).toHaveBeenCalledWith('t-1', 'test@test.com');
    expect(result).toEqual({ success: true });
  });
});
