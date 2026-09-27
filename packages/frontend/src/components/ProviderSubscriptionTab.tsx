import { For, Show, type Accessor, type Component } from 'solid-js';
import type { AuthType } from '../services/api.js';
import type { ProviderDef } from '../services/providers.js';
import { providerIcon } from './ProviderIcon.js';

interface Props {
  subscriptionProviders: ProviderDef[];
  busy: Accessor<boolean>;
  isSubscriptionConnected: (provId: string) => boolean;
  isSubscriptionWithToken: (provId: string) => boolean;
  onOpenDetail: (provId: string, authType: AuthType) => void;
  onAddKey: (provId: string, authType: AuthType) => void;
  onToggle: (provId: string) => void;
}

const ProviderSubscriptionTab: Component<Props> = (props) => {
  const getSubscriptionAuthMode = (prov: ProviderDef) =>
    prov.subscriptionAuthMode ?? (prov.subscriptionKeyPlaceholder ? 'token' : undefined);

  return (
    <>
      <div class="provider-modal__tab-hint">
        Use your existing subscription or paid plan instead of pay-as-you-go API billing. Sign in,
        paste a token, or paste an API key depending on the provider.
      </div>
      <div class="provider-modal__list">
        <For each={props.subscriptionProviders}>
          {(prov) => {
            const hasDetailView = () =>
              !!prov.subscriptionKeyPlaceholder ||
              !!prov.subscriptionCommand ||
              !!getSubscriptionAuthMode(prov);
            const requiresStoredToken = () => getSubscriptionAuthMode(prov) === 'token';
            const connected = () =>
              requiresStoredToken()
                ? props.isSubscriptionWithToken(prov.id)
                : props.isSubscriptionConnected(prov.id);

            return (
              <button
                class="provider-toggle"
                disabled={props.busy()}
                onClick={() =>
                  hasDetailView()
                    ? props.onOpenDetail(prov.id, 'subscription')
                    : props.onToggle(prov.id)
                }
              >
                <span class="provider-toggle__icon">
                  {providerIcon(prov.id, 20) ?? (
                    <span class="provider-card__logo-letter" style={{ background: prov.color }}>
                      {prov.initial}
                    </span>
                  )}
                </span>
                <span class="provider-toggle__info">
                  <span class="provider-toggle__name">{prov.name}</span>
                  <span class="provider-toggle__local-only">
                    {prov.subscriptionLabel ?? 'Subscription'}
                  </span>
                </span>
                <div class="provider-toggle__actions">
                  <Show when={connected()}>
                    <button
                      class="provider-toggle__add-btn"
                      type="button"
                      aria-label={`Add connection for ${prov.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onAddKey(prov.id, 'subscription');
                      }}
                    >
                      <span class="provider-toggle__add-tooltip">Add connection</span>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="M4 11h11v2H4zm0-5h16v2H4zm0 10h8v2H4zm15-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" />
                      </svg>
                    </button>
                  </Show>
                  <span
                    class="provider-toggle__switch"
                    classList={{ 'provider-toggle__switch--on': connected() }}
                  >
                    <span class="provider-toggle__switch-thumb" />
                  </span>
                </div>
              </button>
            );
          }}
        </For>
        <div class="provider-modal__add-custom">
          <a
            class="provider-modal__add-custom-chip"
            href="https://github.com/mnfst/llm-gateway/discussions/973"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="m9,13h2v2c0,.55.45,1,1,1s1-.45,1-1v-2h2c.55,0,1-.45,1-1s-.45-1-1-1h-2v-2c0-.55-.45-1-1-1s-1,.45-1,1v2h-2c-.55,0-1,.45-1,1s.45,1,1,1Z" />
              <path d="m2.72,19.65c-.32.46-.35,1.05-.1,1.55.26.5.77.8,1.33.8h8.05c4.35,0,8.26-2.81,9.51-6.82,1.06-3.41.4-6.9-1.81-9.56-2.18-2.62-5.51-3.95-8.9-3.54C6.07,2.63,2.3,6.63,2.02,11.39c-.14,2.34.55,4.66,1.91,6.51l-1.21,1.75Zm1.29-8.14c.23-3.81,3.24-7.01,7.01-7.45h0c2.73-.32,5.39.74,7.13,2.83,1.77,2.13,2.3,4.94,1.44,7.69-.99,3.19-4.12,5.42-7.6,5.42h-7.09l.67-.96c.49-.7.48-1.63-.01-2.3-1.12-1.52-1.66-3.33-1.55-5.23Z" />
            </svg>
            Request new subscription model
          </a>
        </div>
      </div>
    </>
  );
};

export default ProviderSubscriptionTab;
