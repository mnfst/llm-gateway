import { type Component, type JSX } from 'solid-js';
import '../styles/routing-deprecation.css';

/** Blog post explaining why rule-based (complexity + task-specific) routing is being retired. */
const DEPRECATION_BLOG_URL = 'https://manifest.build/blog/deprecating-rule-based-routing/';

export interface RoutingDeprecationNoticeProps {
  /** Short bold lead-in, e.g. "Complexity routing is being retired." */
  title: string;
  /** Explanatory body (plain text or inline markup). */
  children: JSX.Element;
}

/**
 * Inline, non-blocking deprecation banner rendered on the routing surfaces
 * that are being retired. It only mounts inside sections shown to legacy /
 * invested agents, so new ("clean") agents never see it.
 */
const RoutingDeprecationNotice: Component<RoutingDeprecationNoticeProps> = (props) => (
  <div class="routing-deprecation" role="note">
    <span class="routing-deprecation__icon" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
    <div class="routing-deprecation__text">
      <span class="routing-deprecation__title">{props.title}</span>{' '}
      <span class="routing-deprecation__body">{props.children}</span>{' '}
      <a
        class="routing-deprecation__link"
        href={DEPRECATION_BLOG_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        View more
      </a>
    </div>
  </div>
);

export default RoutingDeprecationNotice;
