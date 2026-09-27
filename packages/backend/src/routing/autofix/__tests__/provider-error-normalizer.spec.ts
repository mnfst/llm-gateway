import { normalizeProviderError, serializeProviderError } from '../provider-error-normalizer';
import type { PhoenixProviderError } from '../phoenix.types';

describe('normalizeProviderError', () => {
  it('extracts all four fields from an OpenAI-compatible envelope', () => {
    const raw = JSON.stringify({
      error: { message: 'm', type: 't', param: 'p', code: 'c' },
    });

    const result = normalizeProviderError(raw);

    // Assert the returned shape matches PhoenixProviderError exactly.
    const expected: PhoenixProviderError = {
      message: 'm',
      type: 't',
      param: 'p',
      code: 'c',
    };
    expect(result).toEqual(expected);
  });

  it('reads message from a flat body (no error key) and nulls the rest', () => {
    const raw = JSON.stringify({ message: 'm' });

    const result = normalizeProviderError(raw);

    expect(result).toEqual({ message: 'm', type: null, param: null, code: null });
  });

  it('reads message from a FastAPI-style {detail} body', () => {
    const body = JSON.stringify({
      detail: "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    });

    expect(normalizeProviderError(body)).toEqual({
      message: "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
      type: null,
      param: null,
      code: null,
    });
  });

  it('treats a whitespace-only bare error string as absent and falls back to the raw body', () => {
    const body = JSON.stringify({ error: '   ' });
    expect(normalizeProviderError(body).message).toBe(body);
  });

  it('reads message from a bare string error field', () => {
    expect(normalizeProviderError(JSON.stringify({ error: 'model not found' }))).toEqual({
      message: 'model not found',
      type: null,
      param: null,
      code: null,
    });
  });

  it('uses the raw body as the message for a non-JSON body', () => {
    const result = normalizeProviderError('boom');

    expect(result).toEqual({ message: 'boom', type: null, param: null, code: null });
  });

  it('falls back to the raw body when JSON parses to a non-object (number)', () => {
    const result = normalizeProviderError('123');

    // JSON.parse('123') === 123, which is not an object → parsed stays null.
    expect(result).toEqual({ message: '123', type: null, param: null, code: null });
  });

  it('falls back to the raw body when JSON parses to null', () => {
    const result = normalizeProviderError('null');

    // JSON.parse('null') === null → the `json && typeof json === 'object'`
    // guard is false, so parsed stays null.
    expect(result).toEqual({ message: 'null', type: null, param: null, code: null });
  });

  it('scrubs an Anthropic-style secret out of the message', () => {
    const secret = `sk-ant-${'a'.repeat(24)}`;
    const raw = JSON.stringify({ error: { message: `bad key ${secret}` } });

    const result = normalizeProviderError(raw);

    expect(result.message).not.toContain(secret);
    expect(result.message).toContain('[REDACTED]');
  });

  it('scrubs a Bearer token out of the message', () => {
    const raw = JSON.stringify({
      error: { message: 'auth failed: Bearer abcdefghijklmnop' },
    });

    const result = normalizeProviderError(raw);

    expect(result.message).not.toContain('abcdefghijklmnop');
    expect(result.message).toContain('Bearer [REDACTED]');
  });

  it('scrubs secrets out of type, param and code (not just message)', () => {
    const secret = `sk-ant-${'a'.repeat(24)}`;
    const raw = JSON.stringify({
      error: { message: 'm', type: `t ${secret}`, param: `p ${secret}`, code: `c ${secret}` },
    });

    const result = normalizeProviderError(raw);

    for (const field of [result.type, result.param, result.code]) {
      expect(field).not.toContain(secret);
      expect(field).toContain('[REDACTED]');
    }
  });

  it('truncates a very long message to 2000 characters', () => {
    const longMessage = 'x'.repeat(5000);
    const raw = JSON.stringify({ error: { message: longMessage } });

    const result = normalizeProviderError(raw);

    expect(result.message).toHaveLength(2000);
    expect(result.message).toBe('x'.repeat(2000));
  });

  it('prefers error.message over a top-level message when both are present', () => {
    const raw = JSON.stringify({
      message: 'top',
      error: { message: 'nested', type: 'nested_type' },
    });

    const result = normalizeProviderError(raw);

    expect(result.message).toBe('nested');
    expect(result.type).toBe('nested_type');
  });

  it('ignores an empty-string error.message and falls back to the top-level message', () => {
    // coerceString returns null for empty strings, exercising the ?? chain's
    // first fallback (error.message empty → parsed.message).
    const raw = JSON.stringify({ message: 'fallback', error: { message: '' } });

    const result = normalizeProviderError(raw);

    expect(result.message).toBe('fallback');
  });

  it('treats a null error field as absent and reads the flat body', () => {
    // parsed.error is present but null → the `parsed.error !== null` guard is
    // false, so errorObj falls back to parsed itself.
    const raw = JSON.stringify({ message: 'flat', error: null });

    const result = normalizeProviderError(raw);

    expect(result).toEqual({ message: 'flat', type: null, param: null, code: null });
  });
});

describe('serializeProviderError', () => {
  const openaiError = JSON.stringify({
    error: {
      message: "Unsupported value: 'temperature' does not support 0.7 with this model.",
      type: 'invalid_request_error',
      param: 'temperature',
      code: 'unsupported_value',
    },
  });

  it('round-trips an envelope through normalize → serialize → normalize', () => {
    const normalized = normalizeProviderError(openaiError);

    const restored = normalizeProviderError(serializeProviderError(normalized));

    // The dims survive the trip. Losing them is what split one error into two
    // Phoenix issues when a stored row was later re-ingested.
    expect(restored).toEqual(normalized);
    expect(restored.param).toBe('temperature');
    expect(restored.code).toBe('unsupported_value');
  });

  it('omits the dimensions the provider did not give us', () => {
    const serialized = serializeProviderError({
      message: 'boom',
      type: null,
      param: null,
      code: null,
    });

    expect(JSON.parse(serialized)).toEqual({ error: { message: 'boom' } });
  });

  it('trims the message so a long error still parses as JSON', () => {
    const serialized = serializeProviderError({
      message: 'x'.repeat(2000),
      type: 'invalid_request_error',
      param: 'temperature',
      code: 'unsupported_value',
    });

    expect(serialized.length).toBeLessThanOrEqual(2000);
    const parsed = normalizeProviderError(serialized);
    expect(parsed.message.startsWith('xxx')).toBe(true);
    expect(parsed.param).toBe('temperature'); // the dims are never the thing that gets cut
    expect(parsed.code).toBe('unsupported_value');
  });

  it('clips a pathologically long dimension rather than storing it whole', () => {
    const serialized = serializeProviderError({
      message: 'm',
      type: null,
      param: 'p'.repeat(5000),
      code: null,
    });

    expect(normalizeProviderError(serialized).param).toHaveLength(1024);
  });

  it('never exceeds the cap, whatever the provider pads', () => {
    // Control characters escape to six JSON bytes each, so bounded dimensions can still
    // exhaust the budget between them. The envelope must fit regardless.
    const cases: PhoenixProviderError[] = [
      { message: 'x'.repeat(9000), type: 't', param: 'p', code: 'c' },
      {
        message: 'm',
        type: '\u0000'.repeat(1024),
        param: '"'.repeat(1024),
        code: '\\'.repeat(1024),
      },
      { message: 'x'.repeat(9000), type: '\u0000'.repeat(1024), param: null, code: null },
      { message: '"'.repeat(3000), type: null, param: null, code: null },
    ];

    for (const error of cases) {
      const serialized = serializeProviderError(error);
      expect(serialized.length).toBeLessThanOrEqual(2000);
      expect(() => JSON.parse(serialized)).not.toThrow();
    }
  });

  it('does not split an astral character when trimming to fit', () => {
    // Cutting a surrogate pair in half orphans one, which JSON renders as `\ud83d`: six
    // characters where there was one. A naive trim therefore grows the envelope past the
    // cap. n=1975 is the length whose cut lands exactly between the two halves.
    for (let n = 1970; n <= 1980; n++) {
      const serialized = serializeProviderError({
        message: 'x'.repeat(n) + '\u{1F600}',
        type: null,
        param: null,
        code: null,
      });

      expect(serialized.length).toBeLessThanOrEqual(2000);
      expect(serialized).not.toContain('\\ud83d');
      expect(() => JSON.parse(serialized)).not.toThrow();
    }
  });

  it('drops the dimensions rather than the whole message when they alone blow the cap', () => {
    const serialized = serializeProviderError({
      message: 'the real error',
      type: '\u0000'.repeat(1024),
      param: '\u0000'.repeat(1024),
      code: '\u0000'.repeat(1024),
    });

    expect(JSON.parse(serialized)).toEqual({ error: { message: 'the real error' } });
  });

  it('escapes a message that would otherwise break the envelope', () => {
    const message = 'he said "hi"\n\\ and left';

    const parsed = normalizeProviderError(
      serializeProviderError({ message, type: null, param: null, code: null }),
    );

    expect(parsed.message).toBe(message);
  });

  it('scrubs secrets even from an error that never went through normalizeProviderError', () => {
    // This is a storage boundary: it must not assume its input is already clean.
    const secret = `sk-ant-${'a'.repeat(24)}`;

    const serialized = serializeProviderError({
      message: `bad key ${secret}`,
      type: `t ${secret}`,
      param: `p ${secret}`,
      code: `c ${secret}`,
    });

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });
});
