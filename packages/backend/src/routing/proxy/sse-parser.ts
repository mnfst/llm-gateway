import { createParser, type EventSourceMessage, type ParseError } from 'eventsource-parser';

export const DEFAULT_MAX_SSE_BUFFER_SIZE = 1_048_576;
export const SSE_BUFFER_OVERFLOW_MESSAGE =
  'SSE buffer overflow: provider sent data without event boundaries';

export interface SsePayloadParser {
  feed(chunk: string): string[];
  flush(): string[];
}

export interface SsePayloadParserOptions {
  maxBufferSize?: number;
  onComment?: (comment: string) => void;
  onEvent?: (event: EventSourceMessage) => void;
}

function toTransformerPayload(event: EventSourceMessage): string | null {
  if (!event.data || event.data === '[DONE]') return null;

  const lines: string[] = [];
  if (event.event) lines.push(`event: ${event.event}`);
  if (event.id) lines.push(`id: ${event.id}`);
  lines.push(event.data);
  return lines.join('\n');
}

function createPayloadCollector(
  events: string[],
  onFatalError: (error: ParseError) => void,
  options: SsePayloadParserOptions,
) {
  return createParser({
    maxBufferSize: options.maxBufferSize,
    onEvent(event) {
      options.onEvent?.(event);
      const payload = toTransformerPayload(event);
      if (payload) events.push(payload);
    },
    onComment: options.onComment,
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') onFatalError(error);
    },
  });
}

export function createSsePayloadParser(options: SsePayloadParserOptions = {}): SsePayloadParser {
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_SSE_BUFFER_SIZE;
  const events: string[] = [];
  let fatalError: ParseError | null = null;
  const parser = createPayloadCollector(
    events,
    (error) => {
      fatalError = error;
    },
    { ...options, maxBufferSize },
  );

  const drain = (): string[] => {
    if (fatalError) throw new Error(SSE_BUFFER_OVERFLOW_MESSAGE);
    const drained = events.slice();
    events.length = 0;
    return drained;
  };

  const feed = (chunk: string): string[] => {
    if (!chunk) return [];
    parser.feed(chunk);
    return drain();
  };

  const flush = (): string[] => {
    parser.feed('\n\n');
    return drain();
  };

  return { feed, flush };
}

export function formatSseComment(comment: string): string {
  return comment ? `: ${comment}\n\n` : ':\n\n';
}
