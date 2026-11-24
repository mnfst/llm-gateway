import { fetchMutate } from './core.js';

/** What the "Custom development" form sends; the backend adds the source. */
export interface ServicesContactRequest {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  message: string;
}

/** Relays the form through the backend to manifest.build, which emails the team. */
export function sendServicesContact(body: ServicesContactRequest): Promise<{ ok: true }> {
  return fetchMutate<{ ok: true }>('/services/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
