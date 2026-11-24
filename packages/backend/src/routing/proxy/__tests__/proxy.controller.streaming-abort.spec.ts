import { ProxyController } from '../proxy.controller';
import { ProxyMessageRecorder } from '../proxy-message-recorder';
import { IngestEventBusService } from '../../../common/services/ingest-event-bus.service';
import { ThoughtSignatureCache } from '../thought-signature-cache';
import { ThinkingBlockCache } from '../thinking-block-cache';
import { ReasoningContentCache } from '../reasoning-content-cache';

/**
 * Tests for client abort during ACTIVE streaming. The base spec covers the
 * case where the service throws immediately after abort, but does not cover
 * the case where the service is mid-stream when the client disconnects.
 * This file isolates that scenario so we can rigorously assert:
 *   - res.end is called exactly once (no double-close)
 *   - no JSON envelope is written (no leaked error frame)
 *   - the rate-limit slot is still released
 *   - no error is thrown to the caller (handleProxyError swallows on abort)
 */

function mockResponse(): {
  res: Record<string, jest.Mock | boolean | number>;
  written: string[];
  headers: Record<string, string>;
} {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const res: Record<string, jest.Mock | boolean | number> = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      written.push(chunk);
    }),
    end: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    once: jest.fn(),
    writableEnded: false,
  };
  return { res, written, headers };
}

function mockRequest(
  body: Record<string, unknown>,
  userId = 'user-1',
  headers: Record<string, string> = {},
) {
  return {
    ingestionContext: {
      userId,
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      agentName: 'test-agent',
    },
    body,
    headers,
    ip: '127.0.0.1',
  };
}

function makeRecorder(repo: { insert: jest.Mock; findOne: jest.Mock; find: jest.Mock }) {
  const pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
  return new ProxyMessageRecorder(
    repo as never,
    pricingCache as never,
    { emit: jest.fn() } as unknown as IngestEventBusService,
    {
      canonicalizeAgentMessageKeys: jest
        .fn()
        .mockImplementation(async (_a: string, provider: string | null, model: string | null) => ({
          provider: provider ?? null,
          model: model ?? null,
        })),
    } as never,
    {
      getCostPerRequest: jest.fn().mockReturnValue(null),
      resolveCostPerRequest: jest.fn().mockResolvedValue(null),
    } as never,
  );
}

describe('ProxyController streaming abort', () => {
  let controller: ProxyController;
  let proxyService: { proxyRequest: jest.Mock };
  let rateLimiter: {
    checkLimit: jest.Mock;
    checkIpLimit: jest.Mock;
    recordSuccess: jest.Mock;
    acquireSlot: jest.Mock;
    releaseSlot: jest.Mock;
  };
  let providerClient: Record<string, jest.Mock>;
  let mockMessageRepo: { insert: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let modelDiscovery: { getModelsForAgent: jest.Mock };
  let recorder: ProxyMessageRecorder;

  beforeEach(() => {
    jest.clearAllMocks();
    proxyService = { proxyRequest: jest.fn() };
    rateLimiter = {
      checkLimit: jest.fn(),
      checkIpLimit: jest.fn(),
      recordSuccess: jest.fn(),
      acquireSlot: jest.fn(),
      releaseSlot: jest.fn(),
    };
    providerClient = {
      convertGoogleResponse: jest.fn(),
      convertGoogleStreamChunk: jest.fn(),
      convertAnthropicResponse: jest.fn(),
      convertAnthropicStreamChunk: jest.fn(),
    };
    mockMessageRepo = {
      insert: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    modelDiscovery = {
      getModelsForAgent: jest.fn().mockResolvedValue([]),
    };
    recorder = makeRecorder(mockMessageRepo);
    controller = new ProxyController(
      proxyService as never,
      rateLimiter as never,
      providerClient as never,
      recorder,
      new ThoughtSignatureCache(),
      new ThinkingBlockCache(),
      new ReasoningContentCache(),
      modelDiscovery as never,
      { assertWithinRequestLimit: jest.fn().mockResolvedValue(undefined) } as never,
      { report: jest.fn() } as never,
      { getCapabilities: jest.fn().mockResolvedValue(null) } as never,
      {
        lookupModel: jest.fn().mockReturnValue(null),
        lookupModelCapabilities: jest.fn().mockReturnValue(null),
      } as never,
    );
  });

  afterEach(() => {
    recorder.onModuleDestroy();
  });

  it('ends response once and swallows error when abort fires while proxyRequest is pending', async () => {
    const cancelledSpy = jest.spyOn(recorder, 'recordCancelledRequest');
    // proxyService returns a Promise that resolves only when the abort signal
    // fires — modeling an in-flight request that gets cancelled mid-pipe.
    proxyService.proxyRequest.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    const { res } = mockResponse();

    // Capture the controller's close listener so we can fire it manually
    // mid-flight (simulating the client socket closing during streaming).
    let closeListener: (() => void) | undefined;
    (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
      if (event === 'close') closeListener = cb;
    });

    const handlerPromise = controller.chatCompletions(req as never, res as never);

    // Wait for the controller to wire up the listener and call proxyRequest.
    await new Promise((r) => setImmediate(r));
    expect(closeListener).toBeDefined();
    expect(proxyService.proxyRequest).toHaveBeenCalled();

    // Verify the controller actually passed an AbortSignal and it has not
    // fired yet — i.e. we are mid-flight when the client disconnects.
    const opts = proxyService.proxyRequest.mock.calls[0][0] as { signal: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);

    // Fire the 'close' event — this should trigger clientAbort.abort()
    // inside the controller, which rejects the in-flight proxyRequest
    // promise via the listener we registered above.
    closeListener!();

    // The handler must resolve (no thrown error escapes to the caller)
    // and not deadlock waiting on the never-resolving promise.
    await expect(handlerPromise).resolves.toBeUndefined();

    // res.end called exactly once, no JSON envelope written, no status set
    // (the controller silently ends the stream on abort).
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(opts.signal.aborted).toBe(true);
    expect(cancelledSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', agentId: 'agent-1' }),
      expect.objectContaining({
        requestId: expect.any(String),
        attempt: undefined,
      }),
    );

    // Slot must still be released even though the request was aborted.
    expect(rateLimiter.releaseSlot).toHaveBeenCalledWith('tenant-1');
  });

  it('does not call res.end again when writableEnded is true at abort time', async () => {
    // Same flow, but the response has already been ended (e.g. by pipeStream's
    // finally block) before the catch block runs. The controller must NOT
    // double-close, which would throw "write after end" in real Express.
    proxyService.proxyRequest.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    const { res } = mockResponse();
    res.writableEnded = true;

    let closeListener: (() => void) | undefined;
    (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
      if (event === 'close') closeListener = cb;
    });

    const handlerPromise = controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setImmediate(r));
    closeListener!();

    await expect(handlerPromise).resolves.toBeUndefined();

    expect(res.end).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(rateLimiter.releaseSlot).toHaveBeenCalledWith('tenant-1');
  });

  it('records no error message when request was aborted mid-flight', async () => {
    // When the client cancels, we should NOT persist an agent_message with
    // status='error' — the abort is normal client behavior, not a failure
    // we want surfaced in analytics.
    proxyService.proxyRequest.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const req = mockRequest({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    const { res } = mockResponse();

    let closeListener: (() => void) | undefined;
    (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
      if (event === 'close') closeListener = cb;
    });

    const handlerPromise = controller.chatCompletions(req as never, res as never);
    await new Promise((r) => setImmediate(r));
    closeListener!();
    await handlerPromise;

    // Flush microtasks for any fire-and-forget recorder chain.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // No agent_message rows written for the abort path
    expect(mockMessageRepo.insert).not.toHaveBeenCalled();
  });
});
