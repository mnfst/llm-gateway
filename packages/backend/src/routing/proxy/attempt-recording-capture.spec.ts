import {
  createAttemptRecordingCapture,
  recordingResponseFromText,
} from './attempt-recording-capture';

describe('Provider Attempt recording capture', () => {
  it('preserves JSON and plain-text provider response bodies', () => {
    expect(recordingResponseFromText('{"error":{"message":"invalid"}}')).toEqual({
      type: 'json',
      body: { error: { message: 'invalid' } },
    });
    expect(recordingResponseFromText('provider offline')).toEqual({
      type: 'json',
      body: 'provider offline',
    });
  });

  it('captures the provider-facing SSE stream', () => {
    const requestBody = { messages: [{ role: 'user', content: 'hello' }] };
    const capture = createAttemptRecordingCapture(requestBody, 'openai_chat_completions');
    capture.appendRaw('data: {"delta":"hi"}\n\n');
    capture.appendRaw('data: [DONE]\n\n');

    expect(capture.buildResponseBody()).toEqual({
      type: 'stream',
      raw_sse: 'data: {"delta":"hi"}\n\ndata: [DONE]\n\n',
    });
    expect(capture.buildRecording()).toEqual({
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: requestBody,
      response_body: {
        type: 'stream',
        raw_sse: 'data: {"delta":"hi"}\n\ndata: [DONE]\n\n',
      },
    });
  });

  it('captures a JSON response as one value', () => {
    const capture = createAttemptRecordingCapture({}, 'anthropic_messages');
    capture.setJson({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });

    expect(capture.buildResponseBody()).toEqual({
      type: 'json',
      body: { choices: [{ message: { role: 'assistant', content: 'hello' } }] },
    });
  });

  it('stores an inline image as a marker instead of its base64 bytes', () => {
    const base64 = 'A'.repeat(2048);
    const requestBody = {
      model: 'gpt-5.1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this screenshot?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
    };
    const snapshot = JSON.stringify(requestBody);

    const capture = createAttemptRecordingCapture(requestBody, 'openai_chat_completions');
    capture.setJson({ ok: true });
    const stored = JSON.stringify(capture.buildRecording().request_body);

    expect(stored).not.toContain(base64);
    expect(stored).toContain('[inline image: image/png,');
    expect(stored).toContain('what is in this screenshot?');
    // The provider still gets the image: only the stored copy is redacted.
    expect(JSON.stringify(requestBody)).toBe(snapshot);
  });

  it('keeps the attempt request when no response was captured', () => {
    const capture = createAttemptRecordingCapture({ messages: [] }, 'openai_chat_completions');
    expect(capture.buildResponseBody()).toBeNull();
    expect(capture.buildRecording()).toEqual({
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: { messages: [] },
      response_body: null,
    });
  });
});
