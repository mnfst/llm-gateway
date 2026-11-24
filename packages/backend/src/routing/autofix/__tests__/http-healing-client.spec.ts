import { HealContractError } from '../healing-client';
import { HttpHealingClient } from '../http-healing-client';
import type { HealOutcome, HealRequest, HealResponse } from '../phoenix.types';

/** Minimal Response-like stub for fetch resolutions. */
function fakeResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeHealRequest(): HealRequest {
  return {
    traceId: 'trace-1',
    tenantId: 'tenant-1',
    provider: 'openai',
    authType: 'api_key',
    api: 'responses',
    request: { max_tokens: 100 },
    response: { statusCode: 400, error: { message: 'bad' } },
  };
}

function makeInstanceId(id = 'install-1') {
  return jest.fn(async () => id);
}

const context = { harness: 'claude-code' } as const;

describe('HttpHealingClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('heal', () => {
    it('POSTs to `${baseUrl}/api/heal` and returns parsed JSON on 200', async () => {
      const healResponse: HealResponse = { status: 'no_patch', issueId: 'i-1' };
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, healResponse));
      const client = new HttpHealingClient('http://x', 1000);
      const input = makeHealRequest();

      const res = await client.heal(input, context);

      expect(res).toEqual(healResponse);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://x/api/heal');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'content-type': 'application/json' });
      expect(init.body).toBe(JSON.stringify(input));
    });

    it('throws a plain Error (a transport failure the breaker counts) on a 5xx', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(false, 500, {}));
      const client = new HttpHealingClient('http://x', 1000);

      const err = await client.heal(makeHealRequest(), context).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(HealContractError);
      expect((err as Error).message).toBe('Phoenix /api/heal responded 500');
    });

    it('throws a HealContractError carrying the status on a 4xx (contract/auth error)', async () => {
      // 401 = Phoenix is up but rejected us (missing/invalid key). The service
      // must be able to tell this apart from an outage so it never trips the breaker.
      fetchSpy.mockResolvedValue(fakeResponse(false, 401, {}));
      const client = new HttpHealingClient('http://x', 1000, 'secret');

      const err = await client.heal(makeHealRequest(), context).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HealContractError);
      expect((err as HealContractError).status).toBe(401);
    });

    it('sends the API key and Manifest version when an API key is configured', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, { status: 'no_patch', issueId: 'i' }));
      const client = new HttpHealingClient('http://x', 1000, 'secret-key', undefined, '6.19.1');

      await client.heal(makeHealRequest(), context);

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        'x-api-key': 'secret-key',
        'X-Manifest-Version': '6.19.1',
      });
    });

    it('announces the install id on the first call, with no registration round-trip', async () => {
      fetchSpy.mockResolvedValue(
        fakeResponse(true, 200, { status: 'no_patch', issueId: 'issue-1' }),
      );
      const client = new HttpHealingClient('http://x', 1000, undefined, makeInstanceId(), '6.15.1');

      await client.heal(makeHealRequest(), context);

      // One call, straight to /api/heal. The old design spent a request on
      // /api/instances/register before it could send anything.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('http://x/api/heal');
      expect(fetchSpy.mock.calls[0][1].headers).toEqual({
        'content-type': 'application/json',
        'X-Manifest-Instance': 'install-1',
        'X-Manifest-Version': '6.15.1',
        'X-Manifest-Harness': 'claude-code',
      });
    });

    it('sends no bearer secret: the id is an identifier, not a credential', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, { status: 'no_patch', issueId: 'i' }));
      const client = new HttpHealingClient('http://x', 1000, undefined, makeInstanceId(), '6.15.1');

      await client.heal(makeHealRequest(), context);

      expect(fetchSpy.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('surfaces a 401 instead of rotating, since there is nothing to rotate', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(false, 401, {}));
      const client = new HttpHealingClient('http://x', 1000, undefined, makeInstanceId(), '6.15.1');

      const err = await client.heal(makeHealRequest(), context).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HealContractError);
      expect((err as HealContractError).status).toBe(401);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('resolves the id through the provider on every call', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, { status: 'no_patch', issueId: 'i' }));
      const instanceId = makeInstanceId();
      const client = new HttpHealingClient('http://x', 1000, undefined, instanceId, '6.15.1');

      await client.heal(makeHealRequest(), context);
      await client.heal(makeHealRequest(), context);

      // The provider caches; the client stays stateless so it never holds a
      // stale id across a rotation on the telemetry side.
      expect(instanceId).toHaveBeenCalledTimes(2);
    });

    it('falls back to "unknown" when the manifest version is unavailable', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, { status: 'no_patch', issueId: 'i' }));
      const client = new HttpHealingClient('http://x', 1000, undefined, makeInstanceId());

      await client.heal(makeHealRequest(), context);

      expect(fetchSpy.mock.calls[0][1].headers['X-Manifest-Version']).toBe('unknown');
    });

    it('requires a bounded harness on the instance-identified path', async () => {
      const client = new HttpHealingClient('http://x', 1000, undefined, makeInstanceId(), '6.15.1');

      // The type makes this unreachable for typed callers; the cast reproduces
      // an untyped JS caller, which the runtime guard still has to reject.
      await expect(client.heal(makeHealRequest(), undefined as never)).rejects.toThrow(
        'Autofix harness is required',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('gives the static API key precedence over the instance id', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, { status: 'no_patch', issueId: 'i' }));
      const instanceId = makeInstanceId();
      const client = new HttpHealingClient('http://x', 1000, 'static-key', instanceId, '6.15.1');

      await client.heal(makeHealRequest(), context);

      expect(instanceId).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls[0][1].headers).toEqual({
        'content-type': 'application/json',
        'x-api-key': 'static-key',
        'X-Manifest-Version': '6.15.1',
      });
    });

    it('strips a trailing slash from baseUrl so the heal URL has no double slash', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, { status: 'no_patch', issueId: 'i' }));
      const client = new HttpHealingClient('http://x/', 1000);

      await client.heal(makeHealRequest(), context);

      expect(fetchSpy.mock.calls[0][0]).toBe('http://x/api/heal');
    });
  });

  describe('reportOutcome', () => {
    const outcome: HealOutcome = { retryStatusCode: 200 };

    it('PATCHes `${baseUrl}/api/heal-attempts/<id>` (URL-encoded) and returns parsed JSON on 200', async () => {
      const confirmResponse = {
        healAttemptId: 'heal/1',
        status: 'succeeded',
        issueStatus: 'verified',
      };
      fetchSpy.mockResolvedValue(fakeResponse(true, 200, confirmResponse));
      const client = new HttpHealingClient('http://x', 1000);

      const res = await client.reportOutcome('heal/1', outcome, context);

      expect(res).toEqual(confirmResponse);
      const [url, init] = fetchSpy.mock.calls[0];
      // The '/' in the id must be percent-encoded.
      expect(url).toBe('http://x/api/heal-attempts/heal%2F1');
      expect(init.method).toBe('PATCH');
      expect(init.headers).toEqual({ 'content-type': 'application/json' });
      expect(init.body).toBe(JSON.stringify(outcome));
    });

    it('sends the x-api-key header on the PATCH when an API key is configured', async () => {
      fetchSpy.mockResolvedValue(
        fakeResponse(true, 200, {
          healAttemptId: 'h',
          status: 'succeeded',
          issueStatus: 'unverified',
        }),
      );
      const client = new HttpHealingClient('http://x', 1000, 'secret-key');

      await client.reportOutcome('h', outcome, context);

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        'x-api-key': 'secret-key',
        'X-Manifest-Version': 'unknown',
      });
    });

    it('sends instance identity headers on the PATCH', async () => {
      fetchSpy.mockResolvedValue(
        fakeResponse(true, 200, {
          healAttemptId: 'h',
          status: 'succeeded',
          issueStatus: 'unverified',
        }),
      );
      const client = new HttpHealingClient(
        'http://x',
        1000,
        undefined,
        makeInstanceId('instance-1'),
        '6.15.1',
      );

      await client.reportOutcome('h', outcome, context);

      expect(fetchSpy.mock.calls[0][1].headers['X-Manifest-Harness']).toBe('claude-code');
      expect(fetchSpy.mock.calls[0][1].headers['X-Manifest-Instance']).toBe('instance-1');
      expect(fetchSpy.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('returns null on a non-ok response', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(false, 404, {}));
      const client = new HttpHealingClient('http://x', 1000);

      const res = await client.reportOutcome('heal-1', outcome, context);

      expect(res).toBeNull();
    });

    it('returns null (does not throw) when fetch rejects', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const client = new HttpHealingClient('http://x', 1000);

      await expect(client.reportOutcome('heal-1', outcome, context)).resolves.toBeNull();
    });
  });

  describe('observe', () => {
    /** Response stub whose body records that it was released. */
    function observeResponse(ok: boolean, status: number, cancel = jest.fn()) {
      return {
        response: { ok, status, body: { cancel } } as unknown as Response,
        cancel,
      };
    }

    it('POSTs the batch to `${baseUrl}/api/heal/observe`', async () => {
      const { response } = observeResponse(true, 200);
      fetchSpy.mockResolvedValue(response);
      const client = new HttpHealingClient('http://x', 1000, 'secret-key');
      const batch = [makeHealRequest()];

      await client.observe(batch, context);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://x/api/heal/observe');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        'x-api-key': 'secret-key',
        'X-Manifest-Version': 'unknown',
      });
      expect(JSON.parse(init.body)).toEqual({ observations: batch });
    });

    it('sends instance identity headers on observations', async () => {
      const { response } = observeResponse(true, 200);
      fetchSpy.mockResolvedValue(response);
      const client = new HttpHealingClient(
        'http://x',
        1000,
        undefined,
        makeInstanceId('instance-1'),
        '6.15.1',
      );

      await client.observe([makeHealRequest()], context);

      expect(fetchSpy.mock.calls[0][1].headers['X-Manifest-Harness']).toBe('claude-code');
      expect(fetchSpy.mock.calls[0][1].headers['X-Manifest-Instance']).toBe('instance-1');
      expect(fetchSpy.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('releases the response body so the connection is not held open', async () => {
      const { response, cancel } = observeResponse(true, 200);
      fetchSpy.mockResolvedValue(response);
      const client = new HttpHealingClient('http://x', 1000);

      await client.observe([makeHealRequest()], context);

      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('does not call fetch for an empty batch', async () => {
      const client = new HttpHealingClient('http://x', 1000);

      await client.observe([], context);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('swallows a non-ok response — evidence is lost, never the request', async () => {
      const { response, cancel } = observeResponse(false, 401);
      fetchSpy.mockResolvedValue(response);
      const client = new HttpHealingClient('http://x', 1000);

      await expect(client.observe([makeHealRequest()], context)).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('swallows a transport failure', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const client = new HttpHealingClient('http://x', 1000);

      await expect(client.observe([makeHealRequest()], context)).resolves.toBeUndefined();
    });
  });
});
