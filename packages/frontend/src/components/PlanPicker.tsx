import { For, Show, createSignal, type Component } from 'solid-js';
import { FREE_REQUEST_LIMIT_LABEL } from '../services/billing-display.js';

/* ── Plan data ───────────────────────────────────────── */

const freeFeatures = [
  'Unlimited agents',
  `${FREE_REQUEST_LIMIT_LABEL} routed requests / month`,
  'All providers, no restrictions',
  'Subscription providers (Claude, ChatGPT, Gemini...)',
  '7-day dashboard retention',
  'Autofix',
  'Budget alerts and notifications',
  'Community support via Discord',
];

const proFeatures = [
  'Unlimited routed requests',
  '365 days dashboard retention',
  'Basic support (platform issues, billing, licence activation)',
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

export type PlanId = 'free' | 'pro' | 'enterprise';

interface PlanDef {
  id: PlanId;
  name: string;
  price: string;
  period?: string;
  desc: string;
  features: string[];
  popular?: boolean;
}

export interface PlanPickerProps {
  /** Price label for Pro plan (e.g. "$19"). Falls back to "Pro" if null. */
  proPrice?: string | null;
  /** Called when the user clicks "Choose this plan". */
  onSelect: (plan: PlanId) => void;
  /** Show a loading spinner on the selected plan's button. */
  busy?: boolean;
  /** Current usage (free plan only). */
  usedRequests?: number | null;
}

const fmt = (n: number) => n.toLocaleString('en-US');

const PlanPicker: Component<PlanPickerProps> = (props) => {
  const [expanded, setExpanded] = createSignal<PlanId | null>('pro');

  const plans = (): PlanDef[] => [
    {
      id: 'free',
      name: 'Free',
      price: '$0',
      period: '/month',
      desc: 'For prototypes and small projects.',
      features: freeFeatures,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: props.proPrice ?? 'Pro',
      period: props.proPrice ? '/month' : undefined,
      desc: 'For production projects. Longer data access and unlimited agents. Not suited for teams.',
      features: proFeatures,
      popular: true,
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: 'Custom',
      desc: 'For scaling projects, large scale teams. Enterprise-grade support and security.',
      features: enterpriseFeatures,
    },
  ];

  const toggle = (id: PlanId) => {
    setExpanded((prev) => (prev === id ? null : id));
  };

  return (
    <div class="plan-picker">
      <For each={plans()}>
        {(plan) => {
          const isExpanded = () => expanded() === plan.id;

          return (
            <button
              type="button"
              class={`plan-picker__card${plan.popular ? ' plan-picker__card--pro' : ''}${isExpanded() ? ' plan-picker__card--expanded' : ''}`}
              onClick={() => toggle(plan.id)}
            >
              <div class="plan-picker__row">
                <div class="plan-picker__name">
                  <span class="plan-picker__radio">
                    <Show when={isExpanded()}>
                      <span class="plan-picker__radio-dot" />
                    </Show>
                  </span>
                  <span>{plan.name}</span>
                  <Show when={plan.popular}>
                    <span class="plan-picker__badge">Popular</span>
                  </Show>
                </div>
                <div class="plan-picker__price-inline">
                  <span class="plan-picker__amount">{plan.price}</span>
                  <Show when={plan.period}>
                    <span class="plan-picker__period">{plan.period}</span>
                  </Show>
                </div>
              </div>

              <Show when={isExpanded()}>
                <div class="plan-picker__details">
                  <Show when={plan.id === 'free' && props.usedRequests != null}>
                    <p class="plan-picker__usage">{fmt(props.usedRequests!)} used this month</p>
                  </Show>
                  <ul class="plan-picker__features">
                    <For each={plan.features}>
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
              </Show>
            </button>
          );
        }}
      </For>

      <Show when={expanded()}>
        <Show
          when={expanded() !== 'enterprise'}
          fallback={
            <a
              class="auth-form__submit plan-picker__cta"
              href="https://manifest.build/pricing"
              target="_blank"
              rel="noopener noreferrer"
            >
              Talk to sales
            </a>
          }
        >
          <button
            type="button"
            class="auth-form__submit plan-picker__cta"
            disabled={props.busy}
            onClick={() => props.onSelect(expanded()!)}
          >
            {props.busy ? <span class="spinner" /> : 'Choose this plan'}
          </button>
        </Show>
      </Show>
    </div>
  );
};

export default PlanPicker;

export { freeFeatures, proFeatures, enterpriseFeatures };
