import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as messages from '../../../src/services/api/messages';

vi.mock('../../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

function setupFetch(response: unknown = {}, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('messages API client', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getMessages GETs /messages with no params when none are provided', async () => {
    const fetchMock = setupFetch({ rows: [] });
    await messages.getMessages();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/messages');
  });

  it('getMessages forwards filtering params as query string', async () => {
    const fetchMock = setupFetch({ rows: [] });
    await messages.getMessages({
      range: '7d',
      provider: 'openai',
      service_type: 'chat',
      cursor: 'c1',
      limit: '50',
      agent_name: 'demo',
      cost_min: '0.01',
      cost_max: '1.00',
      trigger: 'fallback',
      include_total: 'false',
      include_filter_options: 'false',
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('range=7d');
    expect(url).toContain('provider=openai');
    expect(url).toContain('service_type=chat');
    expect(url).toContain('cursor=c1');
    expect(url).toContain('limit=50');
    expect(url).toContain('agent_name=demo');
    expect(url).toContain('cost_min=0.01');
    expect(url).toContain('cost_max=1.00');
    expect(url).toContain('trigger=fallback');
    expect(url).toContain('include_total=false');
    expect(url).toContain('include_filter_options=false');
  });

  it('getMessages can bypass the GET cache for polling', async () => {
    const fetchMock = setupFetch({ rows: [] });
    const params = { agent_name: 'cache-bypass-demo', limit: '1' };

    await messages.getMessages(params);
    await messages.getMessages(params, { cache: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('getMessageCount requests one row with an exact total', async () => {
    const fetchMock = setupFetch({ total_count: 42 });

    await messages.getMessageCount({ range: '30d', agent_name: 'demo' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/messages');
    expect(url).toContain('range=30d');
    expect(url).toContain('agent_name=demo');
    expect(url).toContain('limit=1');
    expect(url).toContain('include_total=true');
    expect(url).toContain('cache_total=true');
    expect(url).toContain('include_filter_options=false');
  });

  it('getMessageFilterOptions GETs filter metadata with agent scope', async () => {
    const fetchMock = setupFetch({ providers: [] });
    await messages.getMessageFilterOptions({ range: '30d', agent_name: 'demo' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/messages/filter-options');
    expect(url).toContain('range=30d');
    expect(url).toContain('agent_name=demo');
  });

  it('getMessageDetails GETs the details endpoint with encoded id', async () => {
    const fetchMock = setupFetch({ message: {} });
    await messages.getMessageDetails('msg/1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/messages/msg%2F1/details');
  });

  it('setMessageFeedback PATCHes the feedback payload', async () => {
    const fetchMock = setupFetch({});
    await messages.setMessageFeedback('m-1', { rating: 'like', tags: ['fast'], details: 'good' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/messages/m-1/feedback');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      rating: 'like',
      tags: ['fast'],
      details: 'good',
    });
  });

  it('clearMessageFeedback DELETEs the feedback resource', async () => {
    const fetchMock = setupFetch({});
    await messages.clearMessageFeedback('m-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/messages/m-1/feedback');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('flagMessageMiscategorized PATCHes the miscategorized resource', async () => {
    const fetchMock = setupFetch({});
    await messages.flagMessageMiscategorized('m-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/messages/m-1/miscategorized');
    expect((init as RequestInit).method).toBe('PATCH');
  });

  it('clearMessageMiscategorized DELETEs the miscategorized resource', async () => {
    const fetchMock = setupFetch({});
    await messages.clearMessageMiscategorized('m-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/messages/m-1/miscategorized');
    expect((init as RequestInit).method).toBe('DELETE');
  });
});
