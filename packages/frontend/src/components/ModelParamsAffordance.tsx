import { createResource, createSignal, lazy, Show, Suspense, type Component } from 'solid-js';
import type { ProviderParamSpec } from 'manifest-shared';
import type { AuthType, RequestParamDefaults } from '../services/api.js';
import { getModelParamSpecs } from '../services/api/model-params.js';

// Only mounted while the parameters dialog is open. Lazy-load it so the
// Routing route doesn't ship the dialog up front.
const ModelParamsDialog = lazy(() => import('./ModelParamsDialog.jsx'));

interface Props {
  agentName: string;
  provider: string | undefined;
  authType: AuthType | undefined;
  model: string;
  slotLabel: string;
  scope: string;
  getParams: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
  ) => RequestParamDefaults | null;
  setParams: (
    scope: string,
    provider: string,
    authType: AuthType,
    model: string,
    params: RequestParamDefaults | null,
  ) => Promise<unknown>;
  disabled?: boolean;
}

const ModelParamsAffordance: Component<Props> = (props) => {
  const [dialogOpen, setDialogOpen] = createSignal(false);

  // Fetch specs only while the dialog is open, so the Routing page never
  // downloads the whole catalog up front. The provider/model filtering that
  // used to run client-side now happens server-side via the by-model endpoint.
  const [specs] = createResource(
    () =>
      dialogOpen() && props.provider && props.authType
        ? { provider: props.provider, authType: props.authType, model: props.model }
        : null,
    (key) =>
      getModelParamSpecs(props.agentName, key.provider, key.authType, key.model).catch(
        () => [] as ProviderParamSpec[],
      ),
  );

  const canOpen = () =>
    props.provider !== undefined && props.authType !== undefined && props.authType !== 'local';

  const current = () => {
    if (!props.provider || !props.authType) return null;
    return props.getParams(props.scope, props.provider, props.authType, props.model);
  };

  const configured = () => current() !== null;

  const requestUrl = () => {
    if (!props.provider || !props.authType) return undefined;
    const authTypeLabel = props.authType === 'subscription' ? 'Subscription' : 'API key';
    const modelLabel = `${props.provider}/${props.model}`;
    const params = new URLSearchParams({
      title: `Parameters: ${modelLabel}`,
      labels: 'parameters',
      body: `Model: \`${modelLabel}\`\nAuth type: ${authTypeLabel}\n\nPlease add the configurable request parameters for this model.`,
    });
    return `https://github.com/mnfst/modelparams.dev/issues/new?${params.toString()}`;
  };

  return (
    <Show when={canOpen()}>
      <button
        type="button"
        class="routing-card__chip-action"
        classList={{
          'routing-card__chip-action--configured': configured(),
          'routing-card__chip-action--dialog-open': dialogOpen(),
        }}
        onClick={(e) => {
          e.stopPropagation();
          setDialogOpen(true);
        }}
        disabled={props.disabled}
        aria-label={`Configure model parameters for ${props.slotLabel}`}
      >
        <span class="routing-tooltip">Parameters</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
      </button>
      <Show when={dialogOpen() && props.provider && props.authType}>
        <Suspense fallback={null}>
          <ModelParamsDialog
            open={dialogOpen()}
            slotLabel={props.slotLabel}
            current={current()}
            specs={specs() ?? []}
            loading={specs.loading}
            requestParamsUrl={requestUrl()}
            onSave={(next) =>
              props.setParams(props.scope, props.provider!, props.authType!, props.model, next)
            }
            onClose={() => setDialogOpen(false)}
          />
        </Suspense>
      </Show>
    </Show>
  );
};

export default ModelParamsAffordance;
