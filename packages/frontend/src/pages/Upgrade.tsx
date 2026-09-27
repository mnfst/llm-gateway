import { Meta, Title } from '@solidjs/meta';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { For, Show, createEffect, createResource, createSignal, type Component } from 'solid-js';
import {
  type PlanId,
  freeFeatures,
  proFeatures,
  enterpriseFeatures,
} from '../components/PlanPicker.jsx';
import { authClient } from '../services/auth-client.js';
import { getBillingStatus } from '../services/api/billing.js';
import { toast } from '../services/toast-store.js';
import { FREE_REQUEST_LIMIT_LABEL, formatBillingPrice } from '../services/billing-display.js';
import { markPlanChosen } from '../services/plan-selection.js';

const Upgrade: Component = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const session = authClient.useSession();
  const userId = () => session()?.data?.user?.id ?? '';
  const [billingError, setBillingError] = createSignal(false);
  const [billing] = createResource(async () => {
    setBillingError(false);
    try {
      return await getBillingStatus({ cache: false });
    } catch {
      setBillingError(true);
      return undefined;
    }
  });
  const [billingBusy, setBillingBusy] = createSignal(false);

  const status = () => billing();
  // `?reason=requests` comes from links on old blocked requests and emails, so
  // it can outlive the Free plan. Only a Free tenant has a limit to report.
  const isRequestLimitEntry = () => searchParams.reason === 'requests' && status()?.plan === 'free';
  const proPrice = () => formatBillingPrice(status()?.priceMonthly);

  createEffect(() => {
    const current = status();
    if (current && !current.enabled) {
      navigate('/', { replace: true });
    }
  });

  const handlePlanSelect = async (plan: PlanId) => {
    if (plan === 'enterprise') {
      return;
    }
    setBillingBusy(true);
    try {
      const origin = window.location.origin;
      const cancelPath = `${window.location.pathname}${window.location.search}` || '/upgrade';
      const res = await authClient.subscription.upgrade({
        plan: 'pro',
        successUrl: `${origin}/overview?upgraded=1`,
        cancelUrl: `${origin}${cancelPath}`,
      });
      const error = (res as { error?: unknown } | undefined)?.error;
      if (error) throw error;
      const uid = userId();
      if (uid) markPlanChosen(uid);
    } catch {
      toast.error('Could not start the upgrade. Please try again.');
    } finally {
      setBillingBusy(false);
    }
  };

  return (
    <div class="account-modal account-modal--standalone">
      <Title>Upgrade to Pro - Manifest</Title>
      <Meta name="description" content="Upgrade Manifest to Pro for unlimited routed requests." />
      <div class="account-modal__inner account-modal__inner--upgrade">
        <Show when={window.history.length > 1}>
          <button
            class="upgrade-back"
            onClick={() => {
              const referrer = document.referrer;
              if (referrer && new URL(referrer).origin === window.location.origin) {
                window.history.back();
              } else {
                navigate('/');
              }
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59Z" />
            </svg>
            Back
          </button>
        </Show>
        <div class="page-header upgrade-page-header upgrade-page-header--centered">
          <div class="upgrade-page-header__copy">
            <h1>Full control over your AI routing</h1>
            <p>Free to start. Pick the plan that fits how your team ships AI.</p>
          </div>
        </div>

        <Show when={isRequestLimitEntry()}>
          <p class="upgrade-limit-notice">
            You've used all{' '}
            {status()?.requests.limit?.toLocaleString('en-US') ?? FREE_REQUEST_LIMIT_LABEL} requests
            this month. Upgrade for unlimited routed requests.
          </p>
        </Show>

        <Show when={billing.loading}>
          <div class="settings-card">
            <div class="settings-card__body">
              <p class="settings-card__desc">Loading billing status...</p>
            </div>
          </div>
        </Show>

        <Show when={billingError()}>
          <div class="settings-card">
            <div class="settings-card__body">
              <p class="settings-card__desc">Could not load billing status. Please try again.</p>
            </div>
            <div class="settings-card__footer billing-footer">
              <span class="billing-footer__note">You can continue to the dashboard.</span>
              <button class="btn btn--outline btn--sm" onClick={() => navigate('/')}>
                Dashboard
              </button>
            </div>
          </div>
        </Show>

        <Show when={status()?.enabled && !billingError()}>
          <Show
            when={status()!.plan === 'pro'}
            fallback={
              <>
                <div class="upgrade-plan-grid">
                  <section class="settings-card upgrade-plan-card">
                    <div class="upgrade-plan-card__header">
                      <h2>Free</h2>
                    </div>
                    <div class="upgrade-plan-card__price">
                      <span class="upgrade-plan-card__amount">$0</span>
                      <span class="upgrade-plan-card__period">/month</span>
                    </div>
                    <p class="upgrade-plan-card__desc">For prototypes and small projects.</p>
                    <div class="upgrade-plan-card__cta">
                      <button
                        class="btn btn--outline"
                        onClick={() => {
                          const uid = userId();
                          if (uid) markPlanChosen(uid);
                          navigate('/');
                        }}
                      >
                        Use Manifest for free
                      </button>
                    </div>
                    <div class="upgrade-plan-card__bottom">
                      <div class="upgrade-plan-card__divider" />
                      <ul class="upgrade-plan-card__features">
                        <For each={freeFeatures}>
                          {(feature) => (
                            <li>
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
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
                  </section>

                  <section class="settings-card upgrade-plan-card upgrade-plan-card--pro">
                    <span class="upgrade-plan-card__badge">Popular</span>
                    <div class="upgrade-plan-card__header">
                      <h2>Pro</h2>
                    </div>
                    <div class="upgrade-plan-card__price">
                      <span class="upgrade-plan-card__amount">{proPrice() ?? 'Pro'}</span>
                      <Show when={proPrice()}>
                        <span class="upgrade-plan-card__period">/month</span>
                      </Show>
                    </div>
                    <p class="upgrade-plan-card__desc">
                      For production projects. Longer data access and unlimited agents. Not suited
                      for teams.
                    </p>
                    <div class="upgrade-plan-card__cta">
                      <button
                        class="btn btn--primary"
                        disabled={billingBusy()}
                        onClick={() => handlePlanSelect('pro')}
                      >
                        {billingBusy() ? <span class="spinner" /> : 'Upgrade to Pro'}
                      </button>
                      <span class="upgrade-plan-card__no-commitment">
                        No commitment, cancel anytime
                      </span>
                    </div>
                    <div class="upgrade-plan-card__bottom">
                      <div class="upgrade-plan-card__divider" />
                      <p class="upgrade-plan-card__features-intro">
                        Everything in the Free plan, plus:
                      </p>
                      <ul class="upgrade-plan-card__features">
                        <For each={proFeatures}>
                          {(feature) => (
                            <li>
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
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
                  </section>

                  <section class="settings-card upgrade-plan-card">
                    <div class="upgrade-plan-card__header">
                      <h2>Enterprise</h2>
                    </div>
                    <div class="upgrade-plan-card__price">
                      <span class="upgrade-plan-card__amount upgrade-plan-card__amount--custom">
                        Let's Talk
                      </span>
                    </div>
                    <p class="upgrade-plan-card__desc">
                      For scaling projects, large scale teams. Enterprise-grade support and
                      security.
                    </p>
                    <div class="upgrade-plan-card__cta">
                      <a
                        class="btn btn--primary"
                        href="https://manifest.build/pricing"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Talk to sales
                      </a>
                    </div>
                    <div class="upgrade-plan-card__bottom">
                      <div class="upgrade-plan-card__divider" />
                      <ul class="upgrade-plan-card__features">
                        <For each={enterpriseFeatures}>
                          {(feature) => (
                            <li>
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
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
                  </section>
                </div>
                <p class="upgrade-terms">
                  Subject to our{' '}
                  <a href="https://manifest.build/terms" target="_blank" rel="noopener noreferrer">
                    terms and conditions
                  </a>
                </p>
              </>
            }
          >
            <div class="upgrade-pro-current">
              <p class="upgrade-pro-current__status">
                You're currently on the <strong>Pro plan</strong>. Manage billing from{' '}
                <a href="/account" class="billing-footer__link">
                  Account
                </a>
                .
              </p>
              <p class="upgrade-pro-current__status">
                If you need more (team management, compliance, SLAs...), explore our Enterprise
                plan.
              </p>

              <div class="upgrade-pro-current__card">
                <section class="settings-card upgrade-plan-card">
                  <div class="upgrade-plan-card__header">
                    <h2>Enterprise</h2>
                  </div>
                  <div class="upgrade-plan-card__price">
                    <span class="upgrade-plan-card__amount upgrade-plan-card__amount--custom">
                      Let's Talk
                    </span>
                  </div>
                  <p class="upgrade-plan-card__desc">
                    Everything is negotiable. We build the plan around your team's needs.
                  </p>
                  <div class="upgrade-plan-card__cta">
                    <a
                      class="btn btn--primary"
                      href="https://manifest.build/pricing"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Talk to sales
                    </a>
                  </div>
                  <div class="upgrade-plan-card__bottom">
                    <div class="upgrade-plan-card__divider" />
                    <ul class="upgrade-plan-card__features">
                      {[
                        'Multiple seats and team management',
                        'SSO / SAML',
                        'Audit logs',
                        'Custom retention',
                        'Uptime SLA',
                        'SOC 2 Type II and ISO 27001',
                        'HIPAA and custom BAAs',
                        'Custom guardrails',
                        'Dedicated support (Slack and email)',
                      ].map((feature) => (
                        <li>
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            fill="#2632EF"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path d="M9 15.59 4.71 11.3 3.3 12.71l5 5c.2.2.45.29.71.29s.51-.1.71-.29l11-11-1.41-1.41L9.02 15.59Z" />
                          </svg>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default Upgrade;
