export interface RecordingResponseBody {
  type: 'json' | 'stream';
  body?: unknown;
  raw_sse?: string;
}

export interface StoredAttemptRecording {
  version: 1;
  wire_format: string;
  request_body: Record<string, unknown>;
  response_body: RecordingResponseBody | null;
}
