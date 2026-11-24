import type { EventSourceMessage } from 'eventsource-parser';
import { TRANSPORT_NETWORK_HTTP_STATUS, TRANSPORT_TIMEOUT_HTTP_STATUS } from 'manifest-shared';
import type { ProviderWireFormat } from './proxy-types';

export type StreamFailureReason =
  'upstream_error' | 'stream_interrupted' | 'stream_idle_timeout' | 'incomplete_stream';

export class StreamFailure extends Error {
  constructor(
    readonly reason: StreamFailureReason,
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StreamFailure';
  }
}

export const STREAM_IDLE_TIMEOUT_MESSAGE =
  'Upstream provider stream timed out while waiting for the next event.';
export const STREAM_INTERRUPTED_MESSAGE = 'Upstream provider stream was interrupted.';
export const INCOMPLETE_STREAM_MESSAGE =
  'Upstream provider stream ended before its completion event.';

export class UpstreamStreamError extends StreamFailure {
  constructor(cause: unknown) {
    super('stream_interrupted', TRANSPORT_NETWORK_HTTP_STATUS, STREAM_INTERRUPTED_MESSAGE, {
      cause,
    });
    this.name = 'UpstreamStreamError';
  }
}

export class StreamIdleTimeoutError extends StreamFailure {
  constructor() {
    super('stream_idle_timeout', TRANSPORT_TIMEOUT_HTTP_STATUS, STREAM_IDLE_TIMEOUT_MESSAGE);
    this.name = 'StreamIdleTimeoutError';
  }
}

interface ParsedEvent {
  type: string | null;
  data: Record<string, unknown> | null;
}

function parseEvent(event: EventSourceMessage): ParsedEvent {
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A non-JSON terminal marker such as [DONE] is handled below.
  }
  const dataType = typeof data?.type === 'string' ? data.type : null;
  return { type: event.event || dataType, data };
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerError(event: ParsedEvent): StreamFailure {
  const error = nestedRecord(event.data?.error);
  const response = nestedRecord(event.data?.response);
  const responseError = nestedRecord(response?.error);
  const messageCandidates = [
    error?.message,
    responseError?.message,
    event.data?.message,
    response?.status_details,
  ];
  const message = messageCandidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  const statusCandidates = [error?.status, responseError?.status, event.data?.status];
  const status = statusCandidates.find(
    (candidate): candidate is number =>
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599,
  );
  return new StreamFailure(
    'upstream_error',
    status ?? 502,
    message ?? 'Upstream provider reported a streaming error.',
  );
}

function chatCompletionFinished(data: Record<string, unknown> | null): boolean {
  if (!Array.isArray(data?.choices)) return false;
  return data.choices.some((choice) => {
    const record = nestedRecord(choice);
    return record?.finish_reason != null;
  });
}

/**
 * Protocol-specific lifecycle observer. Parsing stays delegated to
 * eventsource-parser; this class only interprets provider terminal/error events.
 */
export class StreamProtocolObserver {
  private completed = false;

  constructor(private readonly protocol: ProviderWireFormat) {}

  observe(event: EventSourceMessage): void {
    if (event.data.trim() === '[DONE]') {
      this.completed = true;
      return;
    }

    const parsed = parseEvent(event);
    if (parsed.type === 'error' || parsed.data?.error) {
      throw providerError(parsed);
    }

    if (this.protocol === 'openai_responses') {
      if (parsed.type === 'response.failed') {
        throw providerError(parsed);
      }
      if (parsed.type === 'response.completed' || parsed.type === 'response.incomplete') {
        this.completed = true;
      }
      return;
    }

    if (this.protocol === 'anthropic_messages') {
      if (parsed.type === 'message_stop') this.completed = true;
      return;
    }

    if (this.protocol === 'openai_chat_completions') {
      if (chatCompletionFinished(parsed.data)) this.completed = true;
      return;
    }

    // Google streams have no portable terminal event; clean EOF is terminal.
  }

  isComplete(): boolean {
    return this.completed;
  }

  assertComplete(): void {
    if (this.protocol === 'google_generate_content' || this.protocol === 'google_code_assist') {
      return;
    }
    if (!this.completed) {
      throw new StreamFailure(
        'incomplete_stream',
        TRANSPORT_NETWORK_HTTP_STATUS,
        INCOMPLETE_STREAM_MESSAGE,
      );
    }
  }
}
