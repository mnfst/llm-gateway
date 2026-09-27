import {
  CREDENTIAL_REJECTION_COOLDOWN_MS,
  CredentialRejectionCooldown,
  type RejectedCredentialRef,
} from '../credential-rejection-cooldown';

const ref = (overrides: Partial<RejectedCredentialRef> = {}): RejectedCredentialRef => ({
  tenantId: 'tenant-1',
  provider: 'openai',
  authType: 'subscription',
  connectionId: 'connection-1',
  keyLabel: 'Work',
  model: 'gpt-5.4',
  secret: 'access-token-1',
  ...overrides,
});

describe('CredentialRejectionCooldown', () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('skips a rejected credential until the cooldown ends', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    cooldown.reject(ref());

    expect(cooldown.rejectedUntil(ref())).toBe(now + 60_000);
    now += 59_999;
    expect(cooldown.rejectedUntil(ref())).toBe(1_060_000);
    now += 1;
    expect(cooldown.rejectedUntil(ref())).toBeNull();
  });

  it('tries a new secret at once, so reconnecting or replacing a key clears the skip', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    cooldown.reject(ref());

    expect(cooldown.rejectedUntil(ref({ secret: 'access-token-2' }))).toBeNull();
  });

  it('scopes a rejection to one tenant, connection, provider, auth type, label and model', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    cooldown.reject(ref());

    expect(cooldown.rejectedUntil(ref({ tenantId: 'tenant-2' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ provider: 'anthropic' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ authType: 'api_key' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ keyLabel: 'Personal' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ connectionId: 'connection-2' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ model: 'gpt-5.4-mini' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ provider: 'OpenAI', model: 'GPT-5.4' }))).not.toBeNull();
  });

  it('treats a missing connection, auth type and label as their own scope', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    const bare = ref({ connectionId: null, authType: undefined, keyLabel: undefined });
    cooldown.reject(bare);

    expect(cooldown.rejectedUntil(bare)).not.toBeNull();
  });

  it('ignores credentials it cannot attribute to a tenant or secret', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    cooldown.reject(ref({ tenantId: undefined }));
    cooldown.reject(ref({ secret: '' }));

    expect(cooldown.rejectedUntil(ref({ tenantId: undefined }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ secret: '' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref())).toBeNull();
  });

  it('extends the skip when the same credential is rejected again', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    cooldown.reject(ref());
    now += 30_000;
    cooldown.reject(ref());

    expect(cooldown.rejectedUntil(ref())).toBe(now + 60_000);
  });

  it('remembers only the latest refused secret for a connection', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 10, clock);
    cooldown.reject(ref());
    cooldown.reject(ref({ secret: 'access-token-2' }));

    expect(cooldown.rejectedUntil(ref({ secret: 'access-token-2' }))).not.toBeNull();
    expect(cooldown.rejectedUntil(ref())).toBeNull();
  });

  it('evicts expired entries before dropping live ones when full', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 2, clock);
    cooldown.reject(ref({ keyLabel: 'a' }));
    now += 60_000;
    cooldown.reject(ref({ keyLabel: 'b' }));
    cooldown.reject(ref({ keyLabel: 'c' }));

    expect(cooldown.rejectedUntil(ref({ keyLabel: 'b' }))).not.toBeNull();
    expect(cooldown.rejectedUntil(ref({ keyLabel: 'c' }))).not.toBeNull();
  });

  it('drops the entry that expires first when every entry is still live', () => {
    const cooldown = new CredentialRejectionCooldown(60_000, 2, clock);
    cooldown.reject(ref({ keyLabel: 'a' }));
    now += 1;
    cooldown.reject(ref({ keyLabel: 'b' }));
    now += 1;
    // Re-rejecting "a" moves it behind "b", so "b" now expires first.
    cooldown.reject(ref({ keyLabel: 'a' }));
    cooldown.reject(ref({ keyLabel: 'c' }));

    expect(cooldown.rejectedUntil(ref({ keyLabel: 'b' }))).toBeNull();
    expect(cooldown.rejectedUntil(ref({ keyLabel: 'a' }))).not.toBeNull();
    expect(cooldown.rejectedUntil(ref({ keyLabel: 'c' }))).not.toBeNull();
  });

  it('defaults to a five-minute cooldown on the real clock', () => {
    const cooldown = new CredentialRejectionCooldown();
    const before = Date.now();
    cooldown.reject(ref());

    expect(cooldown.rejectedUntil(ref())).toBeGreaterThanOrEqual(
      before + CREDENTIAL_REJECTION_COOLDOWN_MS,
    );
  });
});
