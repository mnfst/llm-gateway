import { createResource, createSignal, Show, type Component, createEffect } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import {
  duplicateAgent,
  getDuplicatePreview,
  type DuplicateAgentPreview,
} from '../services/api.js';
import { markAgentCreated } from '../services/recent-agents.js';
import { toast } from '../services/toast-store.js';

interface Props {
  open: boolean;
  sourceName: string;
  onClose: () => void;
  onDuplicated?: () => void;
}

const DuplicateAgentModal: Component<Props> = (props) => {
  const navigate = useNavigate();
  const [name, setName] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [nameTouched, setNameTouched] = createSignal(false);
  let cancelledInFlight = false;

  const [preview] = createResource<DuplicateAgentPreview | null, { open: boolean; source: string }>(
    () => ({ open: props.open, source: props.sourceName }),
    async ({ open, source }) => {
      if (!open || !source) return null;
      return (await getDuplicatePreview(source)) ?? null;
    },
  );

  createEffect(() => {
    const p = preview();
    if (p?.suggested_name && !nameTouched()) {
      setName(p.suggested_name);
    }
  });

  createEffect(() => {
    if (!props.open) {
      setName('');
      setNameTouched(false);
      setSubmitting(false);
      // Deliberately don't reset `cancelledInFlight` here — it must stay true
      // until the in-flight fetch returns so handleDuplicate can honor the
      // cancel. handleDuplicate resets it when starting a new request.
    }
  });

  const requestClose = () => {
    if (submitting()) cancelledInFlight = true;
    props.onClose();
  };

  const totalCopied = () => {
    const c = preview()?.copied;
    if (!c) return 0;
    return c.providers + c.tierAssignments + c.specificityAssignments + c.modelParams;
  };

  const handleNameInput = (value: string) => {
    setNameTouched(true);
    setName(value);
  };

  const handleDuplicate = async () => {
    const newName = name().trim();
    if (!newName || submitting()) return;
    cancelledInFlight = false;
    setSubmitting(true);
    try {
      const result = await duplicateAgent(props.sourceName, newName);
      if (!result) return;
      if (cancelledInFlight) {
        // User closed the modal before the request finished. The agent was still
        // created on the server, so refresh the parent list but skip the toast
        // and navigation the user implicitly opted out of.
        props.onDuplicated?.();
        return;
      }
      const slug = result.agent.name;
      markAgentCreated(slug);
      toast.success(`Duplicated "${props.sourceName}" to "${slug}"`);
      props.onClose();
      props.onDuplicated?.();
      navigate(`/harnesses/${encodeURIComponent(slug)}`, {
        state: { newApiKey: result.apiKey },
      });
    } catch {
      // error toast already shown by fetchMutate
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) handleDuplicate();
    if (e.key === 'Escape') requestClose();
  };

  return (
    <Show when={props.open}>
      <div
        class="modal-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) requestClose();
        }}
      >
        <div
          class="modal-card"
          style="max-width: 520px;"
          role="dialog"
          aria-modal="true"
          aria-labelledby="duplicate-agent-title"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <h2 class="modal-card__title" id="duplicate-agent-title">
            Duplicate "{props.sourceName}"
          </h2>
          <p class="modal-card__desc">
            Creates a new harness with the same providers, routing, and tier configuration. A fresh
            API key is generated. Telemetry and request history stay with the original.
          </p>

          <label class="modal-card__field-label" for="duplicate-agent-name">
            New harness name
          </label>
          <input
            ref={(el) =>
              requestAnimationFrame(() => {
                el.focus();
                el.select();
              })
            }
            id="duplicate-agent-name"
            class="modal-card__input modal-card__input--lg"
            type="text"
            placeholder={preview()?.suggested_name ?? `${props.sourceName}-copy`}
            value={name()}
            onInput={(e) => handleNameInput(e.currentTarget.value)}
            disabled={submitting()}
          />

          <div class="duplicate-agent__section">
            <div class="duplicate-agent__section-header">
              What is copied
              <Show when={preview()}>
                <span class="duplicate-agent__badge">{totalCopied()}</span>
              </Show>
            </div>
            <Show
              when={preview()}
              fallback={<div class="skeleton skeleton--rect" style="width: 100%; height: 80px;" />}
            >
              <ul class="duplicate-agent__list">
                <li>
                  <strong>{preview()!.copied.providers}</strong> provider credential
                  {preview()!.copied.providers === 1 ? '' : 's'} (encrypted API keys &amp;
                  subscriptions)
                </li>
                <li>
                  <strong>{preview()!.copied.tierAssignments}</strong> tier override
                  {preview()!.copied.tierAssignments === 1 ? '' : 's'}
                </li>
                <li>
                  <strong>{preview()!.copied.specificityAssignments}</strong> specificity override
                  {preview()!.copied.specificityAssignments === 1 ? '' : 's'}
                </li>
              </ul>
            </Show>
          </div>

          <div class="duplicate-agent__section">
            <div class="duplicate-agent__section-header">What is not copied</div>
            <ul class="duplicate-agent__list">
              <li>Requests</li>
              <li>Logs</li>
              <li>Notification rules</li>
            </ul>
          </div>

          <div class="modal-card__footer">
            <button class="btn btn--ghost btn--sm" onClick={requestClose} type="button">
              Cancel
            </button>
            <button
              class="btn btn--primary btn--sm"
              onClick={handleDuplicate}
              disabled={!name().trim() || submitting()}
              type="button"
            >
              {submitting() ? <span class="spinner" /> : 'Duplicate harness'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default DuplicateAgentModal;
