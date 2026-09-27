export interface ProviderErrorSignals {
  provider?: string | null;
  httpStatus?: number | null;
  errorBody?: string | null;
}

const ANTHROPIC_EXTRA_USAGE_MESSAGE = /\byou(?: are|['’]re) out of extra usage\b/i;

/**
 * Anthropic reports exhausted Claude subscription extra usage as a 400
 * `invalid_request_error`, even though the failure is billing-related and cannot
 * be repaired by changing the request body.
 */
export function isAnthropicExtraUsageError(signals: ProviderErrorSignals): boolean {
  if (signals.httpStatus !== 400 || signals.provider?.trim().toLowerCase() !== 'anthropic') {
    return false;
  }

  if (!signals.errorBody) return false;

  try {
    const parsed = JSON.parse(signals.errorBody) as unknown;
    if (!parsed || typeof parsed !== 'object') return false;

    const body = parsed as Record<string, unknown>;
    const error =
      body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : body;

    return (
      error.type === 'invalid_request_error' &&
      typeof error.message === 'string' &&
      ANTHROPIC_EXTRA_USAGE_MESSAGE.test(error.message)
    );
  } catch {
    return false;
  }
}
