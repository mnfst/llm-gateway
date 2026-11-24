import { mcpOAuthResponse } from './mcp-oauth-response';

const request = (path: string) => new Request(`https://app.manifest.build${path}`);
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('mcpOAuthResponse', () => {
  it('adds an OAuth error code and CIMD guidance to anonymous registration failures', async () => {
    const response = await mcpOAuthResponse(
      request('/api/auth/oauth2/register'),
      json({ error_description: 'Authentication required for client registration' }, 401),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description:
        'Anonymous client registration is disabled. Use a client ID metadata document (CIMD), or sign in to register a client.',
    });
  });

  it('keeps other registration errors unchanged', async () => {
    const original = json({ error: 'invalid_redirect_uri' }, 400);
    expect(await mcpOAuthResponse(request('/api/auth/oauth2/register'), original)).toBe(original);
  });

  it.each([
    '/.well-known/oauth-authorization-server/api/auth',
    '/api/auth/.well-known/oauth-authorization-server',
    '/api/auth/.well-known/openid-configuration',
    '/.well-known/openid-configuration/api/auth',
  ])('does not advertise signed-in-only registration at %s', async (path) => {
    const response = await mcpOAuthResponse(
      request(path),
      json({
        issuer: 'https://app.manifest.build/api/auth',
        registration_endpoint: '/oauth2/register',
      }),
    );
    expect(await response.json()).toEqual({ issuer: 'https://app.manifest.build/api/auth' });
  });

  it('sends invalid callback requests to a visible error page', async () => {
    const original = new Response(null, {
      status: 302,
      headers: {
        location: '/api/auth/error?error=invalid_redirect&error_description=invalid+redirect+uri',
      },
    });
    const response = await mcpOAuthResponse(request('/api/auth/oauth2/authorize'), original);
    expect(response.headers.get('location')).toBe('/oauth-error?error=invalid_redirect_uri');
  });

  it('keeps unrelated authorization redirects unchanged', async () => {
    const original = new Response(null, { status: 302, headers: { location: '/login' } });
    expect(await mcpOAuthResponse(request('/api/auth/oauth2/authorize'), original)).toBe(original);
  });
});
