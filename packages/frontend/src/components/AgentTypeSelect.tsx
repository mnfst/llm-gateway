import { createSignal, Show, onCleanup, type Component } from 'solid-js';
import {
  type AgentCategory,
  type AgentPlatform,
  PLATFORM_LABELS,
  PLATFORM_ICONS,
} from 'manifest-shared';
import AgentTypeGrid from './AgentTypeGrid.jsx';

interface Props {
  category: AgentCategory | null;
  platform: AgentPlatform | null;
  onCategoryChange: (c: AgentCategory) => void;
  onPlatformChange: (p: AgentPlatform) => void;
  disabled?: boolean;
}

const iconFor = (plat: AgentPlatform, cat: AgentCategory): string | undefined => {
  if (plat === 'other') return cat === 'personal' ? '/icons/other-agent.svg' : '/icons/other.svg';
  return PLATFORM_ICONS[plat];
};

const AgentTypeSelect: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  let ref: HTMLDivElement | undefined;

  const selectedIcon = () => {
    const plat = props.platform;
    const cat = props.category;
    if (!plat || !cat) return '/icons/other.svg';
    return iconFor(plat, cat);
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (ref && !ref.contains(e.target as Node)) setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    });
  }

  return (
    <div class="agent-type-select" ref={ref}>
      <button
        class="agent-type-select__trigger"
        classList={{ 'agent-type-select__trigger--open': open() }}
        onClick={() => setOpen(!open())}
        type="button"
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={`Harness type: ${props.platform ? PLATFORM_LABELS[props.platform] : 'Select'}`}
      >
        <Show when={selectedIcon()}>
          <img
            src={selectedIcon()}
            alt=""
            width="24"
            height="24"
            class="agent-type-select__trigger-icon"
          />
        </Show>
        <span class="agent-type-select__trigger-label">
          {props.platform ? PLATFORM_LABELS[props.platform] : 'Select'}
        </span>
        <svg
          class="agent-type-select__caret"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M15.69 8H8.3c-1.29 0-1.98 1.52-1.13 2.49l3.69 4.22c.6.68 1.66.68 2.26 0l3.69-4.22c.85-.97.16-2.49-1.13-2.49Z" />
        </svg>
      </button>
      <Show when={open()}>
        <AgentTypeGrid
          inline={false}
          category={props.category}
          platform={props.platform}
          onCategoryChange={props.onCategoryChange}
          onPlatformChange={(platform) => {
            props.onPlatformChange(platform);
            setOpen(false);
          }}
          disabled={props.disabled}
        />
      </Show>
    </div>
  );
};

export default AgentTypeSelect;
