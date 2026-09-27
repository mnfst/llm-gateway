import * as express from 'express';

export const API_BODY_LIMIT = '1mb';
export const PROXY_BODY_LIMIT = '512mb';
export const PROXY_BODY_LIMIT_BYTES = 512 * 1024 * 1024;

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  if (!(err instanceof Error)) return false;
  const maybe = err as BodyParserError;
  return typeof maybe.type === 'string' || maybe.status === 413 || maybe.statusCode === 413;
}

export function createProxyBodyBudgetMiddleware(): express.RequestHandler {
  let activeBytes = 0;

  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }

    const rawLength = req.headers['content-length'];
    const contentLength = Array.isArray(rawLength) ? rawLength[0] : rawLength;
    if (!contentLength) {
      const rawTransferEncoding = req.headers['transfer-encoding'];
      const transferEncoding = Array.isArray(rawTransferEncoding)
        ? rawTransferEncoding.join(',')
        : rawTransferEncoding;
      if (transferEncoding?.toLowerCase().includes('chunked')) {
        res.status(411).json({
          message: 'Content-Length is required for proxy request bodies',
          error: 'Length Required',
          statusCode: 411,
        });
        return;
      }
      next();
      return;
    }

    const bodyBytes = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(bodyBytes) || bodyBytes < 0) {
      res.status(400).json({
        message: 'Invalid Content-Length header',
        error: 'Bad Request',
        statusCode: 400,
      });
      return;
    }

    if (bodyBytes > PROXY_BODY_LIMIT_BYTES) {
      res.status(413).json({
        message: `Request body exceeds ${PROXY_BODY_LIMIT}`,
        error: 'Payload Too Large',
        statusCode: 413,
      });
      return;
    }

    if (activeBytes + bodyBytes > PROXY_BODY_LIMIT_BYTES) {
      res.status(429).json({
        message: 'Too many large proxy requests in flight',
        error: 'Too Many Requests',
        statusCode: 429,
      });
      return;
    }

    activeBytes += bodyBytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeBytes = Math.max(0, activeBytes - bodyBytes);
    };

    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export function bodyParserErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!isBodyParserError(err)) {
    next(err);
    return;
  }

  if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
    res.status(413).json({
      message: 'Request body is too large',
      error: 'Payload Too Large',
      statusCode: 413,
    });
    return;
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({
      message: 'Invalid JSON request body',
      error: 'Bad Request',
      statusCode: 400,
    });
    return;
  }

  next(err);
}
