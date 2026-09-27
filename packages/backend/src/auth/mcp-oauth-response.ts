/** Keep public MCP OAuth responses useful to clients without changing Better Auth's routes. */
export async function mcpOAuthResponse(request: Request, response: Response): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/auth/oauth2/register' && response.status === 401) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      error?: string;
      error_description?: string;
    } | null;
    if (
      body?.error_description === 'Authentication required for client registration' &&
      !body.error
    ) {
      return jsonResponse(response, {
        error: 'invalid_client',
        error_description:
          'Anonymous client registration is disabled. Use a client ID metadata document (CIMD), or sign in to register a client.',
      });
    }
  }

  if (
    pathname.includes('/.well-known/oauth-authorization-server') ||
    pathname.includes('/.well-known/openid-configuration')
  ) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    if (body?.registration_endpoint) {
      delete body.registration_endpoint;
      return jsonResponse(response, body);
    }
  }

  if (pathname === '/api/auth/oauth2/authorize' && response.status === 302) {
    const location = response.headers.get('location');
    if (
      location &&
      new URL(location, request.url).searchParams.get('error') === 'invalid_redirect'
    ) {
      const headers = new Headers(response.headers);
      headers.set('location', '/oauth-error?error=invalid_redirect_uri');
      return new Response(null, { status: response.status, headers });
    }
  }

  return response;
}

function jsonResponse(original: Response, body: Record<string, unknown>): Response {
  const headers = new Headers(original.headers);
  headers.delete('content-length');
  headers.delete('etag');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status: original.status, headers });
}
