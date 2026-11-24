import type { EventSourceMessage } from 'eventsource-parser';
import {
  INCOMPLETE_STREAM_MESSAGE,
  StreamFailure,
  StreamIdleTimeoutError,
  StreamProtocolObserver,
  UpstreamStreamError,
} from '../stream-protocol';

function event(data: unknown, name = ''): EventSourceMessage {
  return {
    data: typeof data === 'string' ? data : JSON.stringify(data),
    event: name,
    id: undefined,
  };
}

describe('StreamProtocolObserver', () => {
  it('accepts OpenAI Chat Completions terminal markers', () => {
    const done = new StreamProtocolObserver('openai_chat_completions');
    expect(done.isComplete()).toBe(false);
    done.observe(event('[DONE]'));
    expect(done.isComplete()).toBe(true);
    expect(() => done.assertComplete()).not.toThrow();

    const finishReason = new StreamProtocolObserver('openai_chat_completions');
    finishReason.observe(event({ choices: [{ finish_reason: 'stop' }, null] }));
    expect(finishReason.isComplete()).toBe(true);
    expect(() => finishReason.assertComplete()).not.toThrow();
  });

  it('surfaces OpenAI Chat Completions error payloads', () => {
    const observer = new StreamProtocolObserver('openai_chat_completions');
    expect(() =>
      observer.observe(event({ error: { message: 'quota exhausted', status: 429 }, choices: [] })),
    ).toThrow(
      expect.objectContaining({
        reason: 'upstream_error',
        status: 429,
        message: 'quota exhausted',
      }),
    );
  });

  it.each(['response.completed', 'response.incomplete'])(
    'accepts the Responses %s terminal event',
    (type) => {
      const observer = new StreamProtocolObserver('openai_responses');
      observer.observe(event({ type }));
      expect(() => observer.assertComplete()).not.toThrow();
    },
  );

  it('reads Responses event names and nested provider errors', () => {
    const observer = new StreamProtocolObserver('openai_responses');
    expect(() =>
      observer.observe(
        event(
          { response: { error: { message: 'response failed', status: 422 } } },
          'response.failed',
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        reason: 'upstream_error',
        status: 422,
        message: 'response failed',
      }),
    );
  });

  it('falls back to a stable provider-error message and status', () => {
    const observer = new StreamProtocolObserver('openai_responses');
    expect(() => observer.observe(event({ type: 'error' }))).toThrow(
      expect.objectContaining({
        status: 502,
        message: 'Upstream provider reported a streaming error.',
      }),
    );
  });

  it('accepts Anthropic message_stop and rejects Anthropic errors', () => {
    const complete = new StreamProtocolObserver('anthropic_messages');
    complete.observe(event({ type: 'message_stop' }));
    expect(() => complete.assertComplete()).not.toThrow();

    const failed = new StreamProtocolObserver('anthropic_messages');
    expect(() =>
      failed.observe(event({ type: 'error', error: { message: 'overloaded' } })),
    ).toThrow(expect.objectContaining({ message: 'overloaded' }));
  });

  it.each(['google_generate_content', 'google_code_assist'] as const)(
    'treats clean EOF as terminal for %s without marking a provider outcome',
    (protocol) => {
      const observer = new StreamProtocolObserver(protocol);
      observer.observe(event('not-json'));
      expect(observer.isComplete()).toBe(false);
      expect(() => observer.assertComplete()).not.toThrow();
    },
  );

  it('surfaces provider-declared errors for Google streams', () => {
    const observer = new StreamProtocolObserver('google_generate_content');
    expect(() =>
      observer.observe(event({ error: { message: 'Resource exhausted', status: 429 } })),
    ).toThrow(
      expect.objectContaining({
        reason: 'upstream_error',
        status: 429,
        message: 'Resource exhausted',
      }),
    );
  });

  it('rejects clean EOF without a protocol completion event', () => {
    const observer = new StreamProtocolObserver('openai_responses');
    observer.observe(event('not-json'));
    expect(() => observer.assertComplete()).toThrow(
      expect.objectContaining({
        reason: 'incomplete_stream',
        status: 503,
        message: INCOMPLETE_STREAM_MESSAGE,
      }),
    );
  });
});

describe('stream failure types', () => {
  it('retains stable reason, status, and cause values', () => {
    const cause = new Error('socket reset');
    const interrupted = new UpstreamStreamError(cause);
    expect(interrupted).toMatchObject({
      name: 'UpstreamStreamError',
      reason: 'stream_interrupted',
      status: 503,
      cause,
    });

    const timeout = new StreamIdleTimeoutError();
    expect(timeout).toMatchObject({
      name: 'StreamIdleTimeoutError',
      reason: 'stream_idle_timeout',
      status: 504,
    });

    const provider = new StreamFailure('upstream_error', 502, 'bad gateway');
    expect(provider).toMatchObject({
      name: 'StreamFailure',
      reason: 'upstream_error',
      status: 502,
      message: 'bad gateway',
    });
  });
});
