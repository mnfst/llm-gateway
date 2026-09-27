import { MOCK_RENAME_CATALOG, MockHealingClient } from '../mock-healing-client';
import type { HealRequest, PhoenixProviderError } from '../phoenix.types';

/**
 * Build a minimal HealRequest for the mock. Callers override the error fields
 * and request body per case.
 */
function makeRequest(error: PhoenixProviderError, request: Record<string, unknown>): HealRequest {
  return {
    traceId: 'trace-1',
    tenantId: 'tenant-1',
    provider: 'openai',
    authType: 'api_key',
    api: 'responses',
    request,
    response: { statusCode: 400, error },
  };
}

const context = { harness: 'claude-code' } as const;

describe('MOCK_RENAME_CATALOG', () => {
  it('is exported and maps max_tokens to max_output_tokens', () => {
    expect(MOCK_RENAME_CATALOG).toBeDefined();
    expect(MOCK_RENAME_CATALOG.max_tokens).toBe('max_output_tokens');
  });
});

describe('MockHealingClient', () => {
  let client: MockHealingClient;

  beforeEach(() => {
    client = new MockHealingClient();
  });

  describe('heal', () => {
    it('patches an unknown_parameter with a renamable param present in the body', async () => {
      const input = makeRequest(
        { message: 'unknown param', code: 'unknown_parameter', param: 'max_tokens' },
        { max_tokens: 100, model: 'x' },
      );

      const res = await client.heal(input, context);

      // A freshly served patch is `unverified` (Phoenix only answers `patched`
      // for an already-verified issue); the loop still applies it.
      expect(res.status).toBe('unverified');
      expect(res.operations).toEqual([
        { type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' },
      ]);
      // The healed body renames the key and drops the old one.
      expect(res.healedBody).toEqual({ max_output_tokens: 100, model: 'x' });
      expect(res.healedBody).not.toHaveProperty('max_tokens');
      // Identifiers are present strings.
      expect(typeof res.issueId).toBe('string');
      expect(typeof res.patchId).toBe('string');
      expect(typeof res.healAttemptId).toBe('string');
    });

    it('returns no_patch for unknown_parameter when the param is not in the rename catalog', async () => {
      const input = makeRequest(
        { message: 'unknown param', code: 'unknown_parameter', param: 'temperature' },
        { temperature: 0.5, model: 'x' },
      );

      const res = await client.heal(input, context);

      expect(res.status).toBe('no_patch');
      expect(typeof res.issueId).toBe('string');
      expect(res.operations).toBeUndefined();
      expect(res.healedBody).toBeUndefined();
    });

    it('returns no_patch when a renamable param is not present in the request body', async () => {
      const input = makeRequest(
        { message: 'unknown param', code: 'unknown_parameter', param: 'max_tokens' },
        { model: 'x' }, // max_tokens missing → `param in input.request` is false
      );

      const res = await client.heal(input, context);

      expect(res.status).toBe('no_patch');
    });

    it('returns no_patch for a different error code', async () => {
      const input = makeRequest(
        { message: 'rate limited', code: 'rate_limit_exceeded', param: 'max_tokens' },
        { max_tokens: 100, model: 'x' },
      );

      const res = await client.heal(input, context);

      expect(res.status).toBe('no_patch');
    });

    it('returns no_patch when param is null (falsy short-circuits the rename lookup)', async () => {
      const input = makeRequest(
        { message: 'unknown param', code: 'unknown_parameter', param: null },
        { max_tokens: 100, model: 'x' },
      );

      const res = await client.heal(input, context);

      // param is null → `param ? MOCK_RENAME_CATALOG[param] : undefined` yields
      // undefined, so the patched branch is skipped.
      expect(res.status).toBe('no_patch');
    });

    it('returns no_patch for a prototype-chain param name (e.g. toString)', async () => {
      // `toString` is inherited on every object; the own-property checks must stop
      // it from resolving to `Object.prototype.toString` in the catalog or request.
      const input = makeRequest(
        { message: 'unknown param', code: 'unknown_parameter', param: 'toString' },
        { model: 'x' },
      );

      const res = await client.heal(input, context);

      expect(res.status).toBe('no_patch');
      expect(res.healedBody).toBeUndefined();
    });
  });

  describe('reportOutcome', () => {
    it('reports succeeded (issue stays unverified) for a 2xx retry status', async () => {
      const res = await client.reportOutcome('heal-123', { retryStatusCode: 200 }, context);

      expect(res).toEqual({
        healAttemptId: 'heal-123',
        status: 'succeeded',
        issueStatus: 'unverified',
      });
    });

    it('reports failed (issue stays unverified) for a >=400 retry status', async () => {
      const res = await client.reportOutcome(
        'heal-456',
        {
          retryStatusCode: 400,
          error: { message: 'still bad' },
        },
        context,
      );

      expect(res).toEqual({
        healAttemptId: 'heal-456',
        status: 'failed',
        issueStatus: 'unverified',
      });
    });
  });

  describe('observe', () => {
    it('discards the batch — the mock has no issue base to grow', async () => {
      const client = new MockHealingClient();
      const batch = [makeRequest({ message: 'bad' }, { model: 'gpt-5.1' })];

      await expect(client.observe(batch, context)).resolves.toBeUndefined();
    });
  });
});
