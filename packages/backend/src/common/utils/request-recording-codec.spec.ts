import { gzipSync } from 'node:zlib';
import { decodeRequestRecording, encodeRequestRecording } from './request-recording-codec';

const TEST_SECRET = 'recording-codec-secret-at-least-32-characters';

describe('request recording codec', () => {
  const originalKey = process.env['MANIFEST_ENCRYPTION_KEY'];

  beforeEach(() => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = TEST_SECRET;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env['MANIFEST_ENCRYPTION_KEY'];
    else process.env['MANIFEST_ENCRYPTION_KEY'] = originalKey;
  });

  it('round-trips versioned request and response payloads through gzip', async () => {
    const payload = {
      version: 1 as const,
      wire_format: 'openai_chat_completions',
      request_body: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] },
      response_body: { type: 'json' as const, body: { choices: [] } },
    };

    await expect(decodeRequestRecording(await encodeRequestRecording(payload))).resolves.toEqual(
      payload,
    );
  });

  it.each([
    {
      version: 2,
      wire_format: 'openai_chat_completions',
      request_body: {},
      response_body: { type: 'json', body: {} },
    },
    {
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: null,
      response_body: { type: 'json', body: {} },
    },
    {
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: 'invalid',
      response_body: { type: 'json', body: {} },
    },
    {
      version: 1,
      wire_format: 'openai_chat_completions',
      request_body: {},
    },
    {
      version: 1,
      wire_format: '',
      request_body: {},
      response_body: null,
    },
    {
      version: 1,
      request_body: {},
      response_body: null,
    },
  ])('rejects invalid recording payloads', async (payload) => {
    const encoded = await encodeRequestRecording(payload as never);

    await expect(decodeRequestRecording(encoded)).rejects.toThrow(
      'Invalid request recording object',
    );
  });

  it('accepts an attempt with no provider response', async () => {
    const payload = {
      version: 1 as const,
      wire_format: 'anthropic_messages',
      request_body: {},
      response_body: null,
    };

    await expect(decodeRequestRecording(await encodeRequestRecording(payload))).resolves.toEqual(
      payload,
    );
  });

  it('encrypts the stored blob so the plaintext JSON is not recoverable from the bytes', async () => {
    const payload = {
      version: 1 as const,
      wire_format: 'openai_chat_completions',
      request_body: { model: 'test-model', messages: [{ role: 'user', content: 'top-secret-42' }] },
      response_body: { type: 'json' as const, body: { choices: [] } },
    };

    const encoded = await encodeRequestRecording(payload);

    expect(encoded.subarray(0, 4).toString('ascii')).toBe('MRE1');
    expect(encoded.includes('top-secret-42')).toBe(false);
    expect(encoded.includes('openai_chat_completions')).toBe(false);
  });

  it('still decodes legacy gzip-only recordings written before encryption', async () => {
    const payload = {
      version: 1 as const,
      wire_format: 'anthropic_messages',
      request_body: { model: 'legacy-model' },
      response_body: null,
    };

    const legacy = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));

    expect(legacy.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    await expect(decodeRequestRecording(legacy)).resolves.toEqual(payload);
  });

  it('rejects a blob that is neither encrypted nor gzip', async () => {
    await expect(decodeRequestRecording(Buffer.from('not a recording', 'utf8'))).rejects.toThrow(
      'Unrecognized request recording blob: not encrypted and not gzip',
    );
  });

  it('rejects an encrypted blob written under a different secret', async () => {
    const encoded = await encodeRequestRecording({
      version: 1 as const,
      wire_format: 'openai_chat_completions',
      request_body: {},
      response_body: null,
    });

    process.env['MANIFEST_ENCRYPTION_KEY'] = 'a-totally-different-secret-32-chars-long';

    await expect(decodeRequestRecording(encoded)).rejects.toThrow();
  });
});
