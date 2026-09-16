import { Controller, All, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

/**
 * Structured 410 Gone response returned by all deprecated OTLP endpoints.
 *
 * Old plugin versions (pre-routing-only architecture, before PR #1271) still
 * export telemetry to /otlp/v1/{traces,metrics,logs}. Without this controller
 * those requests hit the SPA fallback filter and return 200 with HTML, which
 * clients silently swallow. Returning 410 with a structured JSON error lets
 * clients surface a clear upgrade message to the user.
 */
const GONE_RESPONSE = {
  error: {
    message:
      'OTLP telemetry endpoints have been removed. ' +
      'Use the routing proxy at /v1/chat/completions instead. ' +
      'See https://manifest.build/docs/migration for details.',
    type: 'gone',
    status: 410,
  },
};

/**
 * Structured 404 response for /chat/completions (missing /v1 prefix).
 * The OpenAI SDK appends /chat/completions to the base URL, so users who
 * set baseURL without the /v1 suffix hit this path.
 */
const WRONG_PATH_RESPONSE = {
  error: {
    message:
      'Use /v1/chat/completions (not /chat/completions). ' +
      'Set your baseURL to https://app.manifest.build/v1',
    type: 'invalid_request_error',
    status: 404,
  },
};

/**
 * Returns HTTP 410 Gone for the three OTLP telemetry endpoints removed in
 * PR #1271 (routing-only architecture).
 *
 * Background: the standalone OTLP pipeline (/otlp/v1/traces, /otlp/v1/metrics,
 * /otlp/v1/logs) was removed in favour of the routing proxy at
 * /v1/chat/completions. A PostHog audit found 122 tenants still sending data
 * exclusively via OTLP — their requests were silently 404ing. This controller
 * gives them an actionable error instead.
 *
 * Can be removed once all clients have migrated to the routing proxy.
 */
@Controller()
@Public()
export class OtlpDeprecatedController {
  @All('otlp/v1/traces')
  @HttpCode(HttpStatus.GONE)
  traces() {
    return GONE_RESPONSE;
  }

  @All('otlp/v1/metrics')
  @HttpCode(HttpStatus.GONE)
  metrics() {
    return GONE_RESPONSE;
  }

  @All('otlp/v1/logs')
  @HttpCode(HttpStatus.GONE)
  logs() {
    return GONE_RESPONSE;
  }

  // --- Misrouted OTLP variants (wrong prefix) ---
  // Some old clients prepend /api/v1 to the OTLP path or strip the /otlp
  // prefix, producing paths like /api/v1/otlp/v1/metrics or /v1/metrics.
  // Catch those too and return the same 410 Gone payload.

  @All('api/v1/otlp/v1/traces')
  @HttpCode(HttpStatus.GONE)
  misroutedTraces() {
    return GONE_RESPONSE;
  }

  @All('api/v1/otlp/v1/metrics')
  @HttpCode(HttpStatus.GONE)
  misroutedMetrics() {
    return GONE_RESPONSE;
  }

  @All('api/v1/otlp/v1/logs')
  @HttpCode(HttpStatus.GONE)
  misroutedLogs() {
    return GONE_RESPONSE;
  }

  @All('v1/metrics')
  @HttpCode(HttpStatus.GONE)
  strippedMetrics() {
    return GONE_RESPONSE;
  }

  @All('v1/traces')
  @HttpCode(HttpStatus.GONE)
  strippedTraces() {
    return GONE_RESPONSE;
  }

  @All('v1/logs')
  @HttpCode(HttpStatus.GONE)
  strippedLogs() {
    return GONE_RESPONSE;
  }

  // --- Wrong path for chat completions (missing /v1 prefix) ---

  @Post('chat/completions')
  @HttpCode(HttpStatus.NOT_FOUND)
  wrongChatPath() {
    return WRONG_PATH_RESPONSE;
  }
}
