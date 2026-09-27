import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@solidjs/testing-library';

const mockGetMessageDetails = vi.fn();
const mockFlagMiscategorized = vi.fn();
const mockClearMiscategorized = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getMessageDetails: (...args: unknown[]) => mockGetMessageDetails(...args),
  flagMessageMiscategorized: (...args: unknown[]) => mockFlagMiscategorized(...args),
  clearMessageMiscategorized: (...args: unknown[]) => mockClearMiscategorized(...args),
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  inferProviderName: (m: string) => {
    if (m.startsWith('gpt')) return 'OpenAI';
    return m;
  },
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
}));

import MessageDetails from '../../src/components/MessageDetails';

// The Autofix model is two linked rows: a failed `original` and its
// successful `retry`. Each row carries `autofix_role`, the Phoenix
// `autofix_operations`, and an `autofix_sibling` pointer to the paired row.
//
// The redesigned MessageDetails renders these as an "error + autofix" row of
// colored cards rather than a titled section:
//   • the failed ORIGINAL (has an error_message) → an error card paired with a
//     "autofix" next-card ("Autofix was attempted after this error." + a
//     "View autofix retry" link).
//   • the successful RETRY (no error_message) → the rich `AutofixSection` card:
//     a success phrase, the Phoenix operation table, the Phoenix ids, and a
//     "← View original request" back-link.
const baseMessage = {
  id: 'msg-1',
  timestamp: '2026-02-16 10:00:00',
  agent_name: 'test-agent',
  model: 'gpt-4o',
  status: 'error',
  autofix_status: null,
  error_message: null,
  description: null,
  service_type: 'agent',
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_usd: 0.05,
  duration_ms: 1200,
  trace_id: 'trace-abc123',
  routing_tier: 'standard',
  routing_reason: null,
  specificity_category: null,
  specificity_miscategorized: false,
  auth_type: 'api_key',
  provider_key_label: null,
  skill_name: null,
  fallback_from_model: null,
  fallback_index: null,
  session_key: null,
  feedback_rating: null,
  feedback_tags: null,
  feedback_details: null,
  request_headers: null,
  request_params: null,
  header_tier_id: null,
  header_tier_name: null,
  header_tier_color: null,
  caller_attribution: null,
  autofix_applied: false,
  autofix_role: null,
  autofix_operations: null,
  autofix_decision: null,
  autofix_sibling: null,
};

// The failed original: 400'd on an unknown parameter, Phoenix renamed it, and
// it links forward to the successful retry row.
const originalResponse = {
  message: {
    ...baseMessage,
    id: 'orig-1',
    status: 'error',
    autofix_status: 'retry_succeeded' as const,
    error_message: 'Unknown parameter: max_tokens',
    autofix_applied: true,
    autofix_role: 'original',
    autofix_operations: [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }],
    autofix_sibling: { id: 'retry-1', role: 'retry', status: 'ok' },
  },
};

// The successful retry: 200 after the patch, linking back to the original.
const retryResponse = {
  message: {
    ...baseMessage,
    id: 'retry-1',
    status: 'ok',
    autofix_status: 'retry_succeeded' as const,
    error_message: null,
    autofix_applied: true,
    autofix_role: 'retry',
    autofix_operations: null,
    autofix_sibling: { id: 'orig-1', role: 'original', status: 'error' },
  },
};

describe('MessageDetails Autofix section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it.each([
    ['no_patch', 'No patch'],
    ['resolving', 'Resolving'],
    ['retry_succeeded', 'Retry succeeded'],
    ['retry_failed', 'Retry failed'],
    ['service_error', 'Service error'],
  ] as const)('renders the %s request status as %s', async (autofix_status, label) => {
    mockGetMessageDetails.mockResolvedValue({
      message: { ...baseMessage, autofix_status },
    });
    const { container } = render(() => <MessageDetails messageId="msg-1" />);

    await vi.waitFor(() => expect(container.textContent).toContain(label));
  });

  it('renders the original-side panel: error, the "autofix attempted" card, and the retry link', async () => {
    mockGetMessageDetails.mockResolvedValue(originalResponse);
    const onOpenMessage = vi.fn();
    const { container } = render(() => (
      <MessageDetails messageId="orig-1" onOpenMessage={onOpenMessage} />
    ));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Autofix was attempted after this error.');
    });

    // The failed original shows its error inline alongside the autofix card.
    expect(container.querySelector('.msg-detail__error-inline')!.textContent).toBe(
      'Unknown parameter: max_tokens',
    );

    // The forward link to the successful retry.
    const link = container.querySelector('.error-autofix-row__autofix-btn');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('View Autofix retry');

    // Clicking it opens the sibling (retry) row.
    fireEvent.click(link!);
    expect(onOpenMessage).toHaveBeenCalledWith('retry-1');
  });

  it('renders the retry-side panel: success phrase and the back-link to the original', async () => {
    mockGetMessageDetails.mockResolvedValue(retryResponse);
    const onOpenMessage = vi.fn();
    const { container } = render(() => (
      <MessageDetails messageId="retry-1" onOpenMessage={onOpenMessage} />
    ));

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'Manifest caught an error, repaired the request, and retried it successfully.',
      );
    });

    // The back-link to the original failed request uses the secondary variant.
    const link = container.querySelector('.error-autofix-row__autofix-btn--secondary');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('View original request');

    fireEvent.click(link!);
    expect(onOpenMessage).toHaveBeenCalledWith('orig-1');
  });

  it('does not render the Autofix section when autofix_applied is false', async () => {
    mockGetMessageDetails.mockResolvedValue({ message: { ...baseMessage } });
    const onOpenMessage = vi.fn();
    const { container } = render(() => (
      <MessageDetails messageId="msg-1" onOpenMessage={onOpenMessage} />
    ));

    await vi.waitFor(() => {
      // Wait for the panel to render at all.
      expect(container.textContent).toContain('Request');
    });

    // No error/autofix row and no autofix cards render.
    expect(container.querySelector('.error-autofix-row')).toBeNull();
    expect(container.querySelector('.autofix-card')).toBeNull();
    expect(container.querySelector('.error-autofix-row__autofix-btn')).toBeNull();
  });

  it('omits the sibling link when onOpenMessage is not provided', async () => {
    // A sibling exists, but with no handler the link can go nowhere — so it is
    // not rendered. The "autofix attempted" card still appears.
    mockGetMessageDetails.mockResolvedValue(originalResponse);
    const { container } = render(() => <MessageDetails messageId="orig-1" />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Autofix was attempted after this error.');
    });

    expect(container.querySelector('.error-autofix-row__autofix-btn')).toBeNull();
  });

  it('shows the "autofix attempted" card with no link when autofix_sibling is null', async () => {
    // An `original` row with no retry sibling means Autofix ran but never
    // produced a working request — the card still explains an attempt was made,
    // but there is no sibling to link to.
    const noSibling = {
      message: {
        ...originalResponse.message,
        autofix_sibling: null,
      },
    };
    mockGetMessageDetails.mockResolvedValue(noSibling);
    const onOpenMessage = vi.fn();
    const { container } = render(() => (
      <MessageDetails messageId="orig-1" onOpenMessage={onOpenMessage} />
    ));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Autofix was attempted after this error.');
    });

    // The error is still surfaced, but with no sibling there is no link.
    expect(container.querySelector('.msg-detail__error-inline')!.textContent).toBe(
      'Unknown parameter: max_tokens',
    );
    expect(container.querySelector('.error-autofix-row__autofix-btn')).toBeNull();
  });

  it('renders the retry panel with no operation rows when the operations list is empty', async () => {
    // Defensive: autofix_applied is true but no operations serialized. The
    // `operations && operations.length > 0` guard keeps the operations table
    // absent while the success phrase and the sibling link still render.
    const noOps = {
      message: {
        ...retryResponse.message,
        autofix_operations: [],
      },
    };
    mockGetMessageDetails.mockResolvedValue(noOps);
    const onOpenMessage = vi.fn();
    const { container } = render(() => (
      <MessageDetails messageId="retry-1" onOpenMessage={onOpenMessage} />
    ));

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'Manifest caught an error, repaired the request, and retried it successfully.',
      );
    });
    // Phrase present, no operations table, but the sibling link still renders.
    expect(container.querySelector('.error-autofix-row__meta-table')).toBeNull();
    expect(container.querySelector('.error-autofix-row__autofix-btn--secondary')).not.toBeNull();
  });

  it('describes every Phoenix operation type in the retry panel', async () => {
    // The retry panel renders one row per operation: the raw `op.type` in bold
    // plus a human-readable description. This fixture exercises each branch of
    // describeOperation (with and without from/to).
    const allOps = {
      message: {
        ...retryResponse.message,
        autofix_operations: [
          { type: 'drop_param', from: 'top_k' },
          { type: 'drop_param' },
          { type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' },
          { type: 'rename_param', from: 'x' },
          { type: 'clamp_param', from: 'temperature', to: '2' },
          { type: 'clamp_param' },
          { type: 'set_param', from: 'stream', to: 'false' },
          { type: 'set_param' },
          { type: 'remap_model', from: 'gpt-5', to: 'gpt-4o' },
          { type: 'remap_model' },
          { type: 'remove_unsupported_schema_keywords' },
          { type: 'remove_unsupported_message_fields', from: 'name' },
          { type: 'remove_unsupported_message_fields' },
          { type: 'weird_unknown_op', from: 'a', to: 'b' },
          { type: 'lonely_unknown_op' },
        ],
      },
    };
    mockGetMessageDetails.mockResolvedValue(allOps);
    const { container } = render(() => <MessageDetails messageId="retry-1" />);

    await vi.waitFor(() => {
      expect(container.querySelector('.error-autofix-row__meta-table')).not.toBeNull();
    });

    const text = container.textContent!;
    expect(text).toContain('Removed unsupported parameter "top_k"');
    expect(text).toContain('Removed an unsupported parameter');
    expect(text).toContain('Renamed "max_tokens" to "max_output_tokens"');
    expect(text).toContain('Renamed a parameter');
    expect(text).toContain('Adjusted temperature from temperature to 2');
    expect(text).toContain('Adjusted a value to fit the allowed range');
    expect(text).toContain('Set "stream" to false');
    expect(text).toContain('Set a required parameter value');
    expect(text).toContain('Switched from "gpt-5" to "gpt-4o"');
    expect(text).toContain('Replaced the model with a supported one');
    expect(text).toContain('Cleaned unsupported JSON Schema keywords from tool definitions');
    expect(text).toContain('Removed unsupported field "name" from messages');
    expect(text).toContain('Removed unsupported fields from messages');
    // Unknown op types fall back to `type: from → to` (or bare `type`).
    expect(text).toContain('weird_unknown_op: a → b');
    expect(text).toContain('lonely_unknown_op');
    // The raw op.type is shown in bold too.
    expect(text).toContain('rename_param');
  });

  it('renders an operation description without an arrow when from/to are missing', async () => {
    // An operation type that is not a known param op carries no from/to, so the
    // `: from → to` suffix is suppressed — the only place a `→` could appear.
    const bareOp = {
      message: {
        ...retryResponse.message,
        autofix_operations: [{ type: 'strip_unsupported_field' }],
        autofix_sibling: null,
      },
    };
    mockGetMessageDetails.mockResolvedValue(bareOp);
    const { container } = render(() => <MessageDetails messageId="retry-1" />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('strip_unsupported_field');
    });
    expect(container.textContent).not.toContain('→');
  });

  it('renders Phoenix issue/patch/heal ids (first 8 chars) when autofix_decision is present', async () => {
    // Phoenix's own identifiers for the heal decision. Each id renders as a
    // labelled 8-char slice: "Issue <8>", "Patch <8>", "Heal-attempt <8>".
    const withPhoenix = {
      message: {
        ...retryResponse.message,
        autofix_decision: {
          issueId: 'issue-1234abcd',
          patchId: 'patch-5678efgh',
          healAttemptId: 'heal-9012ijkl',
        },
      },
    };
    mockGetMessageDetails.mockResolvedValue(withPhoenix);
    const { container } = render(() => <MessageDetails messageId="retry-1" />);

    await vi.waitFor(() => {
      expect(container.querySelector('.autofix-card__ids')).not.toBeNull();
    });

    // 8-char slices of each id, with their labels.
    expect(container.textContent).toContain('Issue issue-12');
    expect(container.textContent).toContain('Patch patch-56');
    expect(container.textContent).toContain('Heal-attempt heal-901');
  });

  it('renders only the Heal-attempt id when issueId and patchId are absent', async () => {
    // Exercises the `issueId || patchId || healAttemptId` OR short-circuit past
    // the first two operands: only healAttemptId is present, so the Issue/Patch
    // chips are suppressed while the section still shows the heal id.
    const healOnly = {
      message: {
        ...retryResponse.message,
        autofix_decision: {
          issueId: null,
          patchId: null,
          healAttemptId: 'heal-9012ijkl',
        },
      },
    };
    mockGetMessageDetails.mockResolvedValue(healOnly);
    const { container } = render(() => <MessageDetails messageId="retry-1" />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Heal-attempt heal-901');
    });

    expect(container.textContent).not.toContain('Issue ');
    expect(container.textContent).not.toContain('Patch ');
  });

  it('renders no Phoenix ids when autofix_decision is null', async () => {
    // The retry panel with autofix_decision null (the default) must not render
    // any Issue/Patch/Heal-attempt labels — covers the absent branch.
    mockGetMessageDetails.mockResolvedValue(retryResponse);
    const { container } = render(() => <MessageDetails messageId="retry-1" />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'Manifest caught an error, repaired the request, and retried it successfully.',
      );
    });

    expect(container.querySelector('.autofix-card__ids')).toBeNull();
    expect(container.textContent).not.toContain('Issue ');
    expect(container.textContent).not.toContain('Patch ');
    expect(container.textContent).not.toContain('Heal-attempt');
  });

  it("renders Phoenix's explanation summary and per-op detail when present", async () => {
    // Phoenix now sends a human-readable "why". The card shows its summary in place
    // of the generic phrase, and its authoritative per-op detail — which the local
    // describeOperation could not produce for clamp_param (no from/to).
    const withExplanation = {
      message: {
        ...retryResponse.message,
        autofix_operations: [{ type: 'clamp_param' }],
        autofix_decision: {
          issueId: 'issue-1',
          patchId: 'patch-1',
          healAttemptId: 'heal-1',
          explanation: {
            summary:
              "Your request set max_tokens above this model's limit, so it was capped at 8192.",
            operations: [
              { type: 'clamp_param', detail: 'Capped "max_tokens" at the maximum of 8192.' },
            ],
            source: 'deterministic',
          },
        },
      },
    };
    mockGetMessageDetails.mockResolvedValue(withExplanation);
    const { container } = render(() => <MessageDetails messageId="retry-1" />);

    await vi.waitFor(() => {
      expect(container.querySelector('.error-autofix-row__meta-table')).not.toBeNull();
    });

    const text = container.textContent!;
    // Phoenix's summary replaces the generic success phrase.
    expect(text).toContain('so it was capped at 8192');
    expect(text).not.toContain(
      'Manifest caught an error, repaired the request, and retried it successfully.',
    );
    // Phoenix's authoritative per-op detail (the local fallback couldn't describe clamp_param).
    expect(text).toContain('Capped "max_tokens" at the maximum of 8192.');
    expect(text).toContain('clamp_param');
  });

  it('renders a triple layout: autofix retry trigger → error → fallback next', async () => {
    // A retry that itself failed and was recovered by a fallback: the request
    // was triggered by an autofix (left), it errored (middle), and a fallback
    // fired after (right) — the 3-column `--triple` layout.
    mockGetMessageDetails.mockResolvedValue({
      message: {
        ...baseMessage,
        id: 'triple-1',
        status: 'fallback_error',
        error_message: 'Overloaded',
        autofix_applied: true,
        autofix_role: 'retry',
      },
    });
    const { container } = render(() => <MessageDetails messageId="triple-1" />);

    await vi.waitFor(() => {
      expect(container.querySelector('.error-autofix-row--triple')).not.toBeNull();
    });

    const text = container.textContent!;
    // Trigger card (left): this request came from an autofix.
    expect(text).toContain('This request was triggered by an autofix.');
    // Error card (middle).
    expect(container.querySelector('.msg-detail__error-inline')!.textContent).toBe('Overloaded');
    // Next card (right): a fallback fired after the error.
    expect(text).toContain('A fallback was triggered after this error.');
  });

  it('renders a triple layout: fallback trigger → error → autofix next, with the retry link', async () => {
    // A request reached via fallback that also failed and then triggered an
    // autofix: fallback trigger (left), error (middle), autofix next (right)
    // carrying the forward link to the retry sibling.
    const onOpenMessage = vi.fn();
    mockGetMessageDetails.mockResolvedValue({
      message: {
        ...baseMessage,
        id: 'triple-2',
        status: 'error',
        error_message: 'Bad param',
        fallback_from_model: 'gemini-flash',
        fallback_index: 2,
        autofix_applied: true,
        autofix_role: 'original',
        autofix_sibling: { id: 'retry-2', role: 'retry', status: 'ok' },
      },
    });
    const { container } = render(() => (
      <MessageDetails messageId="triple-2" onOpenMessage={onOpenMessage} />
    ));

    await vi.waitFor(() => {
      expect(container.querySelector('.error-autofix-row--triple')).not.toBeNull();
    });

    const text = container.textContent!;
    // Fallback trigger card (left) with the 1-based attempt number + source.
    expect(text).toContain('Attempt #3:');
    expect(text).toContain('gemini-flash');
    // Error card (middle).
    expect(container.querySelector('.msg-detail__error-inline')!.textContent).toBe('Bad param');
    // Autofix next card (right) with the forward link.
    expect(text).toContain('Autofix was attempted after this error.');
    const link = container.querySelector('.error-autofix-row__autofix-btn');
    expect(link).not.toBeNull();
    fireEvent.click(link!);
    expect(onOpenMessage).toHaveBeenCalledWith('retry-2');
  });

  it('renders a 50/50 trigger+error layout when an autofix retry itself errors with nothing after', async () => {
    // A retry that failed and was NOT recovered: trigger card (this came from an
    // autofix) + the error, but no next-action card and no triple layout.
    mockGetMessageDetails.mockResolvedValue({
      message: {
        ...baseMessage,
        id: 'retry-fail-1',
        status: 'error',
        error_message: 'Retry also failed',
        autofix_applied: true,
        autofix_role: 'retry',
      },
    });
    const { container } = render(() => <MessageDetails messageId="retry-fail-1" />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('This request was triggered by an autofix.');
    });

    // Error present, but no triple layout and no next-action cards.
    expect(container.querySelector('.msg-detail__error-inline')!.textContent).toBe(
      'Retry also failed',
    );
    expect(container.querySelector('.error-autofix-row--triple')).toBeNull();
    expect(container.textContent).not.toContain('A fallback was triggered after this error.');
    expect(container.textContent).not.toContain('Autofix was attempted after this error.');
  });
});
