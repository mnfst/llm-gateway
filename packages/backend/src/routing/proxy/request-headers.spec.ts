import { sanitizeRequestHeaders } from './request-headers';

describe('sanitizeRequestHeaders', () => {
  it('returns null when no headers are provided', () => {
    expect(sanitizeRequestHeaders({})).toBeNull();
  });

  it('returns null when every header is empty or sensitive', () => {
    expect(
      sanitizeRequestHeaders({
        authorization: 'Bearer mnfst_secret',
        cookie: 'session=abc',
        'x-blank': '   ',
      }),
    ).toBeNull();
  });

  it('keeps ordinary headers and lowercases keys', () => {
    expect(
      sanitizeRequestHeaders({
        'Content-Type': 'application/json',
        'User-Agent': 'curl/8.14.1',
        'X-Custom-Foo': 'bar',
      }),
    ).toEqual({
      'content-type': 'application/json',
      'user-agent': 'curl/8.14.1',
      'x-custom-foo': 'bar',
    });
  });

  it('drops sensitive headers regardless of casing', () => {
    const result = sanitizeRequestHeaders({
      Authorization: 'Bearer mnfst_secret',
      Cookie: 'session=abc',
      'Set-Cookie': 'x=y',
      'Proxy-Authorization': 'Basic xxx',
      'X-API-Key': 'abc',
      'x-safe': 'keep',
    });
    expect(result).toEqual({ 'x-safe': 'keep' });
  });

  it('drops Railway/proxy/transport noise headers regardless of casing', () => {
    const result = sanitizeRequestHeaders({
      'X-Railway-Edge': 'railway/europe-west4-drams3a',
      'X-Railway-Request-Id': 'm5e5d2NRQLKtNMov2JZdWA',
      'X-Forwarded-For': '193.33.57.199',
      'X-Forwarded-Host': 'app.manifest.build',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Port': '443',
      'X-Real-Ip': '193.33.57.199',
      'X-Request-Start': '1779377596677',
      'X-Envoy-External-Address': '193.33.57.199',
      Host: 'app.manifest.build',
      Connection: 'keep-alive',
      'Accept-Encoding': 'gzip',
      'Content-Length': '143',
      'User-Agent': 'curl/8.18.0',
    });
    expect(result).toEqual({ 'user-agent': 'curl/8.18.0' });
  });

  it('flattens array values with comma-space separator', () => {
    expect(sanitizeRequestHeaders({ 'x-multi': ['a', 'b', 'c'] })).toEqual({
      'x-multi': 'a, b, c',
    });
  });

  it('skips headers with null/undefined values', () => {
    expect(
      sanitizeRequestHeaders({
        'x-keep': 'yes',
        'x-null': undefined,
      }),
    ).toEqual({ 'x-keep': 'yes' });
  });

  it('strips control characters and trims whitespace', () => {
    expect(
      sanitizeRequestHeaders({
        'x-dirty': '  hello\u0001world\u007f  ',
      }),
    ).toEqual({ 'x-dirty': 'helloworld' });
  });

  it('truncates values longer than 1024 bytes with an ellipsis', () => {
    const big = 'a'.repeat(2000);
    const result = sanitizeRequestHeaders({ 'x-big': big });
    const value = result!['x-big'];
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(1024);
    expect(value.endsWith('…')).toBe(true);
    // Budget is 1024 bytes − 3 (ellipsis) = 1021 'a's.
    expect(value.slice(0, -1)).toBe('a'.repeat(1021));
  });

  it('truncates multi-byte values by byte length without leaving replacement chars', () => {
    // Each 🦞 is 4 bytes in UTF-8, so 400 of them = 1600 bytes > 1024.
    const big = '🦞'.repeat(400);
    const result = sanitizeRequestHeaders({ 'x-big': big });
    const value = result!['x-big'];
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(1024);
    expect(value.endsWith('…')).toBe(true);
    expect(value).not.toContain('\uFFFD');
  });

  it('caps the total number of headers at 50', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 100; i++) headers[`x-h-${i}`] = 'v';
    const result = sanitizeRequestHeaders(headers);
    expect(Object.keys(result!).length).toBe(50);
  });

  it('accounts for JSON-escaped bytes in the total budget', () => {
    // Values full of " chars — each byte doubles after JSON escaping.
    const headers: Record<string, string> = {};
    for (let i = 0; i < 30; i++) headers[`x-h-${i}`] = '"'.repeat(500);
    const result = sanitizeRequestHeaders(headers);
    const serialized = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(serialized).toBeLessThanOrEqual(8192);
  });

  it('respects the 8 KB total byte budget', () => {
    const headers: Record<string, string> = {};
    // Each entry ~1 KB; at most ~8 should fit (budget is 8192 bytes).
    for (let i = 0; i < 20; i++) headers[`x-chunk-${i}`] = 'a'.repeat(1000);
    const result = sanitizeRequestHeaders(headers);
    const serialized = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(serialized).toBeLessThanOrEqual(8192);
    expect(Object.keys(result!).length).toBeLessThan(20);
    expect(Object.keys(result!).length).toBeGreaterThan(0);
  });
});
