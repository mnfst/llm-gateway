import type { INestApplication } from '@nestjs/common';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { mcpOAuthResponse } from '../auth/mcp-oauth-response';
import {
  authInstance,
  authIssuerForHost,
  authOriginForHost,
  mcpResourceForHost,
  MCP_SCOPES,
} from '../auth/auth.instance';

const PROTECTED_RESOURCE_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/api/v1/mcp',
];

const cors = (res: Response): void => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
};

/**
 * Serve the OAuth discovery documents at the well-known ROOT paths.
 *
 * Better Auth is mounted at `/api/auth`, so the MCP plugin's own copies answer
 * at `/api/auth/.well-known/…`. MCP clients may begin at the MCP origin's root
 * document, and RFC 8414 also derives the path-suffixed form from the
 * `/api/auth` issuer. These routes publish both discovery forms, plus the
 * RFC 9728 protected-resource metadata the 401 challenge points at.
 *
 * Registered on Express before `app.listen()` so they land ahead of Nest's
 * router and the SPA fallback, which would otherwise answer these GETs with the
 * dashboard shell where the client expects JSON.
 */
export function mountMcpDiscovery(app: INestApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  const authServerMetadata = oauthProviderAuthServerMetadata(authInstance);

  const serveAuthMetadata = async (req: Request, res: Response): Promise<void> => {
    cors(res);
    try {
      const webRequest = new globalThis.Request(
        `${authOriginForHost(req.headers.host)}${req.originalUrl}`,
        {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
        },
      );
      const response = await mcpOAuthResponse(webRequest, await authServerMetadata(webRequest));
      response.headers.forEach((value, key) => res.set(key, value));
      res.status(response.status).send(req.method === 'HEAD' ? undefined : await response.text());
    } catch {
      res.status(404).json({ statusCode: 404, message: 'OAuth metadata unavailable' });
    }
  };

  // RFC 8414 for a path issuer puts the metadata under the path-suffixed
  // well-known location. The bare root form is for origin issuers, so serving
  // our `/api/auth` issuer document there would advertise a mismatched issuer.
  expressApp.get(
    '/.well-known/oauth-authorization-server/api/auth',
    (req: Request, res: Response) => {
      void serveAuthMetadata(req, res);
    },
  );
  // Answer the bare root form explicitly: without this, the request would fall
  // through to the SPA fallback and a client would get the dashboard HTML.
  expressApp.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    cors(res);
    res.status(404).json({ statusCode: 404, message: 'OAuth metadata unavailable' });
  });

  for (const path of PROTECTED_RESOURCE_PATHS) {
    expressApp.get(path, (req: Request, res: Response) => {
      cors(res);
      res.status(200).json({
        resource: mcpResourceForHost(req.headers.host),
        authorization_servers: [authIssuerForHost(req.headers.host)],
        bearer_methods_supported: ['header'],
        scopes_supported: [...MCP_SCOPES],
      });
    });
  }
}

/**
 * The same well-known paths, answering a JSON 404, for installs running
 * without the MCP server.
 *
 * Without these the requests fall through to the SPA fallback and an MCP
 * client discovering this origin gets the dashboard's HTML with a 200 — which
 * reads as a broken server rather than one that simply does not offer MCP.
 */
export function mountMcpUnavailable(app: INestApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/api/auth',
    ...PROTECTED_RESOURCE_PATHS,
  ]) {
    expressApp.get(path, (_req: Request, res: Response) => {
      cors(res);
      res.status(404).json({ statusCode: 404, message: 'MCP is not enabled on this install' });
    });
  }
}
