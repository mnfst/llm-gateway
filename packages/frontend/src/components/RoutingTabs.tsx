import { createSignal, Show, type Component, type JSX } from 'solid-js';

export type RoutingTabId = 'default' | 'specificity' | 'custom';

interface Tab {
  id: RoutingTabId;
  label: string;
  dot?: () => boolean;
}

export interface RoutingTabsProps {
  specificityEnabled: () => boolean;
  customEnabled: () => boolean;
  /**
   * Gate for the deprecated Task-specific tab. When this returns false the tab
   * is not rendered at all — used to hide task-specific routing from agents that
   * never configured it (see `legacySpecificityVisible` in Routing.tsx).
   * Defaults to shown so existing callers/tests are unaffected.
   */
  showSpecificity?: () => boolean;
  pipelineHelp?: () => JSX.Element | null;
  /** Slot rendered to the right of the tabs (e.g. response mode toggle). */
  headerRight?: JSX.Element;
  /** When set, the help button is removed from the header. The parent manages the modal. */
  onShowHelp?: () => void;
  children: {
    default: JSX.Element;
    specificity: JSX.Element;
    custom: JSX.Element;
  };
}

const RoutingTabs: Component<RoutingTabsProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<RoutingTabId>('default');
  const [helpOpen, setHelpOpen] = createSignal(false);

  const showSpecificity = () => props.showSpecificity?.() ?? true;

  const tabs = (): Tab[] => [
    { id: 'default', label: 'Default', dot: () => true },
    ...(showSpecificity()
      ? [
          {
            id: 'specificity' as RoutingTabId,
            label: 'Task-specific',
            dot: () => props.specificityEnabled(),
          },
        ]
      : []),
    { id: 'custom', label: 'Custom', dot: () => props.customEnabled() },
  ];

  return (
    <div class="routing-tabs">
      <div class="routing-tabs__header">
        <div class="panel__tabs" role="tablist" aria-label="Routing layers">
          {tabs().map((tab) => (
            <button
              class="panel__tab"
              classList={{ 'panel__tab--active': activeTab() === tab.id }}
              role="tab"
              aria-selected={activeTab() === tab.id}
              aria-controls={`routing-tabpanel-${tab.id}`}
              id={`routing-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Show when={tab.dot}>
                <span
                  class="routing-tabs__dot"
                  classList={{
                    'routing-tabs__dot--on': tab.dot!(),
                    'routing-tabs__dot--off': !tab.dot!(),
                  }}
                />
              </Show>
              {tab.label}
            </button>
          ))}
        </div>
        <Show when={props.headerRight}>
          <div class="routing-tabs__header-right">{props.headerRight}</div>
        </Show>
      </div>
      <div
        class="routing-tabs__panel"
        role="tabpanel"
        id={`routing-tabpanel-${activeTab()}`}
        aria-labelledby={`routing-tab-${activeTab()}`}
      >
        <Show when={activeTab() === 'default'}>{props.children.default}</Show>
        <Show when={activeTab() === 'specificity' && showSpecificity()}>
          {props.children.specificity}
        </Show>
        <Show when={activeTab() === 'custom'}>{props.children.custom}</Show>
      </div>
    </div>
  );
};

export default RoutingTabs;
