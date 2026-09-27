import { buildResponsesSseError } from './chatgpt-adapter';
import { isObjectRecord, safeParse } from './chatgpt-helpers';
import { createSsePayloadParser, DEFAULT_MAX_SSE_BUFFER_SIZE } from './sse-parser';

type DownstreamFormat = 'chat-completions' | 'responses';

export interface ChatGptResponseQualifierOptions {
  downstreamFormat: DownstreamFormat;
  timeoutMs?: number;
  maxBufferSize?: number;
}

interface ParsedEvent {
  type: string;
  data: Record<string, unknown>;
}

const encoder = new TextEncoder();
// Allow quiet Codex reasoning beyond generic stream warm-up without delaying
// fallback for the full provider request deadline when no output ever arrives.
export const DEFAULT_CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export function parseCodexSemanticOutputTimeoutMs(
  rawValue = process.env.CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS,
): number {
  const value = rawValue ?? '';
  if (!/^\d+$/.test(value)) return DEFAULT_CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS
    ? parsed
    : DEFAULT_CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS;
}

const CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS = parseCodexSemanticOutputTimeoutMs();

function parseEvent(payload: string): ParsedEvent | null {
  const lines = payload.split('\n');
  const typeLine = lines.find((line) => line.startsWith('event: '));
  const dataLines = lines.filter((line) => !line.startsWith('event: ') && !line.startsWith('id: '));
  const data = safeParse(dataLines.join('\n'));
  if (!typeLine || !data) return null;
  return { type: typeLine.slice(7).trim(), data };
}

function terminalOutput(event: ParsedEvent): Record<string, unknown>[] | null {
  const response = isObjectRecord(event.data.response) ? event.data.response : undefined;
  if (!response) return null;
  return Array.isArray(response.output) ? response.output.filter(isObjectRecord) : [];
}

function outputTextParts(item: Record<string, unknown>): { index: number; text: string }[] {
  if (item.type !== 'message' || !Array.isArray(item.content)) return [];
  return item.content.flatMap((part, index) => {
    if (!isObjectRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') {
      return [];
    }
    return part.text ? [{ index, text: part.text }] : [];
  });
}

function hasUsableOutput(output: Record<string, unknown>[]): boolean {
  return output.some((item) => item.type === 'function_call' || outputTextParts(item).length > 0);
}

function isDeliverable(event: ParsedEvent): boolean {
  if (event.type === 'response.output_text.delta') {
    return typeof event.data.delta === 'string' && event.data.delta.length > 0;
  }
  if (event.type !== 'response.output_item.added') return false;
  const item = isObjectRecord(event.data.item) ? event.data.item : undefined;
  return item?.type === 'function_call';
}

function formatEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function normalizePayload(payload: string): string {
  const lines = payload.split('\n');
  const metadata: string[] = [];
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event: ') || line.startsWith('id: ')) metadata.push(line);
    else data.push(`data: ${line}`);
  }
  return `${[...metadata, ...data].join('\n')}\n\n`;
}

function reasoningText(item: Record<string, unknown>): string {
  if (item.type !== 'reasoning') return '';
  const parts = [...(Array.isArray(item.summary) ? item.summary : [])];
  return parts
    .filter(isObjectRecord)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

function recoveryEvents(output: Record<string, unknown>[], includeReasoning: boolean): string[] {
  const events: string[] = [];

  output.forEach((item, outputIndex) => {
    if (includeReasoning) {
      const reasoning = reasoningText(item);
      if (reasoning) {
        events.push(
          formatEvent('response.reasoning_summary.delta', {
            delta: reasoning,
            item_id: typeof item.id === 'string' ? item.id : undefined,
            output_index: outputIndex,
            summary_index: 0,
          }),
        );
      }
    }

    for (const part of outputTextParts(item)) {
      events.push(
        formatEvent('response.output_text.delta', {
          delta: part.text,
          item_id: typeof item.id === 'string' ? item.id : undefined,
          output_index: outputIndex,
          content_index: part.index,
        }),
      );
    }

    if (item.type === 'function_call') {
      events.push(
        formatEvent('response.output_item.added', {
          output_index: outputIndex,
          item: { ...item, arguments: '' },
        }),
      );
      if (typeof item.arguments === 'string' && item.arguments) {
        events.push(
          formatEvent('response.function_call_arguments.delta', {
            delta: item.arguments,
            item_id: typeof item.id === 'string' ? item.id : undefined,
            output_index: outputIndex,
          }),
        );
      }
    }
  });

  return events;
}

function responseWithBody(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(
  response: Response,
  status: number,
  message: string,
  code: string,
  body?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Response(
    body ??
      JSON.stringify({
        error: { message, type: 'upstream_response_error', code },
      }),
    { status, headers },
  );
}

function replayStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[],
): ReadableStream<Uint8Array> {
  const release = () => reader.releaseLock();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

async function discard(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The qualifier is replacing this body, so a cancellation failure is immaterial.
  } finally {
    reader.releaseLock();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ChatGPT Codex endpoint reports protocol success inside an HTTP 200 SSE
 * body. Hold the body until it contains text/tool output (or a terminal event)
 * so fallback selection does not mistake an empty/failed generation for a
 * successful provider attempt.
 */
export async function qualifyChatGptResponse(
  response: Response,
  options: ChatGptResponseQualifierOptions,
): Promise<Response> {
  if (!response.ok) return response;
  if (!response.body) {
    return errorResponse(
      response,
      502,
      'ChatGPT Codex returned an empty response body',
      'empty_response',
    );
  }

  const timeoutMs = options.timeoutMs ?? CODEX_SEMANTIC_OUTPUT_TIMEOUT_MS;
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_SSE_BUFFER_SIZE;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSsePayloadParser({ maxBufferSize });
  const buffered: Uint8Array[] = [];
  const payloads: string[] = [];
  let bufferedSize = 0;
  let sawReasoningDelta = false;
  const semanticOutputDeadline = performance.now() + timeoutMs;

  const processPayloads = async (newPayloads: string[]): Promise<Response | null> => {
    for (const payload of newPayloads) {
      payloads.push(payload);
      const event = parseEvent(payload);
      if (!event) continue;

      if (isDeliverable(event)) {
        return responseWithBody(response, replayStream(reader, buffered));
      }
      if (
        event.type === 'response.reasoning_summary.delta' ||
        event.type === 'response.reasoning_summary_text.delta'
      ) {
        sawReasoningDelta = true;
      }
      if (event.type === 'error' || event.type === 'response.failed') {
        const error = buildResponsesSseError(event.data);
        await discard(reader);
        return errorResponse(
          response,
          error.status,
          error.message,
          'upstream_stream_error',
          error.body,
        );
      }
      if (event.type === 'response.incomplete') {
        return responseWithBody(response, replayStream(reader, buffered));
      }
      if (event.type !== 'response.completed') continue;

      const terminal = terminalOutput(event);
      if (!terminal || !hasUsableOutput(terminal)) {
        await discard(reader);
        return errorResponse(
          response,
          502,
          'ChatGPT Codex completed without text or tool output',
          'empty_response',
        );
      }

      if (options.downstreamFormat === 'responses') {
        return responseWithBody(response, replayStream(reader, buffered));
      }

      await discard(reader);
      const terminalIndex = payloads.length - 1;
      const recovered = [
        ...payloads.slice(0, terminalIndex).map(normalizePayload),
        ...recoveryEvents(terminal, !sawReasoningDelta),
        normalizePayload(payloads[terminalIndex]),
        'data: [DONE]\n\n',
      ].join('');
      return responseWithBody(response, encoder.encode(recovered));
    }
    return null;
  };

  try {
    while (true) {
      const remainingMs = Math.max(0, semanticOutputDeadline - performance.now());
      const read = await readWithTimeout(reader, remainingMs);
      if (!read) {
        await discard(reader);
        return errorResponse(
          response,
          504,
          `ChatGPT Codex produced no text or tool output within ${timeoutMs}ms`,
          'stream_timeout',
        );
      }

      if (read.done) {
        const tail = decoder.decode();
        const parsed = [...parser.feed(tail), ...parser.flush()];
        const terminal = await processPayloads(parsed);
        if (terminal) return terminal;
        reader.releaseLock();
        return errorResponse(
          response,
          502,
          'ChatGPT Codex ended without text or tool output',
          'empty_response',
        );
      }

      bufferedSize += read.value.byteLength;
      if (bufferedSize > maxBufferSize) {
        await discard(reader);
        return errorResponse(
          response,
          502,
          'ChatGPT Codex produced too much non-output stream data',
          'stream_buffer_overflow',
        );
      }
      buffered.push(read.value);
      const qualified = await processPayloads(
        parser.feed(decoder.decode(read.value, { stream: true })),
      );
      if (qualified) return qualified;
    }
  } catch {
    await discard(reader);
    return errorResponse(
      response,
      502,
      'ChatGPT Codex stream failed before producing output',
      'upstream_stream_error',
    );
  }
}
