describe('appConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function loadConfig() {
    const { appConfig } = await import('./app.config');
    return appConfig();
  }

  it('returns default port 3001', async () => {
    delete process.env['PORT'];
    const config = await loadConfig();
    expect(config.port).toBe(3001);
  });

  it('reads PORT from env', async () => {
    process.env['PORT'] = '8080';
    const config = await loadConfig();
    expect(config.port).toBe(8080);
  });

  it('defaults bindAddress to 127.0.0.1', async () => {
    delete process.env['BIND_ADDRESS'];
    const config = await loadConfig();
    expect(config.bindAddress).toBe('127.0.0.1');
  });

  it('reads BETTER_AUTH_URL from env', async () => {
    process.env['BETTER_AUTH_URL'] = 'https://auth.example.com';
    const config = await loadConfig();
    expect(config.betterAuthUrl).toBe('https://auth.example.com');
  });

  it('defaults throttle settings', async () => {
    delete process.env['THROTTLE_TTL'];
    delete process.env['THROTTLE_LIMIT'];
    const config = await loadConfig();
    expect(config.throttleTtl).toBe(60000);
    expect(config.throttleLimit).toBe(100);
  });

  it('defaults nodeEnv to development when NODE_ENV is not set', async () => {
    delete process.env['NODE_ENV'];
    process.env['DATABASE_URL'] = 'postgresql://test:test@localhost/test';
    const config = await loadConfig();
    expect(config.nodeEnv).toBe('development');
  });

  it('reads NODE_ENV from env', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DATABASE_URL'] = 'postgresql://test:test@localhost/test';
    const config = await loadConfig();
    expect(config.nodeEnv).toBe('production');
  });

  it('defaults dbPoolMax to 10', async () => {
    delete process.env['DB_POOL_MAX'];
    const config = await loadConfig();
    expect(config.dbPoolMax).toBe(10);
  });

  it('reads DB_POOL_MAX from env', async () => {
    process.env['DB_POOL_MAX'] = '50';
    const config = await loadConfig();
    expect(config.dbPoolMax).toBe(50);
  });

  it.each(['', '0', '-1', '1.5', 'Infinity', '5abc'])(
    'uses the default DB_POOL_MAX for invalid value %p',
    async (value) => {
      process.env['DB_POOL_MAX'] = value;
      const config = await loadConfig();
      expect(config.dbPoolMax).toBe(10);
    },
  );

  it('defaults dbTuneSession to true when DB_TUNE_SESSION is unset', async () => {
    delete process.env['DB_TUNE_SESSION'];
    const config = await loadConfig();
    expect(config.dbTuneSession).toBe(true);
  });

  it('disables dbTuneSession when DB_TUNE_SESSION is "false"', async () => {
    process.env['DB_TUNE_SESSION'] = 'false';
    const config = await loadConfig();
    expect(config.dbTuneSession).toBe(false);
  });

  it('defaults runMigrationsOnBoot to true when RUN_MIGRATIONS_ON_BOOT is unset', async () => {
    delete process.env['RUN_MIGRATIONS_ON_BOOT'];
    const config = await loadConfig();
    expect(config.runMigrationsOnBoot).toBe(true);
  });

  it('disables runMigrationsOnBoot when RUN_MIGRATIONS_ON_BOOT is "false"', async () => {
    process.env['RUN_MIGRATIONS_ON_BOOT'] = 'false';
    const config = await loadConfig();
    expect(config.runMigrationsOnBoot).toBe(false);
  });

  it('leaves request recording retention unset by default', async () => {
    delete process.env['REQUEST_RECORDING_RETENTION_DAYS'];
    const config = await loadConfig();
    expect(config.requestRecordingRetentionDays).toBeNull();
  });

  it('reads a positive request recording retention override', async () => {
    process.env['REQUEST_RECORDING_RETENTION_DAYS'] = '90';
    const config = await loadConfig();
    expect(config.requestRecordingRetentionDays).toBe(90);
  });

  it.each(['0', '-1', '1.5', 'invalid', '9007199254740992'])(
    'ignores invalid request recording retention %s',
    async (value) => {
      process.env['REQUEST_RECORDING_RETENTION_DAYS'] = value;
      const config = await loadConfig();
      expect(config.requestRecordingRetentionDays).toBeNull();
    },
  );

  it('defaults the CLI token TTL to 30 days', async () => {
    delete process.env['CLI_TOKEN_TTL_DAYS'];
    const config = await loadConfig();
    expect(config.cliTokenTtlDays).toBe(30);
  });

  it('reads a positive CLI token TTL override', async () => {
    process.env['CLI_TOKEN_TTL_DAYS'] = '7';
    const config = await loadConfig();
    expect(config.cliTokenTtlDays).toBe(7);
  });

  it.each(['0', '-1', '1.5', 'invalid', ''])(
    'falls back to 30 days for a malformed CLI token TTL %s',
    async (value) => {
      // The value is interpolated into an SQL INTERVAL literal, so anything
      // that is not a plain positive integer must never reach the query.
      process.env['CLI_TOKEN_TTL_DAYS'] = value;
      const config = await loadConfig();
      expect(config.cliTokenTtlDays).toBe(30);
    },
  );

  it('defaults the CLI token absolute ceiling to 90 days', async () => {
    delete process.env['CLI_TOKEN_ABSOLUTE_TTL_DAYS'];
    const config = await loadConfig();
    expect(config.cliTokenAbsoluteTtlDays).toBe(90);
  });

  it('reads a positive CLI token absolute ceiling override', async () => {
    process.env['CLI_TOKEN_ABSOLUTE_TTL_DAYS'] = '365';
    const config = await loadConfig();
    expect(config.cliTokenAbsoluteTtlDays).toBe(365);
  });

  it.each(['0', '-1', '1.5', 'invalid', ''])(
    'falls back to 90 days for a malformed CLI token absolute ceiling %s',
    async (value) => {
      process.env['CLI_TOKEN_ABSOLUTE_TTL_DAYS'] = value;
      const config = await loadConfig();
      expect(config.cliTokenAbsoluteTtlDays).toBe(90);
    },
  );

  it('defaults request recording storage selection to auto', async () => {
    delete process.env['REQUEST_RECORDING_STORAGE'];
    const config = await loadConfig();
    expect(config.requestRecordingStorage).toBe('auto');
  });

  it('reads request recording storage settings', async () => {
    process.env['REQUEST_RECORDING_STORAGE'] = 's3';
    process.env['REQUEST_RECORDING_S3_BUCKET'] = 'recordings';
    process.env['REQUEST_RECORDING_S3_REGION'] = 'auto';
    process.env['REQUEST_RECORDING_S3_FORCE_PATH_STYLE'] = 'true';
    const config = await loadConfig();

    expect(config.requestRecordingStorage).toBe('s3');
    expect(config.requestRecordingS3Bucket).toBe('recordings');
    expect(config.requestRecordingS3Region).toBe('auto');
    expect(config.requestRecordingS3ForcePathStyle).toBe(true);
  });

  it('defaults shutdownDrainMs to 10000 when SHUTDOWN_DRAIN_MS is unset', async () => {
    delete process.env['SHUTDOWN_DRAIN_MS'];
    const config = await loadConfig();
    expect(config.shutdownDrainMs).toBe(10000);
  });

  it('reads SHUTDOWN_DRAIN_MS from env', async () => {
    process.env['SHUTDOWN_DRAIN_MS'] = '0';
    const config = await loadConfig();
    expect(config.shutdownDrainMs).toBe(0);
  });

  it('throws when DATABASE_URL is missing in production', async () => {
    delete process.env['DATABASE_URL'];
    process.env['NODE_ENV'] = 'production';
    await expect(loadConfig()).rejects.toThrow('DATABASE_URL is required');
  });

  it('returns default URL when DATABASE_URL is missing in test mode', async () => {
    delete process.env['DATABASE_URL'];
    process.env['NODE_ENV'] = 'test';
    const config = await loadConfig();
    expect(config.databaseUrl).toContain('postgresql://');
  });

  it('reads EMAIL_PROVIDER from env', async () => {
    process.env['EMAIL_PROVIDER'] = 'resend';
    const config = await loadConfig();
    expect(config.emailProvider).toBe('resend');
  });

  it('reads EMAIL_FROM from env', async () => {
    process.env['EMAIL_FROM'] = 'noreply@example.com';
    const config = await loadConfig();
    expect(config.emailFrom).toBe('noreply@example.com');
  });

  it('falls back EMAIL_FROM to NOTIFICATION_FROM_EMAIL', async () => {
    delete process.env['EMAIL_FROM'];
    process.env['NOTIFICATION_FROM_EMAIL'] = 'legacy@example.com';
    const config = await loadConfig();
    expect(config.emailFrom).toBe('legacy@example.com');
  });

  it('defaults emailFrom to noreply@manifest.build', async () => {
    delete process.env['EMAIL_FROM'];
    delete process.env['NOTIFICATION_FROM_EMAIL'];
    const config = await loadConfig();
    expect(config.emailFrom).toBe('noreply@manifest.build');
  });
});
