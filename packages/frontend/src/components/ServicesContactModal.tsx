import { createSignal, For, Show, type JSX } from 'solid-js';
import { sendServicesContact } from '../services/api/services-contact.js';

export const SERVICES_OFFER = [
  'Guardrails written for your own rules',
  'Custom hooks before and after each request',
  'Integrations with the tools you already run',
  'Allow lists and block lists for models and providers',
  'User management for your teams',
  'Installation on your servers or your cloud account',
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ServicesContactModalProps {
  open: boolean;
  defaultName?: string;
  defaultEmail?: string;
  onClose: () => void;
}

/**
 * "Custom development" contact form, opened from the dashboard header. The
 * backend relays it to manifest.build, which emails the Manifest team.
 */
export default function ServicesContactModal(props: ServicesContactModalProps): JSX.Element {
  const [name, setName] = createSignal(props.defaultName ?? '');
  const [email, setEmail] = createSignal(props.defaultEmail ?? '');
  const [phone, setPhone] = createSignal('');
  const [company, setCompany] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [showErrors, setShowErrors] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const nameError = () => showErrors() && !name().trim();
  const emailError = () => showErrors() && !EMAIL_RE.test(email().trim());
  const messageError = () => showErrors() && !message().trim();

  const close = () => {
    setShowErrors(false);
    setFailed(false);
    if (sent()) {
      setSent(false);
      setMessage('');
    }
    props.onClose();
  };

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setShowErrors(true);
    setFailed(false);
    if (!name().trim() || !EMAIL_RE.test(email().trim()) || !message().trim()) return;
    setSending(true);
    try {
      await sendServicesContact({
        name: name().trim(),
        email: email().trim(),
        phone: phone().trim() || undefined,
        company: company().trim() || undefined,
        message: message().trim(),
      });
      setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="modal-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div
          class="modal-card services-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="services-modal-title"
        >
          <div class="services-modal__offer">
            <h2 class="modal-card__title" id="services-modal-title">
              Does your project need something specific?
            </h2>
            <p class="modal-card__desc">
              Our team can develop it for you around Manifest LLM Gateway. For example:
            </p>
            <ul class="services-modal__list">
              <For each={[...SERVICES_OFFER]}>{(item) => <li>{item}</li>}</For>
            </ul>
          </div>
          <div class="services-modal__contact">
            <Show
              when={!sent()}
              fallback={
                <p class="services-modal__sent" role="status">
                  Thanks for your message. The Manifest team will reply by email.
                </p>
              }
            >
              <form onSubmit={submit} novalidate>
                <label class="modal-card__field-label" for="services-name">
                  Name *
                </label>
                <input
                  id="services-name"
                  class="modal-card__input"
                  classList={{ 'modal-card__input--error': nameError() }}
                  type="text"
                  autocomplete="name"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
                <label class="modal-card__field-label" for="services-email">
                  Work email *
                </label>
                <input
                  id="services-email"
                  class="modal-card__input"
                  classList={{ 'modal-card__input--error': emailError() }}
                  type="email"
                  autocomplete="email"
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                />
                <label class="modal-card__field-label" for="services-phone">
                  Phone
                </label>
                <input
                  id="services-phone"
                  class="modal-card__input"
                  type="tel"
                  autocomplete="tel"
                  value={phone()}
                  onInput={(e) => setPhone(e.currentTarget.value)}
                />
                <label class="modal-card__field-label" for="services-company">
                  Company
                </label>
                <input
                  id="services-company"
                  class="modal-card__input"
                  type="text"
                  autocomplete="organization"
                  value={company()}
                  onInput={(e) => setCompany(e.currentTarget.value)}
                />
                <label class="modal-card__field-label" for="services-message">
                  What do you need? *
                </label>
                <textarea
                  id="services-message"
                  class="modal-card__input services-modal__textarea"
                  classList={{ 'modal-card__input--error': messageError() }}
                  rows={4}
                  maxLength={5000}
                  value={message()}
                  onInput={(e) => setMessage(e.currentTarget.value)}
                />
                <Show when={nameError() || emailError() || messageError()}>
                  <p class="modal-card__field-error">
                    Name, a valid email and a message are required.
                  </p>
                </Show>
                <Show when={failed()}>
                  <p class="modal-card__field-error" role="alert">
                    The message was not sent. Please try again in a moment.
                  </p>
                </Show>
                <div class="modal-card__footer">
                  <button class="btn btn--ghost btn--sm" type="button" onClick={close}>
                    Cancel
                  </button>
                  <button class="btn btn--primary btn--sm" type="submit" disabled={sending()}>
                    {sending() ? (
                      <span class="spinner" />
                    ) : (
                      <>
                        Send
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path d="m19.37,4.69c-.37-.25-.83-.29-1.24-.1l-13.34,6.25c-.45.21-.73.65-.72,1.15,0,.5.3.93.75,1.13l3.17,1.37v5.44c0,.42.49.66.82.38l4.32-3.6,4.19,1.82c.16.07.33.1.5.1.23,0,.45-.06.65-.18.35-.21.57-.58.6-.98l.83-11.67c.03-.45-.17-.87-.54-1.12Zm-1.29,12.72c0,.11-.08.17-.12.2-.04.02-.12.06-.23.02l-3.73-1.62h0s-.05-.02-.05-.02l-1.6-.69,1.97-3.95c.21-.43-.24-.89-.67-.67l-5.56,2.78-2.88-1.25c-.13-.06-.15-.18-.15-.23,0-.05.01-.17.14-.23l13.34-6.25c.12-.06.21,0,.25.02s.12.09.11.22l-.83,11.67Z" />
                        </svg>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
