jest.mock('./resolve-provider', () => ({
  createProvider: jest.fn(),
}));

import { sendEmail, isEmailConfigured } from './send-email';
import { createProvider } from './resolve-provider';

describe('isEmailConfigured', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['EMAIL_PROVIDER'];
    delete process.env['EMAIL_API_KEY'];
    delete process.env['EMAIL_DOMAIN'];
    delete process.env['MAILGUN_API_KEY'];
    delete process.env['MAILGUN_DOMAIN'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when no provider is configured', () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it('returns true for the unified EMAIL_* scheme', () => {
    process.env['EMAIL_PROVIDER'] = 'resend';
    process.env['EMAIL_API_KEY'] = 're_key';
    expect(isEmailConfigured()).toBe(true);
  });

  it('returns false for mailgun without a domain', () => {
    process.env['EMAIL_PROVIDER'] = 'mailgun';
    process.env['EMAIL_API_KEY'] = 'key';
    expect(isEmailConfigured()).toBe(false);
  });

  it('honors an explicit env override argument', () => {
    expect(isEmailConfigured({ emailProvider: 'resend', emailApiKey: 're_key' })).toBe(true);
  });
});

describe('sendEmail', () => {
  const originalEnv = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['EMAIL_PROVIDER'];
    delete process.env['EMAIL_API_KEY'];
    delete process.env['EMAIL_DOMAIN'];
    delete process.env['EMAIL_FROM'];
    delete process.env['MAILGUN_API_KEY'];
    delete process.env['MAILGUN_DOMAIN'];
    delete process.env['NOTIFICATION_FROM_EMAIL'];
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    warnSpy.mockRestore();
  });

  describe('unified EMAIL_* scheme', () => {
    it('uses Resend with just API key (no domain required)', async () => {
      process.env['EMAIL_PROVIDER'] = 'resend';
      process.env['EMAIL_API_KEY'] = 're_key';
      process.env['EMAIL_FROM'] = 'noreply@example.com';
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });

      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(true);
      expect(createProvider).toHaveBeenCalledWith({
        provider: 'resend',
        apiKey: 're_key',
        domain: undefined,
        fromEmail: 'noreply@example.com',
      });
    });

    it('uses Mailgun with EMAIL_PROVIDER + EMAIL_DOMAIN', async () => {
      process.env['EMAIL_PROVIDER'] = 'mailgun';
      process.env['EMAIL_API_KEY'] = 'mg-key';
      process.env['EMAIL_DOMAIN'] = 'mg.example.com';
      process.env['EMAIL_FROM'] = 'noreply@mg.example.com';
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });

      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(true);
      expect(createProvider).toHaveBeenCalledWith({
        provider: 'mailgun',
        apiKey: 'mg-key',
        domain: 'mg.example.com',
        fromEmail: 'noreply@mg.example.com',
      });
    });

    it('returns false and warns when EMAIL_PROVIDER=mailgun has no EMAIL_DOMAIN', async () => {
      process.env['EMAIL_PROVIDER'] = 'mailgun';
      process.env['EMAIL_API_KEY'] = 'mg-key';

      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(false);
      expect(createProvider).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('EMAIL_PROVIDER=mailgun requires EMAIL_DOMAIN'),
      );
    });

    it('uses SendGrid with just API key', async () => {
      process.env['EMAIL_PROVIDER'] = 'sendgrid';
      process.env['EMAIL_API_KEY'] = 'SG.key';
      process.env['EMAIL_FROM'] = 'noreply@example.com';
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });

      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(true);
      expect(createProvider).toHaveBeenCalledWith({
        provider: 'sendgrid',
        apiKey: 'SG.key',
        domain: undefined,
        fromEmail: 'noreply@example.com',
      });
    });

    it('returns false and warns when EMAIL_PROVIDER is invalid', async () => {
      process.env['EMAIL_PROVIDER'] = 'postmark';
      process.env['EMAIL_API_KEY'] = 'some-key';

      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(false);
      expect(createProvider).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown EMAIL_PROVIDER=postmark'),
      );
    });

    it('falls back to NOTIFICATION_FROM_EMAIL when EMAIL_FROM not set', async () => {
      process.env['EMAIL_PROVIDER'] = 'resend';
      process.env['EMAIL_API_KEY'] = 're_key';
      process.env['NOTIFICATION_FROM_EMAIL'] = 'legacy@example.com';
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });

      await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ fromEmail: 'legacy@example.com' }),
      );
    });
  });

  describe('legacy Mailgun env vars', () => {
    it('uses MAILGUN_* env vars when EMAIL_* not set', async () => {
      process.env['MAILGUN_API_KEY'] = 'mg-key';
      process.env['MAILGUN_DOMAIN'] = 'mg.test.com';
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });

      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(true);
      expect(createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'mailgun', apiKey: 'mg-key', domain: 'mg.test.com' }),
      );
    });
  });

  describe('no config', () => {
    it('returns false and warns when nothing is configured', async () => {
      const result = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' });

      expect(result).toBe(false);
      expect(createProvider).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No email provider configured'));
    });
  });

  describe('env override (explicit arg)', () => {
    it('prefers env arg over process.env', async () => {
      process.env['EMAIL_PROVIDER'] = 'mailgun';
      process.env['EMAIL_API_KEY'] = 'wrong';
      process.env['EMAIL_DOMAIN'] = 'wrong.com';
      const mockSend = jest.fn().mockResolvedValue(true);
      (createProvider as jest.Mock).mockReturnValue({ send: mockSend });

      await sendEmail(
        { to: 'a@b.com', subject: 'Hi', html: '<p>Hello</p>' },
        {
          emailProvider: 'resend',
          emailApiKey: 're_override',
          emailFrom: 'override@example.com',
        },
      );

      expect(createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'resend', apiKey: 're_override' }),
      );
    });
  });
});
