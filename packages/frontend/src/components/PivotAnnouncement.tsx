import { Show, createSignal, onCleanup, type Component } from 'solid-js';
import {
  PIVOT_CANVAS_BG,
  PIVOT_CANVAS_INK,
  cssColor,
  initBlobCanvas,
} from '../services/blob-canvas.js';

export const MANIFEST_SIGNUP_URL = 'https://dashboard.manifest.build/signup';
const PIVOT_CARD_DISMISSED_KEY = 'manifest-card-dismissed';

/**
 * Bottom-of-sidebar card that sends gateway users to Manifest, the
 * self-healing product. It shows for everyone, cloud and self-hosted alike,
 * with a per-session dismiss.
 */
const PivotAnnouncement: Component = () => {
  const [dismissed, setDismissed] = createSignal(
    sessionStorage.getItem(PIVOT_CARD_DISMISSED_KEY) === '1',
  );
  const dismiss = () => {
    sessionStorage.setItem(PIVOT_CARD_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <Show when={!dismissed()}>
      <div class="sidebar-pivot">
        {/* The inline background doubles as the fallback when the canvas
            cannot start; canvas colors are art data, not theme tokens. */}
        <div class="sidebar-pivot__top" style={{ background: cssColor(PIVOT_CANVAS_BG) }}>
          <canvas
            class="sidebar-pivot__canvas"
            aria-hidden="true"
            ref={(el) => {
              const stop = initBlobCanvas(el);
              onCleanup(stop);
            }}
          />
          <div class="sidebar-pivot__header">
            {/* Fine dark shadow (canvas art color) so the white title stays
                readable on the light spots of the animated backdrop. */}
            <span
              class="sidebar-pivot__title"
              style={{ 'text-shadow': `0 0.5px 2px ${cssColor(PIVOT_CANVAS_INK, 0.45)}` }}
            >
              Manifest, the self-healing layer for APIs
            </span>
            <button
              type="button"
              class="sidebar-pivot__dismiss"
              title="Hide for this session"
              aria-label="Hide the Manifest card for this session"
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
        </div>
        <div class="sidebar-pivot__bottom">
          <p class="sidebar-pivot__desc">
            Manifest fixes failed API requests in real time, before they break your app.
          </p>
          <a
            class="sidebar-pivot__btn"
            href={MANIFEST_SIGNUP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Try Manifest
          </a>
        </div>
      </div>
    </Show>
  );
};

export default PivotAnnouncement;
