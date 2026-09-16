import { describe, expect, it } from 'vitest';
import {
  appendSearch,
  buildLoginRedirect,
  buildSocialAuthUrls,
  getAuthDestination,
  isSafeInternalRedirect,
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
