import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response as ExpressResponse } from 'express';
import { formatManifestError, ManifestErrorCode } from '../../common/errors/error-codes';
import { MANIFEST_CODE_TO_REASON } from '../../common/errors/manifest-error';
import type { RequestWithManifestErrorContext } from '../../otlp/interfaces/ingestion-context.interface';
import { ProxyMessageRecorder } from './proxy-message-recorder';
import { sanitizeRequestHeaders } from './request-headers';
import { getDashboardUrl, sendFriendlyResponse } from './proxy-friendly-response';

/** Guard-thrown messages that should become friendly chat responses. */
const AUTH_ERROR_CODES: Record<string, ManifestErrorCode> = {
  'Authorization header required': 'M001',
  'Empty token': 'M002',
  'Invalid API key format': 'M003',
  'API key expired': 'M004',
  'Invalid API key': 'M005',
};

/** Status codes that should pass through as normal HTTP errors. */
const PASSTHROUGH_STATUSES = new Set([429]);

/**
 * Decide whether the caller is a chat-rendering client (streaming SDK or chat
 * UI) versus a tool/monitor/CI pipeline. Chat clients render the assistant
 * message verbatim, so we wrap errors in a friendly HTTP-200 envelope. Tools
 * inspect status codes, so they get real 4xx/5xx responses.
 *
 * Heuristics, in order:
 *   1. `body.stream === true` → SSE chat client.
 *   2. `Accept: text/event-stream` → SSE chat client even if stream flag missing.
 *   3. Anything else (curl, monitors, non-streaming SDKs) → real status code.
 *
 * The `Accept: application/json` case explicitly falls through to step 3 so
 * non-streaming SDK callers see the actual error and can surface it to user
 * code instead of accepting a stub response as success.
 */
export function isChatRenderingClient(req: Request): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && body['stream'] === true) return true;
  const accept = req.headers['accept'];
  if (typeof accept === 'string' && accept.includes('text/event-stream')) return true;
  return false;
}

@Injectable()
@Catch(HttpException)
export class ProxyExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly config: ConfigService,
    private readonly recorder: ProxyMessageRecorder,
  ) {}

  /**
   * Record an expired-key rejection (M004) against the agent the key belongs to.
   * The guard resolved that agent before noticing the expiry and left it on
   * `manifestErrorContext`; without a context there is nobody to attribute the
   * row to, so nothing is written.
   *
   * `content` is the exact text the caller received, dashboard link included —
   * the row is only useful if it says where to generate a new key.
   */
  private recordExpiredKey(req: Request, content: string): void {
    const ctx = (req as Request & RequestWithManifestErrorContext).manifestErrorContext;
    if (!ctx) return;
    const body = req.body as Record<string, unknown> | undefined;
    const model = typeof body?.model === 'string' ? body.model : undefined;
    this.recorder
      .recordManifestBlockedRequest(ctx, {
        httpStatus: 401,
        errorMessage: content,
        errorCode: 'M004',
        reason: MANIFEST_CODE_TO_REASON.M004,
        model,
        requestHeaders: sanitizeRequestHeaders(req.headers),
      })
      .catch(() => undefined);
  }

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<ExpressResponse>();

    const status = exception.getStatus();
    const message = exception.message;

    // Rate limit errors should stay as HTTP 429 so clients can backoff
    if (PASSTHROUGH_STATUSES.has(status)) {
      const response = exception.getResponse();
      res
        .status(status)
        .json(
          typeof response === 'string'
            ? { error: { message: response, type: 'proxy_error' } }
            : response,
        );
      return;
    }

    // Plan request-limit block (402). Chat clients get the friendly M204
    // upgrade message with a link to the billing UI; SDKs/tools get a real 402
    // with `insufficient_quota` (the type OpenAI SDKs map to billing) plus the
    // machine code and limit/used for programmatic handling.
    const billingResponse = exception.getResponse();
    if (
      status === 402 &&
      typeof billingResponse === 'object' &&
      billingResponse !== null &&
      (billingResponse as { code?: string }).code === 'PLAN_LIMIT_REQUESTS'
    ) {
      const { limit, used } = billingResponse as { limit?: number; used?: number };
      const upgradeUrl = `${getDashboardUrl(this.config)}/upgrade?reason=requests`;
      const content = formatManifestError('M204', { threshold: limit ?? 0, upgradeUrl });
      const isStream = (req.body as Record<string, unknown>)?.stream === true;
      if (isChatRenderingClient(req)) {
        sendFriendlyResponse(res, content, isStream);
      } else {
        res.status(402).json({
          error: { message: content, type: 'insufficient_quota', code: 'PLAN_LIMIT_REQUESTS' },
          limit,
          used,
        });
      }
      return;
    }

    const isStream = (req.body as Record<string, unknown>)?.stream === true;
    const isChatClient = isChatRenderingClient(req);

    const errorCode = AUTH_ERROR_CODES[message];
    if (errorCode) {
      const friendly = formatManifestError(errorCode);
      const dashboardUrl = getDashboardUrl(this.config);
      const content =
        errorCode === 'M004'
          ? `${friendly}: ${dashboardUrl}`
          : `${friendly}\n\nDashboard: ${dashboardUrl}`;
      if (errorCode === 'M004') this.recordExpiredKey(req, content);
      if (isChatClient) {
        sendFriendlyResponse(res, content, isStream);
      } else {
        // Real status — auth errors get 401, validation errors keep their status.
        const realStatus = status === 400 ? 400 : 401;
        res.status(realStatus).json({
          error: { message: content, type: 'auth_error', code: 'manifest_auth' },
        });
      }
      return;
    }

    if (isChatClient) {
      const content = status >= 500 ? formatManifestError('M500') : message;
      sendFriendlyResponse(res, content, isStream);
      return;
    }

    // Tools and monitors: pass the real HTTP status with a structured envelope.
    const errorMessage =
      status >= 500 ? 'Manifest encountered an internal error. Try again shortly.' : message;
    res.status(status).json({
      error: {
        message: errorMessage,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    });
  }
}
