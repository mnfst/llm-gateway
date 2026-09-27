import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import RoutingTabs from '../../src/components/RoutingTabs';

function renderTabs(
  overrides: Partial<{
    specificityEnabled: boolean;
    customEnabled: boolean;
  }> = {},
) {
  return render(() => (
    <RoutingTabs
      specificityEnabled={() => overrides.specificityEnabled ?? false}
      customEnabled={() => overrides.customEnabled ?? false}
    >
      {{
        default: <div data-testid="default-content">Default content</div>,
        specificity: <div data-testid="specificity-content">Specificity content</div>,
        custom: <div data-testid="custom-content">Custom content</div>,
      }}
    </RoutingTabs>
  ));
}

describe('RoutingTabs', () => {
  it('renders all three tab labels', () => {
    renderTabs();
    expect(screen.getByRole('tab', { name: /Default/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Task-specific/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Custom/ })).toBeDefined();
  });

  it('renders tablist with aria-label', () => {
    renderTabs();
    expect(screen.getByRole('tablist', { name: 'Routing layers' })).toBeDefined();
  });

  it('hides the Task-specific tab when showSpecificity returns false', () => {
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        showSpecificity={() => false}
      >
        {{
          default: <div data-testid="default-content">Default content</div>,
          specificity: <div data-testid="specificity-content">Specificity content</div>,
          custom: <div data-testid="custom-content">Custom content</div>,
        }}
      </RoutingTabs>
    ));
    expect(screen.queryByRole('tab', { name: /Task-specific/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /Default/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Custom/ })).toBeDefined();
  });

  it('renders only two dots (Default + Custom) when Task-specific is hidden', () => {
    const { container } = render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => true}
        showSpecificity={() => false}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    const dots = container.querySelectorAll('.routing-tabs__dot');
    expect(dots.length).toBe(2);
  });

  it('keeps the Task-specific tab when showSpecificity returns true', () => {
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        showSpecificity={() => true}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    expect(screen.getByRole('tab', { name: /Task-specific/ })).toBeDefined();
  });

  it('shows default content by default', () => {
    renderTabs();
    expect(screen.getByTestId('default-content')).toBeDefined();
    expect(screen.queryByTestId('specificity-content')).toBeNull();
    expect(screen.queryByTestId('custom-content')).toBeNull();
  });

  it('switches to specificity tab on click', () => {
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Task-specific/ }));
    expect(screen.queryByTestId('default-content')).toBeNull();
    expect(screen.getByTestId('specificity-content')).toBeDefined();
  });

  it('switches to custom tab on click', () => {
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Custom/ }));
    expect(screen.queryByTestId('default-content')).toBeNull();
    expect(screen.getByTestId('custom-content')).toBeDefined();
  });

  it('marks the active tab with aria-selected=true', () => {
    renderTabs();
    const defaultTab = screen.getByRole('tab', { name: /Default/ });
    expect(defaultTab.getAttribute('aria-selected')).toBe('true');

    const specificityTab = screen.getByRole('tab', { name: /Task-specific/ });
    expect(specificityTab.getAttribute('aria-selected')).toBe('false');
  });

  it('updates aria-selected on tab switch', () => {
    renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: /Task-specific/ }));

    expect(screen.getByRole('tab', { name: /Default/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: /Task-specific/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('renders tabpanel with correct role', () => {
    renderTabs();
    expect(screen.getByRole('tabpanel')).toBeDefined();
  });

  it('shows green dot for enabled layers and gray for disabled', () => {
    const { container } = renderTabs({ specificityEnabled: false, customEnabled: true });
    const dots = container.querySelectorAll('.routing-tabs__dot');
    // Default (always on), specificity (off), custom (on)
    expect(dots[0].classList.contains('routing-tabs__dot--on')).toBe(true);
    expect(dots[1].classList.contains('routing-tabs__dot--off')).toBe(true);
    expect(dots[2].classList.contains('routing-tabs__dot--on')).toBe(true);
  });

  it('Default tab always has a green dot; specificity and custom are off by default', () => {
    const { container } = renderTabs();
    const dots = container.querySelectorAll('.routing-tabs__dot');
    expect(dots.length).toBe(3);
    // Default dot is always on
    expect(dots[0].classList.contains('routing-tabs__dot--on')).toBe(true);
    // Specificity and Custom are off by default
    expect(dots[1].classList.contains('routing-tabs__dot--off')).toBe(true);
    expect(dots[2].classList.contains('routing-tabs__dot--off')).toBe(true);
  });

  it('applies active class to selected tab', () => {
    const { container } = renderTabs();
    const tabs = container.querySelectorAll('.panel__tab');
    expect(tabs[0].classList.contains('panel__tab--active')).toBe(true);
    expect(tabs[1].classList.contains('panel__tab--active')).toBe(false);
  });

  /* ---- Pipeline help modal ---- */

  it('accepts pipelineHelp prop without rendering help button or modal', () => {
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        pipelineHelp={() => <div data-testid="help-content">Help text</div>}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    // Help button and modal are now managed by the parent (Routing.tsx)
    expect(screen.queryByLabelText('How routing works')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not show help button when pipelineHelp returns null', () => {
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        pipelineHelp={() => null}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    expect(screen.queryByLabelText('How routing works')).toBeNull();
  });

  it('renders headerRight slot when provided', () => {
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        headerRight={<div data-testid="header-right-content">Right content</div>}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    expect(screen.getByTestId('header-right-content')).toBeDefined();
  });

  it('does not render headerRight wrapper when no slot is provided', () => {
    const { container } = render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    expect(container.querySelector('.routing-tabs__header-right')).toBeNull();
  });

  it('accepts onShowHelp prop for parent-managed help modal', () => {
    const onShowHelp = vi.fn();
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        onShowHelp={onShowHelp}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    // The component accepts the prop but does not render a help button itself
    expect(screen.queryByLabelText('How routing works')).toBeNull();
  });

  it('does not render a help modal internally even with pipelineHelp', () => {
    render(() => (
      <RoutingTabs
        specificityEnabled={() => false}
        customEnabled={() => false}
        pipelineHelp={() => <div>Help</div>}
      >
        {{
          default: <div>Default</div>,
          specificity: <div>Specificity</div>,
          custom: <div>Custom</div>,
        }}
      </RoutingTabs>
    ));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
