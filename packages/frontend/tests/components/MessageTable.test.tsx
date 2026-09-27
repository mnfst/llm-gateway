import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import type { MessageRow } from '../../src/components/message-table-types';
import { COMPACT_COLUMNS, DETAILED_COLUMNS } from '../../src/components/message-table-types';

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
  formatErrorOrigin: (o: string | null | undefined) => o ?? null,
  formatTime: (t: string) => t,
  formatDuration: (ms: number) => `${ms}ms`,
  formatErrorMessage: (s: string) => s,
  customProviderColor: () => '#6366f1',
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  inferProviderFromModel: (m: string) => {
    if (m.startsWith('gpt')) return 'openai';
    if (m.startsWith('claude')) return 'anthropic';
    if (m.startsWith('custom:')) return 'custom';
    // Mirror the real heuristic: tagless Ollama models have a colon
    if (!m.includes('/') && /:/.test(m)) return 'ollama';
    if (m.startsWith('deepseek-')) return 'deepseek';
    return null;
  },
  inferProviderName: (m: string) => {
    if (m.startsWith('gpt')) return 'OpenAI';
    if (m.startsWith('claude')) return 'Anthropic';
    return m;
  },
  resolveProviderId: (dbProvider: string) => {
    if (!dbProvider) return undefined;
    // Mirror the real helper: custom:<uuid> is returned unchanged so the
    // caller can bucket per-custom-provider.
    if (dbProvider.startsWith('custom:')) return dbProvider;
    const map: Record<string, string> = {
      openai: 'openai',
      anthropic: 'anthropic',
      'ollama-cloud': 'ollama-cloud',
      ollama: 'ollama',
    };
    return map[dbProvider.toLowerCase()];
  },
  stripCustomPrefix: (m: string) => m.replace(/^custom:[^/]+\//, ''),
}));

vi.mock('../../src/services/providers.js', () => ({
  PROVIDERS: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'ollama-cloud', name: 'Ollama Cloud' },
    { id: 'ollama', name: 'Ollama' },
  ],
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: (id: string) => <span data-testid={`icon-${id}`} />,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/AuthBadge.js', () => ({
  authBadgeFor: (authType: string | null | undefined) =>
    authType ? <span data-testid={`auth-${authType}`} /> : null,
  authLabel: (authType: string | null | undefined) =>
    authType === 'subscription' ? 'Subscription' : 'API Key',
}));

vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: (props: any) => <span data-testid="info-tooltip" title={props.text} />,
}));

vi.mock('../../src/components/MessageDetails.jsx', () => ({
  // Reads `onOpenMessage` so the lazy prop getter that threads it through
  // MessageTable is exercised.
  default: (props: any) => (
    <div
      data-testid="message-details"
      data-id={props.messageId}
      data-has-open={props.onOpenMessage ? 'yes' : 'no'}
    />
  ),
}));

import MessageTable from '../../src/components/MessageTable';

function makeRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'abc12345-6789',
    timestamp: '2026-02-16 10:00:00',
    agent_name: 'test-agent',
    model: 'gpt-4o',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: 0.05,
    status: 'ok',
    ...overrides,
  };
}


describe('MessageTable', () => {
  describe('column configuration', () => {
    it('renders compact column headers', () => {
      const { container } = render(() => (
        <MessageTable
          items={[]}
          columns={COMPACT_COLUMNS}
          agentName="agent-1"
        />
      ));
      const headers = container.querySelectorAll('th');
      expect(headers.length).toBe(10);
      // Identity first (status, when, what), then mechanics.
      expect(headers[0]!.textContent).toContain('Status');
      expect(headers[1]!.textContent).toContain('Date');
      expect(headers[2]!.textContent).toContain('Model');
      expect(headers[3]!.textContent).toContain('Attempts');
      expect(headers[4]!.textContent).toContain('Recovery attempts');
      expect(headers[5]!.textContent).toContain('Request');
      expect(headers[6]!.textContent).toContain('Cost');
      expect(headers[7]!.textContent).toContain('Tokens');
      expect(headers[8]!.textContent).toContain('Cache');
      expect(headers[9]!.textContent).toContain('Latency');
    });

    it('renders detailed column headers with tooltips', () => {
      const { container } = render(() => (
        <MessageTable
          items={[]}
          columns={DETAILED_COLUMNS}
          agentName="agent-1"
          showHeaderTooltips
        />
      ));
      const headers = container.querySelectorAll('th');
      expect(headers.length).toBe(12);
      expect(headers[0]!.textContent).toContain('Status');
      expect(headers[1]!.textContent).toContain('Date');
      expect(headers[2]!.textContent).toContain('Model');
      expect(headers[3]!.textContent).toContain('Attempts');
      expect(headers[4]!.textContent).toContain('Recovery attempts');
      expect(headers[5]!.textContent).toContain('Request');
      expect(headers[7]!.textContent).toContain('Total Tokens');
      expect(headers[10]!.textContent).toContain('Cache');
      expect(headers[11]!.textContent).toContain('Latency');
      // Tooltips should be present for token columns
      const tooltips = container.querySelectorAll('[data-testid="info-tooltip"]');
      expect(tooltips.length).toBeGreaterThanOrEqual(3);
    });

    it('renders "Tokens" without tooltip when showHeaderTooltips is false', () => {
      const { container } = render(() => (
        <MessageTable
          items={[]}
          columns={COMPACT_COLUMNS}
          agentName="agent-1"
        />
      ));
      const tokensHeader = container.querySelectorAll('th')[7]!; // 'totalTokens' is at index 7 in COMPACT_COLUMNS (after selfheal)
      expect(tokensHeader.textContent).toBe('Tokens');
      expect(tokensHeader.querySelector('[data-testid="info-tooltip"]')).toBeNull();
    });

    it('renders same number of columns for each row as headers', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={DETAILED_COLUMNS}
          agentName="agent-1"
          showHeaderTooltips
        />
      ));
      const headers = container.querySelectorAll('th');
      const cells = container.querySelectorAll('tbody td');
      expect(cells.length).toBe(headers.length);
    });
  });

  describe('data rendering', () => {
    it('renders date cell', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('2026-02-16 10:00:00');
    });

    it('renders message ID (first 8 chars)', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ id: 'e83a3049-xxxx' })]}
          columns={['message']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('e83a3049');
    });

    it('renders heartbeat icon when routing_reason is heartbeat', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ routing_reason: 'heartbeat' })]}
          columns={['message']}
          agentName="agent-1"
        />
      ));
      const heartbeat = container.querySelector('[title="Heartbeat"]');
      expect(heartbeat).toBeDefined();
      expect(heartbeat).not.toBeNull();
    });

    it('renders cost value', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ cost: 1.5 })]}
          columns={['cost']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('$1.50');
    });

    it('renders flat-fee subscription cost as $0.00 when cost is null', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ auth_type: 'subscription', cost: null })]}
          columns={['cost']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('$0.00');
      expect(container.querySelector('[title="Included in subscription"]')).not.toBeNull();
    });

    it('renders the per-request cost for OpenCode-Go-style subscriptions', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ auth_type: 'subscription', cost: 0.013636 })]}
          columns={['cost']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('$0.01');
      expect(
        container.querySelector('[title^="Per-request subscription cost:"]'),
      ).not.toBeNull();
    });

    it('renders em dash for null cost', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ cost: null })]}
          columns={['cost']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('\u2014');
    });

    it('renders total tokens', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ total_tokens: 1500 })]}
          columns={['totalTokens']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('1500');
    });

    it('renders input and output tokens', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ input_tokens: 200, output_tokens: 80 })]}
          columns={['input', 'output']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('200');
      expect(container.textContent).toContain('80');
    });

    it('renders cache tokens', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ cache_read_tokens: 500, cache_creation_tokens: 100 })]}
          columns={['cache']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('Read: 500');
      expect(container.textContent).toContain('Write: 100');
    });

    it('renders em dash for zero cache tokens', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ cache_read_tokens: 0, cache_creation_tokens: 0 })]}
          columns={['cache']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('\u2014');
    });

    it('renders duration', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ duration_ms: 450 })]}
          columns={['duration']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('450ms');
    });
  });

  describe('model column', () => {
    it('renders known provider icon and model name', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ model: 'gpt-4o' })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('[data-testid="icon-openai"]')).not.toBeNull();
      expect(container.textContent).toContain('gpt-4o');
    });

    it('uses getModelDisplayName over display_name', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ model: 'gpt-4o', display_name: 'GPT-4o' })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      // getModelDisplayName is mocked to strip custom prefix; for gpt-4o it returns as-is
      expect(container.textContent).toContain('gpt-4o');
    });

    it('uses stored provider over model-name inference for ollama-cloud tagged models', () => {
      const { container } = render(() => (
        <MessageTable
          items={[
            makeRow({ id: 'm1', model: 'gemma4:31b', provider: 'ollama-cloud' }),
            makeRow({ id: 'm2', model: 'deepseek-v3.2', provider: 'ollama-cloud' }),
            makeRow({ id: 'm3', model: 'kimi-k2:1t', provider: 'ollama-cloud' }),
          ]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      // All three rows should render the ollama-cloud icon, not ollama (colon
      // heuristic) or deepseek (prefix match).
      const cloudIcons = container.querySelectorAll('[data-testid="icon-ollama-cloud"]');
      expect(cloudIcons.length).toBe(3);
      expect(container.querySelector('[data-testid="icon-ollama"]')).toBeNull();
      expect(container.querySelector('[data-testid="icon-deepseek"]')).toBeNull();
    });

    it('falls back to model-name inference when provider field is absent (legacy rows)', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ model: 'gpt-4o', provider: null })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('[data-testid="icon-openai"]')).not.toBeNull();
    });

    it('renders the custom avatar when the stored provider is a custom:<id> prefix', () => {
      // Regression guard: a row with stored provider = 'custom:abc' and
      // model = 'custom:abc/my-model' must render the custom letter avatar,
      // NOT the generic provider-icon branch. Without the isCustomProvider
      // check, provId becomes 'custom:abc' (from resolveProviderId) which
      // does not equal 'custom', so the custom branch would be skipped.
      const { container } = render(() => (
        <MessageTable
          items={[
            makeRow({
              model: 'custom:abc/my-model',
              provider: 'custom:abc',
              custom_provider_name: 'MyProvider',
            }),
          ]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      const avatar = container.querySelector('.provider-card__logo-letter');
      expect(avatar).not.toBeNull();
      expect(avatar!.textContent).toBe('M');
      // The text shows just the raw model — no `custom:` prefix, no name echo.
      expect(container.textContent).toContain('my-model');
      expect(container.textContent).not.toContain('custom:');
    });

    it('renders custom provider letter avatar', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ model: 'custom:abc/my-model', custom_provider_name: 'MyProvider' })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      const avatar = container.querySelector('.provider-card__logo-letter');
      expect(avatar).not.toBeNull();
      expect(avatar!.textContent).toBe('M');
    });

    it('renders em dash for null model', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ model: null })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      expect(container.textContent).toContain('\u2014');
    });

    it('renders routing tier badge', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ routing_tier: 'fast' })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      const badge = container.querySelector('.tier-badge--fast');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('fast');
    });

    it('renders direct routing tier badge in uppercase', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ routing_tier: 'direct' })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      const badge = container.querySelector('.tier-badge--direct');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe('DIRECT');
    });

    it('renders specificity category badge (with underscores replaced) over tier badge', () => {
      const { container } = render(() => (
        <MessageTable
          items={[
            makeRow({
              routing_tier: 'fast',
              specificity_category: 'data_analysis',
            }),
          ]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      const specBadge = container.querySelector('.tier-badge--specificity');
      expect(specBadge).not.toBeNull();
      // underscores replaced with spaces
      expect(specBadge!.textContent).toBe('data analysis');
      // When specificity is set, the tier badge is NOT rendered alongside it.
      expect(container.querySelector('.tier-badge--fast')).toBeNull();
    });

    it('no longer renders a fallback badge in the model column (moved to Trigger)', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ fallback_from_model: 'claude-opus-4-6' })]}
          columns={['model']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('.tier-badge--fallback')).toBeNull();
    });
  });

  describe('attempts column', () => {
    it('renders just the attempt count (no icons) for a row with autofix_applied', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ attempt_count: 2, autofix_applied: true })]}
          columns={['attempts']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('td')!.textContent).toContain('2');
      // Icons moved to selfheal column
      expect(container.querySelector('[title="Autofix"]')).toBeNull();
    });

    it('renders just the attempt count (no icons) when fallback_from_model is set', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ id: 'row-77', fallback_from_model: 'gpt-4o', attempt_count: 2 })]}
          columns={['attempts']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('td')!.textContent).toContain('2');
      // Icons moved to selfheal column
      expect(container.querySelector('[title="Fallback"]')).toBeNull();
    });
  });

  describe('selfheal column', () => {
    it('renders autofix icon with text label when autofix_applied', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ autofix_applied: true })]}
          columns={['selfheal']}
          agentName="agent-1"
        />
      ));
      const badge = container.querySelector('[title="Autofix"]') as HTMLElement;
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('autofix');
    });

    it('renders fallback icon with text label when fallback_from_model is set', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ fallback_from_model: 'gpt-4o' })]}
          columns={['selfheal']}
          agentName="agent-1"
        />
      ));
      const badge = container.querySelector('[title="Fallback"]') as HTMLElement;
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain('fallback');
    });

    it('renders dash when neither autofix nor fallback applies', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['selfheal']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('td')!.textContent).toContain('\u2014');
    });
  });

  describe('status column', () => {
    it('renders success status badge', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ status: 'ok' })]}
          columns={['status']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('.status-badge--ok')).not.toBeNull();
    });

    it('renders rate_limited as a plain "Failed" status with no limits link', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ status: 'rate_limited', error_origin: 'provider' })]}
          columns={['status']}
          agentName="my-agent"
        />
      ));
      // A provider rate limit is just a failure — it must not link to the
      // Manifest spend-limits page, and shows the binary Failed pill.
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('.status-badge--error')!.textContent).toContain('Failed');
      expect(container.textContent).not.toContain('rate_limited');
    });

    it('renders a plain Failed badge for an error row (no status-cell tooltip)', () => {
      // The status-cell hover tooltip was removed — error detail now lives in the
      // expanded accordion, so the status cell is just the binary Failed pill.
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ status: 'error', error_message: 'timeout' })]}
          columns={['status']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('.status-badge-tooltip')).toBeNull();
      const badge = container.querySelector('.status-badge--error');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain('Failed');
    });

    it('renders a fallback_error row as a plain "Failed" pill (no status SVG)', () => {
      // fallback_error is no longer a distinct status — it's just a failure, and
      // the fallback itself is surfaced in the Trigger column, not here.
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ status: 'fallback_error', error_origin: 'provider' })]}
          columns={['status']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('.status-badge--fallback_error')).toBeNull();
      const badge = container.querySelector('.status-badge--error');
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain('Failed');
    });
  });

  describe('row configuration', () => {
    it('sets row id with rowIdPrefix', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ id: 'test-id-123' })]}
          columns={['date']}
          agentName="agent-1"
          rowIdPrefix="msg-"
        />
      ));
      const row = container.querySelector('tr[id="msg-test-id-123"]');
      expect(row).not.toBeNull();
    });

    it('does not set row id when rowIdPrefix is omitted', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
        />
      ));
      const bodyRow = container.querySelector('tbody tr');
      expect(bodyRow!.getAttribute('id')).toBeNull();
    });
  });

  describe('expand details', () => {
    it('renders chevron button for each row when expandable', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow(), makeRow({ id: 'row-2' })]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      const buttons = container.querySelectorAll('.msg-detail__chevron-btn');
      expect(buttons.length).toBe(2);
    });

    it('does not render chevron when expandable is false', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
        />
      ));
      expect(container.querySelector('.msg-detail__chevron-btn')).toBeNull();
      expect(container.querySelector('.msg-detail__chevron-th')).toBeNull();
    });

    it('expands details panel when chevron is clicked', async () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      expect(container.querySelector('[data-testid="message-details"]')).toBeNull();
      const btn = container.querySelector('.msg-detail__chevron-btn') as HTMLButtonElement;
      fireEvent.click(btn);
      expect(container.querySelector('[data-testid="message-details"]')).not.toBeNull();
    });

    it('collapses details panel on second click', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      const btn = container.querySelector('.msg-detail__chevron-btn') as HTMLButtonElement;
      fireEvent.click(btn);
      expect(container.querySelector('[data-testid="message-details"]')).not.toBeNull();
      fireEvent.click(btn);
      expect(container.querySelector('[data-testid="message-details"]')).toBeNull();
    });

    it('adds open class to chevron button when expanded', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      const btn = container.querySelector('.msg-detail__chevron-btn') as HTMLElement;
      expect(btn.classList.contains('msg-detail__chevron-btn--open')).toBe(false);
      fireEvent.click(btn);
      expect(btn.classList.contains('msg-detail__chevron-btn--open')).toBe(true);
    });

    it('passes correct messageId to MessageDetails', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ id: 'specific-msg-id' })]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      const btn = container.querySelector('.msg-detail__chevron-btn') as HTMLButtonElement;
      fireEvent.click(btn);
      const details = container.querySelector('[data-testid="message-details"]');
      expect(details).not.toBeNull();
      expect(details!.getAttribute('data-id')).toBe('specific-msg-id');
    });

    it('threads onOpenMessage through to the expanded MessageDetails', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
          expandable
          onOpenMessage={vi.fn()}
        />
      ));
      const btn = container.querySelector('.msg-detail__chevron-btn') as HTMLButtonElement;
      fireEvent.click(btn);
      const details = container.querySelector('[data-testid="message-details"]');
      expect(details!.getAttribute('data-has-open')).toBe('yes');
    });

    it('sets aria-label on chevron button', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      const btn = container.querySelector('.msg-detail__chevron-btn') as HTMLElement;
      expect(btn.getAttribute('aria-label')).toBe('Expand details');
      fireEvent.click(btn);
      expect(btn.getAttribute('aria-label')).toBe('Collapse details');
    });

    it('expands the panel when the row body (a non-interactive cell) is clicked', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date']}
          agentName="agent-1"
          expandable
        />
      ));
      expect(container.querySelector('[data-testid="message-details"]')).toBeNull();
      // Click a plain cell — the click bubbles to the row handler and toggles.
      const cell = container.querySelector('.msg-row--clickable td') as HTMLElement;
      fireEvent.click(cell);
      expect(container.querySelector('[data-testid="message-details"]')).not.toBeNull();
    });

    it('does not expand when an interactive element inside the row is clicked', () => {
      // A Manifest policy-limit row renders an <a> link to the limits page.
      // Clicking it must NOT toggle the row (the handler bails on
      // button/a/[role=button]).
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ status: 'error', error_origin: 'policy', agent_name: 'my-agent' })]}
          columns={['status']}
          agentName="my-agent"
          expandable
        />
      ));
      const link = container.querySelector('.msg-row--clickable a') as HTMLElement;
      expect(link).not.toBeNull();
      fireEvent.click(link);
      expect(container.querySelector('[data-testid="message-details"]')).toBeNull();
    });
  });

  describe('consistency guarantees', () => {
    it('compact and detailed columns render identical model cell for same data', () => {
      const row = makeRow({ model: 'gpt-4o', display_name: 'GPT-4o', routing_tier: 'fast' });

      const { container: compact } = render(() => (
        <MessageTable
          items={[row]}
          columns={COMPACT_COLUMNS}
          agentName="agent-1"
        />
      ));
      const { container: detailed } = render(() => (
        <MessageTable
          items={[row]}
          columns={DETAILED_COLUMNS}
          agentName="agent-1"
          showHeaderTooltips
        />
      ));

      // Both should show the same model text
      const compactModel = compact.querySelector('.tier-badge--fast');
      const detailedModel = detailed.querySelector('.tier-badge--fast');
      expect(compactModel).not.toBeNull();
      expect(detailedModel).not.toBeNull();
      expect(compactModel!.textContent).toBe(detailedModel!.textContent);
    });

    it('compact and detailed columns render identical status cell for same data', () => {
      const row = makeRow({ status: 'error', error_message: 'timeout' });

      const { container: compact } = render(() => (
        <MessageTable
          items={[row]}
          columns={COMPACT_COLUMNS}
          agentName="agent-1"
        />
      ));
      const { container: detailed } = render(() => (
        <MessageTable
          items={[row]}
          columns={DETAILED_COLUMNS}
          agentName="agent-1"
          showHeaderTooltips
        />
      ));

      const compactBadge = compact.querySelector('.status-badge--error');
      const detailedBadge = detailed.querySelector('.status-badge--error');
      expect(compactBadge).not.toBeNull();
      expect(compactBadge!.textContent).toBe(detailedBadge!.textContent);
    });

    it('supports custom column subsets for future pages', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ duration_ms: 300 })]}
          columns={['date', 'cost', 'totalTokens', 'duration', 'status']}
          agentName="agent-1"
        />
      ));
      const headers = container.querySelectorAll('th');
      expect(headers.length).toBe(5);
      expect(headers[0]!.textContent).toContain('Date');
      expect(headers[1]!.textContent).toContain('Cost');
      expect(headers[2]!.textContent).toContain('Tokens');
      expect(headers[3]!.textContent).toContain('Latency');
      expect(headers[4]!.textContent).toContain('Status');
    });
  });

  describe('agent column (global mode)', () => {
    it('renders Agent column header when agent column is in columns list', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ agent_name: 'my-agent' })]}
          columns={['agent', 'date']}
        />
      ));
      const headers = container.querySelectorAll('th');
      expect(headers[0]!.textContent).toContain('Harness');
      expect(headers[1]!.textContent).toContain('Date');
    });

    it('renders agent_name value in agent cell', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ agent_name: 'my-agent' })]}
          columns={['agent']}
        />
      ));
      expect(container.textContent).toContain('my-agent');
    });

    it('renders em dash when agent_name is null', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow({ agent_name: null })]}
          columns={['agent']}
        />
      ));
      expect(container.textContent).toContain('—');
    });

    it('works without agentName prop (global mode)', () => {
      const { container } = render(() => (
        <MessageTable
          items={[makeRow()]}
          columns={['date', 'status']}
        />
      ));
      expect(container.querySelector('.data-table')).not.toBeNull();
    });
  });
});
