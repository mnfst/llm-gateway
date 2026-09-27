import {
  getEncryptionSecret,
  encrypt,
  decrypt,
  decryptBuffer,
  encryptBuffer,
  hasBinaryEnvelope,
  isEncrypted,
  getDecryptionSecrets,
  decryptWithAny,
  timingSafeCompare,
} from './crypto.util';

describe('getEncryptionSecret', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['MANIFEST_ENCRYPTION_KEY'];
    delete process.env['BETTER_AUTH_SECRET'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns MANIFEST_ENCRYPTION_KEY when it is >= 32 chars', () => {
    const key = 'a'.repeat(32);
    process.env['MANIFEST_ENCRYPTION_KEY'] = key;
    expect(getEncryptionSecret()).toBe(key);
  });

  it('warns once when falling back to BETTER_AUTH_SECRET in production', () => {
    jest.resetModules();
    process.env['NODE_ENV'] = 'production';
    process.env['BETTER_AUTH_SECRET'] = 'b'.repeat(48);
    delete process.env['MANIFEST_ENCRYPTION_KEY'];
    let warnSpy: jest.SpyInstance | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Logger } = require('@nestjs/common');
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./crypto.util') as typeof import('./crypto.util');
      expect(mod.getEncryptionSecret()).toBe('b'.repeat(48));
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns BETTER_AUTH_SECRET when MANIFEST_ENCRYPTION_KEY is not set and secret is >= 32 chars', () => {
    const secret = 'b'.repeat(64);
    process.env['BETTER_AUTH_SECRET'] = secret;
    expect(getEncryptionSecret()).toBe(secret);
  });

  it('prefers MANIFEST_ENCRYPTION_KEY over BETTER_AUTH_SECRET', () => {
    const encKey = 'e'.repeat(32);
    const authSecret = 'a'.repeat(64);
    process.env['MANIFEST_ENCRYPTION_KEY'] = encKey;
    process.env['BETTER_AUTH_SECRET'] = authSecret;
    expect(getEncryptionSecret()).toBe(encKey);
  });

  it('throws when no key is set', () => {
    expect(() => getEncryptionSecret()).toThrow(
      'Encryption secret required. Set MANIFEST_ENCRYPTION_KEY or BETTER_AUTH_SECRET (>=32 chars).',
    );
  });

  it('throws when key exists but is shorter than 32 chars', () => {
    process.env['BETTER_AUTH_SECRET'] = 'only-31-chars-long-xxxxxxxxxx!';
    expect(() => getEncryptionSecret()).toThrow('Encryption secret required.');
  });
});

describe('encrypt / decrypt', () => {
  const secret = 'test-secret-that-is-long-enough-for-scrypt';

  it('round-trips plaintext', () => {
    const plaintext = 'hello world';
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it('round-trips empty plaintext', () => {
    // AES-GCM must accept zero-length messages — cipher.update('', 'utf8') and
    // cipher.final() should produce a valid (empty) ciphertext + auth tag that
    // round-trips cleanly. Regression guard for any future refactor that
    // mishandles empty input (e.g. short-circuiting before final()).
    const ciphertext = encrypt('', secret);
    // Even an empty plaintext must produce the 4-part envelope.
    expect(ciphertext.split(':').length).toBe(4);
    expect(decrypt(ciphertext, secret)).toBe('');
  });

  it('round-trips unicode and multi-byte plaintext', () => {
    const plaintext = 'café — 日本語 — 🚀';
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it('produces different ciphertext each call (random salt/iv)', () => {
    const plaintext = 'deterministic?';
    const a = encrypt(plaintext, secret);
    const b = encrypt(plaintext, secret);
    expect(a).not.toBe(b);
  });

  it('decrypt throws on malformed ciphertext', () => {
    expect(() => decrypt('not:valid', secret)).toThrow('Invalid ciphertext format');
  });

  it('decrypt throws on tampered ciphertext', () => {
    const ciphertext = encrypt('secret data', secret);
    const parts = ciphertext.split(':');
    // Flip a character in the encrypted portion
    parts[3] = 'AAAA' + parts[3].slice(4);
    expect(() => decrypt(parts.join(':'), secret)).toThrow();
  });

  it('decrypt throws when the wrong secret is used', () => {
    const ciphertext = encrypt('payload', secret);
    const wrongSecret = 'different-secret-also-long-enough-for-scrypt';
    expect(() => decrypt(ciphertext, wrongSecret)).toThrow();
  });
});

describe('isEncrypted', () => {
  const secret = 'test-secret-that-is-long-enough-for-scrypt';

  it('returns true for a valid encrypted string', () => {
    const ciphertext = encrypt('test', secret);
    expect(isEncrypted(ciphertext)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isEncrypted('just-a-plain-string')).toBe(false);
  });

  it('returns false for wrong number of parts', () => {
    expect(isEncrypted('a:b:c')).toBe(false);
  });

  it('returns false when parts are not valid base64', () => {
    expect(isEncrypted('not!base64:not!base64:not!base64:not!base64')).toBe(false);
  });

  it('returns false when Buffer.from throws (catch branch)', () => {
    // The catch branch in isEncrypted only fires if Buffer.from itself throws.
    // We stub it to throw on any base64 decode call, then assert (a) the
    // function still returns false (i.e. the catch is actually entered) and
    // (b) our mock was invoked with the 'base64' encoding — without (b), a
    // refactor that stopped calling Buffer.from would pass silently and leave
    // the catch branch uncovered.
    const originalFrom = Buffer.from.bind(Buffer);
    const mockFrom = jest.fn().mockImplementation((value: unknown, encoding?: string) => {
      if (encoding === 'base64') throw new Error('mocked');
      return originalFrom(value as string, encoding as BufferEncoding);
    });
    Buffer.from = mockFrom as unknown as typeof Buffer.from;

    try {
      expect(isEncrypted('a:b:c:d')).toBe(false);
      // Confirm the catch branch was actually exercised — at least one
      // base64 decode attempt must have happened before the throw.
      const base64Calls = mockFrom.mock.calls.filter((args) => args[1] === 'base64');
      expect(base64Calls.length).toBeGreaterThan(0);
    } finally {
      Buffer.from = originalFrom as unknown as typeof Buffer.from;
    }
  });

  it('returns false when a part round-trips to a different base64 string', () => {
    // Buffer.from('AB', 'base64').toString('base64') === 'AA==' (re-encoded
    // form), so a non-canonical base64 part that does not round-trip cleanly
    // must be rejected as not-encrypted. This guards the
    // `buf.toString('base64') !== part` branch inside isEncrypted.
    expect(isEncrypted('AB:AB:AB:AB')).toBe(false);
  });
});

describe('getDecryptionSecrets', () => {
  const originalEnv = process.env;
  const KEY = 'k'.repeat(32);
  const PREVIOUS = 'p'.repeat(32);
  const SESSION = 's'.repeat(32);

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['MANIFEST_ENCRYPTION_KEY'];
    delete process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'];
    delete process.env['BETTER_AUTH_SECRET'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('lists the dedicated key first, then PREVIOUS, then the session secret', () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = KEY;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = PREVIOUS;
    process.env['BETTER_AUTH_SECRET'] = SESSION;
    expect(getDecryptionSecrets()).toEqual([KEY, PREVIOUS, SESSION]);
  });

  it('returns only the session secret when it is the encryption fallback', () => {
    process.env['BETTER_AUTH_SECRET'] = SESSION;
    expect(getDecryptionSecrets()).toEqual([SESSION]);
  });

  it('drops short and duplicate candidates', () => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = KEY;
    process.env['MANIFEST_ENCRYPTION_KEY_PREVIOUS'] = 'too-short';
    process.env['BETTER_AUTH_SECRET'] = KEY;
    expect(getDecryptionSecrets()).toEqual([KEY]);
  });

  it('throws when nothing usable is configured', () => {
    expect(() => getDecryptionSecrets()).toThrow('Encryption secret required');
  });
});

describe('decryptWithAny', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  it('reports index 0 for the current secret', () => {
    expect(decryptWithAny(encrypt('v', A), [A, B])).toEqual({ plaintext: 'v', secretIndex: 0 });
  });

  it('falls through to a later secret and reports its index', () => {
    expect(decryptWithAny(encrypt('v', B), [A, B])).toEqual({ plaintext: 'v', secretIndex: 1 });
  });

  it('rethrows the last error when no secret matches', () => {
    expect(() => decryptWithAny(encrypt('v', 'c'.repeat(32)), [A, B])).toThrow();
  });

  it('throws when given no secrets', () => {
    expect(() => decryptWithAny(encrypt('v', A), [])).toThrow('No decryption secret available');
  });
});

describe('encryptBuffer / decryptBuffer', () => {
  const secret = 'buffer-secret-that-is-at-least-32-characters';
  const plain = Buffer.from('binary payload with a known marker', 'utf8');

  it('round-trips arbitrary bytes', () => {
    expect(decryptBuffer(encryptBuffer(plain, secret), secret)).toEqual(plain);
  });

  it('stamps the self-identifying magic prefix', () => {
    const blob = encryptBuffer(plain, secret);
    expect(blob.subarray(0, 4).toString('ascii')).toBe('MRE1');
    expect(hasBinaryEnvelope(blob)).toBe(true);
    expect(hasBinaryEnvelope(Buffer.from([0x1f, 0x8b, 0x08]))).toBe(false);
    expect(hasBinaryEnvelope(Buffer.from('MR', 'ascii'))).toBe(false);
  });

  it('uses a distinct IV for every encryption of the same input', () => {
    const first = encryptBuffer(plain, secret);
    const second = encryptBuffer(plain, secret);
    expect(first.subarray(4, 16).equals(second.subarray(4, 16))).toBe(false);
    expect(first.equals(second)).toBe(false);
  });

  it('rejects a tampered ciphertext', () => {
    const blob = encryptBuffer(plain, secret);
    blob[blob.length - 1] = blob[blob.length - 1] ^ 0xff;
    expect(() => decryptBuffer(blob, secret)).toThrow();
  });

  it('rejects the wrong secret', () => {
    const blob = encryptBuffer(plain, secret);
    expect(() => decryptBuffer(blob, 'another-secret-that-is-at-least-32-chars')).toThrow();
  });

  it('rejects blobs without the magic prefix or with a truncated header', () => {
    expect(() => decryptBuffer(Buffer.from([0x1f, 0x8b, 0x08, 0x00]), secret)).toThrow(
      'Invalid encrypted blob format',
    );
    expect(() => decryptBuffer(Buffer.from('MRE1short', 'ascii'), secret)).toThrow(
      'Invalid encrypted blob format',
    );
  });
});

describe('timingSafeCompare', () => {
  it('accepts identical strings', () => {
    expect(timingSafeCompare('shared-secret', 'shared-secret')).toBe(true);
  });

  it('rejects a different string of the same length', () => {
    expect(timingSafeCompare('aaaaaaaa', 'bbbbbbbb')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(timingSafeCompare('short', 'much-longer-secret')).toBe(false);
    expect(timingSafeCompare('much-longer-secret', 'short')).toBe(false);
  });

  it('treats two empty strings as equal', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });

  it('compares by bytes, so multi-byte characters are handled', () => {
    expect(timingSafeCompare('sécret', 'sécret')).toBe(true);
    // Byte-length equal but different: the comparison itself has to reject
    // these, not the length shortcut that catches 'sécret' vs 'secret'.
    expect(Buffer.byteLength('é')).toBe(Buffer.byteLength('ab'));
    expect(timingSafeCompare('é', 'ab')).toBe(false);
    // Equal in characters, unequal in bytes: guarding on `String.length`
    // instead would reach timingSafeEqual and make it throw.
    expect(timingSafeCompare('é', 'a')).toBe(false);
    expect(timingSafeCompare('sécret', 'secret')).toBe(false);
  });
});
