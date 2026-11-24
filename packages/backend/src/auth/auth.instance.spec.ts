import type { AuthSession, AuthUser } from './auth.instance';

const mockBetterAuth = jest.fn().mockReturnValue({
  $Infer: { Session: {} },
  api: {},
});

jest.mock('better-auth', () => ({ betterAuth: mockBetterAuth }));
jest.mock('pg', () => ({ Pool: jest.fn() }));
const mockStripePlugin = jest.fn().mockReturnValue({ id: 'stripe' });
jest.mock('@better-auth/stripe', () => ({ stripe: mockStripePlugin }));
// The MCP/OAuth plugins are ESM-only. Jest (Node 22) cannot require them, so
// this spec mocks them exactly as it already mocks `better-auth` itself.
jest.mock('better-auth/plugins', () => ({
  jwt: jest.fn().mockReturnValue({ id: 'jwt' }),
}));
jest.mock('@better-auth/mcp', () => ({
  mcp: jest.fn().mockReturnValue({ id: 'mcp' }),
}));
jest.mock('@better-auth/cimd', () => ({
  cimd: jest.fn().mockReturnValue({ id: 'cimd' }),
}));
jest.mock('@better-auth/core/utils/host', () => ({
  isPublicRoutableHost: jest.fn().mockReturnValue(true),
}));
jest.mock('@react-email/render', () => ({
  render: jest
    .fn()
    .mockImplementation((_el: unknown, opts?: { plainText?: boolean }) =>
      Promise.resolve(opts?.plainText ? 'plain text version' : '<html>rendered</html>'),
    ),
}));
jest.mock('../notifications/emails/verify-email', () => ({
  VerifyEmailEmail: jest.fn().mockReturnValue('verify-email-element'),
}));
jest.mock('../notifications/emails/reset-password', () => ({
  ResetPasswordEmail: jest.fn().mockReturnValue('reset-password-element'),
}));
jest.mock('../notifications/services/email-providers/send-email', () => ({
  sendEmail: jest.fn(),
}));
jest.mock('../billing/subscription-webhook-emails', () => ({
  previousPlanFromEvent: jest.fn().mockReturnValue(null),
  sendPlanChangedEmail: jest.fn().mockResolvedValue(true),
  sendSubscriptionCanceledEmail: jest.fn().mockResolvedValue(true),
  sendSubscriptionConfirmedEmail: jest.fn().mockResolvedValue(true),
}));

describe('auth.instance', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    mockBetterAuth.mockClear();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'a]3kF9!xLm2@pQzR7^wYu4&vN6*cE0hT',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function loadModule() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./auth.instance') as typeof import('./auth.instance');
  }

  it('exports a defined auth object', () => {
    const mod = loadModule();
    expect(mod.auth).toBeDefined();
  });

  it('calls betterAuth with telemetry disabled', () => {
    loadModule();

    expect(mockBetterAuth).toHaveBeenCalledTimes(1);
    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.telemetry).toEqual({ enabled: false });
  });

  it('caches the session in a signed cookie so validation skips the database', () => {
    // Every authenticated request validates the session. In production the
    // database round trip behind that costs ~0.5 s per call on the Railway
    // path even though the statements themselves take 0.3 ms, and it is paid
    // by the browser's get-session probe and by every SessionGuard cache miss.
    // The cookie cache answers from the signed cookie until maxAge, so a
    // revoked session can linger for at most that long.
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.session).toEqual({ cookieCache: { enabled: true, maxAge: 5 * 60 } });
  });

  it('does not set skipStateCookieCheck in account config', () => {
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.account).toBeDefined();
    expect(config.account).not.toHaveProperty('skipStateCookieCheck');
  });

  it('enables account linking with trusted providers', () => {
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.account.accountLinking).toEqual({
      enabled: true,
      trustedProviders: ['google', 'github', 'discord'],
    });
  });

  it('sets basePath to /api/auth', () => {
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.basePath).toBe('/api/auth');
  });

  it('enables emailAndPassword with min length 8', () => {
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.emailAndPassword.enabled).toBe(true);
    expect(config.emailAndPassword.minPasswordLength).toBe(8);
  });

  it('does not require email verification when NODE_ENV is not production', () => {
    process.env['NODE_ENV'] = 'test';
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.emailAndPassword.requireEmailVerification).toBe(false);
  });

  it('requires email verification in production when email provider is configured', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BETTER_AUTH_SECRET'] = 'a]3kF9!xLm2@pQzR7^wYu4&vN6*cE0hT';
    process.env['MAILGUN_API_KEY'] = 'key-test';
    process.env['MAILGUN_DOMAIN'] = 'mg.example.com';
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.emailAndPassword.requireEmailVerification).toBe(true);
  });

  it('does not require email verification in production when no email provider is configured', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['BETTER_AUTH_SECRET'] = 'a]3kF9!xLm2@pQzR7^wYu4&vN6*cE0hT';
    delete process.env['MAILGUN_API_KEY'];
    delete process.env['MAILGUN_DOMAIN'];
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.emailAndPassword.requireEmailVerification).toBe(false);
  });

  it('does not require email verification in development', () => {
    process.env['NODE_ENV'] = 'development';
    loadModule();

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.emailAndPassword.requireEmailVerification).toBe(false);
  });

  describe('trusted origins', () => {
    it('includes default localhost origins', () => {
      delete process.env['BETTER_AUTH_URL'];
      delete process.env['CORS_ORIGIN'];
      delete process.env['FRONTEND_PORT'];
      process.env['PORT'] = '3001';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.trustedOrigins).toContain('http://localhost:3000');
      expect(config.trustedOrigins).toContain('http://127.0.0.1:3000');
      expect(config.trustedOrigins).toContain('http://localhost:3001');
      expect(config.trustedOrigins).toContain('http://127.0.0.1:3001');
    });

    it('includes BETTER_AUTH_URL when set', () => {
      process.env['BETTER_AUTH_URL'] = 'https://app.example.com';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.trustedOrigins).toContain('https://app.example.com');
    });

    it('includes CORS_ORIGIN when set', () => {
      process.env['CORS_ORIGIN'] = 'https://frontend.example.com';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.trustedOrigins).toContain('https://frontend.example.com');
    });

    it('includes FRONTEND_PORT origin when set', () => {
      process.env['FRONTEND_PORT'] = '4000';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.trustedOrigins).toContain('http://localhost:4000');
      expect(config.trustedOrigins).toContain('http://127.0.0.1:4000');
    });

    it('does not include localhost origins in production mode', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['BETTER_AUTH_SECRET'] = 'a]3kF9!xLm2@pQzR7^wYu4&vN6*cE0hT';
      delete process.env['BETTER_AUTH_URL'];
      delete process.env['CORS_ORIGIN'];
      delete process.env['FRONTEND_PORT'];
      process.env['PORT'] = '3001';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.trustedOrigins).not.toContain('http://localhost:3000');
      expect(config.trustedOrigins).not.toContain('http://127.0.0.1:3000');
      expect(config.trustedOrigins).not.toContain('http://localhost:3001');
      expect(config.trustedOrigins).not.toContain('http://127.0.0.1:3001');
    });
  });

  describe('social providers', () => {
    it('disables google when env vars are missing', () => {
      delete process.env['GOOGLE_CLIENT_ID'];
      delete process.env['GOOGLE_CLIENT_SECRET'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.socialProviders.google.enabled).toBe(false);
    });

    it('enables google when both env vars are set', () => {
      process.env['GOOGLE_CLIENT_ID'] = 'google-id';
      process.env['GOOGLE_CLIENT_SECRET'] = 'google-secret';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.socialProviders.google.enabled).toBe(true);
      expect(config.socialProviders.google.clientId).toBe('google-id');
    });

    it('disables github when env vars are missing', () => {
      delete process.env['GITHUB_CLIENT_ID'];
      delete process.env['GITHUB_CLIENT_SECRET'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.socialProviders.github.enabled).toBe(false);
    });

    it('disables discord when env vars are missing', () => {
      delete process.env['DISCORD_CLIENT_ID'];
      delete process.env['DISCORD_CLIENT_SECRET'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.socialProviders.discord.enabled).toBe(false);
    });
  });

  describe('secret validation', () => {
    it('skips validation when NODE_ENV is test', () => {
      process.env['NODE_ENV'] = 'test';
      process.env['BETTER_AUTH_SECRET'] = '';
      expect(() => loadModule()).not.toThrow();
    });

    it('throws when secret is missing in non-test env', () => {
      process.env['NODE_ENV'] = 'development';
      process.env['BETTER_AUTH_SECRET'] = '';
      expect(() => loadModule()).toThrow(
        'BETTER_AUTH_SECRET must be set to a value of at least 32 characters',
      );
    });

    it('throws when secret is too short in non-test env', () => {
      process.env['NODE_ENV'] = 'production';
      process.env['BETTER_AUTH_SECRET'] = 'short';
      expect(() => loadModule()).toThrow(
        'BETTER_AUTH_SECRET must be set to a value of at least 32 characters',
      );
    });
  });

  describe('sendResetPassword callback', () => {
    it('renders the reset password email and calls sendEmail', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ResetPasswordEmail } = require('../notifications/emails/reset-password') as {
        ResetPasswordEmail: jest.Mock;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sendEmail } = require('../notifications/services/email-providers/send-email') as {
        sendEmail: jest.Mock;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { render } = require('@react-email/render') as { render: jest.Mock };

      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      const sendResetPassword = config.emailAndPassword.sendResetPassword;

      const mockUser = { name: 'Jane Doe', email: 'jane@example.com' };
      const mockUrl = 'https://app.example.com/reset?token=abc123';

      await sendResetPassword({ user: mockUser, url: mockUrl });

      expect(ResetPasswordEmail).toHaveBeenCalledWith({
        userName: 'Jane Doe',
        resetUrl: mockUrl,
      });
      expect(render).toHaveBeenCalledTimes(2);
      expect(render).toHaveBeenCalledWith('reset-password-element');
      expect(render).toHaveBeenCalledWith('reset-password-element', { plainText: true });
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'jane@example.com',
        subject: 'Reset your password',
        html: '<html>rendered</html>',
        text: 'plain text version',
      });
    });
  });

  describe('sendVerificationEmail callback', () => {
    it('renders the verification email and calls sendEmail', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { VerifyEmailEmail } = require('../notifications/emails/verify-email') as {
        VerifyEmailEmail: jest.Mock;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sendEmail } = require('../notifications/services/email-providers/send-email') as {
        sendEmail: jest.Mock;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { render } = require('@react-email/render') as { render: jest.Mock };

      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      const sendVerificationEmail = config.emailVerification.sendVerificationEmail;

      const mockUser = { name: 'John Doe', email: 'john@example.com' };
      const mockUrl = 'https://app.example.com/verify?token=xyz789';

      await sendVerificationEmail({ user: mockUser, url: mockUrl });

      expect(VerifyEmailEmail).toHaveBeenCalledWith({
        userName: 'John Doe',
        verificationUrl: mockUrl,
      });
      expect(render).toHaveBeenCalledWith('verify-email-element');
      expect(render).toHaveBeenCalledWith('verify-email-element', { plainText: true });
      expect(sendEmail).toHaveBeenCalledWith({
        to: 'john@example.com',
        subject: 'Verify your email address',
        html: '<html>rendered</html>',
        text: 'plain text version',
      });
    });

    it('sends verification email on sign-up when Mailgun email provider is configured', () => {
      process.env['MAILGUN_API_KEY'] = 'key-test';
      process.env['MAILGUN_DOMAIN'] = 'mg.example.com';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.emailVerification.sendOnSignUp).toBe(true);
    });

    it('sends verification email on sign-up when unified EMAIL_* is configured', () => {
      process.env['EMAIL_PROVIDER'] = 'resend';
      process.env['EMAIL_API_KEY'] = 're_test';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.emailVerification.sendOnSignUp).toBe(true);
    });

    it('does not send verification email on sign-up when no email provider is configured', () => {
      delete process.env['MAILGUN_API_KEY'];
      delete process.env['MAILGUN_DOMAIN'];
      delete process.env['EMAIL_PROVIDER'];
      delete process.env['EMAIL_API_KEY'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.emailVerification.sendOnSignUp).toBe(false);
    });

    it('enables autoSignInAfterVerification', () => {
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.emailVerification.autoSignInAfterVerification).toBe(true);
    });
  });

  describe('database connection', () => {
    it('uses DATABASE_URL from environment', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require('pg') as { Pool: jest.Mock };
      process.env['DATABASE_URL'] = 'postgresql://test:test@db:5432/testdb';

      loadModule();

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: 'postgresql://test:test@db:5432/testdb',
        }),
      );
    });

    it('falls back to default DATABASE_URL when not set', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require('pg') as { Pool: jest.Mock };
      delete process.env['DATABASE_URL'];

      loadModule();

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: 'postgresql://myuser:mypassword@localhost:5432/mydatabase',
        }),
      );
    });

    it('caps the pool size and reaps idle connections by default', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require('pg') as { Pool: jest.Mock };
      delete process.env['AUTH_DB_POOL_MAX'];

      loadModule();

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({ max: 5, idleTimeoutMillis: 30000 }),
      );
    });

    it('reads AUTH_DB_POOL_MAX from env', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require('pg') as { Pool: jest.Mock };
      process.env['AUTH_DB_POOL_MAX'] = '25';

      loadModule();

      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 25 }));
    });

    it.each(['', '0', '-1', '1.5', 'Infinity', '5abc'])(
      'uses the default AUTH_DB_POOL_MAX for invalid value %p',
      (value) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Pool } = require('pg') as { Pool: jest.Mock };
        process.env['AUTH_DB_POOL_MAX'] = value;

        loadModule();

        expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 5 }));
      },
    );
  });

  describe('baseURL configuration', () => {
    it('uses BETTER_AUTH_URL when set', () => {
      process.env['BETTER_AUTH_URL'] = 'https://auth.example.com';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toBe('https://auth.example.com');
    });

    it('falls back to localhost with PORT when BETTER_AUTH_URL is not set', () => {
      delete process.env['BETTER_AUTH_URL'];
      process.env['PORT'] = '4000';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toBe('http://localhost:4000');
    });

    it('falls back to localhost:3001 when neither BETTER_AUTH_URL nor PORT is set', () => {
      delete process.env['BETTER_AUTH_URL'];
      delete process.env['PORT'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toBe('http://localhost:3001');
    });
  });

  describe('multi-host baseURL resolution', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
      process.env['BETTER_AUTH_SECRET'] = 'a]3kF9!xLm2@pQzR7^wYu4&vN6*cE0hT';
      delete process.env['BETTER_AUTH_ALLOWED_HOSTS'];
    });

    it('stays a static origin for a single-host install', () => {
      process.env['BETTER_AUTH_URL'] = 'https://manifest.example.com';
      delete process.env['CORS_ORIGIN'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toBe('https://manifest.example.com');
    });

    it('keeps both Cloud hosts usable when app is canonical', () => {
      process.env['BETTER_AUTH_URL'] = 'https://app.manifest.build';
      process.env['CORS_ORIGIN'] = 'https://app.manifest.build';
      const mod = loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toEqual({
        allowedHosts: expect.arrayContaining(['app.manifest.build', 'gateway.manifest.build']),
        fallback: 'https://app.manifest.build',
        protocol: 'https',
      });
      expect(config.trustedOrigins).toEqual(
        expect.arrayContaining(['https://app.manifest.build', 'https://gateway.manifest.build']),
      );
      expect(mod.mcpResources).toEqual([
        'https://app.manifest.build/api/v1/mcp',
        'https://gateway.manifest.build/api/v1/mcp',
      ]);
      expect(mod.mcpResourceForHost('gateway.manifest.build')).toBe(
        'https://gateway.manifest.build/api/v1/mcp',
      );
      expect(mod.mcpResourceForHost('gateway.manifest.build:443')).toBe(
        'https://gateway.manifest.build/api/v1/mcp',
      );
      expect(mod.mcpResourceForHost('gateway.manifest.build:444')).toBe(
        'https://app.manifest.build/api/v1/mcp',
      );
      expect(mod.authIssuerForHost('gateway.manifest.build')).toBe(
        'https://gateway.manifest.build/api/auth',
      );
      expect(mod.mcpResourceForHost('unknown.example')).toBe(
        'https://app.manifest.build/api/v1/mcp',
      );
    });

    it('resolves per request when the dashboard origin differs from the API origin', () => {
      process.env['BETTER_AUTH_URL'] = 'https://gateway.manifest.build';
      process.env['CORS_ORIGIN'] = 'https://app.manifest.build';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toEqual({
        allowedHosts: expect.arrayContaining(['gateway.manifest.build', 'app.manifest.build']),
        fallback: 'https://gateway.manifest.build',
        protocol: 'https',
      });
      expect(config.baseURL.allowedHosts).toHaveLength(2);
    });

    it('adds extra hosts from BETTER_AUTH_ALLOWED_HOSTS, including wildcards', () => {
      process.env['BETTER_AUTH_URL'] = 'https://gateway.manifest.build';
      delete process.env['CORS_ORIGIN'];
      process.env['BETTER_AUTH_ALLOWED_HOSTS'] =
        'dashboard.manifest.build, *.preview.manifest.build';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect([...config.baseURL.allowedHosts].sort()).toEqual([
        '*.preview.manifest.build',
        'app.manifest.build',
        'dashboard.manifest.build',
        'gateway.manifest.build',
      ]);
    });

    it('ignores malformed allowed-host entries', () => {
      process.env['BETTER_AUTH_URL'] = 'https://gateway.manifest.build';
      process.env['CORS_ORIGIN'] = 'https://app.manifest.build';
      process.env['BETTER_AUTH_ALLOWED_HOSTS'] = ',   ,not a url';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect([...config.baseURL.allowedHosts].sort()).toEqual([
        'app.manifest.build',
        'gateway.manifest.build',
      ]);
    });

    it('uses http when the canonical origin is http', () => {
      process.env['BETTER_AUTH_URL'] = 'http://manifest.internal';
      process.env['CORS_ORIGIN'] = 'http://dashboard.internal';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL.protocol).toBe('http');
    });

    it('keeps the static origin in development', () => {
      process.env['NODE_ENV'] = 'development';
      process.env['BETTER_AUTH_URL'] = 'http://localhost:3001';
      process.env['CORS_ORIGIN'] = 'http://localhost:3000';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.baseURL).toBe('http://localhost:3001');
    });

    it('exports the same base URL passed to betterAuth', () => {
      process.env['BETTER_AUTH_URL'] = 'https://gateway.manifest.build';
      process.env['CORS_ORIGIN'] = 'https://app.manifest.build';
      const mod = loadModule();

      expect(mod.authBaseURL).toEqual(mockBetterAuth.mock.calls[0][0].baseURL);
    });
  });

  describe('plugins', () => {
    beforeEach(() => {
      mockStripePlugin.mockClear();
      (jest.requireMock('@better-auth/mcp') as { mcp: jest.Mock }).mcp.mockClear();
      (jest.requireMock('@better-auth/cimd') as { cimd: jest.Mock }).cimd.mockClear();
      // These tests assert the exact plugin list, so the developer's shell must
      // not be able to flip a branch (MCP_ENABLED=false while testing the
      // switch, or Stripe keys turning billing on).
      for (const key of [
        'MCP_ENABLED',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'STRIPE_PRO_PRICE_ID',
      ]) {
        delete process.env[key];
      }
    });

    // `mcp()` validates its resource URL as it is constructed and throws for a
    // non-loopback HTTP origin. Constructing it anyway would take the whole
    // process down at import time, so a self-hosted install on a plain-HTTP
    // LAN or tailnet hostname must never reach it (issue #2939).
    it('omits the MCP and CIMD plugins on a plain-HTTP non-loopback origin', () => {
      process.env['BETTER_AUTH_URL'] = 'http://manifest.example.internal';
      const mod = loadModule();

      const { mcp } = jest.requireMock('@better-auth/mcp') as { mcp: jest.Mock };
      const { cimd } = jest.requireMock('@better-auth/cimd') as { cimd: jest.Mock };
      expect(mcp).not.toHaveBeenCalled();
      expect(cimd).not.toHaveBeenCalled();
      expect(mockBetterAuth.mock.calls[0][0].plugins).toEqual([{ id: 'jwt' }]);
      expect(mod.mcpEnabled).toBe(false);
      expect(mod.mcpDisabledReason).toContain('HTTPS');
    });

    it('omits the MCP and CIMD plugins when MCP_ENABLED opts out', () => {
      process.env['BETTER_AUTH_URL'] = 'https://manifest.example.com';
      process.env['MCP_ENABLED'] = 'false';
      const mod = loadModule();

      const { mcp } = jest.requireMock('@better-auth/mcp') as { mcp: jest.Mock };
      const { cimd } = jest.requireMock('@better-auth/cimd') as { cimd: jest.Mock };
      expect(mcp).not.toHaveBeenCalled();
      expect(cimd).not.toHaveBeenCalled();
      expect(mockBetterAuth.mock.calls[0][0].plugins).toEqual([{ id: 'jwt' }]);
      expect(mod.mcpEnabled).toBe(false);
      expect(mod.mcpDisabledReason).toBe('disabled by MCP_ENABLED');
    });

    it('keeps the MCP plugins on a loopback development origin', () => {
      delete process.env['BETTER_AUTH_URL'];
      process.env['PORT'] = '3001';
      const mod = loadModule();

      expect(mod.mcpEnabled).toBe(true);
      expect(mod.mcpDisabledReason).toBeNull();
      expect(mockBetterAuth.mock.calls[0][0].plugins).toEqual([
        { id: 'jwt' },
        { id: 'mcp' },
        { id: 'cimd' },
      ]);
    });

    it('configures the MCP plugin for the /api/v1/mcp resource with login and consent pages', () => {
      process.env['BETTER_AUTH_URL'] = 'https://manifest.example.com';
      loadModule();

      const { mcp } = jest.requireMock('@better-auth/mcp') as { mcp: jest.Mock };
      const config = mcp.mock.calls[0][0];
      expect(config.resource).toBe('https://manifest.example.com/api/v1/mcp');
      expect(config.loginPage).toBe('/login');
      expect(config.consentPage).toBe('/consent');
      expect(config.scopes).toEqual(
        expect.arrayContaining(['mcp:read', 'mcp:write', 'offline_access']),
      );
      expect(config.resources[0].identifier).toBe('https://manifest.example.com/api/v1/mcp');
      expect(config.clientRegistrationDefaultResources).toEqual([
        'https://manifest.example.com/api/v1/mcp',
      ]);
      expect(config.allowUnauthenticatedClientRegistration).toBe(false);
      expect(config.allowDynamicClientRegistration).toBe(true);
      expect(config.clientRegistrationRequirePKCE).toBe(true);
      expect(config.clientRegistrationDefaultScopes).toEqual(['mcp:read']);
      expect(config.clientRegistrationAllowedScopes).toEqual(['mcp:write', 'offline_access']);
      expect(config.resourceSeedMode).toBe('overwrite');
      expect(config.resources[0].accessTokenTtl).toBe(15 * 60);
      expect(config.resources[0].allowedScopes).toEqual(
        expect.arrayContaining(['mcp:read', 'mcp:write', 'offline_access']),
      );
    });

    it('registers both Cloud MCP resources for new OAuth clients', () => {
      process.env['BETTER_AUTH_URL'] = 'https://app.manifest.build';
      loadModule();

      const { mcp } = jest.requireMock('@better-auth/mcp') as { mcp: jest.Mock };
      const config = mcp.mock.calls[0][0];
      expect(config.resource).toBe('https://app.manifest.build/api/v1/mcp');
      expect(
        config.resources.map((resource: { identifier: string }) => resource.identifier),
      ).toEqual([
        'https://app.manifest.build/api/v1/mcp',
        'https://gateway.manifest.build/api/v1/mcp',
      ]);
      expect(config.clientRegistrationDefaultResources).toEqual([
        'https://app.manifest.build/api/v1/mcp',
        'https://gateway.manifest.build/api/v1/mcp',
      ]);
    });

    it('registers the MCP/OAuth plugins but not stripe when billing is disabled', () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      delete process.env['STRIPE_SECRET_KEY'];
      delete process.env['STRIPE_WEBHOOK_SECRET'];
      delete process.env['STRIPE_PRO_PRICE_ID'];
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.plugins).toEqual([{ id: 'jwt' }, { id: 'mcp' }, { id: 'cimd' }]);
      expect(mockStripePlugin).not.toHaveBeenCalled();
    });

    it('registers the stripe plugin after the MCP/OAuth plugins when billing is enabled', () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
      process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';
      loadModule();

      const config = mockBetterAuth.mock.calls[0][0];
      expect(config.plugins).toEqual([
        { id: 'jwt' },
        { id: 'mcp' },
        { id: 'cimd' },
        { id: 'stripe' },
      ]);
      expect(mockStripePlugin).toHaveBeenCalledTimes(1);
      const pluginConfig = mockStripePlugin.mock.calls[0][0];
      expect(pluginConfig.stripeClient).toBeDefined();
      expect(pluginConfig.stripeWebhookSecret).toBe('whsec_x');
      expect(pluginConfig.subscription).toMatchObject({
        enabled: true,
        plans: [{ name: 'pro', priceId: 'price_x' }],
      });
      expect(pluginConfig.subscription.onSubscriptionComplete).toEqual(expect.any(Function));
      expect(pluginConfig.subscription.onSubscriptionCreated).toEqual(expect.any(Function));
      expect(pluginConfig.subscription.onSubscriptionUpdate).toEqual(expect.any(Function));
      expect(pluginConfig.subscription.onSubscriptionCancel).toEqual(expect.any(Function));
      expect(pluginConfig.subscription.onSubscriptionDeleted).toEqual(expect.any(Function));
      expect(pluginConfig).not.toHaveProperty('createCustomerOnSignUp');
    });

    it('onSubscriptionComplete calls sendSubscriptionConfirmedEmail', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
      process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webhookEmails = require('../billing/subscription-webhook-emails') as {
        sendSubscriptionConfirmedEmail: jest.Mock;
        sendPlanChangedEmail: jest.Mock;
        sendSubscriptionCanceledEmail: jest.Mock;
        previousPlanFromEvent: jest.Mock;
      };
      jest.spyOn(webhookEmails, 'sendSubscriptionConfirmedEmail').mockResolvedValue(true);
      jest.spyOn(webhookEmails, 'sendPlanChangedEmail').mockResolvedValue(true);
      jest.spyOn(webhookEmails, 'sendSubscriptionCanceledEmail').mockResolvedValue(true);
      jest.spyOn(webhookEmails, 'previousPlanFromEvent').mockReturnValue('free');

      loadModule();
      const pluginConfig = mockStripePlugin.mock.calls[0][0];
      const sub = { subscription: { plan: 'pro' } };
      const evt = { event: { id: 'evt_1' } };

      await pluginConfig.subscription.onSubscriptionComplete({ ...evt, ...sub });
      expect(webhookEmails.sendSubscriptionConfirmedEmail).toHaveBeenCalled();

      await pluginConfig.subscription.onSubscriptionCreated({ ...evt, ...sub });
      expect(webhookEmails.sendSubscriptionConfirmedEmail).toHaveBeenCalledTimes(2);

      await pluginConfig.subscription.onSubscriptionUpdate({ ...evt, ...sub });
      expect(webhookEmails.previousPlanFromEvent).toHaveBeenCalled();
      expect(webhookEmails.sendPlanChangedEmail).toHaveBeenCalled();

      await pluginConfig.subscription.onSubscriptionDeleted({ ...evt, ...sub });
      expect(webhookEmails.sendSubscriptionCanceledEmail).toHaveBeenCalled();
    });

    it('onSubscriptionCancel skips when event is undefined', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
      process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webhookEmails = require('../billing/subscription-webhook-emails') as {
        sendSubscriptionCanceledEmail: jest.Mock;
      };
      jest.spyOn(webhookEmails, 'sendSubscriptionCanceledEmail').mockResolvedValue(true);

      loadModule();
      const pluginConfig = mockStripePlugin.mock.calls[0][0];

      await pluginConfig.subscription.onSubscriptionCancel({
        event: undefined,
        subscription: { plan: 'pro' },
      });
      expect(webhookEmails.sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
    });

    it('onSubscriptionCancel sends when event is present', async () => {
      process.env['MANIFEST_MODE'] = 'cloud';
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
      process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_x';
      process.env['STRIPE_PRO_PRICE_ID'] = 'price_x';

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webhookEmails = require('../billing/subscription-webhook-emails') as {
        sendSubscriptionCanceledEmail: jest.Mock;
      };
      jest.spyOn(webhookEmails, 'sendSubscriptionCanceledEmail').mockResolvedValue(true);

      loadModule();
      const pluginConfig = mockStripePlugin.mock.calls[0][0];

      await pluginConfig.subscription.onSubscriptionCancel({
        event: { id: 'evt_cancel' },
        subscription: { plan: 'pro' },
      });
      expect(webhookEmails.sendSubscriptionCanceledEmail).toHaveBeenCalled();
    });
  });

  describe('exported types', () => {
    it('exports AuthSession and AuthUser types', () => {
      // Type-level check: these compile without errors
      const _session: AuthSession | undefined = undefined;
      const _user: AuthUser | undefined = undefined;
      expect(_session).toBeUndefined();
      expect(_user).toBeUndefined();
    });
  });
});
