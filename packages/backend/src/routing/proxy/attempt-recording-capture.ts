import { redactInlineImageDataUrls } from './inline-image-redaction';
import type { RecordingResponseBody, StoredAttemptRecording } from './attempt-recording.types';

export interface AttemptRecordingCapture {
  appendRaw(text: string): void;
  setJson(body: unknown): void;
  setRaw(text: string): void;
  buildResponseBody(): RecordingResponseBody | null;
  buildRecording(): StoredAttemptRecording;
}

export function recordingResponseFromText(raw: string): RecordingResponseBody {
  try {
    return { type: 'json', body: JSON.parse(raw) as unknown };
  } catch {
    return { type: 'json', body: raw };
  }
}

/**
 * Build one Provider Attempt recording. The stored request body is the
 * provider-facing body with inline base64 images replaced by a short marker:
 * the recording is a debugging artifact, and a single screenshot pasted by an
 * agent would otherwise be persisted in full for every attempt. The body sent
 * to the provider is untouched — only this stored copy is redacted, and
 * {@link redactInlineImageDataUrls} returns a copy so the caller's object is
 * never mutated.
 */
export function createAttemptRecordingCapture(
  requestBody: Record<string, unknown>,
  wireFormat: string,
): AttemptRecordingCapture {
  let rawSse = '';
  let jsonBody: unknown;

  const buildResponseBody = (): RecordingResponseBody | null => {
    if (jsonBody !== undefined) return { type: 'json', body: jsonBody };
    if (rawSse) return { type: 'stream', raw_sse: rawSse };
    return null;
  };

  return {
    appendRaw(text: string): void {
      rawSse += text;
    },
    setJson(body: unknown): void {
      jsonBody = body;
      rawSse = '';
    },
    setRaw(text: string): void {
      jsonBody = undefined;
      rawSse = text;
    },
    buildResponseBody,
    buildRecording(): StoredAttemptRecording {
      return {
        version: 1,
        wire_format: wireFormat,
        request_body: redactInlineImageDataUrls(requestBody),
        response_body: buildResponseBody(),
      };
    },
  };
}
