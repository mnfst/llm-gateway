import {
  authOriginFromEnv,
  isMcpCapableResource,
  mcpAvailability,
  mcpResourceFromEnv,
  mcpResourceProblem,
  resetMcpAvailability,
  resolveMcpAvailability,
} from './mcp-availability';

describe('authOriginFromEnv', () => {
  it('uses BETTER_AUTH_URL with trailing slashes stripped', () => {
    expect(authOriginFromEnv({ BETTER_AUTH_URL: 'https://app.manifest.build//' })).toBe(
      'https://app.manifest.build',
    );
  });

  it('falls back to loopback on PORT', () => {
    expect(authOriginFromEnv({ PORT: '4242' })).toBe('http://localhost:4242');
  });

  it('falls back to the default port when PORT is unset', () => {
    expect(authOriginFromEnv({})).toBe('http://localhost:3001');
  });
});

describe('mcpResourceFromEnv', () => {
  it('appends the MCP route to the auth origin', () => {
    expect(mcpResourceFromEnv({ BETTER_AUTH_URL: 'https://mnfst.example.com' })).toBe(
      'https://mnfst.example.com/api/v1/mcp',
    );
  });
});

describe('reading process.env by default', () => {
  const keys = ['BETTER_AUTH_URL', 'PORT', 'MCP_ENABLED'] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env['BETTER_AUTH_URL'] = 'https://env-default.example.com';
    resetMcpAvailability();
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetMcpAvailability();
  });

  it('authOriginFromEnv reads the ambient environment', () => {
    expect(authOriginFromEnv()).toBe('https://env-default.example.com');
  });

  it('mcpResourceFromEnv reads the ambient environment', () => {
    expect(mcpResourceFromEnv()).toBe('https://env-default.example.com/api/v1/mcp');
  });

  it('resolveMcpAvailability reads the ambient environment', () => {
    expect(resolveMcpAvailability()).toEqual({ enabled: true, reason: null });
  });

  it('mcpAvailability decides once per process and hands every caller the same answer', () => {
    const first = mcpAvailability();
    process.env['MCP_ENABLED'] = 'false';
    expect(mcpAvailability()).toBe(first);
    expect(first).toEqual({ enabled: true, reason: null });
  });

  it('resetMcpAvailability makes the next call re-read the environment', () => {
    expect(mcpAvailability().enabled).toBe(true);
    process.env['MCP_ENABLED'] = 'false';
    resetMcpAvailability();
    expect(mcpAvailability()).toEqual({ enabled: false, reason: 'disabled by MCP_ENABLED' });
  });
});

describe('isMcpCapableResource', () => {
  it.each([
    'https://app.manifest.build/api/v1/mcp',
    'http://localhost:3001/api/v1/mcp',
    'http://127.0.0.1:3001/api/v1/mcp',
    'http://127.5.5.5/api/v1/mcp',
    'http://[::1]:3001/api/v1/mcp',
  ])('accepts %s', (resource) => {
    expect(isMcpCapableResource(resource)).toBe(true);
  });

  it.each([
    'http://manifest.example.internal/api/v1/mcp',
    'http://192.168.1.50:3001/api/v1/mcp',
    'http://manifest.tail1234.ts.net/api/v1/mcp',
    'http://128.0.0.1/api/v1/mcp',
    'ftp://example.com/api/v1/mcp',
    'https://user:pw@mnfst.example.com/api/v1/mcp',
    'https://user@mnfst.example.com/api/v1/mcp',
    'https://mnfst.example.com/app?tenant=x/api/v1/mcp',
    'https://mnfst.example.com/api/v1/mcp#frag',
    'not a url',
  ])('rejects %s', (resource) => {
    expect(isMcpCapableResource(resource)).toBe(false);
  });
});

describe('mcpResourceProblem', () => {
  it.each([
    ['not a url', 'is not an absolute URL'],
    ['https://user:pw@mnfst.example.com/api/v1/mcp', 'must not contain credentials'],
    ['https://mnfst.example.com/api/v1/mcp#frag', 'must not contain a fragment'],
    ['https://mnfst.example.com/app?tenant=x/api/v1/mcp', 'must not contain a query'],
    [
      'http://192.168.1.50:3001/api/v1/mcp',
      'must use HTTPS (loopback HTTP is allowed for development)',
    ],
    ['ftp://example.com/api/v1/mcp', 'must use HTTPS (loopback HTTP is allowed for development)'],
  ])('names the problem with %s', (resource, problem) => {
    expect(mcpResourceProblem(resource)).toBe(problem);
  });

  it('is null for a usable resource', () => {
    expect(mcpResourceProblem('https://mnfst.example.com/api/v1/mcp')).toBeNull();
    expect(mcpResourceProblem('http://localhost:3001/api/v1/mcp')).toBeNull();
  });
});

describe('resolveMcpAvailability', () => {
  it('enables MCP on an HTTPS origin', () => {
    expect(resolveMcpAvailability({ BETTER_AUTH_URL: 'https://mnfst.example.com' })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it('enables MCP on the loopback default used in development', () => {
    expect(resolveMcpAvailability({})).toEqual({ enabled: true, reason: null });
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('disables MCP when MCP_ENABLED=%s', (value) => {
    const result = resolveMcpAvailability({
      BETTER_AUTH_URL: 'https://mnfst.example.com',
      MCP_ENABLED: value,
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('MCP_ENABLED');
  });

  it.each(['true', '1', 'yes', 'on', ''])('keeps MCP on when MCP_ENABLED=%s', (value) => {
    expect(
      resolveMcpAvailability({ BETTER_AUTH_URL: 'https://mnfst.example.com', MCP_ENABLED: value }),
    ).toEqual({ enabled: true, reason: null });
  });

  it('disables MCP on a plain-HTTP non-loopback origin instead of letting boot fail', () => {
    const result = resolveMcpAvailability({
      BETTER_AUTH_URL: 'http://manifest.example.internal',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('http://manifest.example.internal/api/v1/mcp');
    expect(result.reason).toContain('HTTPS');
  });

  it('names the real problem for an HTTPS origin with credentials and never logs the secret', () => {
    const result = resolveMcpAvailability({
      BETTER_AUTH_URL: 'https://admin:hunter2@mnfst.example.com',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('must not contain credentials');
    expect(result.reason).toContain('https://mnfst.example.com/api/v1/mcp');
    expect(result.reason).not.toContain('hunter2');
    expect(result.reason).not.toContain('admin');
    expect(result.reason).not.toContain('HTTPS (loopback');
  });

  it('names a query problem rather than blaming the scheme', () => {
    const result = resolveMcpAvailability({
      BETTER_AUTH_URL: 'https://mnfst.example.com/app?tenant=x',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('must not contain a query');
  });

  it('does not echo a value that is not an http(s) URL', () => {
    // `user:secret@host` parses as a `user:` scheme with the secret in its path.
    const opaque = resolveMcpAvailability({ BETTER_AUTH_URL: 'user:hunter2@host' });
    expect(opaque.enabled).toBe(false);
    expect(opaque.reason).toContain('derived from BETTER_AUTH_URL must use HTTPS');
    expect(opaque.reason).not.toContain('hunter2');

    const junk = resolveMcpAvailability({ BETTER_AUTH_URL: 'not a url' });
    expect(junk.enabled).toBe(false);
    expect(junk.reason).toContain('derived from BETTER_AUTH_URL is not an absolute URL');
    expect(junk.reason).not.toContain('not a url');
  });

  it('reports the explicit opt-out even when the origin is also incapable', () => {
    const result = resolveMcpAvailability({
      BETTER_AUTH_URL: 'http://manifest.example.internal',
      MCP_ENABLED: 'false',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('MCP_ENABLED');
  });

  it('still refuses an incapable origin when MCP_ENABLED asks for it', () => {
    const result = resolveMcpAvailability({
      BETTER_AUTH_URL: 'http://192.168.1.50:3001',
      MCP_ENABLED: 'true',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('HTTPS');
  });
});
