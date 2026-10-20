import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import PlanPicker, { FALLBACK_PRO_PRICE } from '../../src/components/PlanPicker';

describe('PlanPicker', () => {
  it('renders the Pro plan expanded by default and submits it', () => {
    const onSelect = vi.fn();
    const { container } = render(() => <PlanPicker proPrice="$20" onSelect={onSelect} />);

    expect(screen.getByText('Popular')).toBeDefined();
    expect(screen.getByText('$20')).toBeDefined();
    expect(screen.getAllByText('/month').length).toBeGreaterThan(0);
    expect(screen.getByText('Manifest Cloud')).toBeDefined();
    expect(screen.getByText('Servers, database and uptime handled by us')).toBeDefined();
    expect(screen.queryByText('Read the self-hosting guide')).toBeNull();

    const cta = container.querySelector('.plan-picker__cta') as HTMLButtonElement;
    expect(cta.textContent).toBe('Subscribe');
    fireEvent.click(cta);

    expect(onSelect).toHaveBeenCalledWith('pro');
  });

  it('expands the Self-hosted plan with usage and submits it', () => {
    const onSelect = vi.fn();
    const { container } = render(() => (
      <PlanPicker proPrice="$20" usedRequests={1234} onSelect={onSelect} />
    ));

    const cards = container.querySelectorAll<HTMLButtonElement>('.plan-picker__card');
    fireEvent.click(cards[0]);

    expect(screen.getByText('1,234 used this month')).toBeDefined();
    expect(screen.getByText('Self-hosted')).toBeDefined();
    expect(screen.getByText('forever')).toBeDefined();
    expect(screen.getByText('Your data stays on your machine')).toBeDefined();
    expect(screen.getByText('Community support via Discord')).toBeDefined();
    const guide = screen.getByText('Read the self-hosting guide') as HTMLAnchorElement;
    expect(guide.getAttribute('href')).toBe('https://manifest.build/llm-gateway/docs/self-hosted');

    const cta = container.querySelector('.plan-picker__cta') as HTMLButtonElement;
    expect(cta.textContent).toBe('Continue without a subscription');
    fireEvent.click(cta);

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

  it('falls back to the $19 price and disables the CTA while busy', () => {
    const { container } = render(() => <PlanPicker proPrice={null} busy onSelect={vi.fn()} />);
    const cta = container.querySelector('.plan-picker__cta') as HTMLButtonElement;

    expect(screen.getByText(FALLBACK_PRO_PRICE)).toBeDefined();
    expect(screen.queryByText('Pro')).toBeNull();
    expect(cta.disabled).toBe(true);
    expect(cta.querySelector('.spinner')).not.toBeNull();
  });
});
