import { UnauthorizedException, BadRequestException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArgumentsHost } from '@nestjs/common';
import { FREE_PLAN_REQUESTS_PER_MONTH } from 'manifest-shared';
import { ProxyExceptionFilter } from '../proxy-exception.filter';
import type { ProxyMessageRecorder } from '../proxy-message-recorder';

function createMockHost(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const req: Record<string, unknown> = { body, headers };

  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
  };

  return {
    host: {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ArgumentsHost,
    res,
    req,
  };
}

/** Helper for the existing tests that exercised the chat-client friendly path. */
function chatHost(body: Record<string, unknown> = {}) {
  return createMockHost(body, { accept: 'text/event-stream' });
}

describe('ProxyExceptionFilter', () => {
  let filter: ProxyExceptionFilter;
  let config: jest.Mocked<ConfigService>;
  let recordManifestBlockedRequest: jest.Mock;

  beforeEach(() => {
    config = {
      get: jest.fn((key: string) => {
        if (key === 'app.betterAuthUrl') return 'http://localhost:3001';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    recordManifestBlockedRequest = jest.fn().mockResolvedValue(undefined);
    filter = new ProxyExceptionFilter(config, {
      recordManifestBlockedRequest,
    } as unknown as ProxyMessageRecorder);
  });

  describe('auth errors (401) — chat client', () => {
    it('converts "Authorization header required" to friendly message', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('Authorization header required'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({
                content: expect.stringContaining('Missing the Authorization header'),
              }),
            }),
          ]),
        }),
      );
    });

    it('converts "Empty token" to friendly message', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('Empty token'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toContain('Bearer token is empty');
    });

    it('converts "Invalid API key format" to friendly message', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('Invalid API key format'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toContain('mnfst_');
    });

    it('converts "API key expired" with dashboard URL', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('API key expired'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toContain('expired');
      expect(content).toContain('http://localhost:3001');
      expect(content).not.toContain('/routing');
    });

    it('converts "Invalid API key" to friendly message', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toContain("I don't recognize this key");
    });
  });

  describe('recording an expired key (M004)', () => {
    it('records the rejection against the agent the guard resolved', () => {
      const { host, req } = chatHost({ model: 'gpt-4o' });
      req.manifestErrorContext = {
        tenantId: 't-1',
        agentId: 'a-1',
        agentName: 'Fireplace',
        userId: 'u-1',
      };

      filter.catch(new UnauthorizedException('API key expired'), host);

      expect(recordManifestBlockedRequest).toHaveBeenCalledWith(
        req.manifestErrorContext,
        expect.objectContaining({
          httpStatus: 401,
          errorCode: 'M004',
          reason: 'key_expired',
          model: 'gpt-4o',
          errorMessage: expect.stringContaining('M004'),
        }),
      );
    });

    it('stores the same text the caller saw, dashboard link included', () => {
      const { host, req, res } = chatHost();
      req.manifestErrorContext = {
        tenantId: 't-1',
        agentId: 'a-1',
        agentName: 'Fireplace',
        userId: null,
      };

      filter.catch(new UnauthorizedException('API key expired'), host);

      const recorded = recordManifestBlockedRequest.mock.calls[0][1].errorMessage as string;
      const shown = res.json.mock.calls[0][0].choices[0].message.content as string;
      expect(recorded).toBe(shown);
      // A row that doesn't say where to generate a new key isn't actionable.
      expect(recorded).toContain('http://localhost:3001');
    });

    it('records nothing when the key never resolved to an agent', () => {
      const { host } = chatHost();
      filter.catch(new UnauthorizedException('API key expired'), host);
      expect(recordManifestBlockedRequest).not.toHaveBeenCalled();
    });

    it('records nothing for auth failures that cannot be attributed', () => {
      const { host, req } = chatHost();
      req.manifestErrorContext = {
        tenantId: 't-1',
        agentId: 'a-1',
        agentName: 'Fireplace',
        userId: null,
      };
      filter.catch(new UnauthorizedException('Invalid API key'), host);
      expect(recordManifestBlockedRequest).not.toHaveBeenCalled();
    });

    it('swallows a recorder failure rather than turning a 401 into a 500', () => {
      recordManifestBlockedRequest.mockRejectedValueOnce(new Error('db down'));
      const { host, req, res } = chatHost();
      req.manifestErrorContext = {
        tenantId: 't-1',
        agentId: 'a-1',
        agentName: 'Fireplace',
        userId: null,
      };

      expect(() => filter.catch(new UnauthorizedException('API key expired'), host)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('omits a non-string model rather than persisting garbage', () => {
      const { host, req } = chatHost({ model: 42 });
      req.manifestErrorContext = {
        tenantId: 't-1',
        agentId: 'a-1',
        agentName: 'Fireplace',
        userId: null,
      };

      filter.catch(new UnauthorizedException('API key expired'), host);

      expect(recordManifestBlockedRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ model: undefined }),
      );
    });

    it('includes dashboard URL in auth error messages', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toContain('Dashboard: http://localhost:3001');
      expect(content).not.toContain('Dashboard: http://localhost:3001/routing');
    });
  });

  describe('streaming responses', () => {
    it('returns SSE format when stream=true', () => {
      const { host, res } = createMockHost({ stream: true });
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.status).toHaveBeenCalledWith(200);
      const payload = res.send.mock.calls[0][0] as string;
      expect(payload).toContain('data: [DONE]');
      expect(payload).toContain('chat.completion.chunk');
    });

    it('returns SSE friendly response when client sends Accept: text/event-stream', () => {
      const { host, res } = createMockHost({}, { accept: 'text/event-stream' });
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      // Friendly JSON envelope is used here because stream=false even though
      // the Accept header signals a chat client.
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('429 passthrough', () => {
    it('passes rate limit errors through as HTTP 429', () => {
      const { host, res } = createMockHost();
      filter.catch(
        new HttpException('Too many requests — wait a few seconds and retry.', 429),
        host,
      );

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Too many requests — wait a few seconds and retry.',
          }),
        }),
      );
    });

    it('passes structured 429 errors through unchanged', () => {
      const errorBody = { error: { message: 'Rate limited', type: 'rate_limit' } };
      const { host, res } = createMockHost();
      filter.catch(new HttpException(errorBody, 429), host);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(errorBody);
    });
  });

  describe('other errors — chat client', () => {
    it('converts 400 errors to friendly chat message', () => {
      const { host, res } = chatHost();
      filter.catch(new BadRequestException('messages array is required'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toBe('messages array is required');
    });

    it('converts 500 errors to generic friendly message', () => {
      const { host, res } = chatHost();
      filter.catch(new HttpException('Some internal error', 500), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toContain('[🦚 Manifest M500]');
      expect(content).toContain('Something broke on our end');
      expect(content).toContain('https://manifest.build/llm-gateway/docs/errors/M500/');
    });

    it('converts unknown auth message to friendly message', () => {
      const { host, res } = chatHost();
      filter.catch(new UnauthorizedException('Some unknown auth error'), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const content = res.json.mock.calls[0][0].choices[0].message.content;
      expect(content).toBe('Some unknown auth error');
    });
  });

  describe('non-chat clients receive real HTTP statuses', () => {
    it('returns HTTP 401 with structured error envelope for known auth errors', () => {
      const { host, res } = createMockHost();
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'auth_error',
            code: 'manifest_auth',
            message: expect.stringContaining("don't recognize this key"),
          }),
        }),
      );
    });

    it('returns HTTP 400 when a known auth error originated as a 400', () => {
      const { host, res } = createMockHost();
      filter.catch(new BadRequestException('Invalid API key format'), host);

      expect(res.status).toHaveBeenCalledWith(400);
      const payload = res.json.mock.calls[0][0];
      expect(payload.error.type).toBe('auth_error');
    });

    it('returns the original 400 status for validation errors', () => {
      const { host, res } = createMockHost();
      filter.catch(new BadRequestException('messages array is required'), host);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'invalid_request_error',
            message: 'messages array is required',
          }),
        }),
      );
    });

    it('returns 500 with a sanitized message for server errors', () => {
      const { host, res } = createMockHost();
      filter.catch(new HttpException('Some internal error', 500), host);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'server_error',
            message: expect.stringContaining('internal error'),
          }),
        }),
      );
    });

    it('treats Accept: application/json callers as non-chat', () => {
      const { host, res } = createMockHost({}, { accept: 'application/json' });
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('treats stream=false + no accept header as non-chat', () => {
      const { host, res } = createMockHost({ stream: false });
      filter.catch(new UnauthorizedException('Invalid API key'), host);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('plan request-limit block (402 PLAN_LIMIT_REQUESTS)', () => {
    const blockExc = () =>
      new HttpException(
        {
          statusCode: 402,
          code: 'PLAN_LIMIT_REQUESTS',
          limit: FREE_PLAN_REQUESTS_PER_MONTH,
          used: FREE_PLAN_REQUESTS_PER_MONTH,
        },
        402,
      );

    it('renders the friendly M204 upgrade message for a non-streaming chat client (HTTP 200)', () => {
      const { host, res } = chatHost();
      filter.catch(blockExc(), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = res.json.mock.calls[0][0];
      const content = payload.choices[0].message.content as string;
      expect(content).toContain('M204');
      expect(content).toContain(`${FREE_PLAN_REQUESTS_PER_MONTH} requests`);
      expect(content).toContain('http://localhost:3001/upgrade?reason=requests');
    });

    it('returns a real 402 with insufficient_quota + code for an SDK/tool client', () => {
      const { host, res } = createMockHost({}, { accept: 'application/json' });
      filter.catch(blockExc(), host);

      expect(res.status).toHaveBeenCalledWith(402);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'insufficient_quota',
            code: 'PLAN_LIMIT_REQUESTS',
            message: expect.stringContaining('Upgrade to Pro'),
          }),
          limit: FREE_PLAN_REQUESTS_PER_MONTH,
          used: FREE_PLAN_REQUESTS_PER_MONTH,
        }),
      );
      const payload = res.json.mock.calls[0][0];
      expect(payload.error.message).toContain('http://localhost:3001/upgrade?reason=requests');
    });

    it('ignores a 402 without the PLAN_LIMIT_REQUESTS code (falls through)', () => {
      const { host, res } = createMockHost({}, { accept: 'application/json' });
      filter.catch(new HttpException({ statusCode: 402, code: 'SOMETHING_ELSE' }, 402), host);

      // Falls through to the generic tool envelope, not the billing branch.
      expect(res.status).toHaveBeenCalledWith(402);
      const payload = res.json.mock.calls[0][0];
      expect(payload.error.type).not.toBe('insufficient_quota');
    });

    it('renders the friendly M204 upgrade message as SSE for a streaming chat client', () => {
      const { host, res } = createMockHost({ stream: true });
      filter.catch(blockExc(), host);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.status).toHaveBeenCalledWith(200);
      const payload = res.send.mock.calls[0][0] as string;
      expect(payload).toContain('data: [DONE]');
      expect(payload).toContain('M204');
    });

    it('returns the 402 to an Accept: text/event-stream non-streaming client with a friendly response', () => {
      const { host, res } = chatHost();
      filter.catch(blockExc(), host);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = res.json.mock.calls[0][0];
      const content = payload.choices[0].message.content as string;
      expect(content).toContain('M204');
    });
  });
});
