import { createSignal, For, Show, onCleanup, type Component, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

export interface SelectOption {
  label: string;
  value: string;
  /** Optional icon rendered before the label (e.g. provider logo, platform icon). */
  icon?: JSX.Element;
  disabled?: boolean;
  description?: string;
  /** Optional badge rendered after the label (e.g. "PRO" tag). */
  badge?: JSX.Element;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  displayValue?: string;
  disabled?: boolean;
  portal?: boolean;
  maxDropdownHeight?: number;
  ariaDescribedBy?: string;
}

const Select: Component<SelectProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [dropdownStyle, setDropdownStyle] = createSignal('');
  let ref: HTMLDivElement | undefined;
  let dropdownRef: HTMLDivElement | undefined;

  const updateDropdownPosition = () => {
    if (!props.portal || !ref || typeof window === 'undefined') return;

    const gap = 4;
    const viewportMargin = 8;
    const minHeight = 96;
    const maxHeight = props.maxDropdownHeight ?? 320;
    const rect = ref.getBoundingClientRect();
    const availableBelow = window.innerHeight - rect.bottom - gap - viewportMargin;
    const availableAbove = rect.top - gap - viewportMargin;
    const opensAbove = availableBelow < minHeight && availableAbove > availableBelow;
    const availableHeight = opensAbove ? availableAbove : availableBelow;
    const constrainedLeft = Math.min(
      Math.max(rect.left, viewportMargin),
      Math.max(viewportMargin, window.innerWidth - rect.width - viewportMargin),
    );

    setDropdownStyle(
      [
        `left: ${constrainedLeft}px`,
        `top: ${opensAbove ? rect.top - gap : rect.bottom + gap}px`,
        `width: ${rect.width}px`,
        `max-height: ${Math.max(minHeight, Math.min(maxHeight, availableHeight))}px`,
        `transform: ${opensAbove ? 'translateY(-100%)' : 'none'}`,
      ].join('; '),
    );
  };

  const openDropdown = () => {
    updateDropdownPosition();
    setOpen(true);
    if (props.portal && typeof window !== 'undefined') {
      window.requestAnimationFrame?.(updateDropdownPosition);
    }
  };

  const selected = () => props.options.find((o) => o.value === props.value);
  const selectedLabel = () => selected()?.label ?? props.placeholder ?? 'Select...';

  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (ref && !ref.contains(target) && !dropdownRef?.contains(target)) {
      setOpen(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  const handleViewportChange = () => {
    if (open()) updateDropdownPosition();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    onCleanup(() => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    });
  }

  const dropdown = () => (
    <div
      class="custom-select__dropdown"
      classList={{ 'custom-select__dropdown--portal': props.portal }}
      ref={dropdownRef}
      role="listbox"
      style={props.portal ? dropdownStyle() : undefined}
    >
      <For each={props.options}>
        {(opt) => (
          <button
            class="custom-select__option"
            classList={{
              'custom-select__option--selected': props.value === opt.value,
              'custom-select__option--disabled': opt.disabled,
            }}
            onClick={() => {
              if (opt.disabled) return;
              props.onChange(opt.value);
              setOpen(false);
            }}
            disabled={opt.disabled}
            type="button"
            role="option"
            aria-selected={props.value === opt.value}
            aria-disabled={opt.disabled}
            style="display: flex; align-items: center; gap: 6px;"
          >
            <Show when={opt.icon}>{opt.icon}</Show>
            <span class="custom-select__option-text">
              <span>{opt.label}</span>
              <Show when={opt.description}>
                <span class="custom-select__option-desc">{opt.description}</span>
              </Show>
            </span>
            <Show when={opt.badge}>{opt.badge}</Show>
          </button>
        )}
      </For>
    </div>
  );

  return (
    <div class="custom-select" ref={ref}>
      <button
        class="custom-select__trigger"
        classList={{ 'custom-select__trigger--open': open() }}
        onClick={() => {
          if (props.disabled) return;
          if (open()) setOpen(false);
          else openDropdown();
        }}
        disabled={props.disabled}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.label ?? selectedLabel()}
        aria-describedby={props.ariaDescribedBy}
      >
        <span
          class="custom-select__value"
          style="display: inline-flex; align-items: center; gap: 6px;"
        >
          <Show when={!props.displayValue && selected()?.icon}>{selected()!.icon}</Show>
          {props.displayValue ?? selectedLabel()}
        </span>
        <svg
          class="custom-select__chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <Show when={open()}>{props.portal ? <Portal>{dropdown()}</Portal> : dropdown()}</Show>
    </div>
  );
};

export default Select;
