import { A, useLocation } from '@solidjs/router';
import { Show, createSignal, createResource, type Component } from 'solid-js';
import { getBillingStatus } from '../services/api/billing.js';
import { FREE_REQUEST_LIMIT_LABEL } from '../services/billing-display.js';
import { checkIsSelfHosted, checkMcpEnabled } from '../services/setup-status.js';
import AddAgentModal from './AddAgentModal.jsx';
import AutofixAnnouncement from './AutofixAnnouncement.jsx';

interface SidebarProps {
  mobileOpen?: boolean;
  onNavigate?: () => void;
}

/**
 * Returns true when the given route matches the current location either
 * exactly or as a path prefix (so `/harnesses` stays active on `/harnesses/:name/*`).
 */
function makeIsGlobalActive(pathname: () => string) {
  return (route: string): boolean => {
    const p = pathname();
    return p === route || p.startsWith(route + '/');
  };
}

const Sidebar: Component<SidebarProps> = (props) => {
  const location = useLocation();
  const isGlobalActive = makeIsGlobalActive(() => location.pathname);
  const [addModalOpen, setAddModalOpen] = createSignal(false);
  // Local providers only exist on self-hosted installs — a cloud backend
  // can't reach the user's localhost, so the Local entry is hidden there.
  const [selfHosted] = createResource(checkIsSelfHosted);
  // An install served over plain HTTP cannot host the MCP OAuth resource, so
  // the backend runs without the endpoint entirely. The entry waits for the
  // status like the Local one does, rather than appearing and then vanishing
  // on the installs that don't have it.
  const [mcpEnabled] = createResource(checkMcpEnabled);
  const [billing] = createResource(async () => {
    try {
      return await getBillingStatus();
    } catch {
      return null;
    }
  });
  const showUpgrade = () => billing()?.enabled && billing()?.plan === 'free';
  const requestLimitLabel = () =>
    billing()?.requests.limit?.toLocaleString('en-US') ?? FREE_REQUEST_LIMIT_LABEL;

  const handleNav = () => {
    props.onNavigate?.();
    window.dispatchEvent(new CustomEvent('sidebar-navigate'));
  };

  return (
    <nav
      id="agent-navigation"
      class="sidebar"
      classList={{ 'sidebar--mobile-open': props.mobileOpen === true }}
      aria-label="Navigation"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a.sidebar__link')) {
          handleNav();
        }
      }}
    >
      <A
        href="/overview"
        class="sidebar__link"
        classList={{ active: isGlobalActive('/overview') }}
        aria-current={isGlobalActive('/overview') ? 'page' : undefined}
      >
        Overview
      </A>
      <A
        href="/messages"
        class="sidebar__link"
        classList={{ active: isGlobalActive('/messages') }}
        aria-current={isGlobalActive('/messages') ? 'page' : undefined}
      >
        Requests
      </A>
      {/* Harnesses is a plain nav entry to the /harnesses page; the + keeps
          the one-click create from the nav. */}
      <div class="sidebar__link-row">
        <A
          href="/harnesses"
          class="sidebar__link"
          classList={{ active: isGlobalActive('/harnesses') }}
          aria-current={isGlobalActive('/harnesses') ? 'page' : undefined}
        >
          Harnesses
        </A>
        <button
          type="button"
          class="sidebar__section-add"
          title="Create new harness"
          aria-label="Create new harness"
          onClick={() => setAddModalOpen(true)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M19 12.998h-6v6h-2v-6H5v-2h6v-6h2v6h6z" />
          </svg>
        </button>
      </div>
      <div class="sidebar__section-label">PROVIDERS</div>
      <Show when={selfHosted()}>
        <A
          href="/providers/local"
          class="sidebar__link"
          classList={{ active: isGlobalActive('/providers/local') }}
          aria-current={isGlobalActive('/providers/local') ? 'page' : undefined}
        >
          Local
        </A>
      </Show>
      <A
        href="/providers/usage-based"
        class="sidebar__link"
        classList={{ active: isGlobalActive('/providers/usage-based') }}
        aria-current={isGlobalActive('/providers/usage-based') ? 'page' : undefined}
      >
        Usage-based
      </A>
      <A
        href="/providers/subscriptions"
        class="sidebar__link"
        classList={{ active: isGlobalActive('/providers/subscriptions') }}
        aria-current={isGlobalActive('/providers/subscriptions') ? 'page' : undefined}
      >
        Subscriptions
      </A>

      {/* Integrations: surfaces that drive Manifest from outside the dashboard.
          The "New" pills are a showcase device, not structure — delete the two
          spans once these stop being new. n8n joins here when it gets a page. */}
      <div class="sidebar__section-label">INTEGRATIONS</div>
      <Show when={mcpEnabled()}>
        <A
          href="/integrations/mcp"
          class="sidebar__link"
          classList={{ active: isGlobalActive('/integrations/mcp') }}
          aria-current={isGlobalActive('/integrations/mcp') ? 'page' : undefined}
        >
          MCP server
          <span class="sidebar__badge">New</span>
        </A>
      </Show>
      <A
        href="/integrations/cli"
        class="sidebar__link"
        classList={{ active: isGlobalActive('/integrations/cli') }}
        aria-current={isGlobalActive('/integrations/cli') ? 'page' : undefined}
      >
        CLI
        <span class="sidebar__badge">New</span>
      </A>

      <div class="sidebar__section-label">TOOLS</div>
      <A
        href="/playground"
        class="sidebar__link"
        classList={{ active: isGlobalActive('/playground') }}
        aria-current={isGlobalActive('/playground') ? 'page' : undefined}
      >
        Playground
      </A>

      <div class="sidebar__spacer" />

      {/* Autofix announcement: shows for everyone in every deployment mode,
          with a per-session dismiss. Links to the landing page on manifest.build. */}
      <AutofixAnnouncement />

      <Show when={!selfHosted() && showUpgrade()}>
        <div class="sidebar-usage">
          <span class="sidebar-usage__title">
            {new Date().toLocaleDateString('en-US', { month: 'long' })} usage
          </span>
          <span
            class="sidebar-usage__count"
            classList={{
              'sidebar-usage__count--danger':
                (billing()!.requests.used ?? 0) / (billing()!.requests.limit ?? 1) >= 0.8,
            }}
          >
            {billing()!.requests.used != null
              ? billing()!.requests.used!.toLocaleString('en-US')
              : '0'}
            {' / '}
            {billing()!.requests.limit != null
              ? billing()!.requests.limit!.toLocaleString('en-US')
              : '0'}
            {' requests'}
          </span>
          <div class="sidebar-usage__bar">
            <div
              class="sidebar-usage__fill"
              classList={{
                'sidebar-usage__fill--warning':
                  (billing()!.requests.used ?? 0) / (billing()!.requests.limit ?? 1) >= 0.5 &&
                  (billing()!.requests.used ?? 0) / (billing()!.requests.limit ?? 1) < 0.8,
                'sidebar-usage__fill--danger':
                  (billing()!.requests.used ?? 0) / (billing()!.requests.limit ?? 1) >= 0.8,
              }}
              style={{
                width: `${Math.min(100, ((billing()!.requests.used ?? 0) / (billing()!.requests.limit ?? 1)) * 100)}%`,
              }}
            />
          </div>
          <Show when={(billing()!.requests.used ?? 0) / (billing()!.requests.limit ?? 1) >= 0.8}>
            <p class="sidebar-usage__alert">
              {(billing()!.requests.used ?? 0) >= (billing()!.requests.limit ?? 1)
                ? "You've reached your monthly limit. Requests are being blocked."
                : `You're limited to ${requestLimitLabel()} requests this month. Upgrade for unlimited.`}
            </p>
          </Show>
        </div>
        <A href="/upgrade" class="sidebar-upgrade" onClick={handleNav}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2m0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8" />
            <path d="m8 12 1.41 1.41L11 11.83V17h2v-5.17l1.59 1.59L16 12l-4-4z" />
          </svg>
          Upgrade plan
        </A>
      </Show>

      {/* Create-harness modal, opened by the + button next to the Harnesses nav link */}
      <AddAgentModal open={addModalOpen()} onClose={() => setAddModalOpen(false)} />
    </nav>
  );
};

export default Sidebar;
