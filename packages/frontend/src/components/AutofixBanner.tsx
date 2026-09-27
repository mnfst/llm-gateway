import { Show, createSignal, type Component } from 'solid-js';

const AUTOFIX_BANNER_DISMISSED_KEY = 'autofix-banner-dismissed';
const AUTOFIX_DASHBOARD_URL = 'https://dashboard.manifest.build';

/**
 * Top-of-overview banner promoting Autofix (self-healing). Shows for everyone
 * with a per-session dismiss.
 */
const AutofixBanner: Component = () => {
  const [dismissed, setDismissed] = createSignal(
    sessionStorage.getItem(AUTOFIX_BANNER_DISMISSED_KEY) === '1',
  );

  const dismiss = () => {
    sessionStorage.setItem(AUTOFIX_BANNER_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Show when={!dismissed()}>
      <div class="autofix-banner">
        <div class="autofix-banner__content">
          <span class="autofix-banner__text">Keep your apps up with self-healing APIs</span>
          <a
            href={AUTOFIX_DASHBOARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="autofix-banner__btn"
          >
            Get started
          </a>
        </div>
        <button
          type="button"
          class="autofix-banner__close"
          title="Hide for this session"
          aria-label="Hide this banner for this session"
          onClick={dismiss}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m16.192 6.344-4.243 4.242-4.242-4.242-1.414 1.414L10.535 12l-4.242 4.242 1.414 1.414 4.242-4.242 4.243 4.242 1.414-1.414L13.364 12l4.242-4.242z" />
          </svg>
        </button>
      </div>
    </Show>
  );
};

export default AutofixBanner;
