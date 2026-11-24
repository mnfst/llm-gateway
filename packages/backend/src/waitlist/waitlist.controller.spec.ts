import { Request } from 'express';
import { Repository } from 'typeorm';
import { WaitlistClaim } from '../entities/waitlist-claim.entity';
import { WaitlistController, claimRequestIsSameOrigin } from './waitlist.controller';

function reqWith(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

describe('claimRequestIsSameOrigin', () => {
  it('matches when the Origin host equals the Host header', () => {
    expect(
      claimRequestIsSameOrigin({
        origin: 'https://app.manifest.build',
        host: 'app.manifest.build',
      }),
    ).toBe(true);
  });

  it('rejects a foreign origin', () => {
    expect(
      claimRequestIsSameOrigin({ origin: 'https://someone.example', host: 'app.manifest.build' }),
    ).toBe(false);
  });

  it('rejects missing, array, or malformed headers', () => {
    expect(claimRequestIsSameOrigin({})).toBe(false);
    expect(claimRequestIsSameOrigin({ origin: ['a', 'b'], host: 'x' })).toBe(false);
    expect(claimRequestIsSameOrigin({ origin: 'not a url', host: 'x' })).toBe(false);
  });
});

describe('WaitlistController', () => {
  let chain: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };
  let controller: WaitlistController;

  beforeEach(() => {
    chain = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orUpdate: jest.fn(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    chain.insert.mockReturnValue(chain);
    chain.into.mockReturnValue(chain);
    chain.values.mockReturnValue(chain);
    chain.orUpdate.mockReturnValue(chain);
    controller = new WaitlistController({
      createQueryBuilder: () => chain,
    } as unknown as Repository<WaitlistClaim>);
  });

  it('keeps the legacy self-hosted claim endpoint as a no-op success', () => {
    expect(controller.receiveClaim()).toEqual({ ok: true });
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('stores a claim with a normalized email and the declared source', async () => {
    await expect(
      controller.receivePivotClaim({ email: '  Jane@Example.COM ', source: 'cloud' }, reqWith()),
    ).resolves.toEqual({ ok: true });

    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jane@example.com', source: 'cloud' }),
    );
    const row = chain.values.mock.calls[0][0] as { claimed_at: string };
    expect(Number.isNaN(Date.parse(row.claimed_at))).toBe(false);
  });

  it('infers cloud for a sourceless same-origin claim (stale cloud bundle)', async () => {
    await controller.receivePivotClaim(
      { email: 'jane@example.com' },
      reqWith({ origin: 'https://app.manifest.build', host: 'app.manifest.build' }),
    );
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ source: 'cloud' }));
  });

  it('defaults a sourceless cross-origin or headerless claim to self-hosted', async () => {
    await controller.receivePivotClaim({ email: 'jane@example.com' }, reqWith());
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ source: 'self-hosted' }));
  });

  it('lets an explicit source win over the origin inference', async () => {
    await controller.receivePivotClaim(
      { email: 'jane@example.com', source: 'self-hosted' },
      reqWith({ origin: 'https://app.manifest.build', host: 'app.manifest.build' }),
    );
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ source: 'self-hosted' }));
  });

  it('lets the latest claim win on conflict, but never over a website row', async () => {
    await controller.receivePivotClaim(
      { email: 'jane@example.com', source: 'self-hosted' },
      reqWith(),
    );
    expect(chain.orUpdate).toHaveBeenCalledWith(['source', 'claimed_at'], ['email'], {
      overwriteCondition: {
        where: '"waitlist_claims"."source" != :websiteSource',
        parameters: { websiteSource: 'website' },
      },
    });
  });
});
