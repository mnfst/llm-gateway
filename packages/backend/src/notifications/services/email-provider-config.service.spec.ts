jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

jest.mock('@react-email/render', () => ({
  render: jest.fn().mockResolvedValue('<html>test</html>'),
}));

jest.mock('../emails/test-email', () => ({
  TestEmail: jest.fn(() => 'mock-test-email'),
}));

jest.mock('./email-providers/resolve-provider', () => ({
  createProvider: jest.fn(() => ({
    send: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../../common/utils/crypto.util', () => ({
  encrypt: jest.fn((plaintext: string) => `ENC:${plaintext}`),
  decrypt: jest.fn((ciphertext: string) => ciphertext.replace('ENC:', '')),
  isEncrypted: jest.fn((value: string) => value.startsWith('ENC:')),
  getEncryptionSecret: jest.fn(() => 'test-secret-32-chars-long-enough!!'),
  getDecryptionSecrets: jest.fn(() => ['test-secret-32-chars-long-enough!!']),
  decryptWithAny: jest.fn((ciphertext: string, secrets: string[]) => {
    const mod = jest.requireMock('../../common/utils/crypto.util') as {
      decrypt: (c: string, s: string) => string;
    };
    return { plaintext: mod.decrypt(ciphertext, secrets[0]), secretIndex: 0 };
  }),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailProviderConfigService } from './email-provider-config.service';
import { createProvider } from './email-providers/resolve-provider';
import { TenantCacheService } from '../../common/services/tenant-cache.service';

const mockConfigService = {
  get: (key: string, fallback?: string) =>
    ({ 'app.notificationFromEmail': 'noreply@manifest.build' })[key] ?? fallback,
} as unknown as ConfigService;

function createMockTenantCache(ensuredTenantId = 'tenant-1') {
  return {
    ensureForUser: jest.fn().mockResolvedValue(ensuredTenantId),
    resolve: jest.fn().mockResolvedValue(ensuredTenantId),
    invalidate: jest.fn(),
  } as unknown as TenantCacheService;
}

/** A context with a known tenant — the common authenticated case. */
const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

function createMockDataSource(rows: Record<string, unknown>[][] = [[]]) {
  let callIndex = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const result = rows[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    }),
    options: { type: 'postgres' },
  } as any;
}

describe('EmailProviderConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- getConfig ---
  describe('getConfig', () => {
    it('returns null when no config exists', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getConfig('tenant-1');
      expect(result).toBeNull();
    });

    it('returns public config with keyPrefix', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            domain: 'example.com',
            key_prefix: 're_abcde',
            is_active: 1,
            notification_email: 'alerts@test.com',
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getConfig('tenant-1');
      expect(result).toEqual({
        provider: 'resend',
        domain: 'example.com',
        keyPrefix: 're_abcde',
        is_active: true,
        notificationEmail: 'alerts@test.com',
      });
    });

    it('returns null domain and email when not set', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            domain: undefined,
            key_prefix: 're_testk',
            is_active: 1,
            notification_email: undefined,
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getConfig('tenant-1');
      expect(result!.domain).toBeNull();
      expect(result!.notificationEmail).toBeNull();
    });

    it('returns **** when key_prefix is null (legacy data)', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            domain: null,
            key_prefix: null,
            is_active: 1,
            notification_email: null,
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getConfig('tenant-1');
      expect(result!.keyPrefix).toBe('****');
    });
  });

  // --- upsert ---
  describe('upsert', () => {
    it('inserts new config when none exists', async () => {
      const ds = createMockDataSource([
        [], // SELECT existing
        [], // INSERT
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.upsert(ctx, {
        provider: 'resend',
        apiKey: 're_testkey12345678',
        notificationEmail: 'test@test.com',
      });
      expect(result.provider).toBe('resend');
      expect(result.is_active).toBe(true);
      expect(result.keyPrefix).toBe('re_testk');
      expect(result.notificationEmail).toBe('test@test.com');
      expect(ds.query).toHaveBeenCalledTimes(2);
    });

    it('updates existing config with new API key', async () => {
      const ds = createMockDataSource([
        [{ id: 'existing-id', api_key_encrypted: 're_oldkey12345678' }], // SELECT existing
        [], // UPDATE
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.upsert(ctx, {
        provider: 'resend',
        apiKey: 're_newkey12345678',
      });
      expect(result.provider).toBe('resend');
      expect(result.keyPrefix).toBe('re_newke');
    });

    it('updates without API key — keeps existing key', async () => {
      const ds = createMockDataSource([
        [{ id: 'existing-id', api_key_encrypted: 'ENC:re_existingkey123', key_prefix: 're_exist' }],
        [], // UPDATE
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.upsert(ctx, {
        provider: 'resend',
        notificationEmail: 'new@test.com',
      });
      expect(result.provider).toBe('resend');
      expect(result.keyPrefix).toBe('re_exist');
      expect(result.notificationEmail).toBe('new@test.com');
    });

    it('throws when existing config has invalid provider config on update without new API key', async () => {
      const ds = createMockDataSource([
        [{ id: 'existing-id', api_key_encrypted: 'ENC:short' }], // existing with short key
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await expect(service.upsert(ctx, { provider: 'mailgun' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws when no existing config and no API key', async () => {
      const ds = createMockDataSource([
        [], // no existing
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await expect(service.upsert(ctx, { provider: 'resend' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws on invalid provider config', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await expect(service.upsert(ctx, { provider: 'resend', apiKey: 'invalid' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('normalizes notification email', async () => {
      const ds = createMockDataSource([[], []]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.upsert(ctx, {
        provider: 'resend',
        apiKey: 're_testkey12345678',
        notificationEmail: '  User@Test.COM  ',
      });
      expect(result.notificationEmail).toBe('user@test.com');
    });

    it('handles mailgun with domain', async () => {
      const ds = createMockDataSource([[], []]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.upsert(ctx, {
        provider: 'mailgun',
        apiKey: 'key-1234567890abc',
        domain: 'mg.example.com',
      });
      expect(result.provider).toBe('mailgun');
      expect(result.domain).toBe('mg.example.com');
    });

    it('lazily creates a tenant when ctx has no tenantId yet', async () => {
      const ds = createMockDataSource([[], []]);
      const tenantCache = createMockTenantCache('tenant-new');
      const service = new EmailProviderConfigService(ds, mockConfigService, tenantCache);
      const result = await service.upsert(
        { tenantId: null, userId: 'user-1' },
        { provider: 'resend', apiKey: 're_testkey12345678' },
      );
      expect(tenantCache.ensureForUser).toHaveBeenCalledWith('user-1');
      expect(result.provider).toBe('resend');
      // INSERT scopes by the freshly created tenant id.
      const insertParams = ds.query.mock.calls[1][1];
      expect(insertParams[1]).toBe('tenant-new');
    });

    it('throws NotFoundException when ctx has neither tenantId nor userId', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await expect(
        service.upsert(
          { tenantId: null, userId: null },
          { provider: 'resend', apiKey: 're_testkey12345678' },
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // --- remove ---
  describe('remove', () => {
    it('deletes config for user', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await service.remove('tenant-1');
      expect(ds.query).toHaveBeenCalledTimes(1);
    });
  });

  // --- getFullConfig ---
  describe('getFullConfig', () => {
    it('returns null when no active config', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getFullConfig('tenant-1');
      expect(result).toBeNull();
    });

    it('returns full config with decrypted API key', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            api_key_encrypted: 'ENC:re_fullkey12345678',
            domain: 'example.com',
            notification_email: 'alerts@test.com',
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getFullConfig('tenant-1');
      expect(result).toEqual({
        provider: 'resend',
        apiKey: 're_fullkey12345678',
        domain: 'example.com',
        notificationEmail: 'alerts@test.com',
      });
    });

    it('returns plaintext key for backwards compatibility', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            api_key_encrypted: 're_plaintext_legacy_key',
            domain: null,
            notification_email: null,
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getFullConfig('tenant-1');
      expect(result!.apiKey).toBe('re_plaintext_legacy_key');
    });

    it('returns null domain and email when not set', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            api_key_encrypted: 'ENC:re_fullkey12345678',
            domain: undefined,
            notification_email: undefined,
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getFullConfig('tenant-1');
      expect(result!.domain).toBeNull();
      expect(result!.notificationEmail).toBeNull();
    });
  });

  // --- getNotificationEmail ---
  describe('getNotificationEmail', () => {
    it('returns null when no config exists', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getNotificationEmail('tenant-1');
      expect(result).toBeNull();
    });

    it('returns notification email when set', async () => {
      const ds = createMockDataSource([[{ notification_email: 'alerts@test.com' }]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.getNotificationEmail('tenant-1');
      expect(result).toBe('alerts@test.com');
    });
  });

  // --- setNotificationEmail ---
  describe('setNotificationEmail', () => {
    it('updates email when config exists', async () => {
      const ds = createMockDataSource([
        [{ id: 'existing-id' }], // SELECT existing
        [], // UPDATE
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await service.setNotificationEmail('tenant-1', 'New@Email.COM');
      expect(ds.query).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no config exists', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await service.setNotificationEmail('tenant-1', 'test@test.com');
      expect(ds.query).toHaveBeenCalledTimes(1); // only the SELECT
    });
  });

  // --- testSavedConfig ---
  describe('testSavedConfig', () => {
    it('returns error when no config exists', async () => {
      const ds = createMockDataSource([[]]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.testSavedConfig('tenant-1', 'test@test.com');
      expect(result).toEqual({ success: false, error: 'No email provider configured' });
    });

    it('calls testConfig with decrypted credentials', async () => {
      const ds = createMockDataSource([
        [
          {
            provider: 'resend',
            api_key_encrypted: 'ENC:re_savedkey12345678',
            domain: null,
            notification_email: null,
          },
        ],
      ]);
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.testSavedConfig('tenant-1', 'test@test.com');
      expect(result).toEqual({ success: true });
      expect(createProvider).toHaveBeenCalled();
    });
  });

  // --- testConfig ---
  describe('testConfig', () => {
    it('returns success when provider sends', async () => {
      const ds = createMockDataSource();
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.testConfig(
        { provider: 'resend', apiKey: 're_testkey12345678' },
        'test@test.com',
      );
      expect(result).toEqual({ success: true });
    });

    it('returns error on invalid config', async () => {
      const ds = createMockDataSource();
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.testConfig(
        { provider: 'resend', apiKey: 'bad' },
        'test@test.com',
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error when provider fails', async () => {
      (createProvider as jest.Mock).mockReturnValue({
        send: jest.fn().mockResolvedValue(false),
      });
      const ds = createMockDataSource();
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.testConfig(
        { provider: 'resend', apiKey: 're_testkey12345678' },
        'test@test.com',
      );
      expect(result).toEqual({ success: false, error: 'Provider returned failure' });
    });

    it('returns error on exception', async () => {
      (createProvider as jest.Mock).mockReturnValue({
        send: jest.fn().mockRejectedValue(new Error('Network error')),
      });
      const ds = createMockDataSource();
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      const result = await service.testConfig(
        { provider: 'resend', apiKey: 're_testkey12345678' },
        'test@test.com',
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('uses custom domain in from address when provided', async () => {
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });
      const ds = createMockDataSource();
      const service = new EmailProviderConfigService(
        ds,
        mockConfigService,
        createMockTenantCache(),
      );
      await service.testConfig(
        { provider: 'mailgun', apiKey: 'key-1234567890abc', domain: 'mg.example.com' },
        'test@test.com',
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Manifest <noreply@mg.example.com>',
        }),
      );
    });
  });
});
