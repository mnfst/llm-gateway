import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import UpgradeSuccessModal from '../../src/components/UpgradeSuccessModal';

describe('UpgradeSuccessModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(() => <UpgradeSuccessModal open={false} onClose={vi.fn()} />);

    expect(container.textContent).toBe('');
    expect(document.body.querySelector('.upgrade-success-modal')).toBeNull();
  });

  it('renders Pro benefits and closes from the backdrop, Escape, or done button', () => {
    const onClose = vi.fn();
    render(() => <UpgradeSuccessModal open onClose={onClose} />);

    expect(screen.getByText("You're now on the Pro plan")).toBeDefined();
    expect(screen.getByText('Unlimited routed requests')).toBeDefined();
    expect(screen.getByText('365 days dashboard retention')).toBeDefined();

    const dialog = screen.getByRole('dialog', { name: 'Upgrade successful' });
    const backdrop = document.body.querySelector('.modal-backdrop') as HTMLElement;

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(backdrop, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
