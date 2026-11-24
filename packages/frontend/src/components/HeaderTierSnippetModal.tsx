import { type Component, createResource } from 'solid-js';
import FrameworkSnippets from './FrameworkSnippets.jsx';
import { getAgentKey } from '../services/api.js';
import { installOrigin } from '../services/install-endpoints.js';
import type { HeaderTier } from '../services/api/header-tiers.js';

interface Props {
  agentName: string;
  tier: HeaderTier;
  onClose: () => void;
}

/**
 * Modal that shows SDK-specific code snippets for sending the tier's matching
 * header. Reuses {@link FrameworkSnippets} (the same tabbed UI used in the
 * onboarding wizard) with `customHeaders` filled from the tier's rule.
 */
const HeaderTierSnippetModal: Component<Props> = (props) => {
  const [keyData] = createResource(
    () => props.agentName,
    (n) => getAgentKey(n),
  );

  const baseUrl = (): string => {
    return `${installOrigin()}/v1`;
  };

  const customHeaders = (): Record<string, string> => ({
    [props.tier.header_key]: props.tier.header_value,
  });

  const modelText = (): string =>
    props.tier.override_route?.model ?? 'no model assigned (falls back to default routing)';

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose();
      }}
    >
      <div
        class="modal-card"
        style="max-width: 720px;"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-tier-snippet-title"
      >
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
          <h2
            id="header-tier-snippet-title"
            style="margin: 0; font-size: var(--font-size-lg); font-weight: 600;"
          >
            Send the “{props.tier.name}” header
          </h2>
          <button class="modal__close" onClick={() => props.onClose()} aria-label="Close">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m9.17 13.41-3.54 3.54a.996.996 0 0 0 .71 1.7c.26 0 .51-.1.71-.29l2.83-2.83L12 13.41l2.83 2.83 2.12 2.12c.2.2.45.29.71.29s.51-.1.71-.29a.996.996 0 0 0 0-1.41l-3.54-3.54L13.42 12l4.95-4.95a.996.996 0 1 0-1.41-1.41l-4.95 4.95-4.95-4.95a.996.996 0 1 0-1.41 1.41L10.6 12l-1.41 1.41Z" />
            </svg>
          </button>
        </div>
        <p class="modal-card__desc" style="margin-top: 0;">
          Add this header to any request and it'll route to <code>{modelText()}</code>.
        </p>

        <FrameworkSnippets
          apiKey={keyData()?.apiKey ?? null}
          keyPrefix={keyData()?.keyPrefix ?? null}
          baseUrl={baseUrl()}
          customHeaders={customHeaders()}
        />

        <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
          <button class="btn btn--primary" type="button" onClick={() => props.onClose()}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default HeaderTierSnippetModal;
