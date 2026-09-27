import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('RateLimit');

/** Minimal slice of express-rate-limit's options that the handler reads. */
interface RateLimitResponseOptions {
  statusCode: number;
  message: unknown;
}

/**
 * Build an express-rate-limit `handler` that emits one structured security
 * WARN when an auth endpoint's rate limit trips, then sends the library's
 * default 429 response unchanged.
 *
 * express-rate-limit only sets response headers by default — it writes no
 * application log — so a credential-stuffing or account-enumeration burst
 * against the auth endpoints is otherwise invisible in the app logs until it
 * succeeds. This restores an app-layer signal (limiter name, method, path,
 * client IP) without altering the client-facing response at all.
 */
export function createRateLimitReachedHandler(name: string) {
  return (
    req: Request,
    res: Response,
    _next: NextFunction,
    options: RateLimitResponseOptions,
  ): void => {
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    logger.warn(`Rate limit reached on ${name}: ${req.method} ${req.originalUrl} ip=${ip}`);
    res.status(options.statusCode).send(options.message);
  };
}
