import { For, Show, type Component } from 'solid-js';
import ProviderBanner from './ProviderBanner.js';
import EmailProviderSetup from './EmailProviderSetup.js';
import type { EmailProviderConfig } from '../services/api.js';

interface EmailProviderSectionProps {
  emailProvider: EmailProviderConfig | null | undefined;
  loading: boolean;
  onConfigured: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

// No margin on the wrapper: .provider-card carries its own bottom gap, and the
// unboxed setup/skeleton branches bring theirs, so spacing matches cloud's card.
const EmailProviderSection: Component<EmailProviderSectionProps> = (props) => (
  <div>
    <Show
      when={!props.loading}
      fallback={
        <Show
          when={!!props.emailProvider}
          fallback={
            <div style="margin-bottom: var(--gap-lg);">
              <div class="skeleton skeleton--text" style="width: 180px; height: 16px;" />
              <div
                class="skeleton skeleton--text"
                style="width: 280px; height: 13px; margin: 8px 0 var(--gap-lg);"
              />
              <div class="provider-setup-grid">
                <For each={[1, 2, 3]}>
                  {() => (
                    <div style="display: flex; align-items: center; gap: 12px; padding: 16px 20px; border: 1px solid hsl(var(--border)); border-radius: var(--radius);">
                      <div
                        class="skeleton skeleton--rect"
                        style="width: 32px; height: 32px; border-radius: 6px; flex-shrink: 0;"
                      />
                      <div>
                        <div class="skeleton skeleton--text" style="width: 64px; height: 13px;" />
                        <div
                          class="skeleton skeleton--text"
                          style="width: 88px; height: 11px; margin-top: 4px;"
                        />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          }
        >
          <div class="provider-card">
            <div class="provider-card__header">
              <span class="provider-card__label">Your provider</span>
              <div
                class="skeleton skeleton--text"
                style="width: 16px; height: 16px; border-radius: calc(var(--radius) - 2px);"
              />
            </div>
            <div class="provider-card__body">
              <div
                class="skeleton skeleton--rect"
                style="width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0;"
              />
              <div>
                <div class="skeleton skeleton--text" style="width: 80px; height: 14px;" />
                <div
                  class="skeleton skeleton--text"
                  style="width: 160px; height: 12px; margin-top: 2px;"
                />
              </div>
            </div>
          </div>
        </Show>
      }
    >
      <Show
        when={props.emailProvider}
        fallback={
          <div style="margin-bottom: var(--gap-lg);">
            <EmailProviderSetup onConfigured={props.onConfigured} />
          </div>
        }
      >
        <ProviderBanner
          config={props.emailProvider!}
          onEdit={props.onEdit}
          onRemove={props.onRemove}
        />
      </Show>
    </Show>
  </div>
);

export default EmailProviderSection;
