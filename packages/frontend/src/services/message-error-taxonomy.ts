export interface MessageErrorTaxonomySignals {
  error_origin?: string | null;
  error_class?: string | null;
  error_http_status?: number | null;
  routing_reason?: string | null;
}

export function isPlanRequestLimitMessage(message: MessageErrorTaxonomySignals): boolean {
  if (message.error_origin !== 'policy' || message.error_http_status !== 402) return false;
  return (
    message.error_class === 'plan_request_limit_exceeded' ||
    message.routing_reason === 'plan_request_limit_exceeded' ||
    message.error_class === 'limit_exceeded'
  );
}
