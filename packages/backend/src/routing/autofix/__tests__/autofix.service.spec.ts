import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Agent } from '../../../entities/agent.entity';
import type { ForwardResult } from '../../proxy/provider-client';
import { AutofixService, type MaybeHealParams } from '../autofix.service';
import { HealContractError, type HealingClient } from '../healing-client';
import type { HealResponse } from '../phoenix.types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a ForwardResult around the global (undici) Response, all flags false. */
function makeForward(body: string, status: number): ForwardResult {
  return {
    response: new Response(body, { status }),
    isGoogle: false,
    isAnthropic: false,
    isChatGpt: false,
    isResponses: false,
    isCodeAssist: false,
  };
}

type HealingClientMock = {
  heal: jest.Mock<Promise<HealResponse>, [unknown, unknown?]>;
  reportOutcome: jest.Mock;
};

function makeHealingClient(): HealingClientMock {
  return {
    heal: jest.fn(),
    // A landed report (null means "didn't reach Phoenix" and triggers resends).
    reportOutcome: jest.fn().mockResolvedValue({ healAttemptId: 'heal-1', status: 'succeeded' }),
  };
}

/** ConfigService stub whose `get` reads from a plain map (undefined by default). */
function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: jest.fn((key: string) => overrides[key]),
  } as unknown as ConfigService;
}

function makeAgentRepo(findOneImpl?: () => unknown): {
  repo: Repository<Agent>;
  findOne: jest.Mock;
} {
  const findOne = jest.fn(findOneImpl ?? (() => null));
  return { repo: { findOne } as unknown as Repository<Agent>, findOne };
}

function makeService(opts: {
  client?: HealingClient;
  repo?: Repository<Agent>;
  config?: ConfigService;
}): AutofixService {
  return new AutofixService(
    opts.client ?? (makeHealingClient() as unknown as HealingClient),
    opts.repo ?? makeAgentRepo().repo,
    opts.config ?? makeConfig(),
  );
}

/** Base params for maybeHeal; individual tests override `forward` / `reforward`. */
function makeParams(overrides: Partial<MaybeHealParams>): MaybeHealParams {
  return {
    forward: makeForward('{"error":{"message":"boom"}}', 400),
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    provider: 'anthropic',
    model: 'gpt',
    authType: 'subscription',
    apiMode: 'chat_completions',
    requestBody: { model: 'gpt', max_tokens: 100 },
    url: 'https://api.example.com/v1/chat/completions',
    reforward: jest.fn(),
    ...overrides,
  } as MaybeHealParams;
}

const patchedHeal = (over: Partial<HealResponse> = {}): HealResponse => ({
  status: 'patched',
  issueId: 'issue-1',
  patchId: 'patch-1',
  healAttemptId: 'heal-1',
  operations: [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }],
  explanation: {
    summary: 'Renamed the "max_tokens" parameter to "max_output_tokens".',
    operations: [
      {
        type: 'rename_param',
        detail: 'Renamed the "max_tokens" parameter to "max_output_tokens".',
      },
    ],
    source: 'deterministic',
  },
  healedBody: { model: 'gpt', max_output_tokens: 100 },
  ...over,
});

/**
 * A `reforward` mock that returns a FRESH ForwardResult on every call. Reusing a
 * single Response fails: the service reads the retry body (`.text()`), so a
 * shared Response would be "already read" on a later access.
 */
function reforwardMock(
  body: string,
  status: number,
): jest.Mock<Promise<ForwardResult>, [Record<string, unknown>]> {
  return jest.fn((_healedBody: Record<string, unknown>) =>
    Promise.resolve(makeForward(body, status)),
  );
}

// ---------------------------------------------------------------------------

describe('AutofixService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor config parsing
  // -------------------------------------------------------------------------
  describe('constructor config parsing', () => {
    it('defaults globalEnabled to true when AUTOFIX_GLOBAL_ENABLED is unset', () => {
      const { findOne } = makeAgentRepo();
      const service = makeService({ config: makeConfig() });
      // Directly assert the parsed default (only `'false'` disables), and that
      // construction never touches the DB.
      expect((service as unknown as { globalEnabled: boolean }).globalEnabled).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // resolveEnabled — deployment-mode default when autofix_enabled is NULL
  // -------------------------------------------------------------------------
  describe('resolveEnabled (deployment-mode default)', () => {
    let savedMode: string | undefined;
    beforeEach(() => {
      savedMode = process.env.MANIFEST_MODE;
    });
    afterEach(() => {
      if (savedMode === undefined) delete process.env.MANIFEST_MODE;
      else process.env.MANIFEST_MODE = savedMode;
    });

    it('an explicit true/false overrides the mode default', () => {
      process.env.MANIFEST_MODE = 'selfhosted';
      const service = makeService({});
      expect(service.resolveEnabled(true)).toBe(true);
      expect(service.resolveEnabled(false)).toBe(false);
    });

    it('a NULL/undefined flag inherits ON in cloud mode', () => {
      process.env.MANIFEST_MODE = 'cloud';
      const service = makeService({});
      expect(service.resolveEnabled(null)).toBe(true);
      expect(service.resolveEnabled(undefined)).toBe(true);
    });

    it('a NULL flag inherits OFF in self-hosted mode', () => {
      process.env.MANIFEST_MODE = 'selfhosted';
      const service = makeService({});
      expect(service.resolveEnabled(null)).toBe(false);
    });

    it('heals an unset agent in cloud (NULL → default ON)', async () => {
      process.env.MANIFEST_MODE = 'cloud';
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      const reforward = jest.fn().mockResolvedValue(makeForward('{"ok":true}', 200));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: null }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward }));

      expect(result!.record.outcome).toBe('healed');
      expect(client.heal).toHaveBeenCalled();
    });

    it('skips an unset agent in self-hosted (NULL → default OFF)', async () => {
      process.env.MANIFEST_MODE = 'selfhosted';
      const client = makeHealingClient();
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: null }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({}));

      expect(result).toBeNull();
      expect(client.heal).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // isRepairable / parseStatuses
  // -------------------------------------------------------------------------
  describe('isRepairable', () => {
    it('uses the default 400/404/422 set when config is unset', () => {
      const service = makeService({ config: makeConfig() });
      expect(service.isRepairable(400)).toBe(true);
      expect(service.isRepairable(404)).toBe(true);
      expect(service.isRepairable(422)).toBe(true);
      expect(service.isRepairable(500)).toBe(false);
      expect(service.isRepairable(401)).toBe(false);
    });

    it('honours a custom AUTOFIX_REPAIRABLE_STATUSES so 422 becomes non-repairable', () => {
      const service = makeService({
        config: makeConfig({ AUTOFIX_REPAIRABLE_STATUSES: '400,404' }),
      });
      expect(service.isRepairable(400)).toBe(true);
      expect(service.isRepairable(404)).toBe(true);
      expect(service.isRepairable(422)).toBe(false);
    });

    it('falls back to defaults for empty / whitespace config', () => {
      const service = makeService({ config: makeConfig({ AUTOFIX_REPAIRABLE_STATUSES: '   ' }) });
      expect(service.isRepairable(400)).toBe(true);
      expect(service.isRepairable(404)).toBe(true);
      expect(service.isRepairable(422)).toBe(true);
    });

    it('falls back to defaults when every entry is garbage / out of range', () => {
      // Non-numeric and out-of-[400,500) entries are all filtered out, so the
      // parsed set is empty → the DEFAULT set is used.
      const service = makeService({
        config: makeConfig({ AUTOFIX_REPAIRABLE_STATUSES: 'abc,200,500,600' }),
      });
      expect(service.isRepairable(400)).toBe(true);
      expect(service.isRepairable(404)).toBe(true);
      expect(service.isRepairable(422)).toBe(true);
      expect(service.isRepairable(200)).toBe(false);
      expect(service.isRepairable(500)).toBe(false);
    });

    it('keeps only in-range entries and drops out-of-range ones', () => {
      // 429 is a valid 4xx and kept; 500/399 are filtered out.
      const service = makeService({
        config: makeConfig({ AUTOFIX_REPAIRABLE_STATUSES: '429,500,399' }),
      });
      expect(service.isRepairable(429)).toBe(true);
      expect(service.isRepairable(500)).toBe(false);
      expect(service.isRepairable(399)).toBe(false);
      // Default 400 is NOT present because a non-empty valid set replaced defaults.
      expect(service.isRepairable(400)).toBe(false);
    });

    it('rejects a numeric-prefixed token (404abc) that parseInt would misread as 404', () => {
      // Old code used bare parseInt, which accepts '404abc' as 404; the digits-only
      // filter drops it, so only the clean 422 survives.
      const service = makeService({
        config: makeConfig({ AUTOFIX_REPAIRABLE_STATUSES: '404abc,422' }),
      });
      expect(service.isRepairable(404)).toBe(false);
      expect(service.isRepairable(422)).toBe(true);
    });
  });
  // -------------------------------------------------------------------------
  // maybeHeal — hot-path no-ops (no config load, no body read)
  // -------------------------------------------------------------------------
  describe('maybeHeal hot-path no-ops', () => {
    it('returns null and never loads config when the forward is ok', async () => {
      const { repo, findOne } = makeAgentRepo();
      const service = makeService({ repo });
      const forward = makeForward('ok', 200);

      const result = await service.maybeHeal(makeParams({ forward }));

      expect(result).toBeNull();
      expect(findOne).not.toHaveBeenCalled();
      // Body was never consumed.
      expect(forward.response.bodyUsed).toBe(false);
    });

    it('returns null when AUTOFIX_GLOBAL_ENABLED is "false"', async () => {
      const { repo, findOne } = makeAgentRepo();
      const service = makeService({
        repo,
        config: makeConfig({ AUTOFIX_GLOBAL_ENABLED: 'false' }),
      });
      const forward = makeForward('{"error":{"message":"boom"}}', 400);

      const result = await service.maybeHeal(makeParams({ forward }));

      expect(result).toBeNull();
      expect(findOne).not.toHaveBeenCalled();
      expect(forward.response.bodyUsed).toBe(false);
    });

    it('returns null for a non-repairable status without loading config or reading body', async () => {
      const { repo, findOne } = makeAgentRepo();
      const service = makeService({ repo });
      const forward = makeForward('server error', 500);

      const result = await service.maybeHeal(makeParams({ forward }));

      expect(result).toBeNull();
      expect(findOne).not.toHaveBeenCalled();
      expect(forward.response.bodyUsed).toBe(false);
    });

    it('returns null for a 401 (non-repairable) status', async () => {
      const { repo, findOne } = makeAgentRepo();
      const service = makeService({ repo });
      const forward = makeForward('unauthorized', 401);

      const result = await service.maybeHeal(makeParams({ forward }));

      expect(result).toBeNull();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('does not send Anthropic subscription extra-usage exhaustion to Phoenix', async () => {
      const client = makeHealingClient();
      const { repo, findOne } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const forward = makeForward(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'You are out of extra usage. Add more at claude.ai to keep going.',
          },
        }),
        400,
      );

      const result = await service.maybeHeal(makeParams({ forward, provider: 'anthropic' }));

      expect(result).toBeNull();
      expect(client.heal).not.toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
      expect(forward.response.status).toBe(400);
      expect(forward.response.bodyUsed).toBe(false);
    });

    it('keeps status-based healing when Anthropic billing inspection fails', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-1' });
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const forward = makeForward('{"error":{"message":"boom"}}', 400);
      jest.spyOn(forward.response, 'clone').mockImplementation(() => {
        throw new Error('clone failed');
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const result = await service.maybeHeal(makeParams({ forward, provider: 'anthropic' }));

      expect(result?.record.outcome).toBe('unfixable');
      expect(client.heal).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'could not inspect Anthropic 400 for billing semantics: clone failed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — agent config gating
  // -------------------------------------------------------------------------
  describe('maybeHeal agent config gating', () => {
    it('returns null when the agent row is not found', async () => {
      const { repo } = makeAgentRepo(() => null);
      const service = makeService({ repo });

      const result = await service.maybeHeal(makeParams({}));

      expect(result).toBeNull();
    });

    it('returns null when the agent has autofix disabled', async () => {
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: false }));
      const service = makeService({ repo });

      const result = await service.maybeHeal(makeParams({}));

      expect(result).toBeNull();
    });

    it('queries the agent scoped by id + tenant, selecting the PK so a NULL flag row is still found', async () => {
      const { repo, findOne } = makeAgentRepo(() => null);
      const service = makeService({ repo });

      await service.maybeHeal(makeParams({ agentId: 'a-9', tenantId: 't-9' }));

      // `id` must stay in the select: TypeORM returns null for a row whose only
      // selected column is NULL, so selecting the nullable `autofix_enabled`
      // alone makes every default (NULL-flag) agent look not-found. See the
      // real-DB regression in test/autofix-null-flag.e2e-spec.ts.
      expect(findOne).toHaveBeenCalledWith({
        where: { id: 'a-9', tenant_id: 't-9' },
        select: ['id', 'autofix_enabled', 'agent_platform'],
      });
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — happy heal on the single attempt
  // -------------------------------------------------------------------------
  describe('maybeHeal happy path', () => {
    it('finishes the original Provider Attempt before Autofix consumes its response', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-recording' });
      const finishRecording = jest.fn().mockResolvedValue(undefined);
      const forward = {
        ...makeForward('{"error":{"message":"invalid","api_key":"provider-secret"}}', 400),
        attempt: { finishRecording } as never,
      };
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(makeParams({ forward }));

      expect(finishRecording).toHaveBeenCalledWith({
        type: 'json',
        body: {
          error: {
            message: 'invalid',
            api_key: 'provider-secret',
          },
        },
      });
    });

    it('sends the provider exchange to Phoenix and preserves provider response headers', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-wire' });
      const forward = {
        ...makeForward('{"error":{"message":"invalid thinking"}}', 400),
        response: new Response('{"error":{"message":"invalid thinking"}}', {
          status: 400,
          headers: { 'x-provider-request-id': 'provider-request-1' },
        }),
        wireFormat: 'anthropic_messages' as const,
        wireRequestUrl: 'https://api.anthropic.com/v1/messages?key=provider-secret',
      };
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ forward }));

      expect(client.heal.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          providerExchange: {
            format: 'anthropic_messages',
            url: 'https://api.anthropic.com/v1/messages?key=%5BREDACTED%5D',
            request: {
              body: { model: 'gpt', max_tokens: 100 },
              redactedFields: [],
            },
            response: {
              statusCode: 400,
              body: { error: { message: 'invalid thinking' } },
            },
          },
        }),
      );
      expect(result!.forward.response.headers.get('x-provider-request-id')).toBe(
        'provider-request-1',
      );
    });

    it('keeps a plain-text provider response and omits an absent provider URL', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-wire-text' });
      const forward = {
        ...makeForward('invalid thinking', 400),
        wireFormat: 'anthropic_messages' as const,
      };
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(makeParams({ forward }));

      expect(client.heal.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          providerExchange: {
            format: 'anthropic_messages',
            request: {
              body: { model: 'gpt', max_tokens: 100 },
              redactedFields: [],
            },
            response: { statusCode: 400, body: 'invalid thinking' },
          },
        }),
      );
    });

    it('coerces the cached agent platform into the Phoenix harness context', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-1' });
      const { repo } = makeAgentRepo(() => ({
        autofix_enabled: true,
        agent_platform: 'claude-code',
      }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(makeParams({}));

      expect(client.heal.mock.calls[0][1]).toEqual({ harness: 'claude-code' });
    });

    it('never sends an unknown persisted platform value to Phoenix', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-1' });
      const { repo } = makeAgentRepo(() => ({
        autofix_enabled: true,
        agent_platform: 'customer-specific-name',
      }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(makeParams({}));

      expect(client.heal.mock.calls[0][1]).toEqual({ harness: 'other' });
    });

    it('heals on the patched retry, reports the cleared retry, and records the chain', async () => {
      const client = makeHealingClient();
      const heal = patchedHeal();
      client.heal.mockResolvedValue(heal);
      const healedForward = makeForward('{"ok":true}', 200);
      const reforward = jest.fn().mockResolvedValue(healedForward);
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward }));

      expect(result).not.toBeNull();
      expect(result!.record.outcome).toBe('healed');
      expect(result!.record.original_http_status).toBe(400);

      // Returned forward is the healed 200.
      expect(result!.forward).toBe(healedForward);
      expect(result!.forward.response.status).toBe(200);

      // reforward called once with Phoenix's healedBody.
      expect(reforward).toHaveBeenCalledTimes(1);
      expect(reforward).toHaveBeenCalledWith(heal.healedBody);

      // reportOutcome called once with the cleared 2xx retry status and no error.
      expect(client.reportOutcome).toHaveBeenCalledTimes(1);
      expect(client.reportOutcome).toHaveBeenCalledWith(
        'heal-1',
        { retryStatusCode: 200 },
        { harness: 'other' },
      );
      // The success report carries no `error` key.
      expect(client.reportOutcome.mock.calls[0][1]).not.toHaveProperty('error');

      // Chain: original entry (attempt 0, with error + decision + patch_worked)
      // followed by the terminal autofix success entry (attempt 1, status 200, no error).
      const chain = result!.record.chain;
      expect(chain).toHaveLength(2);

      const original = chain[0];
      expect(original.attempt).toBe(0);
      expect(original.origin).toBe('original');
      expect(original.http_status).toBe(400);
      expect(original.error).toBeDefined();
      expect(original.error!.message).toBe('boom');
      expect(original.phoenix_status).toBe('patched');
      expect(original.issue_id).toBe('issue-1');
      expect(original.patch_id).toBe('patch-1');
      expect(original.heal_attempt_id).toBe('heal-1');
      expect(original.operations).toEqual(heal.operations);
      // Phoenix's human-readable "why" rides the same entry, for the recorder to persist.
      expect(original.explanation).toEqual(heal.explanation);
      expect(original.patch_worked).toBe(true);

      const terminal = chain[1];
      expect(terminal.attempt).toBe(1);
      expect(terminal.origin).toBe('autofix');
      expect(terminal.http_status).toBe(200);
      expect(terminal.error).toBeUndefined();
      expect(terminal.request).toEqual(heal.healedBody);
    });

    it('passes the normalized request/response into the heal call', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      const reforward = jest.fn().mockResolvedValue(makeForward('{"ok":true}', 200));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const requestBody = { model: 'gpt', max_tokens: 5 };

      await service.maybeHeal(
        makeParams({
          reforward,
          requestBody,
          provider: 'openai',
          apiMode: 'chat_completions',
          url: 'u',
        }),
      );

      expect(client.heal).toHaveBeenCalledTimes(1);
      const arg = client.heal.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.provider).toBe('openai');
      expect(arg.authType).toBe('subscription');
      expect(arg.api).toBe('chat_completions');
      expect(arg.url).toBe('u');
      expect(arg.request).toEqual(requestBody);
      expect(typeof arg.traceId).toBe('string');
      expect(arg.tenantId).toBe('tenant-1');
      expect(arg.response).toEqual({
        statusCode: 400,
        error: { message: 'boom', type: null, param: null, code: null },
      });
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — provider wire body
  // -------------------------------------------------------------------------
  describe('maybeHeal provider wire body', () => {
    it('reports the failed provider body and reforwards the healed body verbatim', async () => {
      const client = makeHealingClient();
      const requestBody = {
        model: 'claude-opus-4-8',
        messages: [],
        thinking: { type: 'adaptive', budget_tokens: 8192 },
      };
      const healedBody = {
        model: 'claude-opus-4-8',
        messages: [],
        thinking: { type: 'adaptive' },
      };
      client.heal.mockResolvedValue(
        patchedHeal({
          status: 'unverified',
          operations: [{ type: 'drop_param' }],
          healedBody,
        }),
      );
      const reforward = reforwardMock('{"ok":true}', 200);
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward, requestBody }));

      expect(result!.record.outcome).toBe('healed');
      const healArg = client.heal.mock.calls[0][0] as { request: Record<string, unknown> };
      expect(healArg.request).toBe(requestBody);
      expect(reforward.mock.calls[0][0]).toBe(healedBody);
    });

    it('keeps native Gemini model metadata outside the exact provider request', async () => {
      const client = makeHealingClient();
      const requestBody = {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 32_000, topP: 1 },
      };
      const healedBody = {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 32_000 },
      };
      client.heal.mockResolvedValue(
        patchedHeal({
          status: 'unverified',
          operations: [{ type: 'drop_param' }],
          healedBody,
        }),
      );
      const forward = {
        ...makeForward('{"error":{"message":"topP is unsupported"}}', 400),
        wireFormat: 'google_generate_content' as const,
        wireRequestUrl:
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      };
      const reforward = reforwardMock('{"ok":true}', 200);
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(
        makeParams({
          forward,
          reforward,
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          requestBody,
        }),
      );

      expect(client.heal.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          model: 'gemini-2.5-flash',
          request: requestBody,
          providerExchange: expect.objectContaining({
            format: 'google_generate_content',
            request: { body: requestBody, redactedFields: [] },
          }),
        }),
      );
      expect(requestBody).not.toHaveProperty('model');
      expect(reforward).toHaveBeenCalledWith(healedBody);
      expect(healedBody).not.toHaveProperty('model');
    });

    it('does not mutate the provider body', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(
        patchedHeal({ healedBody: { model: 'gpt', max_output_tokens: 100 } }),
      );
      const reforward = reforwardMock('{"ok":true}', 200);
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const requestBody = { model: 'gpt', max_tokens: 100 };

      await service.maybeHeal(makeParams({ reforward, requestBody }));

      expect(requestBody).toEqual({ model: 'gpt', max_tokens: 100 });
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — unfixable / resolving / missing body
  // -------------------------------------------------------------------------
  describe('maybeHeal non-patch decisions', () => {
    it('no_patch → unfixable, returns the rebuilt original error, no confirm', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-2' });
      const reforward = jest.fn();
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const originalBody = '{"error":{"message":"nope"}}';

      const result = await service.maybeHeal(
        makeParams({ forward: makeForward(originalBody, 422), reforward }),
      );

      expect(result!.record.outcome).toBe('unfixable');
      expect(reforward).not.toHaveBeenCalled();
      expect(client.reportOutcome).not.toHaveBeenCalled();

      // The returned forward is the rebuilt original — still readable.
      expect(result!.forward.response.status).toBe(422);
      await expect(result!.forward.response.text()).resolves.toBe(originalBody);

      // Chain records the null patch/heal fields for the no_patch decision.
      const original = result!.record.chain[0];
      expect(original.phoenix_status).toBe('no_patch');
      expect(original.patch_id).toBeNull();
      expect(original.heal_attempt_id).toBeNull();
      expect(original.operations).toBeNull();
    });

    it('resolving → outcome resolving, no reforward, no confirm', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({
        status: 'resolving',
        issueId: 'issue-3',
        retryAfterMs: 5000,
      });
      const reforward = jest.fn();
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward }));

      expect(result!.record.outcome).toBe('resolving');
      expect(reforward).not.toHaveBeenCalled();
      expect(client.reportOutcome).not.toHaveBeenCalled();
    });

    it('patched but healedBody missing → unfixable', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal({ healedBody: null }));
      const reforward = jest.fn();
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward }));

      expect(result!.record.outcome).toBe('unfixable');
      expect(reforward).not.toHaveBeenCalled();
      expect(client.reportOutcome).not.toHaveBeenCalled();
    });

    it('patched but healAttemptId missing → unfixable', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal({ healAttemptId: null }));
      const reforward = jest.fn();
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward }));

      expect(result!.record.outcome).toBe('unfixable');
      expect(reforward).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — single attempt (no retry budget)
  // -------------------------------------------------------------------------
  describe('maybeHeal single attempt', () => {
    it('preserves a failed patched retry as the terminal exhausted attempt', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      // The patched retry still fails with a repairable 400 — Autofix does NOT
      // re-heal; it reports and returns the retry as the terminal attempt.
      const reforward = reforwardMock('{"error":{"message":"still-broken","code":"dup"}}', 400);
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const originalBody = '{"error":{"message":"first"}}';

      const result = await service.maybeHeal(
        makeParams({ forward: makeForward(originalBody, 400), reforward }),
      );

      expect(result!.record.outcome).toBe('exhausted');
      // Exactly one heal + one reforward — there is no retry budget.
      expect(client.heal).toHaveBeenCalledTimes(1);
      expect(reforward).toHaveBeenCalledTimes(1);
      // The single failed retry is reported to Phoenix with its status + error.
      expect(client.reportOutcome).toHaveBeenCalledTimes(1);
      expect(client.reportOutcome).toHaveBeenCalledWith(
        'heal-1',
        {
          retryStatusCode: 400,
          error: { message: 'still-broken', type: null, param: null, code: 'dup' },
        },
        { harness: 'other' },
      );

      // The original is linked to the distinct failed retry that Phoenix produced.
      expect(result!.record.chain).toHaveLength(2);
      expect(result!.record.chain[0].patch_worked).toBe(false);
      expect(result!.record.chain[1]).toEqual({
        attempt: 1,
        origin: 'autofix',
        request: { model: 'gpt', max_output_tokens: 100 },
        http_status: 400,
        error: { message: 'still-broken', type: null, param: null, code: 'dup' },
      });

      // Continues with the rebuilt retry error, still readable downstream.
      expect(result!.forward.response.status).toBe(400);
      await expect(result!.forward.response.text()).resolves.toBe(
        '{"error":{"message":"still-broken","code":"dup"}}',
      );
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — heal transport failure
  // -------------------------------------------------------------------------
  describe('maybeHeal heal transport failure', () => {
    it('returns exhausted (no reforward, no report) when the heal call throws', async () => {
      const client = makeHealingClient();
      client.heal.mockRejectedValue(new Error('phoenix down'));
      const reforward = jest.fn();
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      // Silence the expected "heal call failed" warning.
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const originalBody = '{"error":{"message":"boom"}}';

      const result = await service.maybeHeal(
        makeParams({ forward: makeForward(originalBody, 400), reforward }),
      );

      expect(result!.record.outcome).toBe('exhausted');
      expect(reforward).not.toHaveBeenCalled();
      expect(client.reportOutcome).not.toHaveBeenCalled();

      // Returns the rebuilt original error.
      expect(result!.forward.response.status).toBe(400);
      await expect(result!.forward.response.text()).resolves.toBe(originalBody);
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — a fresh `unverified` patch applies exactly like `patched`
  // -------------------------------------------------------------------------
  describe('maybeHeal unverified status', () => {
    it('applies an unverified patch (fresh, not yet confirmed) and heals', async () => {
      const client = makeHealingClient();
      // The common real-Phoenix answer for a novel resolvable error: a served
      // patch that is not yet verified. It must apply just like `patched`.
      client.heal.mockResolvedValue(patchedHeal({ status: 'unverified' }));
      const reforward = jest.fn().mockResolvedValue(makeForward('{"ok":true}', 200));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(makeParams({ reforward }));

      expect(result!.record.outcome).toBe('healed');
      expect(reforward).toHaveBeenCalledTimes(1);
      // Phoenix's real status is recorded verbatim on the chain.
      expect(result!.record.chain[0].phoenix_status).toBe('unverified');
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — heal contract error (4xx from Phoenix: bad contract / auth)
  // -------------------------------------------------------------------------
  describe('maybeHeal heal contract error', () => {
    it('returns exhausted and does NOT trip the breaker on a HealContractError', async () => {
      const client = makeHealingClient();
      // Phoenix is up but rejects every call (e.g. a missing API key → 401).
      client.heal.mockRejectedValue(new HealContractError(401, 'unauthorized'));
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const service = makeService({
        client: client as unknown as HealingClient,
        repo: makeAgentRepo(() => ({ autofix_enabled: true })).repo,
      });

      // Four consecutive contract errors: a transport failure would open the
      // breaker after three and skip the fourth. A contract error must not — the
      // healer is reachable, so every call still reaches it.
      for (let i = 0; i < 4; i++) {
        const r = await service.maybeHeal(
          makeParams({ forward: makeForward('{"error":{}}', 400) }),
        );
        expect(r!.record.outcome).toBe('exhausted');
      }
      expect(client.heal).toHaveBeenCalledTimes(4);
      // Surfaced loudly (error level), not swallowed as a routine warning.
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Circuit breaker — shed a slow/down healing service off the request path
  // -------------------------------------------------------------------------
  describe('circuit breaker', () => {
    const enabledRepo = () => makeAgentRepo(() => ({ autofix_enabled: true })).repo;

    it('opens after repeated heal failures and skips further heal calls', async () => {
      const client = makeHealingClient();
      client.heal.mockRejectedValue(new Error('phoenix down'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({
        client: client as unknown as HealingClient,
        repo: enabledRepo(),
      });

      // Three repairable failures trip the breaker (each still returns exhausted).
      for (let i = 0; i < 3; i++) {
        const r = await service.maybeHeal(
          makeParams({ forward: makeForward('{"error":{}}', 400) }),
        );
        expect(r!.record.outcome).toBe('exhausted');
      }
      expect(client.heal).toHaveBeenCalledTimes(3);

      // Breaker open: the next repairable failure skips healing entirely and
      // hands the forward back untouched (null → the proxy runs its fallback).
      const skipped = await service.maybeHeal(
        makeParams({ forward: makeForward('{"error":{}}', 400) }),
      );
      expect(skipped).toBeNull();
      expect(client.heal).toHaveBeenCalledTimes(3);
    });

    it('resets the failure streak after a successful heal round-trip', async () => {
      const client = makeHealingClient();
      client.heal
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce({ status: 'no_patch', issueId: 'i' })
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({
        client: client as unknown as HealingClient,
        repo: enabledRepo(),
      });

      // fail, fail, success (streak → 0), fail, fail: never reaches 3 in a row.
      for (let i = 0; i < 5; i++) {
        await service.maybeHeal(makeParams({ forward: makeForward('{"error":{}}', 400) }));
      }
      // Breaker still closed, so a 6th repairable failure reaches the healer.
      await service.maybeHeal(makeParams({ forward: makeForward('{"error":{}}', 400) }));
      expect(client.heal).toHaveBeenCalledTimes(6);
    });

    it('re-attempts healing once the cooldown window elapses', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
      const client = makeHealingClient();
      client.heal.mockRejectedValue(new Error('down'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({
        client: client as unknown as HealingClient,
        repo: enabledRepo(),
      });

      // Trip the breaker at t=1000 (open for the 30s cooldown).
      for (let i = 0; i < 3; i++) {
        await service.maybeHeal(makeParams({ forward: makeForward('{"error":{}}', 400) }));
      }
      expect(client.heal).toHaveBeenCalledTimes(3);

      // Still inside the cooldown → skipped, no heal call.
      nowSpy.mockReturnValue(20_000);
      const during = await service.maybeHeal(
        makeParams({ forward: makeForward('{"error":{}}', 400) }),
      );
      expect(during).toBeNull();
      expect(client.heal).toHaveBeenCalledTimes(3);

      // Past the cooldown → the healer is probed again.
      nowSpy.mockReturnValue(31_001);
      await service.maybeHeal(makeParams({ forward: makeForward('{"error":{}}', 400) }));
      expect(client.heal).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // reportOutcome — fire-and-forget error handling
  // -------------------------------------------------------------------------
  describe('reportOutcome fire-and-forget', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not throw out of maybeHeal when reportOutcome rejects, and resends', async () => {
      jest.useFakeTimers();
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      client.reportOutcome.mockRejectedValueOnce(new Error('report exploded'));
      const reforward = jest.fn().mockResolvedValue(makeForward('{"ok":true}', 200));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      // Silence the expected "reportOutcome ... failed" warning from the catch.
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({ client: client as unknown as HealingClient, repo });

      // Should resolve normally (the delivery loop handles the rejection).
      const result = await service.maybeHeal(makeParams({ reforward }));
      expect(result!.record.outcome).toBe('healed');

      // Let the fire-and-forget catch run; must not surface as an unhandled rejection.
      await jest.advanceTimersByTimeAsync(0);
      expect(client.reportOutcome).toHaveBeenCalledWith(
        'heal-1',
        { retryStatusCode: 200 },
        { harness: 'other' },
      );

      // The rejected send is retried after the first resend delay and lands.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(client.reportOutcome).toHaveBeenCalledTimes(2);
    });

    it('resends a report the healer dropped, then stops once it lands', async () => {
      jest.useFakeTimers();
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      // null = the PATCH did not land (transport failure or non-2xx).
      client.reportOutcome
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ healAttemptId: 'heal-1', status: 'succeeded' });
      const reforward = jest.fn().mockResolvedValue(makeForward('{"ok":true}', 200));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(makeParams({ reforward }));
      expect(client.reportOutcome).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(client.reportOutcome).toHaveBeenCalledTimes(2);

      // Landed on the second send — the schedule stops, no further resends.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(client.reportOutcome).toHaveBeenCalledTimes(2);
    });

    it('gives up once the resend schedule is exhausted', async () => {
      jest.useFakeTimers();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      client.reportOutcome.mockResolvedValue(null);
      const reforward = jest.fn().mockResolvedValue(makeForward('{"ok":true}', 200));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      await service.maybeHeal(makeParams({ reforward }));
      await jest.advanceTimersByTimeAsync(1_000);
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(60_000);

      // Initial send + one resend per schedule slot, then a loud give-up.
      expect(client.reportOutcome).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('giving up after 3 sends'));
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — graceful degradation (H1): never turn a provider 4xx into a 500
  // -------------------------------------------------------------------------
  describe('maybeHeal graceful degradation', () => {
    it('resolves null (does not throw) when the agent config load rejects', async () => {
      const { repo, findOne } = makeAgentRepo(() => {
        throw new Error('db down');
      });
      // Silence the expected "autofix config load failed" warning.
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({ repo });

      await expect(service.maybeHeal(makeParams({}))).resolves.toBeNull();
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('degrades to the readable original error and preserves the audit chain when reforward rejects', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      // The heal produced a patch, but resending it blows up (network death).
      const reforward = jest.fn().mockRejectedValue(new Error('socket hang up'));
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      // Silence the expected "autofix reforward failed" warning.
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({ client: client as unknown as HealingClient, repo });
      const originalBody = '{"error":{"message":"boom"}}';

      const result = await service.maybeHeal(
        makeParams({ forward: makeForward(originalBody, 400), reforward }),
      );

      // Never re-throws: degrades to 'unfixable' but KEEPS the audit chain — the
      // original entry with the Phoenix ids already stamped, now patch_worked=false.
      expect(result!.record.outcome).toBe('unfixable');
      expect(result!.record.original_http_status).toBe(400);
      expect(result!.record.chain).toHaveLength(1);
      expect(result!.record.chain[0].origin).toBe('original');
      expect(result!.record.chain[0].issue_id).toBe('issue-1');
      expect(result!.record.chain[0].patch_worked).toBe(false);
      expect(typeof result!.record.groupId).toBe('string');

      // The evidence loop still closes: a dead retry has no provider status to
      // send, so the death is reported as a synthetic 499 — otherwise the served
      // attempt dangles `pending` until Phoenix's sweeper expires it.
      expect(client.reportOutcome).toHaveBeenCalledWith(
        'heal-1',
        {
          retryStatusCode: 499,
          error: {
            message: 'patched retry never completed: socket hang up',
            type: 'retry_not_completed',
          },
        },
        { harness: 'other' },
      );

      // The returned forward is the rebuilt original — still readable downstream.
      expect(result!.forward.response.status).toBe(400);
      await expect(result!.forward.response.text()).resolves.toBe(originalBody);
    });

    it('degrades via the outer backstop (exhausted, empty chain) on an unexpected throw', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue(patchedHeal());
      // The patch retry fails (non-ok) AND reading its body throws — an unexpected
      // path caught only by maybeHeal's outer backstop, which must still degrade
      // cleanly (never a 500) rather than surface the throw.
      const badRetry = {
        response: {
          ok: false,
          status: 400,
          text: () => Promise.reject(new Error('body already consumed')),
        },
      } as unknown as ForwardResult;
      const reforward = jest.fn().mockResolvedValue(badRetry);
      const { repo } = makeAgentRepo(() => ({ autofix_enabled: true }));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = makeService({ client: client as unknown as HealingClient, repo });

      const result = await service.maybeHeal(
        makeParams({ forward: makeForward('{"error":{"message":"boom"}}', 400), reforward }),
      );

      expect(result!.record.outcome).toBe('exhausted');
      expect(result!.record.chain).toEqual([]);
      expect(result!.forward.response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // maybeHeal — per-agent config freshness
  // -------------------------------------------------------------------------
  describe('maybeHeal config freshness', () => {
    it('observes toggles made by another replica without local invalidation', async () => {
      const client = makeHealingClient();
      client.heal.mockResolvedValue({ status: 'no_patch', issueId: 'issue-x' });
      let enabled = false;
      const { repo, findOne } = makeAgentRepo(() => ({ autofix_enabled: enabled }));
      const service = makeService({ client: client as unknown as HealingClient, repo });

      // This replica first observes the agent as disabled.
      await service.maybeHeal(
        makeParams({ forward: makeForward('{"error":{"message":"a"}}', 400) }),
      );
      expect(findOne).toHaveBeenCalledTimes(1);
      expect(client.heal).not.toHaveBeenCalled();

      // Another replica enables the agent. The next failure must read the new
      // value immediately instead of reusing this replica's previous value.
      enabled = true;
      await service.maybeHeal(
        makeParams({ forward: makeForward('{"error":{"message":"b"}}', 400) }),
      );
      expect(findOne).toHaveBeenCalledTimes(2);
      expect(client.heal).toHaveBeenCalledTimes(1);

      // Disabling is equally immediate because this flag controls consent to
      // send the request body to Phoenix.
      enabled = false;
      await service.maybeHeal(
        makeParams({ forward: makeForward('{"error":{"message":"c"}}', 400) }),
      );
      expect(findOne).toHaveBeenCalledTimes(3);
      expect(client.heal).toHaveBeenCalledTimes(1);
    });

    it('queues a fresh shared consent read for requests that arrive during an older read', async () => {
      const resolveLoads: Array<(agent: Partial<Agent>) => void> = [];
      const findOne = jest.fn(
        () =>
          new Promise<Partial<Agent>>((resolve) => {
            resolveLoads.push(resolve);
          }),
      );
      const service = makeService({
        repo: { findOne } as unknown as Repository<Agent>,
      });

      const first = service.isActiveFor('tenant-1', 'agent-1');
      const second = service.isActiveFor('tenant-1', 'agent-1');
      const third = service.isActiveFor('tenant-1', 'agent-1');
      expect(findOne).toHaveBeenCalledTimes(1);

      // The first result can predate a toggle. Later callers ignore it and share
      // a generation that begins only after this read has completed.
      resolveLoads[0]({ id: 'agent-1', autofix_enabled: false });
      await expect(first).resolves.toBe(false);
      await Promise.resolve();
      expect(findOne).toHaveBeenCalledTimes(2);

      resolveLoads[1]({ id: 'agent-1', autofix_enabled: true });
      await expect(Promise.all([second, third])).resolves.toEqual([true, true]);

      findOne.mockResolvedValue({ id: 'agent-1', autofix_enabled: false });
      await expect(service.isActiveFor('tenant-1', 'agent-1')).resolves.toBe(false);
      expect(findOne).toHaveBeenCalledTimes(3);
    });
  });
});

describe('isActiveFor (the consent gate)', () => {
  it('is active when the deployment and agent allow it', async () => {
    const service = makeService({ repo: makeAgentRepo(() => ({ autofix_enabled: true })).repo });

    await expect(service.isActiveFor('tenant-1', 'agent-1')).resolves.toBe(true);
  });

  /**
   * `defaultAgentEnabled` is `!isSelfHosted()`, resolved in the constructor, and
   * `isSelfHosted()` sniffs for `/.dockerenv` / `/run/.containerenv` / Kubernetes.
   * Pin `MANIFEST_MODE` (priority 1, always wins) so these assertions don't invert
   * when the suite runs inside a container.
   */
  async function withMode(mode: string, run: () => Promise<void>): Promise<void> {
    const previous = process.env['MANIFEST_MODE'];
    process.env['MANIFEST_MODE'] = mode;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env['MANIFEST_MODE'];
      else process.env['MANIFEST_MODE'] = previous;
    }
  }

  it('inherits the cloud default when the agent never chose', async () => {
    await withMode('cloud', async () => {
      const service = makeService({ repo: makeAgentRepo(() => ({ autofix_enabled: null })).repo });

      await expect(service.isActiveFor('tenant-1', 'agent-1')).resolves.toBe(true);
    });
  });

  it('inherits the self-hosted default, where Autofix is opt-in', async () => {
    await withMode('selfhosted', async () => {
      const service = makeService({ repo: makeAgentRepo(() => ({ autofix_enabled: null })).repo });

      await expect(service.isActiveFor('tenant-1', 'agent-1')).resolves.toBe(false);
    });
  });

  it('is inactive when the deployment killed Autofix globally', async () => {
    const service = makeService({ config: makeConfig({ AUTOFIX_GLOBAL_ENABLED: 'false' }) });

    await expect(service.isActiveFor('tenant-1', 'agent-1')).resolves.toBe(false);
  });

  it('is inactive when the agent turned Autofix off', async () => {
    const service = makeService({ repo: makeAgentRepo(() => ({ autofix_enabled: false })).repo });

    await expect(service.isActiveFor('tenant-1', 'agent-1')).resolves.toBe(false);
  });

  it('rejects rather than reporting false, so callers fail closed on a DB error', async () => {
    const service = makeService({
      repo: makeAgentRepo(() => {
        throw new Error('db down');
      }).repo,
    });

    await expect(service.isActiveFor('tenant-1', 'agent-1')).rejects.toThrow('db down');
  });
});
