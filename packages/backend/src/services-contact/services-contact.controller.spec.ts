import { BadGatewayException } from '@nestjs/common';

const fetchMock = jest.fn();
(global as unknown as Record<string, unknown>).fetch = fetchMock;

const selfHosted = jest.fn(() => false);
jest.mock('../common/utils/detect-self-hosted', () => ({ isSelfHosted: () => selfHosted() }));

import { SERVICES_CONTACT_URL, ServicesContactController } from './services-contact.controller';

const dto = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+33 6 00 00 00 00',
  company: 'Acme',
  message: 'We need custom guardrails.',
};

describe('ServicesContactController', () => {
  let controller: ServicesContactController;

  beforeEach(() => {
    fetchMock.mockReset();
    selfHosted.mockReturnValue(false);
    controller = new ServicesContactController();
  });

  it('relays the form to manifest.build with the cloud source', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(controller.contact(dto)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SERVICES_CONTACT_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ ...dto, source: 'dashboard-cloud' });
  });

  it('marks a self-hosted dashboard as such', async () => {
    selfHosted.mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: true });
    await controller.contact(dto);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).source).toBe('dashboard-self-hosted');
  });

  it('answers 502 when manifest.build refuses the request', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(controller.contact(dto)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('answers 502 when manifest.build is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(controller.contact(dto)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
