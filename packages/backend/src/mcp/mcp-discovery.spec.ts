import express from 'express';
import request from 'supertest';
import { mountMcpDiscovery } from './mcp-discovery';

jest.mock('../auth/auth.instance', () => ({
  authInstance: {},
  authOrigin: 'http://localhost:3001',
  authIssuer: 'http://localhost:3001/api/auth',
  mcpResource: 'http://localhost:3001/api/v1/mcp',
  authOriginForHost: (host: string) =>
    host === 'gateway.manifest.build' ? 'https://gateway.manifest.build' : 'http://localhost:3001',
  authIssuerForHost: (host: string) =>
    host === 'gateway.manifest.build'
      ? 'https://gateway.manifest.build/api/auth'
      : 'http://localhost:3001/api/auth',
  mcpResourceForHost: (host: string) =>
    host === 'gateway.manifest.build'
      ? 'https://gateway.manifest.build/api/v1/mcp'
      : 'http://localhost:3001/api/v1/mcp',
  MCP_SCOPES: ['mcp:read', 'mcp:write'],
}));
jest.mock('@better-auth/oauth-provider', () => ({
  oauthProviderAuthServerMetadata: jest.fn(),
}));
jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn(() => new Headers()) }));

const { oauthProviderAuthServerMetadata } = jest.requireMock('@better-auth/oauth-provider') as {
  oauthProviderAuthServerMetadata: jest.Mock;
};

function makeApp(): express.Express {
  const app = express();
  mountMcpDiscovery({
    getHttpAdapter: () => ({ getInstance: () => app }),
  } as never);
  return app;
}

describe('mountMcpDiscovery', () => {
  beforeEach(() => {
    oauthProviderAuthServerMetadata.mockReset();
    oauthProviderAuthServerMetadata.mockReturnValue(
      async () =>
        new Response(JSON.stringify({ issuer: 'http://localhost:3001/api/auth' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  });

  it('serves the protected-resource metadata at both well-known forms', async () => {
    const app = makeApp();
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp',
    ]) {
      const res = await request(app).get(path).expect(200);
      expect(res.body).toMatchObject({
        resource: 'http://localhost:3001/api/v1/mcp',
        authorization_servers: ['http://localhost:3001/api/auth'],
        scopes_supported: ['mcp:read', 'mcp:write'],
      });
      expect(res.headers['access-control-allow-origin']).toBe('*');
    }
  });

  it('answers HEAD on the resource metadata', async () => {
    await request(makeApp()).head('/.well-known/oauth-protected-resource').expect(200);
  });

  it('advertises the gateway resource and issuer to gateway clients', async () => {
    const res = await request(makeApp())
      .get('/.well-known/oauth-protected-resource/api/v1/mcp')
      .set('Host', 'gateway.manifest.build')
      .expect(200);
    expect(res.body).toMatchObject({
      resource: 'https://gateway.manifest.build/api/v1/mcp',
      authorization_servers: ['https://gateway.manifest.build/api/auth'],
    });
  });

  it('proxies the authorization-server metadata at the path-suffixed well-known', async () => {
    const res = await request(makeApp())
      .get('/.well-known/oauth-authorization-server/api/auth')
      .expect(200);
    expect(res.body).toMatchObject({ issuer: 'http://localhost:3001/api/auth' });
  });

  it('uses the gateway host for gateway authorization metadata', async () => {
    const serve = jest.fn(async (req: Request) =>
      new Response(JSON.stringify({ issuer: new URL(req.url).origin + '/api/auth' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    oauthProviderAuthServerMetadata.mockReturnValue(serve);
    const res = await request(makeApp())
      .get('/.well-known/oauth-authorization-server/api/auth')
      .set('Host', 'gateway.manifest.build')
      .expect(200);
    expect(res.body.issuer).toBe('https://gateway.manifest.build/api/auth');
    expect(serve.mock.calls[0][0].url).toBe(
      'https://gateway.manifest.build/.well-known/oauth-authorization-server/api/auth',
    );
  });

  it('answers the origin root well-known with JSON, not the SPA shell', async () => {
    const res = await request(makeApp()).get('/.well-known/oauth-authorization-server').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404 });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers 404 when the authorization-server metadata is unavailable', async () => {
    oauthProviderAuthServerMetadata.mockReturnValue(async () => {
      throw new Error('down');
    });
    await request(makeApp()).get('/.well-known/oauth-authorization-server/api/auth').expect(404);
  });
});
