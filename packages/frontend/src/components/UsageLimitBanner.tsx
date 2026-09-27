import { A } from '@solidjs/router';
import { Show, createEffect, createResource, createSignal, type Component } from 'solid-js';
import { getBillingStatus } from '../services/api/billing.js';
import { authClient } from '../services/auth-client.js';

const DISMISS_KEY = 'manifest_usage_banner_dismissed';

function isDismissedToday(key: string | null): boolean {
  if (!key) return false;
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return false;
    const today = new Date().toISOString().slice(0, 10);
    return stored === today;
  } catch {
    return false;
  }
}

function dismissForToday(key: string | null): void {
  if (!key) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem(key, today);
  } catch {
    /* noop */
  }
}

const UsageLimitBanner: Component = () => {
  const session = authClient.useSession();
  const dismissKey = () => {
    const userId = session()?.data?.user?.id;
    return userId ? `${DISMISS_KEY}:${userId}` : null;
  };
  const [dismissed, setDismissed] = createSignal(false);
  const [billing] = createResource(async () => {
    try {
      return await getBillingStatus();
    } catch {
      return null;
    }
  });

  createEffect(() => setDismissed(isDismissedToday(dismissKey())));

  const ratio = () => {
    const b = billing();
    if (!b?.enabled || b.plan !== 'free' || b.requests.limit == null) return 0;
    return (b.requests.used ?? 0) / b.requests.limit;
  };

  const atLimit = () => ratio() >= 1;
  const nearLimit = () => ratio() >= 0.8 && ratio() < 1;
  const canDismiss = () => nearLimit() && !atLimit();

  const handleDismiss = () => {
    dismissForToday(dismissKey());
    setDismissed(true);
  };

  return (
    <Show when={(nearLimit() && !dismissed()) || atLimit()}>
      <div class="usage-limit-banner" classList={{ 'usage-limit-banner--danger': atLimit() }}>
        <span class="usage-limit-banner__text">
          {atLimit()
            ? "You've reached your monthly limit. Requests are being blocked."
            : `You're limited to ${billing()!.requests.limit!.toLocaleString('en-US')} requests this month. Upgrade for unlimited.`}
        </span>
        <div class="usage-limit-banner__actions">
          <A
            href="/upgrade?reason=requests"
            class="btn btn--outline btn--sm usage-limit-banner__btn"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2m0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8" />
              <path d="m8 12 1.41 1.41L11 11.83V17h2v-5.17l1.59 1.59L16 12l-4-4z" />
            </svg>
            Upgrade plan
          </A>
          <Show when={canDismiss()}>
            <button
              type="button"
              class="btn btn--outline btn--sm usage-limit-banner__btn"
              onClick={handleDismiss}
            >
              Got it
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default UsageLimitBanner;
