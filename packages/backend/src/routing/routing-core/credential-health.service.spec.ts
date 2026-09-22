import { CredentialHealthService, credentialFingerprint } from './credential-health.service';
import type { OAuthTokenBlob } from '../oauth/core';

const serialize = (blob: OAuthTokenBlob) => JSON.stringify(blob);

const blob = (over: Partial<OAuthTokenBlob> = {}): string =>
  serialize({ t: 'access-1', r: 'refresh-1', e: Date.now() + 3_600_000, ...over });

describe('CredentialHealthService', () => {
  let service: CredentialHealthService;

  beforeEach(() => {
    service = new CredentialHealthService();
  });

  it('reports healthy for an untracked credential', () => {
    expect(service.isRejected('up-1', blob())).toBe(false);
    expect(service.getSnapshot('up-1')).toEqual({
      requires_reauth: false,
      last_auth_failure: null,
    });
  });

  it('tracks a rejected credential and exposes its failure', () => {
    service.markRejected('up-1', blob(), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
      keyLabel: 'Work',
      provider: 'openai',
    });

    expect(service.isRejected('up-1', blob())).toBe(true);
    const snapshot = service.getSnapshot('up-1');
    expect(snapshot.requires_reauth).toBe(true);
    expect(snapshot.last_auth_failure).toMatchObject({
      statusCode: 401,
      reason: 'subscription_token_rejected',
      keyLabel: 'Work',
      provider: 'openai',
    });
  });

  // The refresh token is the credential's stable identity: refreshing rotates
  // the access token, and that must NOT be mistaken for a re-authentication.
  it('keeps the rejection after the access token rotates', () => {
    service.markRejected('up-1', blob({ t: 'access-old' }), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });

    expect(service.isRejected('up-1', blob({ t: 'access-new' }))).toBe(true);
  });

  it('treats a new refresh token as re-authenticated and clears the failure', () => {
    service.markRejected('up-1', blob({ r: 'refresh-old' }), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });

    expect(service.isRejected('up-1', blob({ r: 'refresh-new' }))).toBe(false);
    expect(service.getSnapshot('up-1').requires_reauth).toBe(false);
  });

  it('markHealthy clears only the matching credential', () => {
    service.markRejected('up-1', blob({ r: 'refresh-old' }), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });
    // A stale success for the replaced credential must not clear the new mark.
    service.markHealthy('up-1', blob({ r: 'refresh-new' }));
    expect(service.getSnapshot('up-1').requires_reauth).toBe(true);

    service.markHealthy('up-1', blob({ r: 'refresh-old' }));
    expect(service.getSnapshot('up-1').requires_reauth).toBe(false);
  });

  it('ignores a missing connection id or credential value', () => {
    service.markRejected(null, blob(), { statusCode: 401, reason: 'subscription_token_rejected' });
    service.markRejected('up-1', null, { statusCode: 401, reason: 'subscription_token_rejected' });
    expect(service.getSnapshot('up-1').requires_reauth).toBe(false);
    expect(service.isRejected(undefined, blob())).toBe(false);
  });

  it('fingerprints API keys by their own value', () => {
    service.markRejected('up-key', 'sk-dead', {
      statusCode: 401,
      reason: 'api_key_rejected',
    });
    expect(service.isRejected('up-key', 'sk-dead')).toBe(true);
    expect(service.isRejected('up-key', 'sk-live')).toBe(false);
    expect(credentialFingerprint('sk-dead')).not.toBe(credentialFingerprint('sk-live'));
  });

  it('falls back to the access token when the refresh token is blank', () => {
    expect(credentialFingerprint(serialize({ t: 'access-only', r: '', e: 1 }))).toBeTruthy();
  });

  it('tolerates a missing connection id', () => {
    expect(service.getFailure(null)).toBeNull();
    expect(service.getFailure(undefined)).toBeNull();
    expect(service.getSnapshot(undefined)).toEqual({
      requires_reauth: false,
      last_auth_failure: null,
    });
  });

  it('clears every tracked failure', () => {
    service.markRejected('up-1', blob(), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });
    service.clear();
    expect(service.getSnapshot('up-1').requires_reauth).toBe(false);
  });

  it('clears one connection without touching another', () => {
    service.markRejected('up-1', blob(), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });
    service.markRejected('up-2', blob(), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });
    service.clearConnection('up-1');
    expect(service.getSnapshot('up-1').requires_reauth).toBe(false);
    expect(service.getSnapshot('up-2').requires_reauth).toBe(true);
  });

  it('ignores a missing connection id when clearing', () => {
    service.markRejected('up-1', blob(), {
      statusCode: 401,
      reason: 'subscription_token_rejected',
    });
    service.clearConnection(null);
    expect(service.getSnapshot('up-1').requires_reauth).toBe(true);
  });

  it('bounds the tracked set so a flood of dead connections cannot grow unbounded', () => {
    for (let i = 0; i < 5_001; i++) {
      service.markRejected(`up-${i}`, blob({ r: `r-${i}` }), {
        statusCode: 401,
        reason: 'subscription_token_rejected',
      });
    }
    // The oldest entry is evicted; the newest survives.
    expect(service.getSnapshot('up-0').requires_reauth).toBe(false);
    expect(service.getSnapshot('up-5000').requires_reauth).toBe(true);
  });
});
