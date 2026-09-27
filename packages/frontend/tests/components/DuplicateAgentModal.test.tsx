import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const mockDuplicateAgent = vi.fn();
const mockGetDuplicatePreview = vi.fn();
const mockNavigate = vi.fn();
const mockToastSuccess = vi.fn();
const mockMarkAgentCreated = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  duplicateAgent: (...args: unknown[]) => mockDuplicateAgent(...args),
  getDuplicatePreview: (...args: unknown[]) => mockGetDuplicatePreview(...args),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { success: (...a: unknown[]) => mockToastSuccess(...a), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/services/recent-agents.js', () => ({
  markAgentCreated: (...a: unknown[]) => mockMarkAgentCreated(...a),
}));

vi.mock('@solidjs/router', () => ({
  useNavigate: () => mockNavigate,
}));

import DuplicateAgentModal from '../../src/components/DuplicateAgentModal';

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => Array.from(document.querySelectorAll(sel));

describe('DuplicateAgentModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDuplicatePreview.mockResolvedValue({
      copied: {
        providers: 3,
        customProviders: 1,
        tierAssignments: 4,
        specificityAssignments: 2,
        modelParams: 0,
      },
      suggested_name: 'my-agent-copy',
    });
    mockDuplicateAgent.mockResolvedValue({
      agent: { id: 'new-id', name: 'my-agent-copy', display_name: 'my-agent-copy' },
      apiKey: 'mnfst_xyz',
      copied: {
        providers: 3,
        customProviders: 1,
        tierAssignments: 4,
        specificityAssignments: 2,
        modelParams: 0,
      },
    });
  });

  it('does not render when closed', () => {
    render(() => <DuplicateAgentModal open={false} sourceName="my-agent" onClose={vi.fn()} />);
    expect(q('.modal-overlay')).toBeNull();
  });

  it('renders the source agent name in the title and prefills the suggested name', async () => {
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={vi.fn()} />);

    expect(screen.getByText(/Duplicate "my-agent"/)).toBeDefined();

    await waitFor(() => {
      const input = q('#duplicate-agent-name') as HTMLInputElement | null;
      expect(input?.value).toBe('my-agent-copy');
    });
  });

  it('shows copied and not-copied sections without an accordion', async () => {
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={vi.fn()} />);

    await waitFor(() => {
      const allItems = qa('.duplicate-agent__list li');
      // Wait for the copied section to render (more than just the 3 "not copied" items)
      expect(allItems.length).toBeGreaterThan(3);
    });

    // "What is copied" items
    const list = qa('.duplicate-agent__list li').map((li) => li.textContent);
    expect(list.some((t) => t?.includes('3') && t?.includes('provider credential'))).toBe(true);
    expect(list.some((t) => t?.includes('4') && t?.includes('tier override'))).toBe(true);
    expect(list.some((t) => t?.includes('2') && t?.includes('specificity override'))).toBe(true);

    // "What is not copied" items are always visible (no accordion)
    const headers = qa('.duplicate-agent__section-header').map((h) => h.textContent?.trim());
    expect(headers.some((h) => h?.includes('What is copied'))).toBe(true);
    expect(headers.some((h) => h?.includes('What is not copied'))).toBe(true);
    expect(list.some((t) => t === 'Requests')).toBe(true);
    expect(list.some((t) => t === 'Logs')).toBe(true);
    expect(list.some((t) => t === 'Notification rules')).toBe(true);

    // No <details> elements — content is always visible
    expect(document.querySelector('details')).toBeNull();
  });

  it('calls duplicateAgent, shows toast, and navigates on success', async () => {
    const onClose = vi.fn();
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={onClose} />);

    await waitFor(() => {
      const input = q('#duplicate-agent-name') as HTMLInputElement | null;
      expect(input?.value).toBe('my-agent-copy');
    });

    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Duplicate harness',
    ) as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDuplicateAgent).toHaveBeenCalledWith('my-agent', 'my-agent-copy');
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
      expect(mockMarkAgentCreated).toHaveBeenCalledWith('my-agent-copy');
      expect(mockNavigate).toHaveBeenCalledWith('/harnesses/my-agent-copy', {
        state: { newApiKey: 'mnfst_xyz' },
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('disables the Duplicate button when name is empty', async () => {
    mockGetDuplicatePreview.mockResolvedValueOnce({
      copied: {
        providers: 0,
        customProviders: 0,
        tierAssignments: 0,
        specificityAssignments: 0,
        modelParams: 0,
      },
      suggested_name: '',
    });
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={vi.fn()} />);

    await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Duplicate harness',
      ) as HTMLButtonElement;
      expect(btn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('closes when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={onClose} />);

    const cancelBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape keypress', async () => {
    const onClose = vi.fn();
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={onClose} />);

    await waitFor(() => {
      expect(q('#duplicate-agent-name')).toBeDefined();
    });
    const input = q('#duplicate-agent-name') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('submits on Enter keypress', async () => {
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={vi.fn()} />);

    await waitFor(() => {
      const input = q('#duplicate-agent-name') as HTMLInputElement | null;
      expect(input?.value).toBe('my-agent-copy');
    });

    const input = q('#duplicate-agent-name') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockDuplicateAgent).toHaveBeenCalledWith('my-agent', 'my-agent-copy');
    });
  });

  it('swallows errors silently (toast already shown by fetchMutate)', async () => {
    mockDuplicateAgent.mockRejectedValueOnce(new Error('boom'));
    const onClose = vi.fn();
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={onClose} />);

    await waitFor(() => {
      const input = q('#duplicate-agent-name') as HTMLInputElement | null;
      expect(input?.value).toBe('my-agent-copy');
    });

    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Duplicate harness',
    ) as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDuplicateAgent).toHaveBeenCalled();
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the overlay backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={onClose} />);
    await waitFor(() => {
      expect(q('.modal-overlay')).toBeDefined();
    });
    const overlay = q('.modal-overlay') as HTMLDivElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when a click inside the modal card bubbles to the overlay', async () => {
    const onClose = vi.fn();
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={onClose} />);
    await waitFor(() => {
      expect(q('.modal-card')).toBeDefined();
    });
    const card = q('.modal-card') as HTMLDivElement;
    fireEvent.click(card);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips toast + navigate when the parent closes the modal during an in-flight submit', async () => {
    let resolveDuplicate: (value: {
      agent: { id: string; name: string; display_name: string };
      apiKey: string;
      copied: {
        providers: number;
        customProviders: number;
        tierAssignments: number;
        specificityAssignments: number;
        modelParams: number;
      };
    }) => void = () => undefined;
    mockDuplicateAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDuplicate = resolve;
        }),
    );

    // Use a reactive `open` signal so calling onClose actually flips the prop
    // and runs the modal's createEffect, matching real parent wiring.
    const [open, setOpen] = createSignal(true);
    const onDuplicated = vi.fn();
    render(() => (
      <DuplicateAgentModal
        open={open()}
        sourceName="my-agent"
        onClose={() => setOpen(false)}
        onDuplicated={onDuplicated}
      />
    ));

    await waitFor(() => {
      const input = q('#duplicate-agent-name') as HTMLInputElement | null;
      expect(input?.value).toBe('my-agent-copy');
    });

    const duplicateBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Duplicate harness',
    ) as HTMLButtonElement;
    fireEvent.click(duplicateBtn);

    await waitFor(() => {
      expect(mockDuplicateAgent).toHaveBeenCalled();
    });

    const cancelBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    // Modal has closed (props.open flipped to false)
    await waitFor(() => {
      expect(q('.modal-overlay')).toBeNull();
    });

    resolveDuplicate({
      agent: { id: 'new-id', name: 'my-agent-copy', display_name: 'my-agent-copy' },
      apiKey: 'mnfst_xyz',
      copied: {
        providers: 0,
        customProviders: 0,
        tierAssignments: 0,
        specificityAssignments: 0,
        modelParams: 0,
      },
    });

    await waitFor(() => {
      expect(onDuplicated).toHaveBeenCalled();
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockMarkAgentCreated).not.toHaveBeenCalled();
  });

  it('keeps user-typed name when they edit it', async () => {
    render(() => <DuplicateAgentModal open={true} sourceName="my-agent" onClose={vi.fn()} />);

    await waitFor(() => {
      const input = q('#duplicate-agent-name') as HTMLInputElement | null;
      expect(input?.value).toBe('my-agent-copy');
    });

    const input = q('#duplicate-agent-name') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'my-custom-name' } });
    expect(input.value).toBe('my-custom-name');
  });
});
