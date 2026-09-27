import { useParams } from '@solidjs/router';
import { createResource, createSignal, For, Show, type Component } from 'solid-js';
import {
  disableProviderForAgent,
  enableProviderForAgent,
  getEnabledProviders,
  getAgentProviderDisableImpact,
  getCustomProviders,
} from '../services/api.js';
import { getProviders as getGlobalProviders } from '../services/api/providers.js';
import { PROVIDERS } from '../services/providers.js';
import { toast } from '../services/toast-store.js';
import { customProviderColor } from '../services/formatters.js';
import { providerIcon } from '../components/ProviderIcon.jsx';
import NoConnectionsPrompt from '../components/NoConnectionsPrompt.jsx';
import '../styles/routing.css';

const AUTH_BADGES: Record<string, string> = {
  api_key: 'API Key',
  subscription: 'Subscription',
  local: 'Local',
};

interface AgentProviderConnection {
  userProviderId: string;
  provider: string;
  authType: string;
  label: string;
  models: number;
}

const AgentProviders: Component = () => {
  const params = useParams<{ agentName: string }>();
  const agentName = () => decodeURIComponent(params.agentName);

  const [providers] = createResource(async () => {
    try {
      return (await getGlobalProviders()).providers;
    } catch {
      return [];
    }
  });

  const [access, { refetch: refetchAccess }] = createResource(
    () => agentName(),
    async (name) => {
      try {
        return new Set((await getEnabledProviders(name)).enabled);
      } catch {
        return new Set<string>();
      }
    },
  );

  const [customProviders] = createResource(
    () => agentName(),
    (name) => getCustomProviders(name).catch(() => []),
  );

  const connections = (): AgentProviderConnection[] => {
    const rows: AgentProviderConnection[] = [];
    for (const provider of providers() ?? []) {
      for (const connection of provider.connections) {
        if (!connection.is_active) continue;
        rows.push({
          userProviderId: connection.id,
          provider: provider.provider,
          authType: provider.auth_type,
          label: connection.label,
          models: connection.cached_model_count || provider.total_models,
        });
      }
    }
    return rows;
  };

  const [busy, setBusy] = createSignal<string | null>(null);

  const isEnabled = (userProviderId: string) => access()?.has(userProviderId) ?? false;

  const providerName = (providerId: string) => {
    const known = PROVIDERS.find((provider) => provider.id === providerId);
    if (known) return known.name;
    if (providerId.startsWith('custom:')) {
      const customId = providerId.slice('custom:'.length);
      const custom = (customProviders() ?? []).find((provider) => provider.id === customId);
      if (custom) return custom.name;
    }
    return providerId;
  };

  const enableConnection = async (userProviderId: string) => {
    setBusy(userProviderId);
    try {
      await enableProviderForAgent(agentName(), userProviderId);
      await refetchAccess();
    } catch {
      // fetchMutate already surfaces the toast.
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (connection: AgentProviderConnection) => {
    if (!isEnabled(connection.userProviderId)) {
      await enableConnection(connection.userProviderId);
      return;
    }

    setBusy(connection.userProviderId);

    // A provider whose models are wired into this harness's routing can't be
    // disabled — that would silently strip live tier assignments. Block it with
    // an error and tell the user to update routing first, rather than removing
    // the assignments for them.
    let affectedTiers: Array<{ tier: string; model: string; position: string }>;
    try {
      affectedTiers = (await getAgentProviderDisableImpact(agentName(), connection.userProviderId))
        .affected_tiers;
    } catch {
      setBusy(null);
      toast.error("Couldn't check this provider's routing impact. Please try again.");
      return;
    }

    if (affectedTiers.length > 0) {
      setBusy(null);
      toast.error(
        `Can't disable ${providerName(connection.provider)}. Its models are assigned to this harness's routing. Update routing to stop using them first.`,
      );
      return;
    }

    try {
      await disableProviderForAgent(agentName(), connection.userProviderId);
      await refetchAccess();
    } catch {
      // fetchMutate already surfaces the toast.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <p style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm); margin-bottom: 16px;">
        Enable the global provider connections this harness may use. A provider can't be turned off
        while its models are assigned to this harness's routing. Update routing first to remove it.
      </p>

      <Show when={connections().length > 0} fallback={<NoConnectionsPrompt />}>
        <div class="panel" style="padding: 0; overflow-x: auto;">
          <table class="data-table" style="min-width: 600px; table-layout: fixed;">
            <colgroup>
              <col style="width: 220px;" />
              <col style="width: 120px;" />
              <col />
              <col style="width: 56px;" />
              <col style="width: 64px;" />
            </colgroup>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Type</th>
                <th>Connection</th>
                <th>Models</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={connections()}>
                {(connection) => {
                  const enabled = () => isEnabled(connection.userProviderId);
                  const name = () => providerName(connection.provider);
                  return (
                    <tr style={{ opacity: enabled() ? '1' : '0.55' }}>
                      <td>
                        <span style="display: flex; align-items: center; gap: 10px;">
                          <Show
                            when={providerIcon(connection.provider, 20)}
                            fallback={
                              <span
                                style={{
                                  display: 'inline-flex',
                                  'align-items': 'center',
                                  'justify-content': 'center',
                                  width: '20px',
                                  height: '20px',
                                  'border-radius': '4px',
                                  'font-size': '11px',
                                  'font-weight': '600',
                                  color: 'white',
                                  background: customProviderColor(name()),
                                }}
                              >
                                {name().charAt(0).toUpperCase()}
                              </span>
                            }
                          >
                            <span style="display: flex; align-items: center; width: 20px; height: 20px;">
                              {providerIcon(connection.provider, 20)}
                            </span>
                          </Show>
                          <span style="font-weight: 500;">{name()}</span>
                        </span>
                      </td>
                      <td>
                        <span style="font-size: var(--font-size-xs); color: hsl(var(--muted-foreground));">
                          {AUTH_BADGES[connection.authType] ?? connection.authType}
                        </span>
                      </td>
                      <td>
                        <span
                          title={connection.label}
                          style={{
                            display: 'block',
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            color: 'hsl(var(--muted-foreground))',
                          }}
                        >
                          {connection.label}
                        </span>
                      </td>
                      <td>{connection.models || '-'}</td>
                      <td style="text-align: right;">
                        <button
                          class="routing-switch"
                          classList={{ 'routing-switch--on': enabled() }}
                          disabled={busy() === connection.userProviderId}
                          aria-label={`${enabled() ? 'Disable' : 'Enable'} ${name()} ${
                            connection.label
                          }`}
                          onClick={() => void handleToggle(connection)}
                        >
                          <span class="routing-switch__track">
                            <span class="routing-switch__thumb" />
                          </span>
                        </button>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
};

export default AgentProviders;
