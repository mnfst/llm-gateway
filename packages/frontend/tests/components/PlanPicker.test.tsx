import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import PlanPicker, { FALLBACK_PRO_PRICE, proFeatures } from '../../src/components/PlanPicker';

describe('PlanPicker', () => {
  it('shows the Manifest Cloud plan alone and subscribes', () => {
    const onSubscribe = vi.fn();
    const { container } = render(() => <PlanPicker proPrice="$20" onSubscribe={onSubscribe} />);

    expect(container.querySelectorAll('.plan-picker__card')).toHaveLength(1);
    expect(screen.getByText('Manifest Cloud')).toBeDefined();
    expect(screen.getByText('$20')).toBeDefined();
    expect(screen.getByText('/month')).toBeDefined();
    for (const feature of proFeatures) expect(screen.getByText(feature)).toBeDefined();
    expect(screen.queryByText('Self-hosted')).toBeNull();
    expect(screen.queryByText('Talk to sales')).toBeNull();

    const cta = container.querySelector('.plan-picker__cta') as HTMLButtonElement;
    expect(cta.textContent).toBe('Subscribe');
    fireEvent.click(cta);

    expect(onSubscribe).toHaveBeenCalledTimes(1);
  });

  it('falls back to the $19 price and disables the CTA while busy', () => {
    const { container } = render(() => <PlanPicker proPrice={null} busy onSubscribe={vi.fn()} />);
    const cta = container.querySelector('.plan-picker__cta') as HTMLButtonElement;

    expect(screen.getByText(FALLBACK_PRO_PRICE)).toBeDefined();
    expect(cta.disabled).toBe(true);
    expect(cta.querySelector('.spinner')).not.toBeNull();
  });
});
