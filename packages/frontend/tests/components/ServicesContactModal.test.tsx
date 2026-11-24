import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

const sendServicesContact = vi.fn();
vi.mock('../../src/services/api/services-contact.js', () => ({
  sendServicesContact: (...args: unknown[]) => sendServicesContact(...args),
}));

import ServicesContactModal, { SERVICES_OFFER } from '../../src/components/ServicesContactModal';

const renderOpen = (onClose = vi.fn()) =>
  render(() => (
    <ServicesContactModal
      open={true}
      defaultName="Ada Lovelace"
      defaultEmail="ada@example.com"
      onClose={onClose}
    />
  ));

const typeMessage = (container: HTMLElement, value: string) =>
  fireEvent.input(container.querySelector('#services-message')!, { target: { value } });

describe('ServicesContactModal', () => {
  beforeEach(() => {
    sendServicesContact.mockReset();
  });

  it('does not render when closed', () => {
    const { container } = render(() => <ServicesContactModal open={false} onClose={vi.fn()} />);
    expect(container.querySelector('.services-modal')).toBeNull();
  });

  it('lists every service and prefills the name and email', () => {
    const { container } = renderOpen();
    expect(container.querySelectorAll('.services-modal__list li').length).toBe(
      SERVICES_OFFER.length,
    );
    expect(container.querySelector('.modal-card__desc')!.textContent).toContain('For example:');
    expect((container.querySelector('#services-name') as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    );
    expect((container.querySelector('#services-email') as HTMLInputElement).value).toBe(
      'ada@example.com',
    );
  });

  it('does not send without a message', () => {
    const { container, getByText } = renderOpen();
    fireEvent.click(getByText('Send'));
    expect(sendServicesContact).not.toHaveBeenCalled();
    expect(container.querySelector('#services-message')!.classList).toContain(
      'modal-card__input--error',
    );
  });

  it('sends the form and shows the thank-you message', async () => {
    sendServicesContact.mockResolvedValue({ ok: true });
    const { container, getByText, findByRole } = renderOpen();
    fireEvent.input(container.querySelector('#services-company')!, { target: { value: 'Acme' } });
    typeMessage(container, 'We need custom guardrails.');
    fireEvent.click(getByText('Send'));
    await waitFor(() => expect(sendServicesContact).toHaveBeenCalledTimes(1));
    expect(sendServicesContact).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: undefined,
      company: 'Acme',
      message: 'We need custom guardrails.',
    });
    expect((await findByRole('status')).textContent).toContain(
      'The Manifest team will reply by email.',
    );
  });

  it('shows the email address when sending fails', async () => {
    sendServicesContact.mockRejectedValue(new Error('down'));
    const { container, getByText, findByRole } = renderOpen();
    typeMessage(container, 'Hello');
    fireEvent.click(getByText('Send'));
    expect((await findByRole('alert')).textContent).toContain('Please try again in a moment.');
  });

  it('closes on Cancel', () => {
    const onClose = vi.fn();
    const { getByText } = renderOpen(onClose);
    fireEvent.click(getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
