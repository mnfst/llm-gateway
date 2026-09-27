import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type ProxyOptions } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { codecovVitePlugin } from '@codecov/vite-plugin';
import { resolveWingmanDrawerUrl, wingmanDevProxy } from './wingman-dev-proxy';

// Dial the backend on 127.0.0.1, not `localhost`. The dev backend binds
// 127.0.0.1 (IPv4), but on dual-stack machines `localhost` can resolve to
// ::1 (IPv6) first, so proxied requests intermittently hit a port nothing is
// listening on. A failed proxy hop returns no CORS headers, which the hosted
// Wingman SPA (cross-origin, public HTTPS → loopback) then reports as a
// spurious "CORS error".
const backendTarget = `http://127.0.0.1:${process.env.VITE_BACKEND_PORT || '3001'}`;

// `nest --watch` restarts the backend on every save, and http-proxy reuses
// keep-alive sockets that die across a restart. Without this handler Vite
// answers the blip with a bare 502 carrying no CORS headers, so the
// cross-origin Wingman drawer surfaces "backend momentarily unreachable" as a
// misleading CORS failure. Echo the request Origin back on the error response
// so the failure reads as an honest 502 the moment it happens.
const configureDevProxy: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('error', (err, req, res) => {
    // Websocket upgrades hand back a raw socket with no `writeHead`; only
    // real HTTP responses can carry a status line + headers.
    if (!('writeHead' in res) || res.headersSent) return;
    const origin = req.headers.origin;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    res.writeHead(502, headers);
    res.end(JSON.stringify({ error: 'dev proxy: backend unreachable', detail: err.message }));
  });
};

const devProxyRoute: ProxyOptions = { target: backendTarget, configure: configureDevProxy };

const manifestVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../manifest/package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
})();

// The hosted Wingman SPA, and the loopback port the dev proxy republishes it
// on. `WINGMAN_PORT` is the same knob the backend reads for its dev CORS
// allow-list and CSP `frame-src`, so the three stay in step.
const HOSTED_WINGMAN_URL = 'https://wingman.manifest.build';
const wingmanUpstream = process.env.VITE_WINGMAN_URL || HOSTED_WINGMAN_URL;
const wingmanPort = Number(process.env.WINGMAN_PORT || process.env.VITE_WINGMAN_PORT || 3002);
const wingmanDrawerUrl = resolveWingmanDrawerUrl(wingmanUpstream, wingmanPort);

export default defineConfig(({ command }) => ({
  define: {
    __MANIFEST_VERSION__: JSON.stringify(manifestVersion),
    // The Wingman drawer and the orange "Dev" header badge are dev-only
    // affordances. They ship only when Vite runs in dev mode
    // (`vite serve`). Any production build — Docker self-hosted, Railway
    // cloud, anything else — gets `__DEV_MODE__ = false`, so esbuild
    // dead-code-eliminates the FAB, drawer, and badge.
    __DEV_MODE__: JSON.stringify(command === 'serve'),
    // Where the drawer's iframe points. In dev this is the loopback origin the
    // Wingman dev proxy serves on, so the iframe and the gateway share an
    // address space — a public HTTPS iframe cannot reach a localhost gateway
    // (see wingman-dev-proxy.ts). Empty in a production build, where the
    // drawer is dead-code-eliminated anyway.
    __WINGMAN_URL__: JSON.stringify(command === 'serve' ? wingmanDrawerUrl : ''),
  },
  plugins: [
    solidPlugin(),
    wingmanDevProxy({ port: wingmanPort, upstream: wingmanUpstream }),
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: 'manifest-frontend',
      uploadToken: process.env.CODECOV_TOKEN,
    }),
  ],
  server: {
    port: 3000,
    // Disable Vite's built-in CORS handler. Otherwise it short-circuits
    // OPTIONS preflights for proxied paths (e.g. `/api`, `/v1`) and
    // strips the backend's headers — including
    // `Access-Control-Allow-Private-Network`, which Chrome's Private
    // Network Access enforcement now requires when the hosted Wingman
    // SPA (https://wingman.manifest.build) calls into a loopback dev
    // backend. The dashboard itself is same-origin, so it doesn't need
    // Vite's CORS at all.
    cors: false,
    proxy: {
      '/api': devProxyRoute,
      '/otlp': devProxyRoute,
      '/v1': devProxyRoute,
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/solid-js') || id.includes('node_modules/@solidjs/')) {
            return 'vendor';
          }
          if (id.includes('node_modules/uplot')) {
            return 'charts';
          }
          if (id.includes('node_modules/better-auth')) {
            return 'auth';
          }
          // Syntax highlighting (highlight.js) is only pulled in by the
          // recorded-message viewer. Pin it to a stable named chunk so it
          // caches independently of the route chunks that lazy-load it.
          if (id.includes('node_modules/highlight.js')) {
            return 'syntax';
          }
          // Markdown rendering (marked + dompurify) is shared across the
          // few surfaces that render model output. A dedicated chunk keeps
          // its hash stable across route-chunk changes.
          if (id.includes('node_modules/marked') || id.includes('node_modules/dompurify')) {
            return 'markdown';
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    transformMode: { web: [/\.[jt]sx?$/] },
    deps: {
      optimizer: { web: { include: ['solid-js'] } },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/index.tsx',
        'src/components/CostChart.tsx',
        'src/components/TokenChart.tsx',
        'src/components/SingleTokenChart.tsx',
        'src/components/Sparkline.tsx',
      ],
    },
  },
}));
