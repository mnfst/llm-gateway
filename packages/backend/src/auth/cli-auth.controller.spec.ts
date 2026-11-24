import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { CliAuthController } from './cli-auth.controller';

function makeController() {
  const service = {
    createAuthorization: jest.fn().mockResolvedValue({ code: 'c1' }),
    exchange: jest.fn().mockResolvedValue({ token: 'mnfst_pat_x', expiresAt: 'e' }),
    revokeByRawKey: jest.fn().mockResolvedValue({ revoked: true }),
  };
  return { controller: new CliAuthController(service as never), service };
}

const req = (extra: Record<string, unknown>) => ({ headers: {}, ...extra }) as unknown as Request;

const CHALLENGE = 'A'.repeat(43);
const VERIFIER = 'B'.repeat(43);

describe('CliAuthController', () => {
  it('authorize mints a code for a session user', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.authorize(
        { state: 'state-abcdef1234567890', code_challenge: CHALLENGE },
        { tenantId: 't1', userId: 'u1' },
        req({ authMethod: 'session' }),
      ),
    ).resolves.toEqual({ code: 'c1' });
    expect(service.createAuthorization).toHaveBeenCalledWith(
      { tenantId: 't1', userId: 'u1' },
      'state-abcdef1234567890',
      CHALLENGE,
      'S256',
    );
  });

  it('authorize rejects API-key auth (a PAT must not mint a PAT)', async () => {
    const { controller } = makeController();
    await expect(
      controller.authorize(
        { state: 'state-abcdef1234567890', code_challenge: CHALLENGE },
        { tenantId: 't1', userId: 'u1' },
        req({ authMethod: 'api_key' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('authorize rejects a session without a tenant', async () => {
    const { controller } = makeController();
    await expect(
      controller.authorize(
        { state: 'state-abcdef1234567890', code_challenge: CHALLENGE },
        { tenantId: null, userId: 'u1' },
        req({ authMethod: 'session' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('token delegates to exchange with the PKCE verifier', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.token({
        code: 'rawcode-abcdefghijklmnop',
        state: 'state-abcdef1234567890',
        code_verifier: VERIFIER,
      }),
    ).resolves.toEqual({ token: 'mnfst_pat_x', expiresAt: 'e' });
    expect(service.exchange).toHaveBeenCalledWith(
      'rawcode-abcdefghijklmnop',
      'state-abcdef1234567890',
      VERIFIER,
    );
  });

  it('revoke uses the raw X-API-Key header', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.revoke(req({ headers: { 'x-api-key': 'mnfst_pat_abc' } })),
    ).resolves.toEqual({ revoked: true });
    expect(service.revokeByRawKey).toHaveBeenCalledWith('mnfst_pat_abc');
  });

  it('revoke without a key header is a no-op', async () => {
    const { controller, service } = makeController();
    await expect(controller.revoke(req({ headers: {} }))).resolves.toEqual({ revoked: false });
    expect(service.revokeByRawKey).not.toHaveBeenCalled();
  });
});
