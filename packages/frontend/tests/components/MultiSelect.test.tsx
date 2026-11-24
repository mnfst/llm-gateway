import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import MultiSelect from '../../src/components/MultiSelect';

const OPTIONS = [
  {
    label: 'Anthropic',
    value: 'anthropic',
    description: 'Claude models',
    icon: <span data-testid="anthropic-icon">A</span>,
  },
  { label: 'OpenAI', value: 'openai' },
];

function renderMultiSelect(initialValues: string[] = [], label?: string) {
  const [values, setValues] = createSignal(initialValues);
  const onChange = vi.fn((next: string[]) => setValues(next));
  const result = render(() => (
    <MultiSelect
      options={OPTIONS}
      values={values()}
      onChange={onChange}
      placeholder="All providers"
      label={label}
    />
  ));

  return { ...result, onChange };
}

async function openDropdown(name: string | RegExp = 'All providers') {
  await fireEvent.click(screen.getByRole('button', { name }));
}

describe('MultiSelect', () => {
  it('opens with the empty selection, option metadata, and optional accessible label', async () => {
    renderMultiSelect([], 'Provider filter');

    const trigger = screen.getByRole('button', { name: 'Provider filter' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('All providers')).toBeDefined();

    await openDropdown('Provider filter');

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    expect(screen.getByTestId('anthropic-icon')).toBeDefined();
    expect(screen.getByText('Claude models')).toBeDefined();
    expect(
      screen.getByRole('option', { name: 'All providers' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('adds and removes values while keeping the dropdown open', async () => {
    const { onChange } = renderMultiSelect();
    await openDropdown();

    await fireEvent.click(screen.getByRole('option', { name: /Anthropic/ }));
    expect(onChange).toHaveBeenLastCalledWith(['anthropic']);
    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeDefined();
    expect(screen.getByRole('listbox')).toBeDefined();

    await fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }));
    expect(onChange).toHaveBeenLastCalledWith(['anthropic', 'openai']);
    expect(screen.getByText('2 selected')).toBeDefined();

    await fireEvent.click(screen.getByRole('option', { name: /Anthropic/ }));
    expect(onChange).toHaveBeenLastCalledWith(['openai']);
    expect(screen.getByRole('button', { name: 'OpenAI' })).toBeDefined();
  });

  it('clears the selection from the all option', async () => {
    const { onChange } = renderMultiSelect(['anthropic']);
    await openDropdown('Anthropic');

    await fireEvent.click(screen.getByRole('option', { name: 'All providers' }));

    expect(onChange).toHaveBeenLastCalledWith([]);
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: 'All providers' }).getAttribute('aria-selected'),
      ).toBe('true'),
    );
  });

  it('falls back to the placeholder for an unknown selected value', () => {
    renderMultiSelect(['missing']);
    expect(screen.getByText('All providers')).toBeDefined();
  });

  it('closes on outside click and Escape, but not on an option click', async () => {
    renderMultiSelect();
    await openDropdown();
    await fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }));
    expect(screen.getByRole('listbox')).toBeDefined();

    await fireEvent.click(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();

    await openDropdown('OpenAI');
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('removes its document listeners on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderMultiSelect();
    unmount();

    const removedEvents = removeSpy.mock.calls.map(([event]) => event);
    expect(removedEvents).toContain('click');
    expect(removedEvents).toContain('keydown');
    removeSpy.mockRestore();
  });
});

describe('MultiSelect with options derived from the selection', () => {
  // The Requests log builds its model options from the selection itself (so a
  // picked model stays listed even when it drops out of the range window).
  // Toggling then rebuilds the option nodes, and the clicked node is already
  // detached when the document-level outside-click handler runs — contains()
  // says false and the menu used to close after a single pick.
  function renderSelfDerivedMultiSelect() {
    const [values, setValues] = createSignal<string[]>([]);
    const options = () =>
      [...new Set(['gpt-4o', 'claude-sonnet-4', ...values()])].sort().map((value) => ({
        label: value,
        value,
      }));
    return render(() => (
      <MultiSelect
        options={options()}
        values={values()}
        onChange={setValues}
        placeholder="All models"
        label="Model filter"
      />
    ));
  }

  it('stays open after picking an option when the options rebuild', async () => {
    renderSelfDerivedMultiSelect();
    await fireEvent.click(screen.getByRole('button', { name: 'Model filter' }));
    expect(screen.getByRole('listbox')).toBeDefined();

    await fireEvent.click(screen.getByRole('option', { name: /gpt-4o/ }));

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /gpt-4o/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('closes when an outside element removes itself on click', async () => {
    // The detached-node guard must not swallow this: the click came from
    // outside, it merely left no node behind to ask `contains` about.
    const [present, setPresent] = createSignal(true);
    render(() => (
      <Show when={present()}>
        <button data-testid="self-removing" onClick={() => setPresent(false)}>
          dismiss
        </button>
      </Show>
    ));
    renderSelfDerivedMultiSelect();
    await fireEvent.click(screen.getByRole('button', { name: 'Model filter' }));
    expect(screen.getByRole('listbox')).toBeDefined();

    await fireEvent.click(screen.getByTestId('self-removing'));

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('still closes on a click outside the dropdown', async () => {
    renderSelfDerivedMultiSelect();
    await fireEvent.click(screen.getByRole('button', { name: 'Model filter' }));
    expect(screen.getByRole('listbox')).toBeDefined();

    await fireEvent.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });
});
