import { Show, createSignal, type Component } from 'solid-js';

const AUTOFIX_LANDING_URL = 'https://dashboard.manifest.build';
const AUTOFIX_CARD_DISMISSED_KEY = 'autofix-card-dismissed';

const AUTOFIX_BENEFITS = [
  'Fix API failures automatically',
  'Get notified of root cause',
  'Works across your entire stack',
];

/**
 * Sidebar announcement for Autofix (self-healing). Links to the landing page
 * on manifest.build. Shows for everyone with a per-session dismiss.
 */
const AutofixAnnouncement: Component = () => {
  const [dismissed, setDismissed] = createSignal(
    sessionStorage.getItem(AUTOFIX_CARD_DISMISSED_KEY) === '1',
  );

  const dismiss = () => {
    sessionStorage.setItem(AUTOFIX_CARD_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Show when={!dismissed()}>
      <div class="sidebar-autofix">
        <div class="sidebar-autofix__header">
          <span class="sidebar-autofix__title">Make sure your APIs no longer crash</span>
          <button
            type="button"
            class="sidebar-autofix__dismiss"
            title="Hide for this session"
            aria-label="Hide the announcement for this session"
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
        <ul class="sidebar-autofix__benefits">
          {AUTOFIX_BENEFITS.map((benefit) => (
            <li class="sidebar-autofix__benefit-item">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M9 15.59 4.71 11.3 3.3 12.71l5 5c.2.2.45.29.71.29s.51-.1.71-.29l11-11-1.41-1.41L9.02 15.59Z" />
              </svg>
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
        <a href={AUTOFIX_LANDING_URL} target="_blank" rel="noopener noreferrer" class="sidebar-autofix__btn">
          Use it now
        </a>
      </div>
    </Show>
  );
};

export default AutofixAnnouncement;
