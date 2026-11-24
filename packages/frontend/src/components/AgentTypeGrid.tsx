import { For, Show, type Component } from 'solid-js';
import {
  type AgentCategory,
  type AgentPlatform,
  AGENT_CATEGORIES,
  CATEGORY_LABELS,
  PLATFORM_LABELS,
  PLATFORMS_BY_CATEGORY,
  PLATFORM_ICONS,
} from 'manifest-shared';

interface Props {
  category: AgentCategory | null;
  platform: AgentPlatform | null;
  onCategoryChange: (c: AgentCategory) => void;
  onPlatformChange: (p: AgentPlatform) => void;
  disabled?: boolean;
  inline?: boolean;
}

const iconFor = (plat: AgentPlatform, cat: AgentCategory): string | undefined => {
  if (plat === 'other') return cat === 'personal' ? '/icons/other-agent.svg' : '/icons/other.svg';
  return PLATFORM_ICONS[plat];
};

const AgentTypeGrid: Component<Props> = (props) => {
  const handleSelect = (cat: AgentCategory, plat: AgentPlatform) => {
    props.onCategoryChange(cat);
    props.onPlatformChange(plat);
  };

  return (
    <div
      class="agent-type-select__dropdown"
      classList={{ 'agent-type-select__dropdown--inline': props.inline !== false }}
      role="listbox"
    >
      <div class="agent-type-select__groups">
        <For each={[...AGENT_CATEGORIES]}>
          {(cat) => (
            <div class="agent-type-select__column">
              <div class="agent-type-select__group-label" role="presentation">
                {CATEGORY_LABELS[cat]}
              </div>
              <For each={[...PLATFORMS_BY_CATEGORY[cat]]}>
                {(plat) => {
                  const isSelected = () => props.category === cat && props.platform === plat;
                  const icon = iconFor(plat, cat);
                  return (
                    <button
                      class="agent-type-select__option"
                      classList={{ 'agent-type-select__option--selected': isSelected() }}
                      onClick={() => handleSelect(cat, plat)}
                      type="button"
                      role="option"
                      aria-selected={isSelected()}
                      disabled={props.disabled}
                    >
                      <Show when={icon}>
                        <img
                          src={icon}
                          alt=""
                          width="18"
                          height="18"
                          class="agent-type-select__option-icon"
                        />
                      </Show>
                      <span>{PLATFORM_LABELS[plat]}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export default AgentTypeGrid;
