import { useLocation, useNavigate } from '@solidjs/router';
import { Show, createEffect, createResource, createSignal, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { getBillingStatus } from '../services/api/billing.js';
import { authClient } from '../services/auth-client.js';
import { formatBillingPrice } from '../services/billing-display.js';
import { FALLBACK_PRO_PRICE, SELF_HOSTING_GUIDE_URL } from './PlanPicker.jsx';

const DISMISS_KEY = 'manifest_subscription_modal_dismissed';

function isDismissed(key: string | null): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function dismiss(key: string | null): void {
  if (!key) return;
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* noop */
  }
}

/**
 * Opens once per sign-in for a Cloud workspace without a subscription, where
 * nothing routes. Closing it leaves the permanent usage banner in place. The
 * dismissal is keyed by session id, so the next sign-in shows it again.
 */
const SubscriptionRequiredModal: Component = () => {
  const session = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const dismissKey = () => {
    const sessionId = session()?.data?.session?.id;
    return sessionId ? `${DISMISS_KEY}:${sessionId}` : null;
  };
  const [dismissed, setDismissed] = createSignal(true);
  const [billing] = createResource(async () => {
    try {
      return await getBillingStatus();
    } catch {
      return null;
    }
  });

  createEffect(() => setDismissed(isDismissed(dismissKey())));

  const noSubscription = () => {
    const b = billing();
    return b?.enabled === true && b.plan === 'free' && b.requests.limit === 0;
  };
  const price = () => formatBillingPrice(billing()?.priceMonthly) ?? FALLBACK_PRO_PRICE;
  const open = () =>
    noSubscription() &&
    !dismissed() &&
    dismissKey() !== null &&
    !location.pathname.startsWith('/upgrade');

  const close = () => {
    dismiss(dismissKey());
    setDismissed(true);
  };

  const subscribe = () => {
    close();
    navigate('/upgrade?reason=requests');
  };

  return (
    <Show when={open()}>
      <Portal>
        <div
          class="modal-backdrop"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
        >
          <div
            class="modal subscription-required-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="subscription-required-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="subscription-required-modal__body">
              <h2 id="subscription-required-title" class="subscription-required-modal__title">
                Your requests are paused
              </h2>
              <p class="subscription-required-modal__text">
                Manifest Cloud is {price()}/month since November 2, 2026. Your agents' requests are
                not routed until you subscribe.
              </p>
              <p class="subscription-required-modal__text">
                Your harnesses, routing rules and provider keys are kept. You can also run the same
                gateway for free on your own server.
              </p>
              <div class="subscription-required-modal__actions">
                <button type="button" class="btn btn--primary" onClick={subscribe}>
                  Subscribe for {price()}/month
                </button>
                <a
                  class="btn btn--outline"
                  href={SELF_HOSTING_GUIDE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Self-host for free
                </a>
              </div>
              <button type="button" class="subscription-required-modal__later" onClick={close}>
                Not now
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default SubscriptionRequiredModal;
