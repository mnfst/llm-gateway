import { McpController } from './mcp.controller';
import type { Request, Response } from 'express';

jest.mock('../auth/auth.instance', () => ({
  auth: { $context: Promise.resolve({ baseURL: '', internalAdapter: {} }) },
  authIssuer: 'http://localhost:3001/api/auth',
  mcpResource: 'http://localhost:3001/api/v1/mcp',
  authIssuerForHost: (host: string) =>
    host === 'gateway.manifest.build'
      ? 'https://gateway.manifest.build/api/auth'
      : 'http://localhost:3001/api/auth',
  mcpResourceForHost: (host: string) =>
    host === 'gateway.manifest.build'
      ? 'https://gateway.manifest.build/api/v1/mcp'
      : 'http://localhost:3001/api/v1/mcp',
  MCP_READ_SCOPE: 'mcp:read',
}));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn(() => new Headers()) }));
jest.mock('better-auth/oauth2', () => ({ createDpopReplayStore: jest.fn(() => ({})) }));
jest.mock('@better-auth/mcp', () => ({ createMcpProtectedRequestHandler: jest.fn() }));
jest.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: jest.fn(),
  McpServer: jest.fn(),
}));

const { auth } = jest.requireMock('../auth/auth.instance') as {
  auth: { $context: Promise<{ baseURL: string; internalAdapter: object }> };
};
const { createDpopReplayStore } = jest.requireMock('better-auth/oauth2') as {
  createDpopReplayStore: jest.Mock;
};
const { createMcpProtectedRequestHandler } = jest.requireMock('@better-auth/mcp') as {
  createMcpProtectedRequestHandler: jest.Mock;
};
const { createMcpHandler } = jest.requireMock('@modelcontextprotocol/server') as {
  createMcpHandler: jest.Mock;
};

function makeController(tenantId: string | null): McpController {
  const args: unknown[] = new Array(24).fill(undefined);
  args[1] = { resolve: jest.fn().mockResolvedValue(tenantId) };
  return new (McpController as unknown as new (...a: unknown[]) => McpController)(...args);
}

function makeRes() {
  const res = {
    set: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response & {
    set: jest.Mock;
    status: jest.Mock;
    send: jest.Mock;
  };
}

const req = {
  method: 'POST',
  headers: {},
  body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
} as unknown as Request;

describe('McpController', () => {
  beforeEach(() => {
    createMcpProtectedRequestHandler.mockReset();
    createDpopReplayStore.mockClear();
    createMcpHandler.mockReset();
  });

  it('serves a tool call with an explicit issuer when auth has a dynamic base URL', async () => {
    createMcpHandler.mockReturnValue({
      fetch: jest.fn().mockResolvedValue(new Response('OK', { status: 200 })),
    });
    createMcpProtectedRequestHandler.mockImplementation(
      (_options: unknown, cb: (r: unknown, c: unknown) => Promise<Response>) =>
        (request: unknown) => cb(request, { sub: 'user-1', scope: 'mcp:read' }),
    );
    const res = makeRes();
    await makeController('tenant-1').handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('OK');
    const { internalAdapter, baseURL } = await auth.$context;
    expect(baseURL).toBe('');
    expect(createDpopReplayStore).toHaveBeenCalledWith(internalAdapter);
    expect(createMcpProtectedRequestHandler).toHaveBeenCalledWith(
      {
        issuer: 'http://localhost:3001/api/auth',
        audience: 'http://localhost:3001/api/v1/mcp',
        jwksUrl: 'http://localhost:3001/api/auth/jwks',
        requiredScopes: ['mcp:read'],
        dpop: { replayStore: createDpopReplayStore.mock.results[0].value },
      },
      expect.any(Function),
    );
  });

  it('answers 401 with a WWW-Authenticate challenge when the operator is gone', async () => {
    createMcpProtectedRequestHandler.mockImplementation(
      (_options: unknown, cb: (r: unknown, c: unknown) => Promise<Response>) =>
        (request: unknown) => cb(request, { sub: 'user-1', scope: 'mcp:read' }),
    );
    const res = makeRes();
    await makeController(null).handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.send.mock.calls[0][0] as string;
    expect(body).toContain('operator no longer exists');
    expect(res.set).toHaveBeenCalledWith(
      'www-authenticate',
      expect.stringContaining('resource_metadata='),
    );
    expect(res.set).toHaveBeenCalledWith(
      'www-authenticate',
      expect.stringContaining('invalid_token'),
    );
  });

  it('verifies gateway tokens against the gateway issuer and audience', async () => {
    createMcpProtectedRequestHandler.mockReturnValue(async () => new Response('OK'));
    const res = makeRes();
    await makeController('tenant-1').handle(
      { ...req, headers: { host: 'gateway.manifest.build' } } as Request,
      res as never,
    );
    expect(createMcpProtectedRequestHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer: 'https://gateway.manifest.build/api/auth',
        audience: 'https://gateway.manifest.build/api/v1/mcp',
        jwksUrl: 'https://gateway.manifest.build/api/auth/jwks',
      }),
      expect.any(Function),
    );
  });

  it('answers a thrown verify with a JSON-RPC 500', async () => {
    createMcpProtectedRequestHandler.mockReturnValue(async () => {
      throw new Error('boom');
    });
    const res = makeRes();
    await makeController('tenant-1').handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = JSON.parse(res.send.mock.calls[0][0] as string) as {
      error: { code: number; message: string };
    };
    // The caller gets a constant message; the detail is logged server-side.
    expect(body.error).toMatchObject({ code: -32603, message: 'Internal error' });
  });

  it('answers a non-Error throw with a generic JSON-RPC 500', async () => {
    createMcpProtectedRequestHandler.mockReturnValue(async () => {
      throw 'nope';
    });
    const res = makeRes();
    await makeController('tenant-1').handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send.mock.calls[0][0]).toContain('Internal error');
  });
  it.each(['rejectGet', 'rejectDelete'] as const)(
    '%s answers 405 with Allow: POST (stateless JSON transport, no SSE stream)',
    async (method) => {
      const controller = makeController('tenant-1');
      const res = makeRes();

      await controller[method](res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.set).toHaveBeenCalledWith('allow', 'POST');
      expect(res.set).toHaveBeenCalledWith('content-type', 'application/json');
      const body = JSON.parse(res.send.mock.calls[0][0] as string) as {
        jsonrpc: string;
        id: null;
        error: { code: number; message: string };
      };
      expect(body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed' },
      });
      expect(createMcpProtectedRequestHandler).not.toHaveBeenCalled();
    },
  );
});
