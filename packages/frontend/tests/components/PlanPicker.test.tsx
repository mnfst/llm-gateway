import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import PlanPicker from '../../src/components/PlanPicker';
import { FREE_REQUEST_LIMIT_LABEL } from '../../src/services/billing-display';

describe('PlanPicker', () => {
  it('renders the Pro plan expanded by default and submits it', () => {
    const onSelect = vi.fn();
    const { container } = render(() => <PlanPicker proPrice="$20" onSelect={onSelect} />);

    expect(screen.getByText('Popular')).toBeDefined();
    expect(screen.getByText('$20')).toBeDefined();
    expect(screen.getAllByText('/month').length).toBeGreaterThan(0);
    expect(screen.getByText('Unlimited routed requests')).toBeDefined();

    fireEvent.click(container.querySelector('.plan-picker__cta')!);

    expect(onSelect).toHaveBeenCalledWith('pro');
  });

  it('expands the Free plan with usage and submits it', () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <PlanPicker proPrice="$20" usedRequests={1234} onSelect={onSelect} />
    ));

    const cards = container.querySelectorAll<HTMLButtonElement>('.plan-picker__card');
    fireEvent.click(cards[0]);

    expect(screen.getByText('1,234 used this month')).toBeDefined();
    expect(screen.getByText(`${FREE_REQUEST_LIMIT_LABEL} routed requests / month`)).toBeDefined();
    expect(screen.getByText('Community support via Discord')).toBeDefined();

    fireEvent.click(container.querySelector('.plan-picker__cta')!);

    expect(onSelect).toHaveBeenCalledWith('free');
  });

  it('collapses the selected plan when it is clicked again', () => {
    const { container } = render(() => <PlanPicker proPrice="$20" onSelect={vi.fn()} />);
    const proCard = container.querySelectorAll<HTMLButtonElement>('.plan-picker__card')[1];

    fireEvent.click(proCard);

    expect(container.querySelector('.plan-picker__cta')).toBeNull();
  });

  it('renders enterprise details and the sales link', () => {
    const { container } = render(() => <PlanPicker proPrice={null} onSelect={vi.fn()} />);
    const enterpriseCard = container.querySelectorAll<HTMLButtonElement>('.plan-picker__card')[2];

    fireEvent.click(enterpriseCard);

    expect(screen.getByText('Custom')).toBeDefined();
    expect(screen.getByText('SSO / SAML')).toBeDefined();
    const link = container.querySelector('.plan-picker__cta') as HTMLAnchorElement;
    expect(link.textContent).toBe('Talk to sales');
    expect(link.getAttribute('href')).toBe('https://manifest.build/pricing');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('falls back to a Pro label and disables the CTA while busy', () => {
    const { container } = render(() => <PlanPicker proPrice={null} busy onSelect={vi.fn()} />);
    const cta = container.querySelector('.plan-picker__cta') as HTMLButtonElement;

    expect(screen.getAllByText('Pro').length).toBeGreaterThan(0);
    expect(cta.disabled).toBe(true);
    expect(cta.querySelector('.spinner')).not.toBeNull();
  });
});
