import { A, useLocation } from '@solidjs/router';
import { Show, createSignal, createResource, type Component } from 'solid-js';
import { getBillingStatus } from '../services/api/billing.js';
import { checkIsSelfHosted, checkMcpEnabled } from '../services/setup-status.js';
import AddAgentModal from './AddAgentModal.jsx';
import ServicesContactModal from './ServicesContactModal.jsx';
import { authClient } from '../services/auth-client.js';

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
  const [servicesOpen, setServicesOpen] = createSignal(false);
  const session = authClient.useSession();
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
  // A tenant without a subscription has a limit of 0 since the Cloud Free plan
  // ended: there is no allowance to meter, only the upgrade link stays.
  const hasAllowance = () => (billing()?.requests.limit ?? 0) > 0;
  const requestLimitLabel = () => (billing()?.requests.limit ?? 0).toLocaleString('en-US');

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

      <button type="button" class="sidebar-services" onClick={() => setServicesOpen(true)}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="m19.46,5.52c-2.06-2.03-5.29-2.03-7.34,0l-.08.08s-.03.02-.04.03h0s-.11-.11-.11-.11c-2.05-2.03-5.28-2.03-7.34,0-.99.99-1.54,2.29-1.53,3.65,0,1.36.55,2.65,1.54,3.63l6.06,6c.39.38.9.58,1.41.58s1.02-.19,1.41-.58l6.06-6c.99-.98,1.53-2.27,1.54-3.63,0-1.37-.54-2.67-1.53-3.65,0,0,0,0,0,0Zm-8.17,12.58l-6.06-6c-.8-.79-1.24-1.83-1.24-2.92,0-1.1.44-2.15,1.24-2.94.83-.82,1.9-1.23,2.97-1.23s2.13.41,2.96,1.23l.12.11-2.3,2.32c-.74.75-.74,1.96,0,2.71.37.37.86.56,1.36.56s.98-.19,1.36-.56l1.98-1.98,3.89,3.89-1.05,1.04-2.17-2.17c-.2-.2-.51-.2-.71,0s-.2.51,0,.71l2.17,2.17-.8.79-2.16-2.16c-.2-.2-.51-.2-.71,0s-.2.51,0,.71l2.16,2.16-.8.79-2.15-2.15c-.2-.2-.51-.2-.71,0s-.2.51,0,.71l2.15,2.15-.09.09c-.39.38-1.02.38-1.41,0Zm7.46-6l-.48.48-3.89-3.89,1.31-1.31c.2-.2.2-.51,0-.71s-.51-.2-.71,0l-4,4c-.36.36-.94.36-1.3,0s-.36-.94,0-1.29l2.63-2.65s.01,0,.02-.01l.47-.47c1.66-1.64,4.27-1.64,5.94,0,.8.8,1.24,1.84,1.24,2.94,0,1.1-.44,2.13-1.24,2.92Z" />
        </svg>
        Custom development
      </button>

      <Show when={!selfHosted() && showUpgrade()}>
        <Show when={hasAllowance()}>
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
        </Show>
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
      <ServicesContactModal
        open={servicesOpen()}
        defaultName={session()?.data?.user?.name ?? ''}
        defaultEmail={session()?.data?.user?.email ?? ''}
        onClose={() => setServicesOpen(false)}
      />
    </nav>
  );
};

export default Sidebar;
