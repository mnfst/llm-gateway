import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import type { Server } from 'http';
import { parseFrameAncestors } from '../src/cors-csp-config';

// Mirrors the helmet config in src/main.ts. If the two drift, this test
// stops guarding the real deployment — keep them in sync. The
// frame-ancestors directive routes through the same parseFrameAncestors
// helper as production so the validation path is exercised here.
function buildApp() {
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: parseFrameAncestors(process.env['FRAME_ANCESTORS']),
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  app.get('/', (_req, res) => res.status(200).send('ok'));
  return app;
}

describe('CSP header', () => {
  let server: Server;

  beforeAll(() => {
    server = buildApp().listen(0);
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('does NOT include upgrade-insecure-requests (breaks LAN deployments over HTTP)', async () => {
    const res = await request(server).get('/').expect(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('still emits the self-only CSP directives', async () => {
    const res = await request(server).get('/').expect(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('honors a configured FRAME_ANCESTORS and drops the bare wildcard', async () => {
    const prev = process.env['FRAME_ANCESTORS'];
    process.env['FRAME_ANCESTORS'] = 'https://app.example.com, *';
    const scopedServer = buildApp().listen(0);
    try {
      const res = await request(scopedServer).get('/').expect(200);
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain('frame-ancestors https://app.example.com');
      // The bare wildcard would let any site frame the app — it must be dropped.
      expect(csp).not.toContain('frame-ancestors *');
      expect(csp).not.toMatch(/frame-ancestors[^;]*\s\*/);
    } finally {
      await new Promise<void>((resolve) => scopedServer.close(() => resolve()));
      if (prev === undefined) delete process.env['FRAME_ANCESTORS'];
      else process.env['FRAME_ANCESTORS'] = prev;
    }
  });
});
