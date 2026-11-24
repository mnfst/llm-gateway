import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { NotificationsController } from './notifications.controller';
import { NotificationRulesService } from './services/notification-rules.service';
import { NotificationLogService } from './services/notification-log.service';
import { EmailProviderConfigService } from './services/email-provider-config.service';
import { NotificationCronService } from './services/notification-cron.service';
import { TenantCacheService } from '../common/services/tenant-cache.service';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

describe('NotificationsController setNotificationEmail validation', () => {
  let module: TestingModule;
  let controller: NotificationsController;
  let emailProviderConfigService: jest.Mocked<EmailProviderConfigService>;

  beforeEach(async () => {
    const mockEmailProviderConfigService = {
      getConfig: jest.fn(),
      upsert: jest.fn(),
      remove: jest.fn(),
      testConfig: jest.fn(),
      testSavedConfig: jest.fn(),
      getNotificationEmail: jest.fn(),
      setNotificationEmail: jest.fn(),
    };

    module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationRulesService,
          useValue: {
            listRules: jest.fn(),
            createRule: jest.fn(),
            updateRule: jest.fn(),
            deleteRule: jest.fn(),
            getRule: jest.fn(),
            getOwnedRule: jest.fn(),
          },
        },
        { provide: NotificationLogService, useValue: { getLogsForAgent: jest.fn() } },
        { provide: EmailProviderConfigService, useValue: mockEmailProviderConfigService },
        { provide: NotificationCronService, useValue: { checkThresholds: jest.fn() } },
      ],
    }).compile();

    controller = module.get(NotificationsController);
    emailProviderConfigService = module.get(EmailProviderConfigService);
  });

  it('propagates BadRequestException when email is an empty string', async () => {
    emailProviderConfigService.setNotificationEmail.mockRejectedValue(
      new BadRequestException('Notification email must be a non-empty string'),
    );

    await expect(controller.setNotificationEmail(ctx, { email: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(emailProviderConfigService.setNotificationEmail).toHaveBeenCalledWith('tenant-1', '');
  });

  it('propagates BadRequestException when email is whitespace only (spaces)', async () => {
    emailProviderConfigService.setNotificationEmail.mockRejectedValue(
      new BadRequestException('Notification email must be a non-empty string'),
    );

    await expect(controller.setNotificationEmail(ctx, { email: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(emailProviderConfigService.setNotificationEmail).toHaveBeenCalledWith('tenant-1', '   ');
  });

  it('propagates BadRequestException when email is whitespace only (tabs and newlines)', async () => {
    emailProviderConfigService.setNotificationEmail.mockRejectedValue(
      new BadRequestException('Notification email must be a non-empty string'),
    );

    await expect(controller.setNotificationEmail(ctx, { email: '\t\n\r ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(emailProviderConfigService.setNotificationEmail).toHaveBeenCalledWith(
      'tenant-1',
      '\t\n\r ',
    );
  });

  it('does not call setNotificationEmail with persisted writes after rejection', async () => {
    emailProviderConfigService.setNotificationEmail.mockRejectedValue(
      new BadRequestException('Notification email must be a non-empty string'),
    );

    await expect(controller.setNotificationEmail(ctx, { email: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // The controller should not have returned a saved:true payload — assert that
    // a rejected promise short-circuits the `return { saved: true }` line.
    expect(emailProviderConfigService.setNotificationEmail).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid non-empty email and returns saved: true', async () => {
    emailProviderConfigService.setNotificationEmail.mockResolvedValue(undefined);

    const result = await controller.setNotificationEmail(ctx, { email: 'alerts@test.com' });

    expect(emailProviderConfigService.setNotificationEmail).toHaveBeenCalledWith(
      'tenant-1',
      'alerts@test.com',
    );
    expect(result).toEqual({ saved: true });
  });
});

describe('EmailProviderConfigService.setNotificationEmail empty/whitespace handling', () => {
  // Direct unit tests on the service method that the controller delegates to.
  // The controller-level tests above only assert propagation; these assert
  // that the service itself rejects empty/whitespace input before touching
  // the database.

  function createMockDataSource() {
    return {
      query: jest.fn().mockResolvedValue([]),
      options: { type: 'postgres' },
    } as unknown as DataSource;
  }

  const mockConfigService = {
    get: (_key: string, fallback?: string) => fallback,
  } as unknown as ConfigService;

  const mockTenantCache = {
    ensureForUser: jest.fn().mockResolvedValue('tenant-1'),
    resolve: jest.fn().mockResolvedValue('tenant-1'),
    invalidate: jest.fn(),
  } as unknown as TenantCacheService;

  it('throws BadRequestException for empty string without querying the database', async () => {
    const ds = createMockDataSource();
    const service = new EmailProviderConfigService(ds, mockConfigService, mockTenantCache);

    await expect(service.setNotificationEmail('tenant-1', '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for whitespace-only input without querying the database', async () => {
    const ds = createMockDataSource();
    const service = new EmailProviderConfigService(ds, mockConfigService, mockTenantCache);

    await expect(service.setNotificationEmail('tenant-1', '   \t\n')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for non-string (cast) input without querying the database', async () => {
    const ds = createMockDataSource();
    const service = new EmailProviderConfigService(ds, mockConfigService, mockTenantCache);

    await expect(
      service.setNotificationEmail('tenant-1', undefined as unknown as string),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ds.query).not.toHaveBeenCalled();
  });

  it('still updates the DB when a valid trimmed email is provided', async () => {
    // First query returns an existing row, second is the UPDATE.
    const ds = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'existing-1' }])
        .mockResolvedValueOnce([]),
      options: { type: 'postgres' },
    } as unknown as DataSource;
    const service = new EmailProviderConfigService(ds, mockConfigService, mockTenantCache);

    await service.setNotificationEmail('tenant-1', '  Alerts@Test.COM  ');

    expect(ds.query).toHaveBeenCalledTimes(2);
    // Second call is the UPDATE — confirm the email was lowercased & trimmed.
    const updateCall = (ds.query as jest.Mock).mock.calls[1];
    expect(updateCall[1][0]).toBe('alerts@test.com');
    expect(updateCall[1][2]).toBe('tenant-1');
  });
});
