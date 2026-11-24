import { buildMcpServer } from './mcp-server.factory';
import { McpToolDeps } from './tool-deps';
import { McpOperator } from './mcp-auth';

jest.mock('../auth/auth.instance', () => ({ authOrigin: 'http://localhost:3001' }));

interface FakeServer {
  tools: string[];
  info: unknown;
  opts: unknown;
}
const mockInstances: FakeServer[] = [];

jest.mock('@modelcontextprotocol/server', () => ({
  McpServer: jest.fn().mockImplementation(function (
    this: FakeServer,
    info: unknown,
    opts: unknown,
  ) {
    this.info = info;
    this.opts = opts;
    this.tools = [];
    (this as unknown as { registerTool: (name: string) => void }).registerTool = (name: string) =>
      this.tools.push(name);
    mockInstances.push(this);
  }),
  createMcpHandler: jest.fn(),
}));

const deps = {} as McpToolDeps;

describe('buildMcpServer', () => {
  it('registers the full tool set for a read+write token', () => {
    const server = buildMcpServer(deps, {
      userId: 'u',
      tenantId: 't',
      scopes: new Set(['mcp:read', 'mcp:write']),
    }) as unknown as FakeServer;
    expect(server.tools).toContain('manifest_agent_create');
    expect(server.tools).toContain('manifest_provider_connect');
    expect(server.tools).toContain('manifest_routing_test');
    expect(server.tools).toContain('manifest_guide');
    expect(JSON.stringify(server.opts)).toContain('create, update, and delete');
  });

  // A per-POST server can never push a list-changed notification, and the bit
  // is what makes a client open a `subscriptions/listen` stream against this
  // endpoint. `McpServer` sets it by default once a tool is registered.
  it('does not advertise tools.listChanged on the stateless transport', () => {
    const server = buildMcpServer(deps, {
      userId: 'u',
      tenantId: 't',
      scopes: new Set(['mcp:read']),
    }) as unknown as FakeServer;
    expect(server.opts).toMatchObject({ capabilities: { tools: { listChanged: false } } });
  });

  it('hides write tools from a read-only token', () => {
    const server = buildMcpServer(deps, {
      userId: 'u',
      tenantId: 't',
      scopes: new Set(['mcp:read']),
    } satisfies McpOperator) as unknown as FakeServer;
    expect(server.tools).toContain('manifest_agent_list');
    expect(server.tools).not.toContain('manifest_agent_create');
    expect(JSON.stringify(server.opts)).toContain('read-only');
  });
});
