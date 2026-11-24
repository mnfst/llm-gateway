import { classifyCaller } from './caller-classifier';

describe('classifyCaller', () => {
  it('returns null when no identifying headers are present', () => {
    expect(classifyCaller({})).toBeNull();
    expect(classifyCaller({ 'content-type': 'application/json' })).toBeNull();
  });

  it('classifies the OpenAI JS SDK from User-Agent + stainless headers', () => {
    const result = classifyCaller({
      'user-agent': 'OpenAI/JS 6.26.0',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '6.26.0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.17.1',
      'x-stainless-os': 'Linux',
      'x-stainless-arch': 'x64',
    });

    expect(result).toEqual({
      sdk: 'openai-js',
      sdkVersion: '6.26.0',
      runtime: 'node',
      runtimeVersion: 'v22.17.1',
      os: 'Linux',
      arch: 'x64',
      userAgent: 'OpenAI/JS 6.26.0',
    });
  });

  it('classifies the Anthropic SDK', () => {
    const result = classifyCaller({ 'user-agent': 'anthropic-sdk-js/0.20.0' });
    expect(result?.sdk).toBe('anthropic-js');
    expect(result?.sdkVersion).toBe('0.20.0');
  });

  it('classifies curl', () => {
    const result = classifyCaller({ 'user-agent': 'curl/8.14.1' });
    expect(result?.sdk).toBe('curl');
    expect(result?.sdkVersion).toBe('8.14.1');
  });

  it('classifies python-requests', () => {
    const result = classifyCaller({ 'user-agent': 'python-requests/2.31.0' });
    expect(result?.sdk).toBe('python-requests');
    expect(result?.sdkVersion).toBe('2.31.0');
  });

  it('classifies node-fetch', () => {
    const result = classifyCaller({ 'user-agent': 'node-fetch/3.3.0' });
    expect(result?.sdk).toBe('node-fetch');
    expect(result?.sdkVersion).toBe('3.3.0');
  });

  it('classifies axios', () => {
    const result = classifyCaller({ 'user-agent': 'axios/1.6.0' });
    expect(result?.sdk).toBe('axios');
    expect(result?.sdkVersion).toBe('1.6.0');
  });

  it('classifies the n8n community node', () => {
    const result = classifyCaller({
      'user-agent': 'n8n-nodes-manifest',
      'x-title': 'n8n',
      'http-referer': 'https://n8n.io',
    });
    expect(result).toEqual({
      sdk: 'n8n-nodes-manifest',
      userAgent: 'n8n-nodes-manifest',
      appName: 'n8n',
      appUrl: 'https://n8n.io',
    });
  });

  it('classifies a versioned n8n community node User-Agent', () => {
    const result = classifyCaller({ 'user-agent': 'n8n-nodes-manifest/0.2.2' });
    expect(result?.sdk).toBe('n8n-nodes-manifest');
    expect(result?.sdkVersion).toBe('0.2.2');
  });

  it('falls back to stainless-{lang} when UA does not match a known pattern', () => {
    const result = classifyCaller({
      'user-agent': 'mystery-client/1.2.3',
      'x-stainless-lang': 'python',
      'x-stainless-package-version': '1.5.0',
    });
    expect(result?.sdk).toBe('stainless-python');
    expect(result?.sdkVersion).toBe('1.5.0');
  });

  it('uses stainless headers alone when User-Agent is missing', () => {
    const result = classifyCaller({
      'x-stainless-lang': 'go',
      'x-stainless-package-version': '0.9.0',
    });
    expect(result?.sdk).toBe('stainless-go');
    expect(result?.sdkVersion).toBe('0.9.0');
  });

  it('marks UA-only requests as unknown when no SDK pattern matches', () => {
    const result = classifyCaller({ 'user-agent': 'mystery-client/1.0' });
    expect(result?.sdk).toBe('unknown');
    expect(result?.sdkVersion).toBeUndefined();
  });

  it('captures OpenRouter-style attribution headers (HTTP-Referer, X-Title)', () => {
    const result = classifyCaller({
      'user-agent': 'curl/8.0',
      'http-referer': 'https://example.com/some/path?query=1',
      'x-title': 'Example App',
    });
    expect(result?.appName).toBe('Example App');
    expect(result?.appUrl).toBe('https://example.com');
  });

  it('prefers X-OpenRouter-Title over X-Title', () => {
    const result = classifyCaller({
      'user-agent': 'curl/8.0',
      'x-openrouter-title': 'Newer Title',
      'x-title': 'Old Title',
    });
    expect(result?.appName).toBe('Newer Title');
  });

  it('parses categories, trims, caps length and count', () => {
    const long = 'x'.repeat(50);
    const result = classifyCaller({
      'user-agent': 'curl/8.0',
      'x-openrouter-categories': `  chat , coding,,  ${long}, a, b, c, d, e, f, g, h, i, j`,
    });
    expect(result?.categories).toHaveLength(10);
    expect(result?.categories?.[0]).toBe('chat');
    expect(result?.categories?.[1]).toBe('coding');
    expect(result?.categories?.[2]).toHaveLength(32);
  });

  it('returns undefined categories when the header is only commas and whitespace', () => {
    const result = classifyCaller({
      'user-agent': 'curl/8.0',
      'x-openrouter-categories': ' , , ',
    });
    expect(result?.categories).toBeUndefined();
  });

  it('stores the raw value when HTTP-Referer is not a valid URL', () => {
    const result = classifyCaller({
      'user-agent': 'curl/8.0',
      'http-referer': 'not a url',
    });
    expect(result?.appUrl).toBe('not a url');
  });

  it('falls back to Referer when HTTP-Referer is absent', () => {
    const result = classifyCaller({
      'user-agent': 'curl/8.0',
      referer: 'https://fallback.example.com/page',
    });
    expect(result?.appUrl).toBe('https://fallback.example.com');
  });

  it('takes the first value when a header arrives as an array', () => {
    const result = classifyCaller({
      'user-agent': ['curl/8.0', 'curl/9.0'],
    });
    expect(result?.sdk).toBe('curl');
    expect(result?.sdkVersion).toBe('8.0');
  });

  it('truncates oversized User-Agent and strips control characters', () => {
    const evil = 'curl/8.0\x00\x1b[31mevil\x7f' + 'A'.repeat(1000);
    const result = classifyCaller({ 'user-agent': evil });
    expect(result?.userAgent).toBeDefined();
    expect(result!.userAgent!.length).toBeLessThanOrEqual(256);
    expect(result!.userAgent).not.toContain('\x00');
    expect(result!.userAgent).not.toContain('\x1b');
    expect(result!.userAgent).not.toContain('\x7f');
  });

  it('treats a whitespace-only header value as absent', () => {
    const result = classifyCaller({ 'user-agent': '   \t\n  ' });
    expect(result).toBeNull();
  });

  it('ignores empty stainless-lang', () => {
    const result = classifyCaller({
      'user-agent': 'mystery/1.0',
      'x-stainless-lang': '   ',
    });
    expect(result?.sdk).toBe('unknown');
  });

  it('sanitizes stainless runtime/os/arch fields', () => {
    const result = classifyCaller({
      'user-agent': 'OpenAI/JS 6.26.0',
      'x-stainless-runtime': 'node\x00',
      'x-stainless-os': 'Linux\n',
      'x-stainless-arch': 'x64\t',
    });
    expect(result?.runtime).toBe('node');
    expect(result?.os).toBe('Linux');
    expect(result?.arch).toBe('x64');
  });
});
