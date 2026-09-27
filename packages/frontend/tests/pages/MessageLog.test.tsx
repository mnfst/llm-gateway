import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

let mockAgentName = 'test-agent';
let mockSearchParams: Record<string, string | undefined> = {};
let mockSearchAgentAccessor: (() => string | undefined) | null = null;
let mockSearchModelAccessor: (() => string | undefined) | null = null;
const mockSetSearchParams = vi.fn();
const mockNavigate = vi.fn();
const pingBox = vi.hoisted(() => ({ read: (): number => 0, set: (_value: number) => {} }));
vi.mock('@solidjs/router', () => ({
  useParams: () => ({ agentName: mockAgentName }),
  useSearchParams: () => [
    {
      get agent() {
        return mockSearchAgentAccessor ? mockSearchAgentAccessor() : mockSearchParams.agent;
      },
      get status() {
        return mockSearchParams.status;
      },
      get request() {
        return mockSearchParams.request;
      },
      get range() {
        return mockSearchParams.range;
      },
      get model() {
        return mockSearchModelAccessor ? mockSearchModelAccessor() : mockSearchParams.model;
      },
    },
    mockSetSearchParams,
  ],
  useNavigate: () => mockNavigate,
  A: (props: any) => (
    <a href={props.href} style={props.style} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: (props: any) => <meta name={props.name ?? ''} content={props.content ?? ''} />,
}));

const mockGetMessages = vi.fn();
const mockGetMessageCount = vi.fn();
const mockGetMessageFilterOptions = vi.fn();
const mockGetAgents = vi.fn();
const mockGetCustomProviders = vi.fn();
const mockGetSpecificityAssignments = vi.fn();
const mockGetMessageDetails = vi.fn();
const mockGetRoutingStatus = vi.fn();
const mockSetMessageFeedback = vi.fn();
const mockClearMessageFeedback = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  getMessageCount: (...args: unknown[]) => mockGetMessageCount(...args),
  getMessageFilterOptions: (...args: unknown[]) => mockGetMessageFilterOptions(...args),
  getAgents: (...args: unknown[]) => mockGetAgents(...args),
  getCustomProviders: (...args: unknown[]) => mockGetCustomProviders(...args),
  getSpecificityAssignments: (...args: unknown[]) => mockGetSpecificityAssignments(...args),
  getMessageDetails: (...args: unknown[]) => mockGetMessageDetails(...args),
  getRoutingStatus: (...args: unknown[]) => mockGetRoutingStatus(...args),
  setMessageFeedback: (...args: unknown[]) => mockSetMessageFeedback(...args),
  clearMessageFeedback: (...args: unknown[]) => mockClearMessageFeedback(...args),
}));

const mockGetProviderConnections = vi.fn().mockResolvedValue({
  providers: [
    {
      provider: 'openai',
      auth_type: 'api_key',
      display_name: null,
      connection_count: 1,
      total_models: 0,
      connections: [
        {
          id: 'conn-openai-1',
          label: 'Default',
          key_prefix: null,
          priority: 0,
          connected_at: '',
          models_fetched_at: null,
          cached_model_count: 0,
          is_active: true,
        },
      ],
    },
    {
      provider: 'anthropic',
      auth_type: 'subscription',
      display_name: null,
      connection_count: 1,
      total_models: 0,
      connections: [
        {
          id: 'conn-anthropic-1',
          label: 'Team',
          key_prefix: null,
          priority: 0,
          connected_at: '',
          models_fetched_at: null,
          cached_model_count: 0,
          is_active: false,
        },
      ],
    },
    {
      provider: 'custom:abc-123',
      auth_type: 'api_key',
      display_name: 'Cohere',
      connection_count: 1,
      total_models: 0,
      connections: [
        {
          id: 'conn-custom-1',
          label: 'Default',
          key_prefix: null,
          priority: 0,
          connected_at: '',
          models_fetched_at: null,
          cached_model_count: 0,
          is_active: true,
        },
      ],
    },
  ],
  model_counts: {},
});
vi.mock('../../src/services/api/providers.js', () => ({
  getProviders: (...args: unknown[]) => mockGetProviderConnections(...args),
}));

vi.mock('../../src/components/MultiSelect.jsx', () => ({
  default: (props: any) => (
    <select
      data-testid="multiselect"
      aria-label={props.label}
      value={props.values?.[0] ?? ''}
      onChange={(e: any) => {
        const value = e.target.value;
        props.onChange(value ? [value] : []);
      }}
    >
      <option value="">{props.placeholder}</option>
      {props.options?.map((o: any) => (
        <option value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

import { resetPlanStore } from '../../src/services/plan-store';

vi.mock('../../src/services/sse.js', () => ({
  pingCount: () => 0,
  messagePing: () => pingBox.read(),
  analyticsPing: () => 0,
  agentPing: () => 0,
  routingPing: () => 0,
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug.replace(/^custom:[^/]+\//, ''),
  preloadModelDisplayNames: () => {},
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatCost: (v: number) => `$${v.toFixed(2)}`,
  formatNumber: (v: number) => String(v),
  formatStatus: (s: string) => s,
  formatErrorOrigin: (o: string | null | undefined) => o ?? null,
  formatErrorClass: (c: string | null | undefined) => c ?? null,
  formatTime: (t: string) => t,
  formatDuration: (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`),
  formatErrorMessage: (s: string) => s,
  customProviderColor: vi.fn(() => '#6366f1'),
  sortedHeaderEntries: (h: Record<string, string> | null | undefined) =>
    Object.entries(h ?? {}).sort(([a], [b]) => a.localeCompare(b)),
}));

const mockCheckIsSelfHosted = vi.fn(() => Promise.resolve(false));
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => mockCheckIsSelfHosted(),
}));

vi.mock('../../src/components/SetupModal.jsx', () => ({
  default: (props: any) => (
    <div
      data-testid="setup-modal"
      data-open={props.open ? 'true' : 'false'}
      data-agent={props.agentName ?? ''}
      data-platform={props.agentPlatform ?? ''}
      data-category={props.agentCategory ?? ''}
    >
      <button data-testid="setup-close" onClick={() => props.onClose?.()}>
        Close
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/FeedbackModal.jsx', () => ({
  default: (props: any) => (
    <div data-testid="feedback-modal" data-open={props.open ? 'true' : 'false'}>
      <button data-testid="feedback-submit" onClick={() => props.onSubmit?.(['Too slow'], 'test')}>
        Submit
      </button>
      <button data-testid="feedback-close" onClick={() => props.onClose?.()}>
        Close
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: () => <span data-testid="info-tooltip" />,
}));

vi.mock('../../src/components/RequestDrawer.jsx', () => ({
  default: (props: { messageId: string | null }) => (
    <div data-testid="request-drawer" data-message-id={props.messageId ?? ''} />
  ),
}));

vi.mock('../../src/components/Select.jsx', () => ({
  default: (props: any) => (
    <select
      data-testid="select"
      value={props.value}
      onChange={(e: any) => props.onChange(e.target.value)}
    >
      {props.options?.map((o: any) => (
        <option value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

vi.mock('../../src/components/ErrorState.jsx', () => ({
  default: (props: any) => <div data-testid="error-state">{props.title}</div>,
}));

vi.mock('../../src/components/Pagination.jsx', () => ({
  default: (props: any) => {
    const total = props.totalItems();
    return total > props.pageSize ? (
      <div data-testid="pagination">
        <button
          data-testid="pagination-prev"
          onClick={props.onPrevious}
          disabled={props.currentPage() <= 1}
        >
          Previous
        </button>
        <button
          data-testid="pagination-next"
          onClick={props.onNext}
          disabled={!props.hasNextPage()}
        >
          Next
        </button>
      </div>
    ) : null;
  },
}));

import MessageLog from '../../src/pages/MessageLog';

const messagesData = {
  items: [
    {
      id: 'msg-12345678',
      timestamp: '2026-02-18T10:00:00Z',
      agent_name: 'test-agent',
      model: 'gpt-4o',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost: 0.01,
      status: 'ok',
      cache_read_tokens: 500,
      cache_creation_tokens: 100,
      duration_ms: 1200,
    },
    {
      id: 'msg-87654321',
      timestamp: '2026-02-18T09:00:00Z',
      agent_name: 'test-agent',
      model: 'claude-3.5-sonnet',
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      cost: 0.02,
      status: 'error',
      cache_read_tokens: null,
      cache_creation_tokens: null,
      duration_ms: null,
    },
  ],
  next_cursor: null,
  total_count: 2,
  providers: ['anthropic', 'openai'],
};

const selectWithOption = (container: HTMLElement, optionText: string): HTMLSelectElement => {
  const select = Array.from(
    container.querySelectorAll<HTMLSelectElement>('[data-testid="select"]'),
  ).find((candidate) => candidate.textContent?.includes(optionText));
  expect(select).toBeDefined();
  return select!;
};

const connectionMultiselect = (container: HTMLElement) =>
  container.querySelector(
    '[data-testid="multiselect"][aria-label="Connection filter"]',
  ) as HTMLSelectElement;

describe('MessageLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockAgentName = 'test-agent';
    mockSearchParams = {};
    mockSearchAgentAccessor = null;
    mockSearchModelAccessor = null;
    mockGetAgents.mockResolvedValue({
      agents: [{ agent_name: 'agent-alpha' }, { agent_name: 'agent-beta' }],
    });
    mockGetMessageFilterOptions.mockResolvedValue({ providers: ['anthropic', 'openai'] });
    mockGetMessageCount.mockResolvedValue(undefined);
    mockGetCustomProviders.mockResolvedValue([]);
    mockGetSpecificityAssignments.mockResolvedValue([]);
    mockGetRoutingStatus.mockResolvedValue({ enabled: false });
    const [ping, setPing] = createSignal(0);
    pingBox.read = ping;
    pingBox.set = setPing;
    resetPlanStore({ enabled: false, plan: 'free' });
  });

  it('renders Requests heading', () => {
    mockGetMessages.mockResolvedValue(messagesData);
    render(() => <MessageLog />);
    expect(screen.getByText('Requests')).toBeDefined();
  });

  it('renders breadcrumb subtitle', () => {
    mockGetMessages.mockResolvedValue(messagesData);
    render(() => <MessageLog />);
    expect(screen.getByText(/Full log of requests from your app/)).toBeDefined();
  });

  it('shows loading skeleton while fetching', () => {
    mockGetMessages.mockReturnValue(new Promise(() => {}));
    const { container } = render(() => <MessageLog />);
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows message items after data loads', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('msg-1234');
      expect(container.textContent).toContain('msg-8765');
      expect(container.textContent).toContain('gpt-4o');
      expect(container.textContent).toContain('claude-3.5-sonnet');
    });
  });

  it('shows total count', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('2 total');
    });
  });

  it('shows table headers', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Date');
      expect(container.textContent).toContain('Cost');
      expect(container.textContent).toContain('Total Tokens');
      expect(container.textContent).toContain('Model');
      expect(container.textContent).toContain('Cache');
      expect(container.textContent).toContain('Latency');
      expect(container.textContent).toContain('Status');
    });
  });

  it('shows formatted costs', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$0.01');
      expect(container.textContent).toContain('$0.02');
    });
  });

  it('shows empty state for new agent', async () => {
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No requests yet');
    });
  });

  it("shows 'no messages match' when filters return 0 results", async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const selects = container.querySelectorAll('[data-testid="select"]');
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: ['openai'],
    });
    await vi.waitFor(() =>
      expect(connectionMultiselect(container)?.textContent).toContain('OpenAI · Default'),
    );
    await fireEvent.change(connectionMultiselect(container), {
      target: { value: 'conn-openai-1' },
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No requests match your filters');
    });
  });

  it('does not show waiting banner when filters return 0 results', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const selects = container.querySelectorAll('[data-testid="select"]');
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });
    const selects = container.querySelectorAll('[data-testid="select"]');
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: ['openai'],
    });
    await fireEvent.change(selects[0], { target: { value: 'openai' } });
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('Waiting for data');
      expect(container.textContent).not.toContain('No requests yet');
    });
  });

  it('shows filter controls when data exists', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const selects = container.querySelectorAll('[data-testid="select"]');
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('lists every connection in the filter, inactive ones included', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const ms = connectionMultiselect(container);
      expect(ms).not.toBeNull();
      // Connection labels are "<provider display name> · <key label>".
      expect(ms.textContent).toContain('OpenAI · Default');
      // Inactive connections stay listed: the log keeps their history.
      expect(ms.textContent).toContain('Anthropic · Team');
      expect(ms.textContent).toContain('All connections');
    });
  });

  it('sends the selected connection ids to the API', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() =>
      expect(connectionMultiselect(container)?.textContent).toContain('OpenAI · Default'),
    );
    mockGetMessages.mockClear();
    await fireEvent.change(connectionMultiselect(container), {
      target: { value: 'conn-openai-1' },
    });
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(
        expect.objectContaining({ connections: 'conn-openai-1' }),
      );
    });
    expect(mockSetSearchParams).toHaveBeenCalledWith(
      { connections: 'conn-openai-1' },
      { replace: true },
    );
  });

  it('shows the loading skeleton when filters change', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('msg-1234');
    });

    // A filter change requests a different dataset and never resolves.
    mockGetMessages.mockReturnValue(new Promise(() => {}));
    await fireEvent.change(connectionMultiselect(container), {
      target: { value: 'conn-openai-1' },
    });

    await vi.waitFor(() => {
      expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    });
    expect(container.textContent).not.toContain('msg-1234');
  });

  it('keeps showing data during a background ping refetch instead of skeletons', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('msg-1234');
    });

    // A background SSE ping refetches the same query and never resolves.
    mockGetMessages.mockReturnValue(new Promise(() => {}));
    pingBox.set(1);
    await vi.waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(2));

    expect(container.textContent).toContain('msg-1234');
    expect(container.querySelectorAll('.skeleton').length).toBe(0);
  });

  it('no longer offers the cost range inputs', async () => {
    // Removed: filtering by an absolute dollar threshold requires already
    // knowing the cost distribution you are trying to discover.
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('msg-1234');
    });
    expect(container.querySelectorAll('.cost-range-filter__input').length).toBe(0);
  });

  it('offers Cancelled as its own status, distinct from Failed', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('msg-1234');
    });
    const status = selectWithOption(container, 'All statuses');
    expect(status.textContent).toContain('Cancelled');

    // The label alone proves nothing: the point of the change is that
    // `cancelled` reaches the API as its own value rather than folding into
    // `failed`, so assert what goes on the wire.
    mockGetMessages.mockClear();
    await fireEvent.change(status, { target: { value: 'cancelled' } });
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled' }),
      );
    });
    expect(mockSetSearchParams).toHaveBeenCalledWith({ status: 'cancelled' }, { replace: true });

    mockGetMessages.mockClear();
    await fireEvent.change(status, { target: { value: 'failed' } });
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });
  });

  it('follows ?model= when navigation changes it after mount', async () => {
    const [searchModel, setSearchModel] = createSignal<string | undefined>('gpt-4o');
    mockSearchModelAccessor = searchModel;
    mockGetMessageFilterOptions.mockResolvedValue({
      providers: ['openai'],
      models: ['gpt-4o', 'claude-3.5-sonnet'],
    });
    mockGetMessages.mockResolvedValue(messagesData);

    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('msg-1234');
    });

    mockGetMessages.mockClear();
    setSearchModel('claude-3.5-sonnet');
    await vi.waitFor(() => {
      const sent = mockGetMessages.mock.calls.map((call) => (call[0] as any)?.model);
      expect(sent).toContain('claude-3.5-sonnet');
    });
  });

  it('lists the tenant models from filter-options in a model filter', async () => {
    mockGetMessageFilterOptions.mockResolvedValue({
      providers: ['openai'],
      models: ['gpt-4o', 'claude-3.5-sonnet'],
    });
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const filter = container.querySelector(
        '[data-testid="multiselect"][aria-label="Model filter"]',
      );
      expect(filter?.textContent).toContain('gpt-4o');
      expect(filter?.textContent).toContain('claude-3.5-sonnet');
    });
  });

  it('requests messages narrowed to the selected model', async () => {
    mockGetMessageFilterOptions.mockResolvedValue({
      providers: ['openai'],
      models: ['gpt-4o', 'claude-3.5-sonnet'],
    });
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="multiselect"][aria-label="Model filter"]'),
      ).toBeTruthy();
    });

    const filter = container.querySelector(
      '[data-testid="multiselect"][aria-label="Model filter"]',
    ) as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: 'gpt-4o' } });

    await vi.waitFor(() => {
      const sentModels = mockGetMessages.mock.calls.map((call) => (call[0] as any)?.model);
      expect(sentModels).toContain('gpt-4o');
    });
  });

  it('shows cache tokens when present', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Read: 500 / Write: 100');
    });
  });

  it('shows dash for null cache tokens', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(2);
    });
  });

  it('shows dash for zero cache tokens', async () => {
    const dataWithZeroCache = {
      ...messagesData,
      items: [{ ...messagesData.items[0], cache_read_tokens: 0, cache_creation_tokens: 0 }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithZeroCache);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      // Zero cache tokens should show dash, not "Read: 0 / Write: 0"
      expect(container.textContent).not.toContain('Read: 0 / Write: 0');
    });
  });

  it('shows formatted duration', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('1.2s');
    });
  });

  it('shows dash for null duration', async () => {
    const dataWithNullDuration = {
      ...messagesData,
      items: [messagesData.items[1]], // second item has duration_ms: null
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithNullDuration);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('claude-3.5-sonnet');
    });
  });

  it('shows sub-second duration in ms format', async () => {
    const dataWithMsDuration = {
      ...messagesData,
      items: [{ ...messagesData.items[0], duration_ms: 423 }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithMsDuration);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('423ms');
    });
  });

  it('calls getMessages on mount', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalled();
    });
  });

  it('filters messages by failed status and writes the URL param', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const selects = container.querySelectorAll('[data-testid="select"]');
      expect(selects.length).toBeGreaterThanOrEqual(3);
    });

    mockGetMessages.mockClear();
    const statusSelect = selectWithOption(container, 'Failed');
    expect(statusSelect.textContent).toContain('Success');
    expect(statusSelect.textContent).not.toContain('Rate limited');
    expect(statusSelect.textContent).not.toContain('Handled fallback');
    await fireEvent.change(statusSelect, { target: { value: 'failed' } });

    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });
    expect(mockSetSearchParams).toHaveBeenCalledWith({ status: 'failed' }, { replace: true });
  });

  it('filters messages by period range', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(selectWithOption(container, 'All time')).toBeDefined();
    });

    const rangeSelect = selectWithOption(container, 'All time');
    expect(rangeSelect.textContent).toContain('Last 24 hours');
    expect(rangeSelect.textContent).toContain('Last 7 days');
    expect(rangeSelect.textContent).toContain('Last 365 days');

    mockGetMessages.mockClear();
    await fireEvent.change(rangeSelect, { target: { value: '7d' } });

    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(expect.objectContaining({ range: '7d' }));
    });
    expect(mockSetSearchParams).toHaveBeenCalledWith({ range: '7d' }, { replace: true });
  });

  it('clamps a Pro-range deep link before loading data for a free plan', async () => {
    mockSearchParams = { range: '365d' };
    // The plan store is resolved by AuthGuard before any page mounts, so the
    // clamp is synchronous — no fetch ever goes out at the PRO range.
    resetPlanStore({ enabled: true, plan: 'free' });
    mockGetMessages.mockResolvedValue(messagesData);

    render(() => <MessageLog />);

    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(expect.objectContaining({ range: '7d' }));
    });
    expect(mockGetMessages).not.toHaveBeenCalledWith(expect.objectContaining({ range: '365d' }));
    await vi.waitFor(() => {
      expect(mockSetSearchParams).toHaveBeenCalledWith({ range: '7d' }, { replace: true });
    });
  });

  it('filters messages by attempt status (plain select, URL-synced)', async () => {
    // Kept, not derivable: "has a failed attempt" is Status=Failed UNION
    // Recovery!=none, and those two selects AND together, so no single choice
    // spans it. The connection cards in GlobalOverview and ConnectionDetail
    // deep-link here with ?attempts=, and would otherwise land unfiltered.
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(selectWithOption(container, 'All attempt statuses')).toBeDefined();
    });
    const attemptSelect = selectWithOption(container, 'All attempt statuses');
    expect(attemptSelect.textContent).toContain('With a failed attempt');
    expect(attemptSelect.textContent).toContain('With a succeeded attempt');

    mockGetMessages.mockClear();
    await fireEvent.change(attemptSelect, { target: { value: 'has_failed' } });
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(
        expect.objectContaining({ attempts: 'has_failed' }),
      );
    });
    expect(mockSetSearchParams).toHaveBeenCalledWith({ attempts: 'has_failed' }, { replace: true });
  });

  it('filters messages by recovery reading (plain select, URL-synced)', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(selectWithOption(container, 'All attempts')).toBeDefined();
    });

    const triggerSelect = selectWithOption(container, 'All attempts');
    expect(triggerSelect.textContent).toContain('With any recovery attempt');
    expect(triggerSelect.textContent).toContain('With an autofix attempt');
    expect(triggerSelect.textContent).toContain('With a fallback attempt');
    expect(triggerSelect.textContent).toContain('No recovery attempt');

    mockGetMessages.mockClear();
    await fireEvent.change(triggerSelect, { target: { value: 'fallback' } });
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'fallback' }),
      );
    });
    expect(mockSetSearchParams).toHaveBeenCalledWith({ trigger: 'fallback' }, { replace: true });

    // 'With any recovery attempt' folds both kinds on the wire, so it matches
    // exactly what the recovered-requests deep links send.
    mockGetMessages.mockClear();
    await fireEvent.change(selectWithOption(container, 'All attempts'), {
      target: { value: 'any' },
    });
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'autofix,fallback' }),
      );
    });
  });

  it('seeds the status filter from the status search param', async () => {
    mockSearchParams = { status: 'failed' };
    mockGetMessages.mockResolvedValue(messagesData);
    render(() => <MessageLog />);

    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });
  });

  describe('status cell', () => {
    it('renders a failed row as a Failed badge with no hover tooltip', async () => {
      // The status-cell hover tooltip was removed — error detail is shown in the
      // expanded accordion now, so the cell is just the binary Failed pill.
      const dataWithError = {
        ...messagesData,
        items: [
          {
            id: 'msg-err12345',
            timestamp: '2026-02-18T10:00:00Z',
            agent_name: 'test-agent',
            model: 'gpt-4o',
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cost: 0,
            status: 'error',
            error_origin: 'provider',
            error_message: '401 Unauthorized: invalid API key',
          },
        ],
      };
      mockGetMessages.mockResolvedValue(dataWithError);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const badge = container.querySelector('.status-badge--error');
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toContain('Failed');
      });
      expect(container.querySelector('.status-badge-tooltip')).toBeNull();
    });
  });

  describe('pagination', () => {
    it('loads rows without a total and counts independently', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetMessageCount.mockResolvedValue({ ...messagesData, total_count: 120 });
      const { container } = render(() => <MessageLog />);

      await vi.waitFor(() => {
        expect(mockGetMessages).toHaveBeenCalledWith(
          expect.objectContaining({
            include_total: 'false',
            include_filter_options: 'false',
            limit: '50',
          }),
        );
        expect(mockGetMessageCount).toHaveBeenCalledWith(
          expect.objectContaining({ agent_name: 'test-agent' }),
        );
        expect(container.textContent).toContain('120 total');
      });
    });

    it('shows pagination when total_count exceeds page size', async () => {
      const bigData = { ...messagesData, total_count: 120, next_cursor: 'cursor-2' };
      mockGetMessages.mockResolvedValue(bigData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="pagination"]')).not.toBeNull();
      });
    });

    it('hides pagination when total_count is within page size', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('2 total');
        expect(container.querySelector('[data-testid="pagination"]')).toBeNull();
      });
    });

    it('Next calls getMessages with cursor after navigating', async () => {
      const bigData = { ...messagesData, total_count: 120, next_cursor: 'cursor-for-page-2' };
      mockGetMessages.mockResolvedValue(bigData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="pagination-next"]')).not.toBeNull();
      });
      mockGetMessages.mockClear();
      mockGetMessages.mockResolvedValue({ ...messagesData, total_count: 120, next_cursor: null });
      const nextBtn = container.querySelector(
        '[data-testid="pagination-next"]',
      ) as HTMLButtonElement;
      nextBtn.click();
      await vi.waitFor(() => {
        expect(mockGetMessages).toHaveBeenCalledWith(
          expect.objectContaining({ cursor: 'cursor-for-page-2' }),
        );
      });
    });

    it('uses lower-bound totals after skipping exact counts on later pages', async () => {
      const firstPage = {
        ...messagesData,
        total_count: 51,
        total_count_exact: false,
        next_cursor: 'cursor-for-page-2',
      };
      mockGetMessages.mockResolvedValue(firstPage);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('51 total');
      });

      mockGetMessages.mockResolvedValue({
        ...messagesData,
        total_count: 2,
        total_count_exact: false,
        next_cursor: null,
      });
      const nextBtn = container.querySelector(
        '[data-testid="pagination-next"]',
      ) as HTMLButtonElement;
      nextBtn.click();

      await vi.waitFor(() => {
        expect(container.textContent).toContain('52 total');
      });
    });
  });

  it('does not send an origin param by default — no origin is hidden', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    render(() => <MessageLog />);
    await vi.waitFor(() => expect(mockGetMessages).toHaveBeenCalled());

    const query = mockGetMessages.mock.calls[0][0] as Record<string, string>;
    expect(query.origin).toBeUndefined();
  });

  it('narrows the log to Manifest-authored failures via the origin filter', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => expect(mockGetMessages).toHaveBeenCalled());

    const originSelect = selectWithOption(container, 'All origins');
    await fireEvent.change(originSelect, { target: { value: 'manifest' } });

    await vi.waitFor(() => {
      const last = mockGetMessages.mock.calls.at(-1)![0] as Record<string, string>;
      expect(last.origin).toBe('manifest');
    });
  });

  it('clears all filters when Clear filters button is clicked', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const selects = container.querySelectorAll('[data-testid="select"]');
      expect(selects.length).toBeGreaterThanOrEqual(1);
    });
    // Set a filter to trigger filtered empty state
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: ['openai'],
    });
    await vi.waitFor(() =>
      expect(connectionMultiselect(container)?.textContent).toContain('OpenAI · Default'),
    );
    await fireEvent.change(connectionMultiselect(container), {
      target: { value: 'conn-openai-1' },
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('No requests match your filters');
    });
    // Click Clear filters
    const clearBtn = container.querySelector('.btn--outline')!;
    fireEvent.click(clearBtn);
    // Filters should be cleared (API re-called)
    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalled();
    });
  });

  it('shows routing tier badge when present', async () => {
    const dataWithTier = {
      ...messagesData,
      items: [{ ...messagesData.items[0], routing_tier: 'simple' }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithTier);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const badge = container.querySelector('.tier-badge');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('simple');
    });
  });

  it('closes setup modal via onClose callback', async () => {
    // To trigger setup modal, we need a new agent without setup completed
    localStorage.removeItem('setup_completed_test-agent');
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    const { container } = render(() => <MessageLog />);
    // The setup-close button in our mock will call onClose
    const closeBtn = container.querySelector('[data-testid="setup-close"]');
    if (closeBtn) {
      fireEvent.click(closeBtn);
    }
    // Verify mock was rendered
    expect(container.querySelector('[data-testid="setup-modal"]')).not.toBeNull();
  });

  it('shows Connect provider button when setupCompleted but no providers', async () => {
    localStorage.setItem('setup_completed_test-agent', '1');
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Connect provider');
      expect(container.textContent).toContain('Connect a provider to start routing LLM calls');
      expect(container.textContent).not.toContain('Enable routing');
      const btn = container.querySelector('.empty-state button.btn--primary');
      expect(btn).not.toBeNull();
    });
  });

  it('navigates to routing with openProviders state when Connect provider clicked', async () => {
    localStorage.setItem('setup_completed_test-agent', '1');
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Connect provider');
    });
    const btn = container.querySelector('.empty-state button.btn--primary') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/harnesses/test-agent/routing', {
      state: { openProviders: true },
    });
  });

  it('shows message table when providers are enabled but no data', async () => {
    mockGetRoutingStatus.mockResolvedValue({ enabled: true });
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.querySelector('.waiting-banner')).not.toBeNull();
      expect(container.querySelector('.empty-state')).toBeNull();
      expect(container.textContent).toContain('0 total');
    });
  });

  it('shows Set up harness when no setupCompleted and no providers', async () => {
    mockGetMessages.mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Set up harness');
      expect(container.textContent).not.toContain('Enable routing');
      expect(container.textContent).not.toContain('Connect provider');
    });
  });

  describe('custom provider models', () => {
    // The backend resolves the custom provider's name into each row
    // (`custom_provider_name`) and ships a `provider_labels` map for the
    // filter dropdown; the page no longer fetches the list itself.
    const customMessagesData = {
      items: [
        {
          id: 'msg-cp1',
          timestamp: '2026-02-18T10:00:00Z',
          agent_name: 'test-agent',
          model: 'custom:abc-123/my-llama',
          provider: 'custom:abc-123',
          custom_provider_name: 'Cohere',
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cost: 0.01,
          status: 'ok',
          cache_read_tokens: null,
          cache_creation_tokens: null,
          duration_ms: 800,
        },
      ],
      next_cursor: null,
      total_count: 1,
      providers: ['custom:abc-123'],
      provider_labels: { 'custom:abc-123': 'Cohere' },
    };

    it('renders custom provider icon in message rows', async () => {
      mockGetMessages.mockResolvedValue(customMessagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const img = container.querySelector('img[alt="Cohere"]');
        expect(img).not.toBeNull();
      });
    });

    it('strips custom prefix from model name display', async () => {
      mockGetMessages.mockResolvedValue(customMessagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('my-llama');
        expect(container.textContent).not.toContain('custom:abc-123/');
      });
    });

    it('labels the connection filter option with the custom provider name', async () => {
      mockGetMessages.mockResolvedValue(customMessagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(connectionMultiselect(container)?.textContent).toContain('Cohere · Default');
      });
    });

    it('falls back to model prefix when custom provider was deleted', async () => {
      const deletedProvider = {
        ...customMessagesData,
        items: [{ ...customMessagesData.items[0], custom_provider_name: null }],
        provider_labels: {},
      };
      mockGetMessages.mockResolvedValue(deletedProvider);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('my-llama');
        expect(container.textContent).not.toContain('custom:abc-123/');
      });
    });

    it('resolves custom provider name + icon in global mode from the response', async () => {
      // Global ("All harnesses") log has no route agent. The backend resolves
      // the custom provider's name into each row (`custom_provider_name`), so
      // custom:<uuid> models still render with the real name and provider icon
      // — the page no longer fetches the provider list itself.
      mockAgentName = undefined;
      mockGetAgents.mockResolvedValue({ agents: [{ agent_name: 'agent-alpha' }] });
      mockGetMessages.mockResolvedValue(customMessagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelector('img[alt="Cohere"]')).not.toBeNull();
        expect(container.textContent).not.toContain('custom:abc-123/');
      });
    });
  });

  describe('clear filters', () => {
    it('clears all filters when clear button is clicked', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const selects = container.querySelectorAll('[data-testid="select"]');
        expect(selects.length).toBeGreaterThanOrEqual(1);
      });

      // Set a filter
      mockGetMessages.mockResolvedValue({
        items: [],
        next_cursor: null,
        total_count: 0,
        providers: ['openai'],
      });
      await vi.waitFor(() =>
        expect(connectionMultiselect(container)?.textContent).toContain('OpenAI · Default'),
      );
      await fireEvent.change(connectionMultiselect(container), {
        target: { value: 'conn-openai-1' },
      });

      await vi.waitFor(() => {
        expect(container.textContent).toContain('No requests match your filters');
      });

      // Click clear filters
      const clearBtn = container.querySelector('.message-log__clear-btn');
      if (clearBtn) {
        mockGetMessages.mockResolvedValue(messagesData);
        fireEvent.click(clearBtn);
        await vi.waitFor(() => {
          expect(container.textContent).toContain('msg-1234');
        });
      }
    });
  });

  it('shows $0.00 cost for flat-fee subscription messages (cost null)', async () => {
    const dataWithSub = {
      ...messagesData,
      items: [{ ...messagesData.items[0], auth_type: 'subscription', cost: null }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithSub);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$0.00');
      expect(container.querySelector('[title="Included in subscription"]')).not.toBeNull();
    });
  });

  it('shows the per-request cost for OpenCode Go subscription messages', async () => {
    const dataWithPerRequestSub = {
      ...messagesData,
      items: [{ ...messagesData.items[0], auth_type: 'subscription', cost: 0.013636 }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithPerRequestSub);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      // Per-request subscriptions (OpenCode Go) carry real costs — don't hide them.
      expect(container.textContent).toContain('$0.01');
      expect(container.querySelector('[title^="Per-request subscription cost:"]')).not.toBeNull();
    });
  });

  it('shows formatCost fallback for non-subscription messages with cost', async () => {
    const dataWithCost = {
      ...messagesData,
      items: [{ ...messagesData.items[0], auth_type: null, cost: 0.05 }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithCost);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$0.05');
    });
  });

  it('renders provider icon SVG for known provider model', async () => {
    const dataWithProvider = {
      ...messagesData,
      items: [{ ...messagesData.items[0], model: 'gpt-4o', auth_type: null }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithProvider);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      // providerIcon returns an inline SVG for known providers
      const providerSpan = container.querySelector('[role="img"]');
      expect(providerSpan).not.toBeNull();
      const svg = providerSpan!.querySelector('svg');
      expect(svg).not.toBeNull();
    });
  });

  it('renders subscription auth badge on provider icon', async () => {
    const dataWithSub = {
      ...messagesData,
      items: [{ ...messagesData.items[0], model: 'claude-sonnet-4', auth_type: 'subscription' }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithSub);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const badge = container.querySelector('.provider-auth-badge--sub');
      expect(badge).not.toBeNull();
    });
  });

  it('renders api_key auth badge when auth_type is api_key', async () => {
    const dataWithApiKey = {
      ...messagesData,
      items: [{ ...messagesData.items[0], model: 'claude-sonnet-4', auth_type: 'api_key' }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithApiKey);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const badge = container.querySelector('.provider-auth-badge--key');
      expect(badge).not.toBeNull();
      const subBadge = container.querySelector('.provider-auth-badge--sub');
      expect(subBadge).toBeNull();
    });
  });

  it('renders meta description tag', () => {
    mockGetMessages.mockResolvedValue(messagesData);
    render(() => <MessageLog />);
    // Meta is mocked as null, just ensure it renders without error
    expect(screen.getByText('Requests')).toBeDefined();
  });

  it('renders routing tier badge when present', async () => {
    const dataWithTier = {
      ...messagesData,
      items: [{ ...messagesData.items[0], routing_tier: 'simple' }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithTier);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const badge = container.querySelector('.tier-badge');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('simple');
    });
  });

  it('renders setup modal', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="setup-modal"]')).not.toBeNull();
    });
  });

  it('renders fallback badge when fallback_from_model is present', async () => {
    const dataWithFallback = {
      ...messagesData,
      items: [{ ...messagesData.items[0], fallback_from_model: 'gpt-4o', fallback_index: 0 }],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithFallback);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      // Fallback is now shown in the Self-heal column, not a Model-cell tier badge.
      const badge = container.querySelector('[title="Fallback"]');
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute('title')).toBe('Fallback');
    });
  });

  it('does not render fallback badge when fallback_from_model is absent', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('gpt-4o');
      const badge = container.querySelector('.tier-badge--fallback');
      expect(badge).toBeNull();
    });
  });

  it('renders a non-ok row as a binary Failed status (fallback_error is no longer its own pill)', async () => {
    const dataWithFailure = {
      ...messagesData,
      items: [
        {
          ...messagesData.items[0],
          status: 'fallback_error',
          model: 'gemini-flash',
          error_origin: 'provider',
          error_message: 'Provider returned HTTP 429, routed to fallback',
        },
      ],
      total_count: 1,
    };
    mockGetMessages.mockResolvedValue(dataWithFailure);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      expect(container.querySelector('.status-badge--fallback_error')).toBeNull();
      const badge = container.querySelector('.status-badge--error');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain('Failed');
    });
  });

  it('assigns row IDs for scroll targeting', async () => {
    mockGetMessages.mockResolvedValue(messagesData);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const row = container.querySelector('#msg-msg-12345678');
      expect(row).not.toBeNull();
    });
  });

  it('shows the fallback trigger badge on the recovered (retry) row', async () => {
    // The redesign moved the fallback indicator to the Trigger column, shown on
    // the row that carries fallback_from_model (the recovered/retry row).
    const dataWithChain = {
      ...messagesData,
      items: [
        {
          id: 'success-1',
          timestamp: '2026-02-18T10:00:00.200Z',
          agent_name: 'test-agent',
          model: 'deepseek-chat',
          input_tokens: 500,
          output_tokens: 100,
          total_tokens: 600,
          cost: 0.01,
          status: 'ok',
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          duration_ms: 800,
          fallback_from_model: 'gemini-flash',
          fallback_index: 0,
        },
        {
          id: 'primary-fail-1',
          timestamp: '2026-02-18T10:00:00.000Z',
          agent_name: 'test-agent',
          model: 'gemini-flash',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost: null,
          status: 'fallback_error',
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          duration_ms: null,
          error_message: 'Provider returned HTTP 429, routed to fallback',
        },
      ],
      total_count: 2,
      providers: ['deepseek', 'gemini'],
    };
    mockGetMessages.mockResolvedValue(dataWithChain);
    const { container } = render(() => <MessageLog />);
    await vi.waitFor(() => {
      const badge = container.querySelector('[title="Fallback"]');
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute('title')).toBe('Fallback');
    });
    // The badge lives on the recovered row, and there's exactly one (the failed
    // original carries no fallback_from_model, so no Self-heal badge).
    expect(container.querySelectorAll('[title="Fallback"]').length).toBe(1);
    const successRow = container.querySelector('#msg-success-1')!;
    expect(successRow.querySelector('[title="Fallback"]')).not.toBeNull();
  });

  describe('Tier filter', () => {
    it('renders a Tier select with Playground among the options', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const selects = container.querySelectorAll('[data-testid="select"]');
        expect(selects.length).toBeGreaterThanOrEqual(2);
      });
      const tierSelect = selectWithOption(container, 'All tiers');
      expect(tierSelect.textContent).toContain('All tiers');
      expect(tierSelect.textContent).toContain('Playground');
      expect(tierSelect.textContent).toContain('Simple');
    });

    it('adds active task-specific categories and defined custom tiers to the tier options', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetSpecificityAssignments.mockResolvedValue([
        { category: 'coding', is_active: true },
        { category: 'trading', is_active: false },
      ]);
      mockGetMessageFilterOptions.mockResolvedValue({
        providers: ['anthropic'],
        header_tiers: [
          { name: 'Premium', ids: ['ht-premium'] },
          { name: 'Legacy', ids: ['ht-legacy'] },
        ],
      });

      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const tierSelect = selectWithOption(container, 'All tiers');
        expect(tierSelect.textContent).toContain('Coding');
        expect(tierSelect.textContent).toContain('Premium');
      });

      const tierSelect = selectWithOption(container, 'All tiers');
      expect(tierSelect.textContent).not.toContain('Trading');
      expect(tierSelect.textContent).toContain('Legacy');
      expect(tierSelect.textContent).not.toContain('Task:');
      expect(tierSelect.textContent).not.toContain('Custom:');
    });

    it('sends routing_tier in the query when a tier is selected', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-testid="select"]').length).toBeGreaterThanOrEqual(
          2,
        );
      });
      const tierSelect = selectWithOption(container, 'All tiers');
      mockGetMessages.mockClear();
      fireEvent.change(tierSelect, { target: { value: 'playground' } });
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.routing_tier).toBe('playground');
      });
    });

    it('sends specificity_category in the query when a task category is selected', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetSpecificityAssignments.mockResolvedValue([{ category: 'coding', is_active: true }]);

      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-testid="select"]').length).toBeGreaterThanOrEqual(
          2,
        );
      });

      const tierSelect = selectWithOption(container, 'All tiers');
      mockGetMessages.mockClear();
      fireEvent.change(tierSelect, { target: { value: 'specificity:coding' } });

      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.specificity_category).toBe('coding');
        expect(lastQ.routing_tier).toBeUndefined();
      });
    });

    it('lists custom tiers on the global log, where no harness is selected', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetMessageFilterOptions.mockResolvedValue({
        providers: ['anthropic'],
        header_tiers: [{ name: 'Premium', ids: ['ht-premium-a', 'ht-premium-b'] }],
      });

      const { container } = render(() => <MessageLog />);

      await vi.waitFor(() => {
        const tierSelect = selectWithOption(container, 'All tiers');
        expect(tierSelect.textContent).toContain('Premium');
      });

      // The regression was the options being fetched per harness: on the
      // global log that resolved to nothing. Pin the request as unscoped, or
      // an agent-scoped fetch would satisfy the assertion above.
      expect(mockGetMessageFilterOptions).toHaveBeenCalled();
      for (const [query] of mockGetMessageFilterOptions.mock.calls) {
        expect(query).not.toHaveProperty('agent_name');
      }
    });

    it('sends header_tier_id in the query when a custom tier is selected', async () => {
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetMessageFilterOptions.mockResolvedValue({
        providers: ['anthropic'],
        header_tiers: [{ name: 'Premium', ids: ['ht-premium'] }],
      });

      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-testid="select"]').length).toBeGreaterThanOrEqual(
          2,
        );
      });

      const tierSelect = selectWithOption(container, 'All tiers');
      mockGetMessages.mockClear();
      fireEvent.change(tierSelect, { target: { value: 'header:ht-premium' } });

      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.header_tier_id).toBe('ht-premium');
        expect(lastQ.routing_tier).toBeUndefined();
      });
    });

    it('filters on every harness defining a same-named custom tier', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetMessageFilterOptions.mockResolvedValue({
        providers: ['anthropic'],
        header_tiers: [{ name: 'Premium', ids: ['ht-alpha', 'ht-beta'] }],
      });

      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(selectWithOption(container, 'All tiers').textContent).toContain('Premium');
      });

      const tierSelect = selectWithOption(container, 'All tiers');
      mockGetMessages.mockClear();
      fireEvent.change(tierSelect, { target: { value: 'header:ht-alpha,ht-beta' } });

      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.header_tier_id).toBe('ht-alpha,ht-beta');
      });
    });
  });

  describe('Agent filter (global mode)', () => {
    it('renders agent filter dropdown in global mode (no agentName)', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const selects = container.querySelectorAll('[data-testid="select"]');
        // agent filter is the first select in global mode
        expect(selects.length).toBeGreaterThanOrEqual(1);
        expect(selects[0].textContent).toContain('All harnesses');
      });
    });

    it('populates agent filter with sorted agent names from getAgents()', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const selects = container.querySelectorAll('[data-testid="select"]');
        expect(selects[0].textContent).toContain('agent-alpha');
        expect(selects[0].textContent).toContain('agent-beta');
      });
    });

    it('requests system agents so the reserved Playground agent appears in the filter', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(mockGetAgents).toHaveBeenCalledWith(true);
      });
    });

    it('seeds the agent filter from the ?agent= search param (View more redirect)', async () => {
      mockAgentName = '';
      mockSearchParams = { agent: 'agent-beta' };
      mockGetMessages.mockResolvedValue(messagesData);
      render(() => <MessageLog />);
      await vi.waitFor(() => {
        const lastCall = mockGetMessages.mock.calls.at(-1)![0] as Record<string, string>;
        expect(lastCall.agent_name).toBe('agent-beta');
      });
    });

    it('ignores the ?agent= search param in agent-scoped mode (route param wins)', async () => {
      // mockAgentName is "test-agent" from beforeEach
      mockSearchParams = { agent: 'agent-beta' };
      mockGetMessages.mockResolvedValue(messagesData);
      render(() => <MessageLog />);
      await vi.waitFor(() => {
        const lastCall = mockGetMessages.mock.calls.at(-1)![0] as Record<string, string>;
        expect(lastCall.agent_name).toBe('test-agent');
      });
    });

    it('does NOT render agent filter dropdown in agent-scoped mode', async () => {
      // mockAgentName is "test-agent" from beforeEach
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const selects = container.querySelectorAll('[data-testid="select"]');
        // In agent mode, no harness select renders; the first Select is the
        // recovery filter (connections stay a multiselect, rendered apart).
        expect(selects[0].textContent).not.toContain('All harnesses');
        expect(selects[0].textContent).toContain('All attempts');
      });
    });

    it('passes agent_name query param when an agent is selected', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      // Wait for agentList to resolve so the options are populated
      await vi.waitFor(() => {
        const agentSelect = container.querySelectorAll(
          '[data-testid="select"]',
        )[0] as HTMLSelectElement;
        expect(agentSelect.textContent).toContain('agent-alpha');
      });
      mockGetMessages.mockClear();
      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      fireEvent.change(agentSelect, { target: { value: 'agent-alpha' } });
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.agent_name).toBe('agent-alpha');
      });
    });

    it('loads custom tier options for the selected agent in global mode', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      mockGetMessageFilterOptions.mockResolvedValue({
        providers: ['anthropic'],
        header_tiers: [{ name: 'Premium', ids: ['ht-premium'] }],
      });

      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const agentSelect = container.querySelectorAll(
          '[data-testid="select"]',
        )[0] as HTMLSelectElement;
        expect(agentSelect.textContent).toContain('agent-alpha');
      });

      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      fireEvent.change(agentSelect, { target: { value: 'agent-alpha' } });

      await vi.waitFor(() => {
        expect(mockGetMessageFilterOptions).toHaveBeenCalledWith(
          expect.objectContaining({ agent_name: 'agent-alpha' }),
        );
        const tierSelect = selectWithOption(container, 'All tiers');
        expect(tierSelect.textContent).toContain('Premium');
      });
    });

    it('pre-seeds the agent filter from the ?agent= query param (View more deep-link)', async () => {
      mockAgentName = '';
      mockSearchParams = { agent: 'agent-beta' };
      mockGetMessages.mockResolvedValue(messagesData);
      render(() => <MessageLog />);
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.agent_name).toBe('agent-beta');
      });
    });

    it('updates the agent filter when the ?agent= query param changes', async () => {
      mockAgentName = '';
      const [searchAgent, setSearchAgent] = createSignal<string | undefined>();
      mockSearchAgentAccessor = searchAgent;
      mockGetMessages.mockResolvedValue(messagesData);

      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        const agentSelect = container.querySelectorAll(
          '[data-testid="select"]',
        )[0] as HTMLSelectElement;
        expect(agentSelect.textContent).toContain('agent-beta');
      });

      mockGetMessages.mockClear();
      setSearchAgent('agent-beta');

      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.agent_name).toBe('agent-beta');
      });
      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      expect(agentSelect.value).toBe('agent-beta');
    });

    it("omits agent_name query param when 'All harnesses' is selected", async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      // Wait for agentList to resolve so the options are populated
      await vi.waitFor(() => {
        const agentSelect = container.querySelectorAll(
          '[data-testid="select"]',
        )[0] as HTMLSelectElement;
        expect(agentSelect.textContent).toContain('agent-alpha');
      });
      // Select an agent first
      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      fireEvent.change(agentSelect, { target: { value: 'agent-alpha' } });
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        expect(calls.some((c: any[]) => c[0]?.agent_name === 'agent-alpha')).toBe(true);
      });
      mockGetMessages.mockClear();
      // Then go back to "All harnesses"
      fireEvent.change(agentSelect, { target: { value: '' } });
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.agent_name).toBeUndefined();
      });
    });

    it('includes agentFilter in hasActiveFilters so filtered-empty state appears', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      // Wait for agentList to resolve before interacting with the filter
      await vi.waitFor(() => {
        const agentSelect = container.querySelectorAll(
          '[data-testid="select"]',
        )[0] as HTMLSelectElement;
        expect(agentSelect.textContent).toContain('agent-alpha');
      });
      mockGetMessages.mockResolvedValue({
        items: [],
        next_cursor: null,
        total_count: 0,
        providers: ['openai'],
      });
      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      fireEvent.change(agentSelect, { target: { value: 'agent-alpha' } });
      await vi.waitFor(() => {
        expect(container.textContent).toContain('No requests match your filters');
      });
    });

    it('clears agentFilter when Clear filters is clicked', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      // Wait for agentList to resolve before interacting with the filter
      await vi.waitFor(() => {
        const agentSelect = container.querySelectorAll(
          '[data-testid="select"]',
        )[0] as HTMLSelectElement;
        expect(agentSelect.textContent).toContain('agent-alpha');
      });
      mockGetMessages.mockResolvedValue({
        items: [],
        next_cursor: null,
        total_count: 0,
        providers: ['openai'],
      });
      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      fireEvent.change(agentSelect, { target: { value: 'agent-alpha' } });
      await vi.waitFor(() => {
        expect(container.textContent).toContain('No requests match your filters');
      });
      // Clear filters — restores data
      mockGetMessages.mockResolvedValue(messagesData);
      const clearBtn = container.querySelector('.btn--outline') as HTMLButtonElement;
      fireEvent.click(clearBtn);
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        expect(calls.some((c: any[]) => !c[0]?.agent_name)).toBe(true);
      });
    });

    it('surfaces getAgents() errors to the resource error state (not silently empty)', async () => {
      mockAgentName = '';
      // The loader no longer swallows errors: when getAgents() rejects the
      // rejection propagates out of the loader so SolidJS resource transitions
      // into error state instead of silently returning [].
      // We verify: (1) getAgents was actually called; (2) the UI still renders
      // the agent filter gracefully via `agentList() ?? []`.
      mockGetAgents.mockImplementation(async () => {
        throw new Error('network error');
      });
      mockGetMessages.mockResolvedValue(messagesData);
      const { container, unmount } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(mockGetAgents).toHaveBeenCalled();
        const selects = container.querySelectorAll('[data-testid="select"]');
        // Agent filter still renders gracefully (agentList() ?? [] = [])
        expect(selects[0].textContent).toContain('All harnesses');
        expect(selects[0].textContent).not.toContain('agent-alpha');
      });
      // Unmount and reset before the rejection can leak into the next test.
      unmount();
      mockGetAgents.mockResolvedValue({ agents: [] });
    });

    it('resets page when agentFilter changes', async () => {
      mockAgentName = '';
      const bigData = { ...messagesData, total_count: 120, next_cursor: 'cursor-2' };
      mockGetMessages.mockResolvedValue(bigData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="pagination-next"]')).not.toBeNull();
      });
      // Navigate to next page
      const nextBtn = container.querySelector(
        '[data-testid="pagination-next"]',
      ) as HTMLButtonElement;
      mockGetMessages.mockResolvedValue({ ...bigData, next_cursor: null });
      nextBtn.click();
      await vi.waitFor(() => {
        expect(mockGetMessages).toHaveBeenCalledWith(
          expect.objectContaining({ cursor: 'cursor-2' }),
        );
      });
      // Changing agent filter should reset page (no cursor)
      mockGetMessages.mockClear();
      mockGetMessages.mockResolvedValue(messagesData);
      const agentSelect = container.querySelectorAll(
        '[data-testid="select"]',
      )[0] as HTMLSelectElement;
      fireEvent.change(agentSelect, { target: { value: 'agent-alpha' } });
      await vi.waitFor(() => {
        const calls = mockGetMessages.mock.calls;
        const lastQ = calls[calls.length - 1]?.[0] ?? {};
        expect(lastQ.cursor).toBeUndefined();
      });
    });

    it("renders 'Harness' column header in the message table when in global mode", async () => {
      // Fix: columns() now inserts 'agent' before 'model' when !params.agentName.
      // This test asserts the Harness column header actually appears in the DOM,
      // not just that the component receives the columns array.
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('gpt-4o');
      });
      const headers = Array.from(container.querySelectorAll('thead th'));
      const headerTexts = headers.map((th) => th.textContent?.trim());
      expect(headerTexts).toContain('Harness');
    });

    it("does NOT render 'Harness' column header in agent-scoped mode", async () => {
      // mockAgentName is "test-agent" from beforeEach — agent-scoped mode.
      // columns() returns DETAILED_COLUMNS unchanged (no 'agent' key).
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('gpt-4o');
      });
      const headers = Array.from(container.querySelectorAll('thead th'));
      const headerTexts = headers.map((th) => th.textContent?.trim());
      expect(headerTexts).not.toContain('Harness');
    });

    it('renders agent_name values in the Agent column cells in global mode', async () => {
      // Each message row must show its agent_name in the Agent cell when
      // the 'agent' column is included (global mode).
      mockAgentName = '';
      const globalMessagesData = {
        ...messagesData,
        items: [
          { ...messagesData.items[0], agent_name: 'alpha-bot' },
          { ...messagesData.items[1], agent_name: 'beta-bot' },
        ],
      };
      mockGetMessages.mockResolvedValue(globalMessagesData);
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('alpha-bot');
        expect(container.textContent).toContain('beta-bot');
      });
    });

    it('renders harness platform icons in global Harness column cells', async () => {
      mockAgentName = '';
      mockGetAgents.mockResolvedValue({
        agents: [
          {
            agent_name: 'alpha-bot',
            agent_platform: 'openclaw',
            agent_category: 'personal',
          },
        ],
      });
      mockGetMessages.mockResolvedValue({
        ...messagesData,
        items: [{ ...messagesData.items[0], agent_name: 'alpha-bot' }],
      });
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('alpha-bot');
        expect(container.querySelector('td img[src="/icons/openclaw.svg"]')).not.toBeNull();
      });
    });
  });

  describe('global mode title and CTA (Bug 2 + Bug 3)', () => {
    it("renders 'Requests - Manifest' title without agent prefix in global mode", () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      const title = container.querySelector('title');
      expect(title?.textContent).toBe('Requests - Manifest');
    });

    it('renders agent-scoped title in agent mode', () => {
      // mockAgentName is "test-agent" from beforeEach
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      const title = container.querySelector('title');
      expect(title?.textContent).toContain('test-agent');
      expect(title?.textContent).toContain('Requests - Manifest');
    });

    it("does not render 'undefined' in the title in global mode", () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue(messagesData);
      const { container } = render(() => <MessageLog />);
      const title = container.querySelector('title');
      expect(title?.textContent).not.toContain('undefined');
    });

    it('does not render SetupModal in global mode (no agentName)', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue({
        items: [],
        next_cursor: null,
        total_count: 0,
        providers: [],
      });
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        // Setup modal must not be rendered when there is no agentName
        expect(container.querySelector('[data-testid="setup-modal"]')).toBeNull();
      });
    });

    it("shows 'Go to Harnesses' link (not SetupModal CTA) in the empty state in global mode", async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue({
        items: [],
        next_cursor: null,
        total_count: 0,
        providers: [],
      });
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('No requests yet');
        // Global empty state guides to /harnesses, not set-up-agent modal
        const link = container.querySelector('a[href="/harnesses"]') as HTMLAnchorElement;
        expect(link).not.toBeNull();
        expect(link.textContent).toContain('Go to Harnesses');
        // No "Set up harness" button in global mode
        expect(container.textContent).not.toContain('Set up harness');
      });
    });

    it('does not navigate to /harnesses/undefined/routing in global mode', async () => {
      mockAgentName = '';
      mockGetMessages.mockResolvedValue({
        items: [],
        next_cursor: null,
        total_count: 0,
        providers: [],
      });
      const { container } = render(() => <MessageLog />);
      await vi.waitFor(() => {
        expect(container.textContent).toContain('No requests yet');
      });
      // Clicking the "Go to Harnesses" link should use the href attribute, not navigate()
      // Verify no button triggers mockNavigate with "/harnesses/undefined/routing"
      expect(mockNavigate).not.toHaveBeenCalledWith(
        expect.stringContaining('undefined'),
        expect.anything(),
      );
    });
  });

  describe('drawer deep-link (?request=)', () => {
    it('opens the side panel for the request named in the URL', async () => {
      mockSearchParams = { request: 'msg-deeplink-1' };
      render(() => <MessageLog />);
      await vi.waitFor(() => {
        const drawer = screen.getByTestId('request-drawer');
        expect(drawer.getAttribute('data-message-id')).toBe('msg-deeplink-1');
      });
      mockSearchParams = {};
    });
  });
});
