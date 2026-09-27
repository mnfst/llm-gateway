import express, { Request, Response } from 'express';
import { EventEmitter } from 'events';
import request from 'supertest';
import {
  API_BODY_LIMIT,
  PROXY_BODY_LIMIT,
  PROXY_BODY_LIMIT_BYTES,
  bodyParserErrorHandler,
  createProxyBodyBudgetMiddleware,
} from './body-parser-limits';

function createParserTestApp() {
  const app = express();
  app.use('/v1', createProxyBodyBudgetMiddleware());
  app.use('/v1', express.json({ limit: PROXY_BODY_LIMIT }));
  app.use(express.json({ limit: API_BODY_LIMIT }));
  app.use(bodyParserErrorHandler);
  app.post('/v1/chat/completions', (req: Request, res: Response) => {
    res.json({ contentLength: String(req.body.messages[0].content).length });
  });
  app.post('/api/v1/test', (req: Request, res: Response) => {
    res.json({ contentLength: String(req.body.messages[0].content).length });
  });
  return app;
}

function createMockResponse() {
  const res = new EventEmitter() as express.Response & EventEmitter;
  res.status = jest.fn(() => res) as unknown as express.Response['status'];
  res.json = jest.fn(() => res) as unknown as express.Response['json'];
  return res;
}

describe('body parser limits', () => {
  it('allows OpenAI-compatible proxy bodies above the regular Manifest API limit', async () => {
    const content = 'x'.repeat(1024 * 1024 + 1);
    const payload = { messages: [{ role: 'user', content }] };

    await request(createParserTestApp()).post('/v1/chat/completions').send(payload).expect(200);
    const apiRes = await request(createParserTestApp())
      .post('/api/v1/test')
      .send(payload)
      .expect(413);

    expect(apiRes.body).toEqual({
      message: 'Request body is too large',
      error: 'Payload Too Large',
      statusCode: 413,
    });
  });

  it('returns JSON 400s for malformed proxy JSON', async () => {
    const res = await request(createParserTestApp())
      .post('/v1/chat/completions')
      .set('Content-Type', 'application/json')
      .send('{"messages":')
      .expect(400);

    expect(res.body).toEqual({
      message: 'Invalid JSON request body',
      error: 'Bad Request',
      statusCode: 400,
    });
  });

  it('limits the total Content-Length of proxy request bodies in flight', () => {
    const middleware = createProxyBodyBudgetMiddleware();
    const firstReq = {
      method: 'POST',
      headers: { 'content-length': String(PROXY_BODY_LIMIT_BYTES) },
    } as express.Request;
    const secondReq = {
      method: 'POST',
      headers: { 'content-length': '1' },
    } as express.Request;
    const firstRes = createMockResponse();
    const secondRes = createMockResponse();
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    middleware(firstReq, firstRes, firstNext);
    middleware(secondReq, secondRes, secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondRes.status).toHaveBeenCalledWith(429);
    expect(secondRes.json).toHaveBeenCalledWith({
      message: 'Too many large proxy requests in flight',
      error: 'Too Many Requests',
      statusCode: 429,
    });

    firstRes.emit('finish');
    const thirdNext = jest.fn();
    middleware(secondReq, createMockResponse(), thirdNext);
    expect(thirdNext).toHaveBeenCalledTimes(1);
  });

  it('skips body budgets for requests without proxy bodies', () => {
    const middleware = createProxyBodyBudgetMiddleware();
    const next = jest.fn();

    middleware({ method: 'GET', headers: {} } as express.Request, createMockResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows proxy request bodies without Content-Length when they are not chunked', () => {
    const middleware = createProxyBodyBudgetMiddleware();
    const next = jest.fn();

    middleware({ method: 'POST', headers: {} } as express.Request, createMockResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects chunked proxy request bodies without a Content-Length budget', () => {
    const middleware = createProxyBodyBudgetMiddleware();
    const res = createMockResponse();
    const next = jest.fn();

    middleware(
      {
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked' },
      } as express.Request,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(411);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Content-Length is required for proxy request bodies',
      error: 'Length Required',
      statusCode: 411,
    });
  });

  it('rejects invalid proxy Content-Length headers', () => {
    const middleware = createProxyBodyBudgetMiddleware();
    const res = createMockResponse();
    const next = jest.fn();

    middleware(
      {
        method: 'POST',
        headers: { 'content-length': '-1' },
      } as express.Request,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Invalid Content-Length header',
      error: 'Bad Request',
      statusCode: 400,
    });
  });

  it('rejects proxy request bodies above the proxy limit before parsing', () => {
    const middleware = createProxyBodyBudgetMiddleware();
    const res = createMockResponse();
    const next = jest.fn();

    middleware(
      {
        method: 'POST',
        headers: { 'content-length': String(PROXY_BODY_LIMIT_BYTES + 1) },
      } as express.Request,
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      message: `Request body exceeds ${PROXY_BODY_LIMIT}`,
      error: 'Payload Too Large',
      statusCode: 413,
    });
  });

  it('passes through non-body-parser errors', () => {
    const res = createMockResponse();
    const next = jest.fn();
    const err = new Error('boom');

    bodyParserErrorHandler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through unsupported body-parser errors', () => {
    const res = createMockResponse();
    const next = jest.fn();
    const err = Object.assign(new Error('unsupported parser error'), {
      type: 'entity.verify.failed',
    });

    bodyParserErrorHandler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
