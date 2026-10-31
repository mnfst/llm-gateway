// RET-480-B2 — provider-client accounting hooks: the attempt counter must see
// the EXACT wire fetch body (model + stream folded in by forward()), must be
// counted BEFORE fetch (retries/timeouts count), and must never break the
// forward even when the hook explodes.

import { ProviderClient } from '../provider-client';

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

const recordAttempt = jest.fn();
const quotaAccounting = {
  recordAttempt,
  recordConsumed: jest.fn(),
  noteWindowFlush: jest.fn(),
};

const buildClient = () =>
  new ProviderClient(undefined, undefined, undefined, undefined, quotaAccounting as never);

const forwardOpts = (stream: boolean) => ({
  provider: 'openai',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  body: { messages: [{ role: 'user', content: 'Hello' }], temperature: 0.7 },
  stream,
});

describe('ProviderClient — quota accounting recordAttempt (RET-480-B2)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    recordAttempt.mockReset();
  });

  it('counts the attempt BEFORE fetch with the exact serialized wire body', async () => {
    let fetchBody: unknown;
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      // By fetch time the attempt must already be counted.
      expect(recordAttempt).toHaveBeenCalledTimes(1);
      fetchBody = init.body;
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const client = buildClient();
    await client.forward(forwardOpts(true));

    expect(recordAttempt).toHaveBeenCalledTimes(1);
    const [provider, wireBody] = recordAttempt.mock.calls[0];
    expect(provider).toBe('openai');
    // Exact wire bytes: serialize-once means the hook arg === fetch body.
    expect(wireBody).toBe(fetchBody);
    const parsed = JSON.parse(wireBody as string) as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.stream).toBe(true);
    expect(parsed.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('counts a rejected fetch (timeout/transport) as an attempt too', async () => {
    mockFetch.mockRejectedValueOnce(new Error('The operation was aborted'));
    const client = buildClient();
    await expect(client.forward(forwardOpts(true))).rejects.toBeDefined();
    expect(recordAttempt).toHaveBeenCalledTimes(1);
  });

  it('never breaks the forward when the accounting hook explodes', async () => {
    recordAttempt.mockImplementationOnce(() => {
      throw new Error('accounting backend down');
    });
    mockFetch.mockResolvedValueOnce(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const client = buildClient();
    const result = await client.forward(forwardOpts(true));
    expect(result.response.status).toBe(200);
  });

  it('counts each healed wire-body retry as its own attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"bad param"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const client = buildClient();
    const first = await client.forward(forwardOpts(true));
    await first.retryWireBody?.({ ...forwardOpts(true).body, temperature: 0.5 });
    expect(recordAttempt).toHaveBeenCalledTimes(2);
  });
});
