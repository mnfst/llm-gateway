import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import MessageTable from '../../src/components/MessageTable';
import type { MessageRow } from '../../src/components/message-table-types';

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class} title={props.title}>
      {props.children}
    </a>
  ),
}));

const baseRow: MessageRow = {
  id: 'msg-1',
  timestamp: '2026-07-08T16:10:25.191Z',
  agent_name: 'demo-agent',
  model: 'auto',
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  cost: 0,
  status: 'error',
};

function renderStatus(row: Partial<MessageRow>) {
  render(() => (
    <MessageTable
      items={[{ ...baseRow, ...row }]}
      columns={['status']}
      customProviderName={() => undefined}
    />
  ));
}

describe('MessageTable status labels', () => {
  it('labels billing plan request-limit blocks as plan limits', () => {
    renderStatus({
      error_origin: 'policy',
      error_class: 'plan_request_limit_exceeded',
      routing_reason: 'plan_request_limit_exceeded',
      error_http_status: 402,
    });

    const link = screen.getByText('Failed') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/upgrade?reason=requests');
    expect(link.getAttribute('title')).toBe('Free plan request limit reached - upgrade to Pro');
  });

  it('keeps other Manifest policy failures labelled as custom limits', () => {
    renderStatus({
      error_origin: 'policy',
      error_class: 'limit_exceeded',
      error_http_status: null,
    });

    const link = screen.getByText('Failed') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/harnesses/demo-agent/limits');
    expect(link.getAttribute('title')).toBe('Manifest usage limit reached - open your limits');
  });
});
