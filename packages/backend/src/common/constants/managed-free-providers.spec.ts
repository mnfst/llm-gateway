import {
  getManagedFreeLiteLlmAutoAllowlist,
  getManagedFreeLiteLlmBaseUrl,
  getManagedFreeLiteLlmMasterKey,
  getManagedFreeLiteLlmMaxBudgetUsd,
  getManagedFreeLiteLlmModelsUrl,
  getManagedFreeProviderConfig,
  isManagedFreeLiteLlmAutoEligible,
} from './managed-free-providers';

describe('managed free provider config', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env['CREDITS_BASE_URL'];
    delete process.env['CREDITS_MASTER_KEY'];
    delete process.env['CREDITS_GEMINI_FREE_MAX_BUDGET'];
    delete process.env['CREDITS_AUTO_PROVISION_ALLOWLIST'];
  });

  afterAll(() => {
    process.env = env;
  });

  it('defaults to the managed gateway', () => {
    expect(getManagedFreeLiteLlmBaseUrl()).toBe('https://credits.manifest.build');
  });

  it('strips trailing slashes from the base URL', () => {
    process.env['CREDITS_BASE_URL'] = 'https://example.com/credits/';
    expect(getManagedFreeLiteLlmBaseUrl()).toBe('https://example.com/credits');
  });

  it('defaults the maximum budget to 10', () => {
    const config = getManagedFreeProviderConfig('gemini-free')!;
    expect(getManagedFreeLiteLlmMaxBudgetUsd(config)).toBe(10);
  });

  it('parses valid budgets and rejects invalid values', () => {
    const config = getManagedFreeProviderConfig('gemini-free')!;
    process.env['CREDITS_GEMINI_FREE_MAX_BUDGET'] = '12.5';
    expect(getManagedFreeLiteLlmMaxBudgetUsd(config)).toBe(12.5);
    process.env['CREDITS_GEMINI_FREE_MAX_BUDGET'] = '-1';
    expect(getManagedFreeLiteLlmMaxBudgetUsd(config)).toBe(10);
    process.env['CREDITS_GEMINI_FREE_MAX_BUDGET'] = 'invalid';
    expect(getManagedFreeLiteLlmMaxBudgetUsd(config)).toBe(10);
  });

  it('builds the model catalog URL from the configured gateway', () => {
    process.env['CREDITS_BASE_URL'] = 'https://credits.test/';
    expect(getManagedFreeLiteLlmModelsUrl()).toBe('https://credits.test/v1/models');
  });

  it('parses allowlisted emails', () => {
    process.env['CREDITS_AUTO_PROVISION_ALLOWLIST'] = 'A@x.com, b@y.com ';
    expect(getManagedFreeLiteLlmAutoAllowlist()).toEqual(['a@x.com', 'b@y.com']);
  });

  it('requires the master key for automatic provisioning', () => {
    expect(isManagedFreeLiteLlmAutoEligible('a@x.com')).toBe(false);
    process.env['CREDITS_MASTER_KEY'] = 'sk-test';
    expect(isManagedFreeLiteLlmAutoEligible('a@x.com')).toBe(true);
    expect(getManagedFreeLiteLlmMasterKey()).toBe('sk-test');
  });

  it('honors the allowlist when configured', () => {
    process.env['CREDITS_MASTER_KEY'] = 'sk-test';
    process.env['CREDITS_AUTO_PROVISION_ALLOWLIST'] = 'allowed@example.com';
    expect(isManagedFreeLiteLlmAutoEligible('allowed@example.com')).toBe(true);
    expect(isManagedFreeLiteLlmAutoEligible('other@example.com')).toBe(false);
  });

  it('keeps Gemini-specific values in one copyable config entry', () => {
    expect(getManagedFreeProviderConfig('gemini-free')).toMatchObject({
      id: 'gemini-free',
      displayName: 'Gemini Free',
      litellmModels: ['gemini/*'],
      catalogModelIdPrefix: 'gemini-',
      preferredModelIdPrefix: 'gemini/',
      maxBudgetEnvVar: 'CREDITS_GEMINI_FREE_MAX_BUDGET',
    });
  });
});
