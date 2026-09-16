import { type Component, Show, createResource, createSignal } from 'solid-js';
import CopyButton from './CopyButton.jsx';
import ModelSelectDropdown from './ModelSelectDropdown.jsx';
import SetupStepAddProvider from './SetupStepAddProvider.jsx';
import { getAgentKey } from '../services/api.js';
import { installOrigin } from '../services/install-endpoints.js';
import { agentPlatform, agentCategory } from '../services/agent-platform-store.js';
import { platformIcon } from 'manifest-shared';

interface Props {
  open: boolean;
  mode: 'enable' | 'disable';
  agentName: string;
  connectedProvider?: string | null;
  onClose: () => void;
}

const RoutingInstructionModal: Component<Props> = (props) => {
  const [selectedModel, setSelectedModel] = createSignal<string | null>(null);
  const isEnable = () => props.mode === 'enable';
  const title = () => (isEnable() ? 'Activate routing' : 'Deactivate routing');
  const modelOrPlaceholder = () => selectedModel() ?? '<provider/model>';

  const [apiKeyData] = createResource(
    () => (props.open && isEnable() ? props.agentName : null),
    (n) => getAgentKey(n),
  );

  const baseUrl = () => {
    return `${installOrigin()}/v1`;
  };

  const disableCmd = () =>
    `openclaw config unset models.providers.manifest\nopenclaw config unset agents.defaults.models.manifest/auto\nopenclaw config set agents.defaults.model.primary ${modelOrPlaceholder()}\nopenclaw gateway restart`;

  const handleModelSelect = (cliValue: string) => {
    setSelectedModel(cliValue);
  };

  return (
    <Show when={props.open}>
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
          style="max-width: 640px;"
          role="dialog"
          aria-modal="true"
          aria-labelledby="routing-instruction-title"
        >
          <div class="setup-modal__header">
            <div class="modal-card__title" id="routing-instruction-title">
              <Show when={isEnable()}>
                <Show when={platformIcon(agentPlatform(), agentCategory())}>
                  <img
                    src={platformIcon(agentPlatform(), agentCategory())}
                    alt=""
                    width="28"
                    height="28"
                    class="platform-icon setup-modal__platform-icon"
                  />
                </Show>
              </Show>
              <Show when={isEnable()} fallback={<>Deactivate routing</>}>
                Set up harness: <em>{props.agentName}</em>
              </Show>
            </div>
            <button class="modal__close" onClick={() => props.onClose()} aria-label="Close">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <Show when={isEnable()}>
            <p class="modal-card__desc">
              Connect your harness to Manifest to start routing requests.
            </p>
          </Show>

          <Show
            when={isEnable()}
            fallback={
              <>
                <p style="margin: 0 0 14px; font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); line-height: 1.5;">
                  This will stop routing requests through Manifest and restore direct model access
                  in your OpenClaw harness.
                </p>

                <p style="margin: 0 0 8px; font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); line-height: 1.5;">
                  1. Pick the model your harness should use directly:
                </p>

                <ModelSelectDropdown selectedValue={selectedModel()} onSelect={handleModelSelect} />

                <p style="margin: 14px 0; font-size: var(--font-size-sm); color: hsl(var(--muted-foreground)); line-height: 1.5;">
                  2. Run these commands in your harness's terminal to restore direct model access:
                </p>

                <div class="modal-terminal">
                  <div class="modal-terminal__header">
                    <div class="modal-terminal__dots">
                      <span class="modal-terminal__dot modal-terminal__dot--red" />
                      <span class="modal-terminal__dot modal-terminal__dot--yellow" />
                      <span class="modal-terminal__dot modal-terminal__dot--green" />
                    </div>
                    <div class="modal-terminal__tabs">
                      <span class="modal-terminal__tab modal-terminal__tab--active">Terminal</span>
                    </div>
                  </div>
                  <div class="modal-terminal__body">
                    <CopyButton text={disableCmd()} />
                    <div>
                      <span class="modal-terminal__prompt">$</span>
                      <span class="modal-terminal__code">
                        openclaw config unset models.providers.manifest
                      </span>
                    </div>
                    <div style="margin-top: 8px;">
                      <span class="modal-terminal__prompt">$</span>
                      <span class="modal-terminal__code">
                        openclaw config unset agents.defaults.models.manifest/auto
                      </span>
                    </div>
                    <div style="margin-top: 8px;">
                      <span class="modal-terminal__prompt">$</span>
                      <span class="modal-terminal__code">
                        openclaw config set agents.defaults.model.primary {modelOrPlaceholder()}
                      </span>
                    </div>
                    <div style="margin-top: 8px;">
                      <span class="modal-terminal__prompt">$</span>
                      <span class="modal-terminal__code">openclaw gateway restart</span>
                    </div>
                  </div>
                </div>
              </>
            }
          >
            <SetupStepAddProvider
              apiKey={apiKeyData()?.apiKey ?? null}
              keyPrefix={apiKeyData()?.keyPrefix ?? null}
              baseUrl={baseUrl()}
              platform={agentPlatform()}
            />
          </Show>

          <div style="display: flex; justify-content: flex-end; margin-top: 20px;">
            <button class="btn btn--primary btn--sm" onClick={() => props.onClose()}>
              Done
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default RoutingInstructionModal;
