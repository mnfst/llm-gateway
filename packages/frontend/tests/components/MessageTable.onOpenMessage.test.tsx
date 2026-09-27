import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@solidjs/testing-library';
import type { MessageRow } from '../../src/components/message-table-types';

// This suite renders the REAL MessageDetails inside an expanded MessageTable
// row (unlike MessageTable.test.tsx, which stubs MessageDetails). It proves the
// `onOpenMessage` prop is threaded end-to-end: table → ExpandableRow →
// MessageDetails → Autofix link → handler. The api layer is mocked so the
// resource resolves to an Autofixed original with a sibling.

const mockGetMessageDetails = vi.fn();
const mockFlagMiscategorized = vi.fn();
const mockClearMiscategorized = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getMessageDetails: (...args: unknown[]) => mockGetMessageDetails(...args),
  flagMessageMiscategorized: (...args: unknown[]) => mockFlagMiscategorized(...args),
  clearMessageMiscategorized: (...args: unknown[]) => mockClearMiscategorized(...args),
}));

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatCost: (v: number) => (v < 0 ? null : `$${v.toFixed(2)}`),
  formatNumber: (v: number) => String(v),
  formatStatus: (s: string) => s,
  formatTime: (t: string) => t,
  formatDuration: (ms: number) => `${ms}ms`,
  formatErrorMessage: (s: string) => s,
  formatErrorOrigin: (o: string | null | undefined) => o ?? null,
  formatErrorClass: (c: string | null | undefined) => c ?? null,
  customProviderColor: () => '#6366f1',
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  inferProviderFromModel: (m: string) => (m.startsWith('gpt') ? 'openai' : null),
  inferProviderName: (m: string) => (m.startsWith('gpt') ? 'OpenAI' : m),
  resolveProviderId: (dbProvider: string) => (dbProvider ? dbProvider.toLowerCase() : undefined),
  stripCustomPrefix: (m: string) => m.replace(/^custom:[^/]+\//, ''),
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [{ id: 'openai', name: 'OpenAI' }],
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: (id: string) => <span data-testid={`icon-${id}`} />,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/AuthBadge.js', () => ({
  authBadgeFor: () => null,
  authLabel: () => 'API Key',
}));

vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: (props: any) => <span data-testid="info-tooltip" title={props.text} />,
}));

import MessageTable from '../../src/components/MessageTable';

function makeRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'orig-1',
    timestamp: '2026-02-16 10:00:00',
    agent_name: 'test-agent',
    model: 'gpt-4o',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: 0.05,
    status: 'error',
    ...overrides,
  };
}

const originalDetail = {
  message: {
    id: 'orig-1',
    timestamp: '2026-02-16 10:00:00',
    agent_name: 'test-agent',
    model: 'gpt-4o',
    status: 'error',
    error_message: 'Unknown parameter: max_tokens',
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
    autofix_applied: true,
    autofix_role: 'original',
    autofix_operations: [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }],
    autofix_sibling: { id: 'retry-1', role: 'retry', status: 'ok' },
  },
};

describe('MessageTable onOpenMessage passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('threads onOpenMessage into an expanded row so the Autofix link opens the sibling', async () => {
    mockGetMessageDetails.mockResolvedValue(originalDetail);
    const onOpenMessage = vi.fn();
    const { container } = render(() => (
      <MessageTable
        items={[makeRow()]}
        columns={['date']}
        agentName="agent-1"
        customProviderName={() => undefined}
        onOpenMessage={onOpenMessage}
        rowIdPrefix="msg-"
        expandable
      />
    ));

    // Expand the row via the chevron.
    const chevron = container.querySelector('.msg-detail__chevron-btn') as HTMLButtonElement;
    expect(chevron).not.toBeNull();
    fireEvent.click(chevron);

    // The real MessageDetails resource resolves and renders the Autofix link.
    const link = await vi.waitFor(() => {
      const el = container.querySelector('.error-autofix-row__autofix-btn');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    expect(link.textContent).toContain('View Autofix retry');

    // Clicking the sibling link calls the table's onOpenMessage with the id.
    fireEvent.click(link);
    expect(onOpenMessage).toHaveBeenCalledWith('retry-1');
  });
});
