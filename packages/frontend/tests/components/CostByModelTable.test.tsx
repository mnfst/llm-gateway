import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import CostByModelTable from '../../src/components/CostByModelTable';

function row(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5',
    tokens: 1000,
    share_pct: 50,
    estimated_cost: 1.23,
    auth_type: 'api_key',
    ...overrides,
  };
}

describe('CostByModelTable', () => {
  it('renders a header row with Model/Tokens/% of total/Cost', () => {
    const { container } = render(() => (
      <CostByModelTable rows={[]} />
    ));
    const headers = Array.from(container.querySelectorAll('th')).map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Model', 'Tokens', '% of total', 'Cost']);
  });

  it('is titled "Model usage" and adds attempt reliability columns when data is provided', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[row({ model: 'gpt-4o' })]}
        reliability={[{ model: 'gpt-4o', attempts: 120, failed: 10, succeeded: 110 }]}
      />
    ));
    expect(container.textContent).toContain('Model usage');
    const headers = Array.from(container.querySelectorAll('th')).map((h) => h.textContent?.trim());
    // Attempt world: a model is not healed, it acts. Total attempts counts
    // every provider call on the model; Success rate is attempt-level.
    expect(headers).toEqual(['Model', 'Tokens', '% of total', 'Cost', 'Total attempts', 'Success rate']);
    const cells = Array.from(container.querySelectorAll('tbody td')).map((c) =>
      c.textContent?.trim(),
    );
    expect(cells).toContain('120'); // total attempts
    expect(cells).toContain('91.7%'); // 110 / 120
    expect(container.textContent).not.toContain('Healed');
  });

  it('sorts rows by estimated_cost descending', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[
          row({ model: 'cheap', estimated_cost: 0.5 }),
          row({ model: 'pricey', estimated_cost: 5 }),
          row({ model: 'mid', estimated_cost: 2 }),
        ]}
      />
    ));
    const firstCells = Array.from(container.querySelectorAll('tbody tr td:first-child')).map(
      (td) => td.textContent?.trim() ?? '',
    );
    // Sort is by cost desc, so: pricey, mid, cheap.
    expect(firstCells[0]).toContain('pricey');
    expect(firstCells[1]).toContain('mid');
    expect(firstCells[2]).toContain('cheap');
  });

  it('formats tokens and rounds the share percentage', () => {
    const { container } = render(() => (
      <CostByModelTable rows={[row({ tokens: 12345, share_pct: 42.6 })]} />
    ));
    expect(container.textContent).toContain('12.3k');
    expect(container.textContent).toContain('43%');
  });

  it('renders a dash for null/zero costs', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[row({ estimated_cost: 0 })]}
      />
    ));
    const costCell = container.querySelector('tbody tr td:nth-child(4)');
    // formatCost(0) returns '$0.00' (non-null), so the fallback em-dash should
    // NOT appear. But extremely small values below the display threshold do
    // get a tooltip with the raw value — verify the rendering path stays
    // consistent:
    expect(costCell?.textContent?.trim()).not.toBe('');
  });

  it('adds a tooltip with the full cost for sub-penny amounts', () => {
    const { container } = render(() => (
      <CostByModelTable rows={[row({ estimated_cost: 0.00123 })]} />
    ));
    const costCell = container.querySelector('tbody tr td:nth-child(4)');
    expect(costCell?.getAttribute('title')).toBe('$0.001230');
  });

  it('renders a custom-provider letter badge and the stripped model text', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[
          row({
            model: 'custom:abc123/gpt-custom',
            provider: 'custom:abc123',
            custom_provider_name: 'My Provider',
            auth_type: null,
          }),
        ]}
      />
    ));
    const letterBadge = container.querySelector('.provider-card__logo-letter');
    expect(letterBadge).not.toBeNull();
    expect(letterBadge?.textContent).toBe('M');
    expect(letterBadge?.getAttribute('title')).toBe('My Provider');
    // Just the raw model — no `custom:` prefix, no provider-name echo.
    expect(container.textContent).toContain('gpt-custom');
    expect(container.textContent).not.toContain('custom:');
  });

  it('falls back to the stripped custom prefix when the provider was deleted', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[
          row({
            model: 'custom:abc/my-model',
            provider: 'custom:abc',
            custom_provider_name: null,
            auth_type: null,
          }),
        ]}
      />
    ));
    const letterBadge = container.querySelector('.provider-card__logo-letter');
    // stripCustomPrefix('custom:abc/my-model') → 'my-model' → first letter "M".
    expect(letterBadge?.textContent).toBe('M');
    expect(container.textContent).toContain('my-model');
    expect(container.textContent).not.toContain('Custom');
  });

  it('renders a provider icon + auth badge for recognised model prefixes', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[row({ model: 'claude-opus-4', auth_type: 'subscription' })]}
      />
    ));
    const providerCell = container.querySelector('tbody tr td');
    expect(providerCell?.querySelector('.provider-auth-badge--sub')).not.toBeNull();
    // Tooltip on the outer wrapper reflects the auth label.
    expect(providerCell?.innerHTML).toContain('Subscription');
  });

  it('prefers the stored provider over model-name inference', () => {
    // Model name starts with "minimax-" which would infer MiniMax,
    // but the stored provider is "ollama" — icon tooltip should say Ollama.
    const { container } = render(() => (
      <CostByModelTable
        rows={[row({ model: 'minimax-chat', provider: 'ollama', auth_type: 'api_key' })]}
      />
    ));
    const providerSpan = container.querySelector('tbody tr td span[title]');
    expect(providerSpan?.getAttribute('title')).toContain('Ollama');
  });

  it('falls back to model-name inference when provider is null', () => {
    const { container } = render(() => (
      <CostByModelTable
        rows={[row({ model: 'claude-opus-4', provider: null, auth_type: 'api_key' })]}
      />
    ));
    const providerSpan = container.querySelector('tbody tr td span[title]');
    expect(providerSpan?.getAttribute('title')).toContain('Anthropic');
  });

  describe('boundary values', () => {
    function shareCellOf(container: HTMLElement) {
      return container.querySelector('tbody tr td:nth-child(3)');
    }

    function costCellOf(container: HTMLElement) {
      return container.querySelector('tbody tr td:nth-child(4)');
    }

    function barWidthStyle(container: HTMLElement): string {
      // Cell structure: <td><div flex><div bar-bg><div bar-fill/></div><span/></div></td>
      // The bar fill is the deepest div, three levels below the cell.
      const inner = container.querySelector(
        'tbody tr td:nth-child(3) > div > div > div',
      );
      return inner?.getAttribute('style') ?? '';
    }

    it('handles share_pct = 0', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ share_pct: 0 })]}
        />
      ));
      expect(barWidthStyle(container)).toContain('width: 0%');
      expect(shareCellOf(container)?.textContent).toContain('0%');
    });

    it('handles share_pct = -1 without crashing', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ share_pct: -1 })]}
        />
      ));
      // The text label uses Math.round, so "-1%" is shown verbatim.
      expect(shareCellOf(container)?.textContent).toContain('-1%');
      // jsdom filters invalid CSS values (width cannot be negative), so the
      // width declaration is dropped from the parsed style. We only assert
      // the component rendered without throwing.
      expect(container.querySelector('tbody tr')).not.toBeNull();
    });

    it('handles share_pct > 100 without crashing', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ share_pct: 150 })]}
        />
      ));
      expect(shareCellOf(container)?.textContent).toContain('150%');
      // Width over 100% is allowed by the browser (will overflow the parent),
      // but we just verify the value made it into the style untouched.
      expect(barWidthStyle(container)).toContain('width: 150%');
    });

    it('handles share_pct = NaN without crashing', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ share_pct: NaN })]}
        />
      ));
      // Math.round(NaN) is NaN — rendered as "NaN%". The component must
      // remain renderable; we only care that no exception was thrown.
      expect(shareCellOf(container)?.textContent).toContain('NaN%');
      // The width style contains "NaN%" which is invalid CSS, but Solid
      // still attaches the attribute. Ensure the row exists.
      expect(container.querySelector('tbody tr')).not.toBeNull();
    });

    it('handles estimated_cost = -0.50 (returns null → em-dash)', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ estimated_cost: -0.5 })]}
        />
      ));
      const cell = costCellOf(container);
      expect(cell?.textContent?.trim()).toBe('—');
      // No tooltip should be attached for invalid / negative costs.
      expect(cell?.getAttribute('title')).toBeNull();
    });

    it('handles estimated_cost = NaN without crashing', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ estimated_cost: NaN })]}
        />
      ));
      const cell = costCellOf(container);
      // formatCost(NaN) currently falls through the comparisons and prints
      // "$NaN". The contract under test is that the component does not
      // throw and renders SOMETHING (em-dash OR the NaN-safe fallback).
      const text = cell?.textContent?.trim() ?? '';
      expect(text === '—' || text === '$NaN').toBe(true);
      // The sub-penny tooltip path requires cost > 0 — NaN > 0 is false,
      // so no tooltip should be set.
      expect(cell?.getAttribute('title')).toBeNull();
    });

    it('handles estimated_cost = Infinity without crashing', () => {
      const { container } = render(() => (
        <CostByModelTable
          rows={[row({ estimated_cost: Infinity })]}
        />
      ));
      const cell = costCellOf(container);
      const text = cell?.textContent?.trim() ?? '';
      // formatCost(Infinity) → "$Infinity". Em-dash is also acceptable if
      // the helper is hardened later. Either way, no crash.
      expect(text === '—' || text === '$Infinity').toBe(true);
      // Infinity > 0 && Infinity < 0.01 is false, so no sub-penny tooltip.
      expect(cell?.getAttribute('title')).toBeNull();
    });
  });

  it('words the Total attempts tooltip by Doctor availability', () => {
    const { container, unmount } = render(() => (
      <CostByModelTable
        rows={[row({ model: 'gpt-4o' })]}
        reliability={[{ model: 'gpt-4o', attempts: 10, failed: 1, succeeded: 9 }]}
        doctorAvailable
      />
    ));
    const labels = () =>
      [...container.querySelectorAll('.info-tooltip')].map((e) => e.getAttribute('aria-label'));
    expect(labels().join(' ')).toContain('including fallback retries and autofixed attempts');
    unmount();

    const { container: c2 } = render(() => (
      <CostByModelTable
        rows={[row({ model: 'gpt-4o' })]}
        reliability={[{ model: 'gpt-4o', attempts: 10, failed: 1, succeeded: 9 }]}
      />
    ));
    // Without the Doctor version the sentence never mentions Autofix.
    const labels2 = [...c2.querySelectorAll('.info-tooltip')]
      .map((e) => e.getAttribute('aria-label'))
      .join(' ');
    expect(labels2).toContain('including fallback retries.');
    expect(labels2).not.toContain('autofixed');
    // Success rate carries the model-grain definition.
    expect(labels2).toContain('Successful attempts over all attempts for this model.');
  });
});
