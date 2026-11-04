import { For, type Component } from 'solid-js';

export const SELF_HOSTING_GUIDE_URL = 'https://manifest.build/llm-gateway/docs/self-hosted';

/* ── Plan data ───────────────────────────────────────── */

// Features of the self-hosted gateway, shown on the Upgrade page.
const freeFeatures = [
  'Unlimited routed requests',
  'All providers, including local models',
  'Autofix, routing rules and fallbacks',
  'Your data stays on your machine',
  'Community support via Discord',
];

const proFeatures = [
  'Hosted at app.manifest.build, ready in a minute',
  'Updates land the same day we ship them',
  'Servers, database and uptime handled by us',
  'Unlimited routed requests',
  '365 days of dashboard history',
  'Support from the team (platform issues, billing)',
];

const enterpriseFeatures = [
  'Multiple seats and team management',
  'SSO / SAML',
  'Audit logs',
  'Custom retention',
  'Uptime SLA',
  'SOC 2 Type II and ISO 27001',
  'HIPAA and custom BAAs',
  'Custom guardrails',
  'Dedicated support (Slack and email)',
];

/** Shown when Stripe returns no price, so the Cloud card never reads "Pro" alone. */
export const FALLBACK_PRO_PRICE = '$19';

export type PlanId = 'free' | 'pro' | 'enterprise';

export interface PlanPickerProps {
  /** Price label for the Cloud plan (e.g. "$19"). Falls back to FALLBACK_PRO_PRICE if null. */
  proPrice?: string | null;
  /** Called when the user clicks Subscribe. */
  onSubscribe: () => void;
  /** Show a loading spinner on the Subscribe button. */
  busy?: boolean;
}

/**
 * The signup plan step. Manifest Cloud has one paid plan, so the step shows
 * that plan alone: no free option and no sales path inside the signup flow.
 */
const PlanPicker: Component<PlanPickerProps> = (props) => (
  <div class="plan-picker">
    <div class="plan-picker__card">
      <div class="plan-picker__row">
        <div class="plan-picker__name">
          <span>Manifest Cloud</span>
        </div>
        <div class="plan-picker__price-inline">
          <span class="plan-picker__amount">{props.proPrice ?? FALLBACK_PRO_PRICE}</span>
          <span class="plan-picker__period">/month</span>
        </div>
      </div>
      <div class="plan-picker__details">
        <ul class="plan-picker__features">
          <For each={proFeatures}>
            {(feature) => (
              <li>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  fill="#2632EF"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M9 15.59 4.71 11.3 3.3 12.71l5 5c.2.2.45.29.71.29s.51-.1.71-.29l11-11-1.41-1.41L9.02 15.59Z" />
                </svg>
                <span>{feature}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>

    <button
      type="button"
      class="auth-form__submit plan-picker__cta"
      disabled={props.busy}
      onClick={() => props.onSubscribe()}
    >
      {props.busy ? <span class="spinner" /> : 'Subscribe'}
    </button>
  </div>
);

export default PlanPicker;

export { freeFeatures, proFeatures, enterpriseFeatures };
