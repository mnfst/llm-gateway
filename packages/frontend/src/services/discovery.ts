/**
 * Self-hosted user discovery onboarding step.
 *
 * Shown once to new self-hosted users right after signup. This module is the
 * frontend contract for the backend endpoints:
 *
 *   GET  /api/v1/discovery/status   -> { required: boolean } (optional)
 *   POST /api/v1/discovery/complete -> { ok: true }
 *        body: { name?, email?, projectType?, companySize? }
 *        (an empty body means the user skipped the form)
 *
 * Completion is persisted per user in localStorage so the step appears
 * exactly once per user on this browser. The complete endpoint forwards
 * non-empty submissions to Peacock; the optional status endpoint can replace
 * the local fallback later if completion needs to follow a user across browsers.
 */

export interface DiscoverySubmission {
  name?: string;
  email?: string;
  projectType?: string;
  companySize?: string;
}

export interface DiscoveryOption {
  label: string;
  value: string;
}

export const PROJECT_TYPE_OPTIONS: DiscoveryOption[] = [
  { label: 'AI product or application', value: 'ai_product' },
  { label: 'AI agent', value: 'ai_agent' },
  { label: 'Internal AI tool or automation', value: 'internal_tool' },
  { label: 'AI workflow / automation platform', value: 'workflow_platform' },
  { label: 'Personal project / experimentation', value: 'personal_project' },
  { label: 'Other', value: 'other' },
];

export const COMPANY_SIZE_OPTIONS: DiscoveryOption[] = [
  { label: "I'm not using Manifest for work", value: 'not_for_work' },
  { label: '1–20', value: '1-20' },
  { label: '21–100', value: '21-100' },
  { label: '101–500', value: '101-500' },
  { label: '501–1,000', value: '501-1000' },
  { label: '1,000+', value: '1000+' },
];

const PREFIX = 'manifest_discovery_done_';
const PENDING_PREFIX = 'manifest_discovery_pending_';

export function markDiscoveryDoneLocally(userId: string): void {
  try {
    localStorage.setItem(`${PREFIX}${userId}`, '1');
    localStorage.removeItem(`${PENDING_PREFIX}${userId}`);
  } catch {
    /* storage full or unavailable */
  }
}

/**
 * Record at signup that this user still has the discovery step ahead, along
 * with where the flow continues afterwards. The guards use this to send the
 * user back to the form (browser Back, manual navigation) until it is
 * completed or skipped.
 */
export function markDiscoveryPending(userId: string, next: string): void {
  if (!userId) return;
  try {
    localStorage.setItem(`${PENDING_PREFIX}${userId}`, next);
  } catch {
    /* storage full or unavailable */
  }
}

/** The pending `next` destination, or null when nothing is pending. */
export function getDiscoveryPendingNext(userId: string): string | null {
  if (!userId) return null;
  try {
    if (localStorage.getItem(`${PREFIX}${userId}`) === '1') return null;
    return localStorage.getItem(`${PENDING_PREFIX}${userId}`);
  } catch {
    return null;
  }
}

/**
 * Cache-free probe used before dropping the pending marker: only a positive
 * "this deployment is not self-hosted" answer counts. A transient failure
 * returns false so a real self-hosted signup never loses the one-time form.
 */
export async function isConfirmedNotSelfHosted(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/setup/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { isSelfHosted?: boolean };
    return data.isSelfHosted === false;
  } catch {
    return false;
  }
}

/** Drop the pending marker without recording completion. */
export function clearDiscoveryPending(userId: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(`${PENDING_PREFIX}${userId}`);
  } catch {
    /* storage unavailable */
  }
}

export function hasDiscoveryBeenDoneLocally(userId: string): boolean {
  try {
    return localStorage.getItem(`${PREFIX}${userId}`) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the discovery step should be shown to this user. The local done
 * flag wins when present; otherwise the backend is asked. A `required: false`
 * answer is cached as local completion so the guards stop redirecting here.
 * When the endpoint is unreachable or not deployed yet, only users holding a
 * signup pending marker see the step, so existing users who open /discovery
 * by hand are never trapped.
 */
export async function isDiscoveryRequired(userId: string): Promise<boolean> {
  if (hasDiscoveryBeenDoneLocally(userId)) return false;
  try {
    const res = await fetch('/api/v1/discovery/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) return getDiscoveryPendingNext(userId) !== null;
    const data = (await res.json()) as { required?: boolean };
    if (data.required === true) return true;
    markDiscoveryDoneLocally(userId);
    return false;
  } catch {
    return getDiscoveryPendingNext(userId) !== null;
  }
}

/**
 * Record the step as done (submit and skip both land here — skip sends an
 * empty submission). The local flag is written first so the user is never
 * shown the form again even if the backend call fails or does not exist yet.
 */
export async function completeDiscovery(
  userId: string,
  submission: DiscoverySubmission,
): Promise<void> {
  markDiscoveryDoneLocally(userId);
  try {
    await fetch('/api/v1/discovery/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(submission),
    });
  } catch {
    /* endpoint unavailable — the local flag already recorded completion */
  }
}
