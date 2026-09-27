import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';

// Reuses the mock surface from Workspace.test.tsx. Tests here focus on
// AddAgentModal validation edges and the exact shape of the createAgent
// payload, which the happy-path tests don't strictly assert.

const mockNavigate = vi.fn();
let mockSearchParams: Record<string, string | undefined> = {};
const mockSetSearchParams = vi.fn((next: Record<string, string | undefined>) => {
  mockSearchParams = { ...mockSearchParams, ...next };
});
vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams, mockSetSearchParams] as const,
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

const mockGetAgents = vi.fn();
const mockCreateAgent = vi.fn();
const mockDeleteAgent = vi.fn();
const mockGetGlobalProviders = vi.fn();
vi.mock('../../src/services/api.js', () => ({
  getAgents: (...args: unknown[]) => mockGetAgents(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
  getGlobalProviders: (...args: unknown[]) => mockGetGlobalProviders(...args),
}));

// AddAgentModal checks workspace Autofix consent before creating an agent with
// Autofix on (the default). Unmocked it rejects, which fails closed into the
// consent dialog and stops the create these tests assert on.
const mockGetWorkspaceAutofixStatus = vi.fn();
vi.mock('../../src/services/api/analytics.js', () => ({
  getWorkspaceAutofixStatus: (...args: unknown[]) => mockGetWorkspaceAutofixStatus(...args),
}));

vi.mock('../../src/components/DuplicateAgentModal.jsx', () => ({ default: () => null }));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatNumber: (v: number) => String(v),
  formatCost: (v: number) => `$${v.toFixed(2)}`,
}));

vi.mock('../../src/components/Sparkline.jsx', () => ({
  default: () => <div data-testid="sparkline" />,
}));

vi.mock('../../src/services/sse.js', () => ({
  pingCount: () => 0,
  messagePing: () => 0,
  analyticsPing: () => 0,
  agentPing: () => 0,
  routingPing: () => 0,
  refreshAgents: vi.fn(),
}));

vi.mock('../../src/components/AgentTypeSelect.jsx', () => ({
  default: (props: any) => (
    <div
      data-testid="agent-type-picker"
      data-category={props.category ?? ''}
      data-platform={props.platform ?? ''}
      data-disabled={String(!!props.disabled)}
    >
      <button data-testid="pick-app" onClick={() => props.onCategoryChange('app')}>
        App
      </button>
      <button data-testid="pick-langchain" onClick={() => props.onPlatformChange('langchain')}>
        LC
      </button>
    </div>
  ),
}));

const mockMarkAgentCreated = vi.fn();
vi.mock('../../src/services/recent-agents.js', () => ({
  markAgentCreated: (...args: unknown[]) => mockMarkAgentCreated(...args),
  markSetupPending: vi.fn(),
}));

const { MOCK_FREE_PLAN_REQUESTS_PER_MONTH } = vi.hoisted(() => ({
  MOCK_FREE_PLAN_REQUESTS_PER_MONTH: 10_000,
}));

vi.mock('manifest-shared', () => ({
  AGENT_CATEGORIES: ['personal', 'app', 'coding'],
  FREE_PLAN_REQUESTS_PER_MONTH: MOCK_FREE_PLAN_REQUESTS_PER_MONTH,
  PLAN_LIMITS: {
    free: { requestsPerMonth: MOCK_FREE_PLAN_REQUESTS_PER_MONTH },
    pro: { requestsPerMonth: null },
  },
  PLATFORM_ICONS: {},
  PLATFORMS_BY_CATEGORY: {
    personal: ['openclaw', 'hermes', 'other'],
    app: ['openai-sdk', 'vercel-ai-sdk', 'langchain', 'other'],
    coding: ['claude-code', 'other'],
  },
  platformIcon: () => undefined,
}));

import Workspace from '../../src/pages/Workspace';

const openModal = () => {
  const result = render(() => <Workspace />);
  fireEvent.click(screen.getAllByText('Connect Harness')[0]);
  const input = result.container.querySelector('.modal-card__input') as HTMLInputElement;
  const createBtn = Array.from(
    result.container.querySelectorAll<HTMLButtonElement>('.modal-card button.btn--primary'),
  ).pop() as HTMLButtonElement;
  return { ...result, input, createBtn };
};

describe('Workspace AddAgentModal - name validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockGetAgents.mockResolvedValue({ agents: [] });
    mockCreateAgent.mockResolvedValue({ agent: { name: 'stub' }, apiKey: 'k' });
    mockGetGlobalProviders.mockResolvedValue({ providers: [{ provider: 'openai' }] });
    mockGetWorkspaceAutofixStatus.mockResolvedValue({ consented: true });
  });

  it('keeps Create disabled while the name is the empty string', () => {
    const { input, createBtn } = openModal();
    expect(input.value).toBe('');
    expect(createBtn.disabled).toBe(true);
  });

  it('keeps Create disabled when the name is only spaces', () => {
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: '     ' } });
    expect(createBtn.disabled).toBe(true);
  });

  it('keeps Create disabled when the name is only tabs and newlines', () => {
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: '\t\n\t  ' } });
    expect(createBtn.disabled).toBe(true);
  });

  it('does not call createAgent when the user clicks Create with whitespace only', () => {
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.click(createBtn);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it('does not call createAgent when Enter is pressed with whitespace only', () => {
    const { input } = openModal();
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it('enables Create as soon as a single non-space character is typed', () => {
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'a' } });
    expect(createBtn.disabled).toBe(false);
  });

  it('accepts a name with a URL-reserved slash and routes through encodeURIComponent', async () => {
    mockCreateAgent.mockResolvedValue({ agent: { name: 'weird/name' }, apiKey: 'k' });
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'weird/name' } });
    expect(createBtn.disabled).toBe(false);
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/harnesses/weird%2Fname/routing',
        expect.anything(),
      );
    });
  });

  it('accepts a name with a percent sign without double-encoding', async () => {
    mockCreateAgent.mockResolvedValue({ agent: { name: '100%cool' }, apiKey: 'k' });
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: '100%cool' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/harnesses/100%25cool/routing', expect.anything());
    });
  });

  it('accepts a unicode emoji name and url-encodes the navigation target', async () => {
    mockCreateAgent.mockResolvedValue({ agent: { name: 'bot-🚀' }, apiKey: 'k' });
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'bot-🚀' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        `/harnesses/${encodeURIComponent('bot-🚀')}/routing`,
        expect.anything(),
      );
    });
  });

  it('trims surrounding whitespace before submitting the name', async () => {
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: '  spaced-out  ' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: 'spaced-out',
        agent_category: 'personal',
        agent_platform: 'openclaw',
        autofix_enabled: true,
        record_messages: true,
      });
    });
  });

  it('accepts a very long name (256 chars) without truncating client-side', async () => {
    const longName = 'a'.repeat(256);
    mockCreateAgent.mockResolvedValue({ agent: { name: longName }, apiKey: 'k' });
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: longName } });
    expect(createBtn.disabled).toBe(false);
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: longName,
        agent_category: 'personal',
        agent_platform: 'openclaw',
        autofix_enabled: true,
        record_messages: true,
      });
    });
  });
});

describe('Workspace AddAgentModal - exact createAgent payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = {};
    mockGetAgents.mockResolvedValue({ agents: [] });
    mockCreateAgent.mockResolvedValue({ agent: { name: 'demo' }, apiKey: 'k' });
    mockGetGlobalProviders.mockResolvedValue({ providers: [{ provider: 'openai' }] });
    mockGetWorkspaceAutofixStatus.mockResolvedValue({ consented: true });
  });

  it('submits the default category and platform when the user only types a name', async () => {
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'Demo Agent' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: 'Demo Agent',
        agent_category: 'personal',
        agent_platform: 'openclaw',
        autofix_enabled: true,
        record_messages: true,
      });
    });
    // Strict: nothing else was sneaked in (e.g. recordMessages, displayName).
    const call = mockCreateAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual([
      'agent_category',
      'agent_platform',
      'autofix_enabled',
      'name',
      'record_messages',
    ]);
  });

  it('includes the user-selected category and platform in the payload', async () => {
    const { container, input, createBtn } = openModal();
    fireEvent.click(container.querySelector('[data-testid="pick-app"]')!);
    fireEvent.click(container.querySelector('[data-testid="pick-langchain"]')!);
    fireEvent.input(input, { target: { value: 'my-langchain-agent' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: 'my-langchain-agent',
        agent_category: 'app',
        agent_platform: 'langchain',
        autofix_enabled: true,
        record_messages: true,
      });
    });
  });

  it('navigates to the slug returned by the server, not the typed name', async () => {
    mockCreateAgent.mockResolvedValue({ agent: { name: 'demo-agent-1' }, apiKey: 'key-xyz' });
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'Demo Agent' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/harnesses/demo-agent-1/routing', {
        state: { newApiKey: 'key-xyz' },
      });
    });
    expect(mockMarkAgentCreated).toHaveBeenCalledWith('demo-agent-1');
  });

  it('falls back to the typed name when the server omits the slug', async () => {
    mockCreateAgent.mockResolvedValue({ apiKey: 'k' });
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'Fallback Agent' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        `/harnesses/${encodeURIComponent('Fallback Agent')}/routing`,
        { state: { newApiKey: 'k' } },
      );
    });
    expect(mockMarkAgentCreated).toHaveBeenCalledWith('Fallback Agent');
  });

  it('does not call markAgentCreated or navigate when createAgent rejects', async () => {
    mockCreateAgent.mockRejectedValue(new Error('boom'));
    const { input, createBtn } = openModal();
    fireEvent.input(input, { target: { value: 'Demo Agent' } });
    fireEvent.click(createBtn);
    await vi.waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalled();
    });
    expect(mockMarkAgentCreated).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
