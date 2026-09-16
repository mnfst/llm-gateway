import { ApiClient } from './client';
import { CliError } from './errors';
import { VERSION } from './version';
import { fetchStub } from '../test/helpers';

function makeClient(replies: Array<{ status: number; body: unknown }>) {
  const stub = fetchStub(replies);
  const client = new ApiClient({
    origin: 'http://localhost:2099',
    apiKey: 'secret-key',
    fetchImpl: stub.impl,
  });
  return { client, calls: stub.calls };
}

describe('ApiClient', () => {
  it('sends X-API-Key, user agent, and query params under /api/v1', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true } }]);
    const result = await client.request('GET', '/agents', {
      query: { includePlayground: 'true', skip: undefined },
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0].url).toBe('http://localhost:2099/api/v1/agents?includePlayground=true');
    expect(calls[0].headers['X-API-Key']).toBe('secret-key');
    expect(calls[0].headers['User-Agent']).toBe(`mnfst-cli/${VERSION}`);
    expect(calls[0].headers['Content-Type']).toBeUndefined();
  });

  it('serializes JSON bodies with a content type', async () => {
    const { client, calls } = makeClient([{ status: 201, body: {} }]);
    await client.request('POST', '/agents', { body: { name: 'a' } });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('{"name":"a"}');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
  });

  it('returns null for an empty or non-JSON success body', async () => {
    const stub = fetchStub([{ status: 200, body: null }]);
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      await stub.impl(url as string, init);
      return new Response('not-json', { status: 200 });
    }) as typeof fetch;
    const client = new ApiClient({ origin: 'http://h', apiKey: 'k', fetchImpl: impl });
    expect(await client.request('GET', '/x')).toBeNull();
  });

  it('refuses a redirect with one request instead of following it', async () => {
    const stub = fetchStub([{ status: 302, body: {} }]);
    const client = new ApiClient({
      origin: 'https://app.manifest.build',
      apiKey: 'secret-key',
      fetchImpl: stub.impl,
    });
    await expect(client.request('GET', '/me')).rejects.toMatchObject({
      code: 'redirect_not_allowed',
      status: 302,
    });
    // Exactly one request, to the configured origin: the key never follows.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].headers['X-API-Key']).toBe('secret-key');
  });

  it('maps Nest error bodies onto the stable CliError shape', async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: { statusCode: 400, message: ['name too short', 'bad slug'], error: 'Bad Request' },
      },
    ]);
    const err = await client.request('POST', '/agents').then(
      () => {
        throw new Error('expected CliError');
      },
      (e) => e as CliError,
    );
    expect(err.code).toBe('bad_request');
    expect(err.message).toBe('name too short; bad slug');
    expect(err.status).toBe(400);
    expect(JSON.stringify(err.toJSON())).not.toContain('secret-key');
  });

  it('adds actionable hints for 401 and 404', async () => {
    const unauthorized = makeClient([{ status: 401, body: { message: 'Invalid API key' } }]);
    await expect(unauthorized.client.request('GET', '/me')).rejects.toMatchObject({
      status: 401,
      hint: expect.stringContaining('mnfst login'),
    });
    const missing = makeClient([{ status: 404, body: {} }]);
    await expect(missing.client.request('GET', '/agents/x')).rejects.toMatchObject({
      status: 404,
      message: 'Request failed with HTTP 404',
      hint: expect.stringContaining('agent list'),
    });
  });

  it('aborts requests after the configured timeout', async () => {
    const impl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('This operation was aborted')),
        );
      })) as typeof fetch;
    const client = new ApiClient({
      origin: 'http://slow',
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 5,
    });
    await expect(client.request('GET', '/me')).rejects.toMatchObject({ code: 'network_error' });
  });

  it('wraps transport failures as network_error without leaking the key', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:2099');
    }) as typeof fetch;
    const client = new ApiClient({
      origin: 'http://localhost:2099',
      apiKey: 'secret-key',
      fetchImpl: impl,
    });
    const err = await client.request('GET', '/me').then(
      () => {
        throw new Error('expected CliError');
      },
      (e) => e as CliError,
    );
    expect(err.code).toBe('network_error');
    expect(err.message).toContain('ECONNREFUSED');
    expect(JSON.stringify(err.toJSON())).not.toContain('secret-key');
  });
});
