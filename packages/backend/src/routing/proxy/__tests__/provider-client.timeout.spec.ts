// Tests that the PROVIDER_TIMEOUT_MS abort signal actually fires and
// aborts the in-flight fetch. The existing AbortSignal passthrough
// tests in provider-client.spec.ts only verify the signal is *created*
// and combined — they mock fetch to resolve immediately, so the timeout
// behavior is never exercised.
//
// PROVIDER_TIMEOUT_MS is captured at module import time, so each test
// imports a fresh copy of the module under jest.isolateModulesAsync
// with a short timeout override. The fetch mock returns a promise that
// only settles when the signal aborts — if the timeout doesn't fire,
// the test would block until Jest's per-test timeout (still a clear
// failure, but we keep the per-test cap at 5 seconds for speed).

import { ProviderClient } from '../provider-client';

const mockFetch = jest.fn();
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;

const body = {
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0.7,
};

describe('ProviderClient — timeout signal actually aborts the in-flight fetch', () => {
  const originalEnv = process.env.PROVIDER_TIMEOUT_MS;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PROVIDER_TIMEOUT_MS;
    else process.env.PROVIDER_TIMEOUT_MS = originalEnv;
  });

  it('fires PROVIDER_TIMEOUT_MS abort on pending fetch and surfaces the error', async () => {
    process.env.PROVIDER_TIMEOUT_MS = '25';

    let abortObserved = false;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        sig.addEventListener('abort', () => {
          abortObserved = true;
          // Mirror real fetch behavior: reject with the signal's abort reason.
          reject(sig.reason);
        });
      });
    });

    await jest.isolateModulesAsync(async () => {
      const { ProviderClient: FreshClient } = await import('../provider-client');
      const fresh = new FreshClient();
      await expect(
        fresh.forward({
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'gpt-4o',
          body,
          stream: false,
        }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    expect(abortObserved).toBe(true);
    // Sanity-check that the signal we received was the one that aborted.
    const finalSignal = (mockFetch.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(finalSignal.aborted).toBe(true);
  }, 5000);

  it('does NOT abort fetch when neither client signal nor timeout has elapsed', async () => {
    // Long timeout so it never fires inside the assertion window.
    process.env.PROVIDER_TIMEOUT_MS = '60000';

    let aborted = false;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      return new Promise(() => {
        sig.addEventListener('abort', () => {
          aborted = true;
        });
      });
    });

    await jest.isolateModulesAsync(async () => {
      const { ProviderClient: FreshClient } = await import('../provider-client');
      const fresh = new FreshClient();
      const pending = fresh.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
      });
      // Swallow the eventual rejection so the dangling forward (the real
      // 60s timeout fires after the test ends) doesn't trip Node's
      // unhandledRejection warning. We attach catch to BOTH the original
      // and the .then chain since both will reject when the timeout fires.
      const raced = pending.then(() => 'forwarded').catch(() => 'errored');
      // Race the pending forward against a short tick — the forward must NOT
      // win because neither client nor timeout signal has aborted yet.
      const winner = await Promise.race([
        raced,
        new Promise<string>((r) => setTimeout(() => r('still-pending'), 30)),
      ]);
      expect(winner).toBe('still-pending');
      expect(aborted).toBe(false);
    });
  }, 5000);

  it('caller-initiated AbortController.abort() propagates through combined signal', async () => {
    process.env.PROVIDER_TIMEOUT_MS = '60000';

    let abortObserved = false;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          abortObserved = true;
          reject(sig.reason);
        };
        // Handle both already-aborted (synchronous) and not-yet-aborted (event) cases.
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort);
      });
    });

    await jest.isolateModulesAsync(async () => {
      const { ProviderClient: FreshClient } = await import('../provider-client');
      const fresh = new FreshClient();
      const ac = new AbortController();
      const pending = fresh.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: false,
        signal: ac.signal,
      });
      // Yield to the microtask queue so forward() reaches fetch() before we abort.
      await new Promise((r) => setImmediate(r));
      ac.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    expect(abortObserved).toBe(true);
  }, 5000);

  it('surfaces a streaming response-header timeout as TimeoutError', async () => {
    process.env.PROVIDER_TIMEOUT_MS = '25';

    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const sig = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        sig.addEventListener('abort', () => reject(sig.reason));
      });
    });

    await jest.isolateModulesAsync(async () => {
      const { ProviderClient: FreshClient } = await import('../provider-client');
      const fresh = new FreshClient();
      await expect(
        fresh.forward({
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'gpt-4o',
          body,
          stream: true,
        }),
      ).rejects.toMatchObject({
        name: 'TimeoutError',
        message: 'Upstream provider request timed out',
      });
    });
  }, 5000);

  it('does not abort a streaming response body after headers arrive', async () => {
    process.env.PROVIDER_TIMEOUT_MS = '25';

    let fetchSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      fetchSignal = init.signal as AbortSignal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });

    await jest.isolateModulesAsync(async () => {
      const { ProviderClient: FreshClient } = await import('../provider-client');
      const fresh = new FreshClient();
      await fresh.forward({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        body,
        stream: true,
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(false);
  }, 5000);
});
