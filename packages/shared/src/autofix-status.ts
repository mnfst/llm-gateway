export const AUTOFIX_STATUSES = [
  'no_patch',
  'resolving',
  'retry_succeeded',
  'retry_failed',
  'service_error',
] as const;

export type AutofixStatus = (typeof AUTOFIX_STATUSES)[number];

export const AUTOFIX_STATUS_LABELS: Record<AutofixStatus, string> = {
  no_patch: 'No patch',
  resolving: 'Resolving',
  retry_succeeded: 'Retry succeeded',
  retry_failed: 'Retry failed',
  service_error: 'Service error',
};

export interface AutofixStatusChainEntry {
  origin: 'original' | 'autofix';
  http_status: number;
  phoenix_status?: string;
  heal_attempt_id?: string | null;
  patch_worked?: boolean;
}

export interface AutofixStatusRecord {
  chain: AutofixStatusChainEntry[];
}

/** Derive the request-level Autofix outcome from its recorded execution. */
export function deriveAutofixStatus(
  record: AutofixStatusRecord | null | undefined,
): AutofixStatus | null {
  if (!record) return null;

  const retry = record.chain.find((entry) => entry.origin === 'autofix');
  if (retry) {
    return retry.http_status >= 200 && retry.http_status < 300 ? 'retry_succeeded' : 'retry_failed';
  }

  const decision = record.chain.find(
    (entry) => entry.phoenix_status != null || entry.heal_attempt_id != null,
  );
  // A patch was handed out but the resend threw before producing a response.
  if (decision?.heal_attempt_id != null && decision.patch_worked === false) {
    return 'retry_failed';
  }
  if (decision?.phoenix_status === 'resolving') return 'resolving';
  if (decision?.phoenix_status === 'no_patch') return 'no_patch';

  // The flow was entered, but Phoenix failed or returned an unusable contract.
  return 'service_error';
}
