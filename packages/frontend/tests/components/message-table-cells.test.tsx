import { describe, it, expect, vi } from 'vitest';
import { render } from '@solidjs/testing-library';
import {
  AutofixIcon,
  FallbackIcon,
  HeartbeatIcon,
  ModelCell,
  AgentCell,
  StatusCell,
  AttemptsCell,
  SelfHealCell,
} from '../../src/components/message-table-cells';
import { fireEvent } from '@solidjs/testing-library';
import type { MessageRow } from '../../src/components/message-table-types';

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatCost: (v: number) => `$${v.toFixed(2)}`,
  formatNumber: (v: number) => String(v),
  formatStatus: (s: string) =>
    ({ ok: 'Success', error: 'Failed', rate_limited: 'Failed', fallback_error: 'Handled' })[s] ?? s,
  formatTime: (t: string) => t,
  formatDuration: (ms: number) => `${ms}ms`,
  formatErrorMessage: (s: string) => s,
  customProviderColor: () => '#6366f1',
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  // Mirror the real helpers' custom-provider behavior so ModelCell's custom
  // branch is exercised; non-custom inputs behave exactly as before.
  inferProviderFromModel: (m: string) => (m.startsWith('custom:') ? 'custom' : null),
  inferProviderName: (m: string) => m,
  resolveProviderId: (p: string) => (p.startsWith('custom:') ? p : undefined),
  stripCustomPrefix: (m: string) => m.replace(/^custom:[^/]+\//, ''),
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/AuthBadge.js', () => ({
  authBadgeFor: () => null,
  authLabel: () => 'API Key',
}));

vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: (props: any) => <span title={props.text} />,
}));

function baseRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '1',
    timestamp: '2025-01-01T00:00:00Z',
    agent_name: 'demo',
    model: 'gpt-4o',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: 0.01,
    status: 'success',
    ...overrides,
  };
}

describe('FallbackIcon', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(() => <FallbackIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('HeartbeatIcon', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(() => <HeartbeatIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('AutofixIcon', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(() => <AutofixIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('AttemptsCell', () => {
  function renderCell(row: MessageRow) {
    return render(() => (
      <table>
        <tbody>
          <tr>{AttemptsCell(row)}</tr>
        </tbody>
      </table>
    ));
  }

  it('renders just the attempt count (no icons) for a row with autofix_applied', () => {
    const { container } = renderCell(baseRow({ attempt_count: 2, autofix_applied: true }));
    expect(container.querySelector('td')!.textContent).toContain('2');
    // Icons moved to SelfHealCell
    expect(container.querySelector('[title="Autofix"]')).toBeNull();
  });

  it('renders just the attempt count (no icons) when fallback_from_model is set', () => {
    const { container } = renderCell(baseRow({ fallback_from_model: 'gpt-4o', attempt_count: 2 }));
    expect(container.querySelector('td')!.textContent).toContain('2');
    // Icons moved to SelfHealCell
    expect(container.querySelector('[title="Fallback"]')).toBeNull();
  });

  it('renders only the count with no badges when neither autofix nor fallback applies', () => {
    const { container } = renderCell(baseRow({ attempt_count: 1 }));
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('td')!.textContent).toContain('1');
  });
});

describe('SelfHealCell', () => {
  function renderCell(row: MessageRow) {
    return render(() => (
      <table>
        <tbody>
          <tr>{SelfHealCell(row)}</tr>
        </tbody>
      </table>
    ));
  }

  it('renders a dash when neither autofix nor fallback applies', () => {
    const { container } = renderCell(baseRow());
    expect(container.querySelector('td')!.textContent).toContain('\u2014');
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('renders autofix badge with icon and text when autofix_applied', () => {
    const { container } = renderCell(baseRow({ autofix_applied: true }));
    const badge = container.querySelector('[title="Autofix"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('trigger-badge--autofix');
    expect(badge.textContent).toContain('autofix');
  });

  it('renders fallback badge with icon and text when fallback_from_model is set', () => {
    const { container } = renderCell(baseRow({ fallback_from_model: 'gpt-4o' }));
    const badge = container.querySelector('[title="Fallback"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('trigger-badge--fallback');
    expect(badge.textContent).toContain('fallback');
  });

  it('renders both badges when both autofix and fallback apply', () => {
    const { container } = renderCell(
      baseRow({ autofix_applied: true, fallback_from_model: 'gpt-4o' }),
    );
    expect(container.querySelector('[title="Autofix"]')).not.toBeNull();
    expect(container.querySelector('[title="Fallback"]')).not.toBeNull();
  });
});

describe('AgentCell', () => {
  it('renders agent_name when present', () => {
    const row = baseRow({ agent_name: 'my-agent' });
    const { container } = render(() => (
      <table>
        <tbody>
          <tr>{AgentCell(row)}</tr>
        </tbody>
      </table>
    ));
    expect(container.textContent).toContain('my-agent');
  });

  it('renders em dash when agent_name is null', () => {
    const row = baseRow({ agent_name: null });
    const { container } = render(() => (
      <table>
        <tbody>
          <tr>{AgentCell(row)}</tr>
        </tbody>
      </table>
    ));
    expect(container.textContent).toContain('—');
  });
});

describe('StatusCell merged pill', () => {
  function renderCell(row: MessageRow) {
    return render(() => (
      <table>
        <tbody>
          <tr>{StatusCell(row, undefined)}</tr>
        </tbody>
      </table>
    ));
  }

  function onlyBadge(container: HTMLElement) {
    const badges = container.querySelectorAll('.status-badge');
    // Exactly ONE pill per cell — the whole point of the merge.
    expect(badges.length).toBe(1);
    return badges[0]!;
  }

  it('renders a provider error as a plain "Failed" pill with the cause as title', () => {
    const { container } = renderCell(
      baseRow({ status: 'error', error_message: 'boom', error_origin: 'provider' }),
    );
    const badge = onlyBadge(container);
    expect(badge.textContent).toContain('Failed');
    expect(badge.getAttribute('title')).toBe('Provider');
    expect(badge.className).toContain('status-badge--error');
  });

  it('carries a transport error cause in the pill title', () => {
    const { container } = renderCell(
      baseRow({ status: 'error', error_message: 'net', error_origin: 'transport' }),
    );
    const badge = onlyBadge(container);
    expect(badge.textContent).toContain('Failed');
    expect(badge.getAttribute('title')).toBe('Transport');
  });

  it('titles a malformed caller body "Bad request", not "Provider"', () => {
    const { container } = renderCell(
      baseRow({
        status: 'error',
        error_message: '[🦚 Manifest M300] `messages` array is required.',
        error_origin: 'request',
        error_class: 'invalid_request',
      }),
    );
    const badge = onlyBadge(container);
    expect(badge.textContent).toContain('Failed');
    expect(badge.getAttribute('title')).toBe('Bad request');
    // `request` is not a policy origin, so no limits link is rendered.
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders a provider rate limit as plain "Failed" with no limits link', () => {
    const { container } = renderCell(
      baseRow({ status: 'rate_limited', error_message: 'rl', error_origin: 'provider' }),
    );
    expect(container.querySelector('a')).toBeNull();
    expect(onlyBadge(container).getAttribute('title')).toBe('Provider');
  });

  it('renders a non-ok fallback_error row as a plain "Failed" pill', () => {
    // fallback_error is no longer a distinct status pill — anything that isn't
    // `ok` is a failure, and the fallback itself is surfaced in the Trigger column.
    const { container } = renderCell(
      baseRow({ status: 'fallback_error', error_message: 'overloaded', error_origin: 'provider' }),
    );
    const badge = onlyBadge(container);
    expect(badge.textContent).toContain('Failed');
    expect(badge.getAttribute('title')).toBe('Provider');
    expect(badge.className).toContain('status-badge--error');
  });

  it('renders a successful row as a single "Success" pill (no descriptor)', () => {
    const { container } = renderCell(baseRow({ status: 'ok' }));
    const badge = onlyBadge(container);
    expect(badge.textContent!.trim()).toBe('Success');
    expect(container.querySelector('a')).toBeNull();
  });

  it.each([
    ['pending', 'Pending'],
    ['cancelled', 'Cancelled'],
  ])('renders %s as a neutral outcome', (status, label) => {
    const { container } = renderCell(baseRow({ status }));
    const badge = onlyBadge(container);
    expect(badge.textContent!.trim()).toBe(label);
    expect(badge.className).toContain('status-badge--neutral');
    expect(badge.className).not.toContain('status-badge--error');
  });

  it("merges a Manifest limit into one red 'Failed' pill linking to its agent's limits", () => {
    const { container } = renderCell(
      baseRow({
        agent_name: 'billing-bot',
        status: 'error',
        error_message: 'Usage limit exceeded',
        error_origin: 'policy',
        error_class: 'limit_exceeded',
      }),
    );
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('/harnesses/billing-bot/limits');
    expect(link!.textContent).toContain('Failed');
    expect(link!.className).toContain('status-badge--error');
    expect(container.querySelectorAll('a').length).toBe(1);
  });

  it('renders a Manifest limit with no agent as the pill without a link', () => {
    const { container } = renderCell(
      baseRow({
        agent_name: null,
        status: 'error',
        error_message: 'Usage limit exceeded',
        error_origin: 'policy',
        error_class: 'limit_exceeded',
      }),
    );
    expect(container.querySelector('a')).toBeNull();
    expect(onlyBadge(container).textContent).toContain('Failed');
    expect(onlyBadge(container).getAttribute('title')).toBe('Custom limit');
  });
});

describe('ModelCell', () => {
  it('renders header tier badge when header_tier_name is set', () => {
    const row = baseRow({
      header_tier_name: 'My Custom Tier',
      header_tier_color: 'rose',
    });
    const { container } = render(() => (
      <table>
        <tbody>
          <tr>{ModelCell(row)}</tr>
        </tbody>
      </table>
    ));
    const badge = container.querySelector('.tier-badge--custom');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('My Custom Tier');
    expect(badge!.className).toContain('tier-color--rose');
  });

  it('uses indigo as default header tier color', () => {
    const row = baseRow({ header_tier_name: 'Tier A' });
    const { container } = render(() => (
      <table>
        <tbody>
          <tr>{ModelCell(row)}</tr>
        </tbody>
      </table>
    ));
    const badge = container.querySelector('.tier-badge--custom');
    expect(badge).not.toBeNull();
    expect(badge!.className).toContain('tier-color--indigo');
  });

  it('renders a custom row with just the model text and the provider name in the tooltip', () => {
    const row = baseRow({
      model: 'custom:u-1/openai/gpt-oss-120b',
      provider: 'custom:u-1',
      custom_provider_name: 'MyLLM',
    });
    const { container } = render(() => (
      <table>
        <tbody>
          <tr>{ModelCell(row)}</tr>
        </tbody>
      </table>
    ));
    expect(container.textContent).toContain('openai/gpt-oss-120b');
    expect(container.textContent).not.toContain('custom:');
    expect(container.textContent).not.toContain('Custom');
    expect(container.querySelector('[title="MyLLM"]')).not.toBeNull();
  });

  it('falls back to a letter avatar from the model when the custom provider was deleted', () => {
    const row = baseRow({
      model: 'custom:gone/my-model',
      provider: 'custom:gone',
      custom_provider_name: null,
    });
    const { container } = render(() => (
      <table>
        <tbody>
          <tr>{ModelCell(row)}</tr>
        </tbody>
      </table>
    ));
    expect(container.textContent).toContain('my-model');
    expect(container.textContent).not.toContain('custom:');
    const avatar = container.querySelector('.provider-card__logo-letter');
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe('M');
  });
});
