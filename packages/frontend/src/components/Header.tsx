import { A, useLocation, useNavigate } from '@solidjs/router';
import {
  Show,
  createSignal,
  createEffect,
  createResource,
  onCleanup,
  onMount,
  type Component,
} from 'solid-js';
import { useAgentName } from '../services/routing.js';
import { authClient } from '../services/auth-client.js';
import { agentDisplayName } from '../services/agent-display-name.js';
import { agentPlatformIcon } from '../services/agent-platform-store.js';
import { checkIsSelfHosted } from '../services/setup-status.js';
import NotificationBell from './NotificationBell.jsx';
import { getBillingStatus } from '../services/api/billing.js';
import {
  connectionBreadcrumbName,
  connectionBreadcrumbProviderId,
  connectionBreadcrumbLabel,
  connectionBreadcrumbBackLink,
  connectionBreadcrumbBackLabel,
} from '../services/connection-breadcrumb-store.js';
import { providerIcon } from './ProviderIcon.jsx';
import DuplicateAgentModal from './DuplicateAgentModal.jsx';

const GITHUB_REPO = 'mnfst/llm-gateway';
const STAR_DISMISSED_KEY = 'github-star-dismissed';
const STAR_CACHE_KEY = 'github-star-count';
const STAR_CACHE_TS_KEY = 'github-star-ts';
const STAR_CACHE_TTL = 3600000; // 1 hour
const DOCS_BASE_URL = 'https://manifest.build/llm-gateway/docs';

interface HeaderProps {
  showMobileNavToggle?: boolean;
  mobileNavOpen?: boolean;
  onMobileNavToggle?: () => void;
}

const Header: Component<HeaderProps> = (props) => {
  const getAgentName = useAgentName();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [gearOpen, setGearOpen] = createSignal(false);
  const [duplicateOpen, setDuplicateOpen] = createSignal(false);
  const [starCount, setStarCount] = createSignal<number | null>(null);
  const [starDismissed, setStarDismissed] = createSignal(
    sessionStorage.getItem(STAR_DISMISSED_KEY) === 'true',
  );
  const [isSelfHosted, setIsSelfHosted] = createSignal(false);
  const session = authClient.useSession();
  const navigate = useNavigate();
  const [billing] = createResource(async () => {
    try {
      return await getBillingStatus();
    } catch {
      return null;
    }
  });
  const isPro = () => billing()?.enabled && billing()?.plan === 'pro';

  onMount(() => {
    checkIsSelfHosted().then(setIsSelfHosted);
    if (!starDismissed()) {
      const cachedCount = sessionStorage.getItem(STAR_CACHE_KEY);
      const cachedTs = sessionStorage.getItem(STAR_CACHE_TS_KEY);
      if (cachedCount && cachedTs && Date.now() - Number(cachedTs) < STAR_CACHE_TTL) {
        setStarCount(Number(cachedCount));
        return;
      }
      fetch('/api/v1/github/stars')
        .then((r) => r.json())
        .then((data) => {
          if (typeof data.stars === 'number') {
            setStarCount(data.stars);
            sessionStorage.setItem(STAR_CACHE_KEY, String(data.stars));
            sessionStorage.setItem(STAR_CACHE_TS_KEY, String(Date.now()));
          }
        })
        .catch(() => {});
    }
  });

  const dismissStar = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    sessionStorage.setItem(STAR_DISMISSED_KEY, 'true');
    setStarDismissed(true);
  };

  const formatCount = (n: number): string => {
    return n.toLocaleString('en-US');
  };

  const user = () => session()?.data?.user;
  const effectiveName = () => user()?.name ?? 'User';
  const docsUrl = () => {
    const p = location.pathname;
    if (p.includes('/guardrails') || p.includes('/limits')) return `${DOCS_BASE_URL}/observability/`;
    if (p.includes('/routing')) return `${DOCS_BASE_URL}/llm-gateway/`;
    if (p.startsWith('/providers/subscriptions')) {
      return `${DOCS_BASE_URL}/providers/subscription-based-providers/`;
    }
    if (p.startsWith('/providers/usage-based'))
      return `${DOCS_BASE_URL}/providers/api-key-providers/`;
    if (p.startsWith('/providers/local')) return `${DOCS_BASE_URL}/providers/local-models/`;
    if (p.includes('/providers')) return `${DOCS_BASE_URL}/providers/api-key-providers/`;
    return `${DOCS_BASE_URL}/introduction/`;
  };

  const initials = () => {
    const name = effectiveName();
    return name.charAt(0).toUpperCase();
  };

  const handleLogout = async () => {
    await authClient.signOut();
    window.location.replace('/login');
  };

  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.header__user')) {
      setMenuOpen(false);
    }
    if (!target.closest('.header__gear')) {
      setGearOpen(false);
    }
  };

  createEffect(() => {
    if (menuOpen() || gearOpen()) {
      document.addEventListener('click', handleClickOutside);
      onCleanup(() => document.removeEventListener('click', handleClickOutside));
    }
  });

  return (
    <header class="header">
      <div class="header__left">
        <A href="/" class="header__logo">
          <img
            src="/logotype-white.svg"
            alt="Manifest LLM Gateway"
            class="header__logo-img header__logo-img--light"
          />
          <img src="/logotype-dark.svg" alt="" class="header__logo-img header__logo-img--dark" />
        </A>
        <Show when={isSelfHosted()}>
          <span class="header__mode-badge" title="Running on the self-hosted version of Manifest">
            Self-hosted
          </span>
        </Show>
        <Show when={getAgentName()}>
          <span class="header__separator">/</span>
          <A href="/harnesses" class="header__breadcrumb-link" style="font-weight: 500;">
            Harnesses
          </A>
          <span class="header__separator">/</span>
          <span class="header__breadcrumb-current">
            <Show when={agentPlatformIcon()}>
              <img
                src={agentPlatformIcon()}
                alt=""
                width="14"
                height="14"
                class="header__breadcrumb-icon"
              />
            </Show>
            <span>{agentDisplayName() ?? getAgentName()}</span>
            <div class="header__gear" style="position: relative;">
              <button
                class="header__gear-btn"
                onClick={() => setGearOpen(!gearOpen())}
                aria-label="Harness actions"
                aria-haspopup="menu"
                aria-expanded={gearOpen()}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4m0 6c-1.08 0-2-.92-2-2s.92-2 2-2 2 .92 2 2-.92 2-2 2" />
                  <path d="m20.42 13.4-.51-.29c.05-.37.08-.74.08-1.11s-.03-.74-.08-1.11l.51-.29c.96-.55 1.28-1.78.73-2.73l-1-1.73a2.006 2.006 0 0 0-2.73-.73l-.53.31c-.58-.46-1.22-.83-1.9-1.11v-.6c0-1.1-.9-2-2-2h-2c-1.1 0-2 .9-2 2v.6c-.67.28-1.31.66-1.9 1.11l-.53-.31c-.96-.55-2.18-.22-2.73.73l-1 1.73c-.55.96-.22 2.18.73 2.73l.51.29c-.05.37-.08.74-.08 1.11s.03.74.08 1.11l-.51.29c-.96.55-1.28 1.78-.73 2.73l1 1.73c.55.95 1.77 1.28 2.73.73l.53-.31c.58.46 1.22.83 1.9 1.11v.6c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2v-.6a8.7 8.7 0 0 0 1.9-1.11l.53.31c.95.55 2.18.22 2.73-.73l1-1.73c.55-.96.22-2.18-.73-2.73m-2.59-2.78c.11.45.17.92.17 1.38s-.06.92-.17 1.38a1 1 0 0 0 .47 1.11l1.12.65-1 1.73-1.14-.66c-.38-.22-.87-.16-1.19.14-.68.65-1.51 1.13-2.38 1.4-.42.13-.71.52-.71.96v1.3h-2v-1.3c0-.44-.29-.83-.71-.96-.88-.27-1.7-.75-2.38-1.4a1.01 1.01 0 0 0-1.19-.15l-1.14.66-1-1.73 1.12-.65c.39-.22.58-.68.47-1.11-.11-.45-.17-.92-.17-1.38s.06-.93.17-1.38A1 1 0 0 0 5.7 9.5l-1.12-.65 1-1.73 1.14.66c.38.22.87.16 1.19-.14.68-.65 1.51-1.13 2.38-1.4.42-.13.71-.52.71-.96v-1.3h2v1.3c0 .44.29.83.71.96.88.27 1.7.75 2.38 1.4.32.31.81.36 1.19.14l1.14-.66 1 1.73-1.12.65c-.39.22-.58.68-.47 1.11Z" />
                </svg>
              </button>
              <Show when={gearOpen()}>
                <div class="header__dropdown" role="menu" style="left: 0; right: auto;">
                  <A
                    href={`/harnesses/${encodeURIComponent(getAgentName()!)}/settings`}
                    class="header__dropdown-item"
                    role="menuitem"
                    onClick={() => setGearOpen(false)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Settings
                  </A>
                  <button
                    class="header__dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      setGearOpen(false);
                      setDuplicateOpen(true);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z" />
                      <path d="M4 22h10c1.1 0 2-.9 2-2v-2h-2v2H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2m10-10h2v-2h2V8h-2V6h-2v2h-2v2h2z" />
                    </svg>
                    Duplicate harness
                  </button>
                </div>
              </Show>
            </div>
          </span>
        </Show>
        <Show when={!getAgentName() && connectionBreadcrumbName()}>
          <span class="header__separator">/</span>
          <A
            href={connectionBreadcrumbBackLink()}
            class="header__breadcrumb-link"
            style="font-weight: 500;"
          >
            {connectionBreadcrumbBackLabel()}
          </A>
          <span class="header__separator">/</span>
          {/* Same classes as the harness crumb so the phone breakpoint hides the
              parent link and truncates the name instead of wrapping it. */}
          <span class="header__breadcrumb-current">
            <Show when={connectionBreadcrumbProviderId()}>
              <span class="header__breadcrumb-provider-icon">
                {providerIcon(connectionBreadcrumbProviderId()!, 14)}
              </span>
            </Show>
            <span>{connectionBreadcrumbName()}</span>
            <Show when={connectionBreadcrumbLabel()}>
              <span class="header__breadcrumb-label">{connectionBreadcrumbLabel()}</span>
            </Show>
          </span>
        </Show>
      </div>
      <div class="header__right">
        <Show when={props.showMobileNavToggle}>
          <button
            type="button"
            class="mobile-nav-toggle"
            aria-label={
              props.mobileNavOpen === true ? 'Close navigation menu' : 'Open navigation menu'
            }
            aria-controls="agent-navigation"
            aria-expanded={props.mobileNavOpen === true}
            onClick={props.onMobileNavToggle}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </Show>
        <a href={docsUrl()} target="_blank" rel="noopener noreferrer" class="header__docs-link">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          Docs
        </a>
        <NotificationBell />
        <Show when={!starDismissed()}>
          <div class="header__star-separator" />
          <div class="header__github-star">
            <a
              href={`https://github.com/${GITHUB_REPO}`}
              target="_blank"
              rel="noopener noreferrer"
              class="header__github-star-btn"
            >
              <span class="header__github-star-action">
                <svg
                  class="header__github-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                <span class="header__github-star-label">Star</span>
              </span>
              <Show when={starCount() !== null}>
                <span class="header__github-star-count">{formatCount(starCount()!)}</span>
              </Show>
            </a>
            <button
              class="header__github-star-close"
              onClick={dismissStar}
              aria-label="Dismiss GitHub star button"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
          <div class="header__star-separator" />
        </Show>
        <div class="header__user" style="position: relative;">
          <button
            class="header__avatar-btn"
            onClick={() => setMenuOpen(!menuOpen())}
            aria-label="User menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
          >
            <div class="header__avatar">{initials()}</div>
          </button>
          <Show when={menuOpen()}>
            <div class="header__dropdown" role="menu">
              <div class="header__dropdown-header">
                <span class="header__dropdown-name">
                  {effectiveName()}
                  <Show when={isPro()}>
                    <span class="header__pro-badge">PRO</span>
                  </Show>
                </span>
                <span class="header__dropdown-email">{user()?.email ?? ''}</span>
              </div>
              <div class="header__dropdown-divider" />
              <A
                href="/account"
                class="header__dropdown-item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                Account Preferences
              </A>
              <button
                class="header__dropdown-item header__dropdown-item--danger"
                role="menuitem"
                onClick={handleLogout}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Log out
              </button>
            </div>
          </Show>
        </div>
      </div>
      <DuplicateAgentModal
        open={duplicateOpen()}
        sourceName={getAgentName() ?? ''}
        onClose={() => setDuplicateOpen(false)}
      />
    </header>
  );
};

export default Header;
