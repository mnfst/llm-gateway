import { describe, expect, it } from 'vitest';
import {
  appendSearch,
  buildLoginRedirect,
  buildSocialAuthUrls,
  getAuthDestination,
  isSafeInternalRedirect,
  signedOAuthDestination,
} from '../../src/services/auth-redirects';

describe('auth redirect helpers', () => {
  it('accepts safe internal redirects', () => {
    expect(isSafeInternalRedirect('/upgrade')).toBe(true);
    expect(isSafeInternalRedirect('/upgrade?reason=requests')).toBe(true);
  });

  it('rejects external or malformed redirects', () => {
    expect(isSafeInternalRedirect(undefined)).toBe(false);
    expect(isSafeInternalRedirect('https://evil.test')).toBe(false);
    expect(isSafeInternalRedirect('//evil.test')).toBe(false);
    expect(isSafeInternalRedirect('/https://evil.test')).toBe(false);
    expect(isSafeInternalRedirect('%2F%2Fevil.test')).toBe(false);
    expect(isSafeInternalRedirect('%')).toBe(false);
  });

  it('chooses redirect before plan intent', () => {
    expect(getAuthDestination({ redirect: '/messages', plan: 'pro' })).toBe('/messages');
  });

  it('falls back to upgrade for pro intent', () => {
    expect(getAuthDestination({ plan: 'pro' })).toBe('/upgrade');
  });

  it('falls back to home without safe redirect or pro intent', () => {
    expect(getAuthDestination({ redirect: 'https://evil.test' })).toBe('/');
  });

  it('resumes a signed MCP authorization query after sign-in', () => {
    const query =
      '?client_id=https%3A%2F%2Fclient.test%2Fmetadata&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&ba_param=client_id&ba_param=redirect_uri&sig=abc&oauth=failed';
    const destination = signedOAuthDestination(query);
    expect(destination).toBe(
      '/api/auth/oauth2/authorize?client_id=https%3A%2F%2Fclient.test%2Fmetadata&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&ba_param=client_id&ba_param=redirect_uri&sig=abc',
    );
    expect(getAuthDestination({ plan: 'pro' }, query)).toBe(destination);
    expect(buildSocialAuthUrls({}, query)).toEqual({
      callbackURL: destination,
      errorCallbackURL: `/login?${new URLSearchParams(query.slice(1)).toString()}`,
    });
  });

  it('does not treat unsigned OAuth parameters as a sign-in destination', () => {
    expect(
      signedOAuthDestination('?client_id=client&redirect_uri=http%3A%2F%2F127.0.0.1'),
    ).toBeUndefined();
  });

  it('builds encoded login redirects from path and search', () => {
    expect(buildLoginRedirect('/upgrade', '?reason=requests')).toBe(
      '/login?redirect=%2Fupgrade%3Freason%3Drequests',
    );
  });

  it('appends search strings to cross-links', () => {
    expect(appendSearch('/login', '?plan=pro')).toBe('/login?plan=pro');
    expect(appendSearch('/login', 'plan=pro')).toBe('/login?plan=pro');
    expect(appendSearch('/login')).toBe('/login');
  });

  it('builds social callback URLs for pro intent', () => {
    expect(buildSocialAuthUrls({ plan: 'pro' })).toEqual({
      callbackURL: '/upgrade',
      errorCallbackURL: '/login?plan=pro&oauth=failed',
    });
  });

  it('preserves safe redirects in social error callbacks', () => {
    expect(buildSocialAuthUrls({ redirect: '/upgrade?reason=requests' })).toEqual({
      callbackURL: '/upgrade?reason=requests',
      errorCallbackURL: '/login?redirect=%2Fupgrade%3Freason%3Drequests&oauth=failed',
    });
  });
});
