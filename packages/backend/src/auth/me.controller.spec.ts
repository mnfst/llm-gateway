import { MeController } from './me.controller';
import { Request } from 'express';

describe('MeController', () => {
  const controller = new MeController();

  it('returns tenant, user, and auth method from the request', () => {
    const request = { authMethod: 'api_key' } as Request & { authMethod: string };
    expect(controller.me({ tenantId: 't1', userId: 'u1' }, request)).toEqual({
      tenantId: 't1',
      userId: 'u1',
      authMethod: 'api_key',
      expiresAt: null,
    });
  });

  it('reports a null auth method when no guard stamped one', () => {
    expect(controller.me({ tenantId: 't1', userId: null }, {} as Request)).toEqual({
      tenantId: 't1',
      userId: null,
      authMethod: null,
      expiresAt: null,
    });
  });

  it('echoes the key expiry the guard stamped on the request', () => {
    const expiresAt = '2026-09-01T00:00:00.000Z';
    const request = { authMethod: 'api_key', apiKeyExpiresAt: expiresAt } as Request & {
      authMethod: string;
      apiKeyExpiresAt: string;
    };
    expect(controller.me({ tenantId: 't1', userId: 'u1' }, request)).toEqual({
      tenantId: 't1',
      userId: 'u1',
      authMethod: 'api_key',
      expiresAt,
    });
  });

  it('reports a null expiry for a non-expiring key', () => {
    const request = { authMethod: 'api_key', apiKeyExpiresAt: null } as Request & {
      authMethod: string;
      apiKeyExpiresAt: string | null;
    };
    expect(controller.me({ tenantId: 't1', userId: 'u1' }, request)).toEqual({
      tenantId: 't1',
      userId: 'u1',
      authMethod: 'api_key',
      expiresAt: null,
    });
  });
});
