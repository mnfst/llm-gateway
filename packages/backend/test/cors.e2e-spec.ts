import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import {
  HOSTED_WINGMAN_ORIGIN,
  applyPrivateNetworkAllow,
  buildCorsOptions,
  buildDevAllowedOrigins,
  buildProdAllowedOrigins,
} from '../src/cors-csp-config';

@Controller()
class CorsTestController {
  @Get('/api/v1/health')
  health() {
    return { status: 'healthy' };
  }

  @Post('/v1/chat/completions')
  chat() {
    return { ok: true };
  }
}

@Module({ controllers: [CorsTestController] })
class CorsTestModule {}

// Boots a minimal NestJS app and calls `enableCors()` with the exact same
// inputs main.ts uses in dev: the dev allow-list, the PNA middleware, and the
// shared CORS options (header reflection + preflight maxAge).
async function buildDevApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [CorsTestModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  const allowedOrigins = buildDevAllowedOrigins({
    configuredOrigin: 'http://localhost:3000',
    wingmanPort: 3002,
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    applyPrivateNetworkAllow(req, allowedOrigins, (name, value) => res.setHeader(name, value));
    next();
  });
  app.enableCors(buildCorsOptions(allowedOrigins));
  await app.init();
  return app;
}

// Boots a minimal NestJS app with the exact CORS config main.ts uses in
// production: the hosted Wingman origin (plus WINGMAN_CORS_ORIGINS opt-ins), the
// PNA middleware (so a browser-hosted Wingman can reach a self-hosted gateway on
// a LAN address), and the shared CORS options.
async function buildProdApp(extraOrigins?: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [CorsTestModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  const allowedOrigins = buildProdAllowedOrigins({ extraOrigins });
  app.use((req: Request, res: Response, next: NextFunction) => {
    applyPrivateNetworkAllow(req, allowedOrigins, (name, value) => res.setHeader(name, value));
    next();
  });
  app.enableCors(buildCorsOptions(allowedOrigins));
  await app.init();
  return app;
}

describe('CORS — development', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDevApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows the configured Vite frontend origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/v1/health')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('allows the local Wingman dev server', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', 'http://localhost:3002')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3002');
  });

  it('allows preflight from the hosted Wingman origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.headers['access-control-allow-origin']).toBe(HOSTED_WINGMAN_ORIGIN);
    const allowHeaders = (res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
  });

  it('does not echo Access-Control-Allow-Credentials (no cookies cross-origin)', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rejects unknown origins (no Allow-Origin header echoed)', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes Access-Control-Allow-Private-Network for PNA preflight from a listed origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/v1/health')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Private-Network', 'true');
    expect(res.headers['access-control-allow-private-network']).toBe('true');
  });

  it('does not echo Allow-Private-Network when the request header is missing', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/v1/health')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it('caches the preflight (maxAge) so a reload does not re-run it every few seconds', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-max-age']).toBe('7200');
  });
});

describe('CORS — production', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildProdApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows preflight from the hosted Wingman origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBe(HOSTED_WINGMAN_ORIGIN);
  });

  it('reflects the SDK fingerprint headers on the preflight (X-Stainless-*)', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,x-stainless-lang,x-stainless-runtime',
      );
    const allowHeaders = (res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
    expect(allowHeaders).toContain('x-stainless-lang');
    expect(allowHeaders).toContain('x-stainless-runtime');
  });

  it('echoes Allow-Origin on the actual POST, not just the preflight', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .send({ model: 'auto' });
    expect(res.headers['access-control-allow-origin']).toBe(HOSTED_WINGMAN_ORIGIN);
  });

  it('does not echo Access-Control-Allow-Credentials (no cookies cross-origin)', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rejects unknown origins (no Allow-Origin header echoed)', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the Private Network Access preflight for an allow-listed origin (self-hosted LAN gateways)', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Private-Network', 'true');
    expect(res.headers['access-control-allow-private-network']).toBe('true');
  });

  it('caches the preflight (maxAge) to avoid a preflight per Wingman request', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/chat/completions')
      .set('Origin', HOSTED_WINGMAN_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-max-age']).toBe('7200');
  });

  it('allows an operator-configured extra origin via WINGMAN_CORS_ORIGINS', async () => {
    const scoped = await buildProdApp('https://wingman.acme.dev');
    try {
      const res = await request(scoped.getHttpServer())
        .options('/v1/chat/completions')
        .set('Origin', 'https://wingman.acme.dev')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBe('https://wingman.acme.dev');
    } finally {
      await scoped.close();
    }
  });
});
