import http from 'node:http';
import https from 'node:https';
import type { Plugin } from 'vite';

/**
 * Serves the hosted Wingman SPA from a loopback origin during `vite serve`.
 *
 * The drawer used to iframe `https://wingman.manifest.build` directly and pass
 * it the dashboard's own origin as the gateway to test. That stopped working:
 * a public HTTPS page reaching `http://localhost:<port>` is a local-network
 * request, which Chrome (≥ 138) gates behind the Local Network Access
 * permission. Inside a cross-origin iframe that permission is denied by
 * permissions policy unless the embedder delegates it, so no prompt ever
 * appeared and every call failed with `Failed to fetch` — reported by the
 * browser as a CORS error, which is what sent us auditing the allow-list
 * repeatedly. Local Network Access also replaced Private Network Access, so
 * the `Access-Control-Allow-Private-Network` header the backend still sends
 * can no longer satisfy it.
 *
 * Reverse-proxying the SPA onto `127.0.0.1:<wingmanPort>` puts the iframe in
 * the same address space as the gateway, which sidesteps the permission
 * entirely — and works the same way in Safari and Firefox, neither of which
 * implements the Chrome permission. It is mounted at the port root so
 * Wingman's absolute asset paths (`/assets/…`, `/icons/…`) resolve unchanged.
 *
 * Dev only: `apply: 'serve'` keeps it out of every production build, matching
 * the drawer it exists to serve.
 */
/** True when the upstream is a remote HTTPS SPA that has to be republished on loopback. */
export function isRemoteWingman(upstream: string): boolean {
  return upstream.startsWith('https://');
}

/**
 * The origin the drawer's iframe should point at.
 *
 * A remote HTTPS SPA is replaced by the loopback origin the proxy serves it
 * on — framing it directly would make every gateway call a blocked
 * local-network request. An upstream that is already on loopback (a
 * contributor's own `npm run dev` Wingman) is framed as-is.
 */
export function resolveWingmanDrawerUrl(upstream: string, port: number): string {
  return isRemoteWingman(upstream) ? `http://localhost:${port}` : upstream;
}

export function wingmanDevProxy(options: { port: number; upstream: string }): Plugin {
  return {
    name: 'manifest:wingman-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      // Only proxy a remote SPA. A contributor who points VITE_WINGMAN_URL at
      // their own Wingman checkout is already on a loopback origin.
      if (!isRemoteWingman(options.upstream)) return;
      const upstream = new URL(options.upstream);

      const proxy = http.createServer((req, res) => {
        const upstreamReq = https.request(
          {
            host: upstream.hostname,
            port: 443,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: upstream.hostname,
              // Pass through undecoded so we can stream the body untouched.
              'accept-encoding': 'identity',
            },
          },
          (upstreamRes) => {
            const headers = { ...upstreamRes.headers };
            // The upstream CSP and framing headers are written for the hosted
            // origin; on loopback they'd only block the drawer.
            delete headers['content-security-policy'];
            delete headers['x-frame-options'];
            res.writeHead(upstreamRes.statusCode ?? 502, headers);
            upstreamRes.pipe(res);
          },
        );
        upstreamReq.on('error', (err: Error) => {
          if (res.headersSent) return;
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`Wingman dev proxy could not reach ${options.upstream}: ${err.message}`);
        });
        req.pipe(upstreamReq);
      });

      proxy.on('error', (err: NodeJS.ErrnoException) => {
        // A stale proxy from a previous run already owns the port — harmless,
        // the drawer still resolves. Anything else is worth surfacing.
        const detail = err.code === 'EADDRINUSE' ? 'port already in use' : err.message;
        server.config.logger.warn(`[wingman] dev proxy not started (${detail})`);
      });

      proxy.listen(options.port, '127.0.0.1', () => {
        server.config.logger.info(
          `  ➜  Wingman drawer: http://localhost:${options.port} (proxying ${options.upstream})`,
        );
      });

      server.httpServer?.on('close', () => proxy.close());
    },
  };
}
