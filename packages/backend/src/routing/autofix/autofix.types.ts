import type {
  PhoenixExplanation,
  PhoenixHealStatus,
  PhoenixOperation,
  PhoenixProviderError,
} from './phoenix.types';

/**
 * How an Autofix attempt ended:
 * - `healed`     — a patched request eventually succeeded.
 * - `unfixable`  — Phoenix had no patch (`no_patch`) or returned an empty one.
 * - `resolving`  — Phoenix is still authoring a patch (novel error); nothing to
 *                  resend this time. A later request for the same issue may heal.
 * - `exhausted`  — a patched retry failed, or the healing flow aborted before
 *                  it could complete. Inspect `chain` to tell whether a retry
 *                  was actually sent.
 */
export type AutofixOutcome = 'healed' | 'unfixable' | 'resolving' | 'exhausted';

/**
 * One request actually sent to the provider during healing, in order. Entry 0
 * (`origin: 'original'`) is the agent's own request; later `autofix` entries are
 * the bodies Phoenix produced. The heal decision fields (`issue_id` … ) describe
 * what Phoenix said about THIS entry's failure; `patch_worked` says whether the
 * patch derived here produced a working request.
 */
export interface AutofixChainEntry {
  attempt: number;
  origin: 'original' | 'autofix';
  request: Record<string, unknown>;
  http_status: number;
  /** Absent on the terminal success entry. */
  error?: PhoenixProviderError;
  phoenix_status?: PhoenixHealStatus;
  issue_id?: string;
  patch_id?: string | null;
  heal_attempt_id?: string | null;
  operations?: PhoenixOperation[] | null;
  /** Phoenix's human-readable "why" for the fix derived here (null when none). */
  explanation?: PhoenixExplanation | null;
  patch_worked?: boolean;
}

/**
 * The full Autofix story. An `autofix` chain entry exists if and only if a
 * patched request was actually sent to the provider. The recorder uses that
 * invariant—not Phoenix consultation alone—to decide whether Autofix was
 * applied. When a retry exists, the failed original and retry are recorded as
 * linked `agent_messages` rows sharing `groupId`.
 */
export interface AutofixRecord {
  /** Shared id linking the failed-original and retry rows, when a retry exists. */
  groupId: string;
  outcome: AutofixOutcome;
  original_http_status: number;
  chain: AutofixChainEntry[];
}

/** The patched provider attempt, when Manifest actually sent one. */
export function getAutofixRetry(autofix: AutofixRecord | undefined): AutofixChainEntry | undefined {
  return autofix?.chain.find((entry) => entry.origin === 'autofix');
}
