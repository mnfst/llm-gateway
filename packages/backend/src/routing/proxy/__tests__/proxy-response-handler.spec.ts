import {
  buildMetaHeaders,
  handleProviderError,
  recordFallbackFailures,
  handleStreamResponse,
  handleNonStreamResponse,
  recordSuccess,
} from '../proxy-response-handler';
import { RoutingMeta } from '../proxy.service';
import { FailedFallback } from '../proxy-fallback.service';
import { IngestionContext } from '../../../otlp/interfaces/ingestion-context.interface';
import { StreamUsage } from '../stream-writer';
import { Logger } from '@nestjs/common';
import type { AutofixRecord } from '../../autofix/autofix.types';

const testCtx: IngestionContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  agentName: 'test-agent',
  userId: 'user-1',
};

function makeMeta(overrides: Partial<RoutingMeta> = {}): RoutingMeta {
  return {
    tier: 'standard' as any,
    model: 'gpt-4o',
    provider: 'openai',
    confidence: 0.9,
    reason: 'auto',
    ...overrides,
  };
}

function mockResponse(): {
  res: Record<string, jest.Mock> & { writableEnded?: boolean };
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const res: Record<string, jest.Mock> & { writableEnded?: boolean } = {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    json: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  };
  res.writableEnded = false;
  return { res, headers };
}

function mockRecorder() {
  return {
    recordProviderError: jest.fn().mockResolvedValue(undefined),
    recordFailedFallbacks: jest.fn().mockResolvedValue(undefined),
    recordPrimaryFailure: jest.fn().mockResolvedValue(undefined),
    recordFallbackSuccess: jest.fn().mockResolvedValue(undefined),
    recordSuccessMessage: jest.fn().mockResolvedValue(undefined),
    recordManifestBlockedRequest: jest.fn().mockResolvedValue(undefined),
    recordAutofixOriginal: jest.fn().mockResolvedValue(undefined),
  };
}

function failedAutofixRetry(): AutofixRecord {
  return {
    groupId: 'grp-failed-retry',
    outcome: 'exhausted',
    original_http_status: 400,
    chain: [
      {
        attempt: 0,
        origin: 'original',
        request: { max_tokens: 5 },
        http_status: 400,
        error: { message: 'Unknown parameter' },
        issue_id: 'issue-1',
        patch_id: 'patch-1',
        heal_attempt_id: 'heal-1',
      },
      {
        attempt: 1,
        origin: 'autofix',
        request: { max_output_tokens: 5 },
        http_status: 422,
        error: { message: 'Retry also failed' },
      },
    ],
  };
}

describe('proxy-response-handler', () => {
  /* ── buildMetaHeaders ── */

  describe('buildMetaHeaders', () => {
    it('should include standard routing headers', () => {
      const meta = makeMeta();
      const headers = buildMetaHeaders(meta);

      expect(headers['X-Manifest-Tier']).toBe('standard');
      expect(headers['X-Manifest-Model']).toBe('gpt-4o');
      expect(headers['X-Manifest-Provider']).toBe('openai');
      expect(headers['X-Manifest-Confidence']).toBe('0.9');
      expect(headers['X-Manifest-Reason']).toBe('auto');
    });

    it('should include fallback headers when fallbackFromModel is set', () => {
      const meta = makeMeta({
        fallbackFromModel: 'gpt-4o',
        fallbackIndex: 2,
      });
      const headers = buildMetaHeaders(meta);

      expect(headers['X-Manifest-Fallback-From']).toBe('gpt-4o');
      expect(headers['X-Manifest-Fallback-Index']).toBe('2');
    });

    it('should default fallback index to 0 when not set', () => {
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o' });
      const headers = buildMetaHeaders(meta);

      expect(headers['X-Manifest-Fallback-Index']).toBe('0');
    });

    it('should not include fallback headers when no fallback', () => {
      const meta = makeMeta();
      const headers = buildMetaHeaders(meta);

      expect(headers).not.toHaveProperty('X-Manifest-Fallback-From');
      expect(headers).not.toHaveProperty('X-Manifest-Fallback-Index');
    });

    it('should include specificity header when specificity_category is set', () => {
      const meta = makeMeta({ specificity_category: 'coding' });
      const headers = buildMetaHeaders(meta);

      expect(headers['X-Manifest-Specificity']).toBe('coding');
    });

    it('should not include specificity header when specificity_category is not set', () => {
      const meta = makeMeta();
      const headers = buildMetaHeaders(meta);

      expect(headers).not.toHaveProperty('X-Manifest-Specificity');
    });
  });

  /* ── handleProviderError ── */

  describe('handleProviderError', () => {
    it('should record provider error and return sanitized error for non-fallback', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();
      const metaHeaders = buildMetaHeaders(meta);

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        500,
        'Internal Server Error',
        undefined,
        recorder as any,
        'trace-1',
        undefined,
        undefined,
        undefined,
        'request-1',
        undefined,
        'responses',
      );

      expect(recorder.recordProviderError).toHaveBeenCalledWith(
        testCtx,
        500,
        'Internal Server Error',
        expect.objectContaining({
          requestId: expect.any(String),
          model: 'gpt-4o',
          provider: 'openai',
          tier: 'standard',
          traceId: 'trace-1',
          fallbackFromModel: undefined,
          fallbackIndex: undefined,
          authType: undefined,
          reason: 'auto',
          specificityCategory: undefined,
          apiMode: 'responses',
        }),
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'server_error',
            code: null,
            status: 500,
            source: 'provider',
            provider: 'openai',
            model: 'gpt-4o',
          }),
        }),
      );
    });

    it('forwards meta.reason so single-shot upstream errors keep routing_reason', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ reason: 'header-match' });
      const metaHeaders = buildMetaHeaders(meta);

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        500,
        'oops',
        undefined,
        recorder as any,
      );

      expect(recorder.recordProviderError).toHaveBeenCalledWith(
        testCtx,
        500,
        'oops',
        expect.objectContaining({ reason: 'header-match' }),
      );
    });

    it('finishes a locally rejected Request without recording a Provider Attempt', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ providerCallStarted: false });

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        429,
        'route cooling down',
        undefined,
        recorder as any,
      );

      expect(recorder.recordProviderError).toHaveBeenCalledWith(
        testCtx,
        429,
        'route cooling down',
        expect.objectContaining({ skipAttempt: true }),
      );
    });

    it('records the original and terminal retry when a patched request fails', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();
      const autofix = failedAutofixRetry();

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        422,
        'Retry also failed',
        undefined,
        recorder as any,
        'trace-retry',
        null,
        { 'x-request': '1' },
        autofix,
      );

      expect(recorder.recordAutofixOriginal).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        autofix,
        expect.objectContaining({ traceId: 'trace-retry', provider: 'openai' }),
      );
      expect(recorder.recordProviderError).toHaveBeenCalledWith(
        testCtx,
        422,
        'Retry also failed',
        expect.objectContaining({ autofix }),
      );
    });

    it('should handle fallback exhausted when failedFallbacks present and no fallbackFromModel', async () => {
      const { res, headers } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider_key_label: 'Work' }); // no fallbackFromModel
      const metaHeaders = buildMetaHeaders(meta);
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-3-haiku',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 429,
          errorBody: 'rate limited',
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        502,
        'Bad Gateway',
        failedFallbacks,
        recorder as any,
        undefined,
        undefined,
        undefined,
        undefined,
        'request-exhausted',
        undefined,
        'messages',
      );

      expect(recorder.recordFailedFallbacks).toHaveBeenCalled();
      expect(recorder.recordPrimaryFailure).toHaveBeenCalled();
      // Exhausted chain: meta still describes the primary, so both failure
      // recorders get its connection label.
      expect(recorder.recordFailedFallbacks).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'gpt-4o',
        failedFallbacks,
        expect.objectContaining({ providerKeyLabel: 'Work' }),
      );
      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'gpt-4o',
        'Bad Gateway',
        expect.any(String),
        undefined,
        expect.objectContaining({ providerKeyLabel: 'Work', apiMode: 'messages' }),
      );
      expect(res.setHeader).toHaveBeenCalledWith('X-Manifest-Fallback-Exhausted', 'true');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            type: 'api_error',
            code: null,
            source: 'provider',
            fallback_exhausted: true,
            primary_model: 'gpt-4o',
            attempted_fallbacks: [
              expect.objectContaining({
                model: 'claude-3-haiku',
                provider: 'anthropic',
                status: 429,
              }),
            ],
          }),
        }),
      );
    });

    it('keeps a no-patch audit unlinked when the fallback chain exhausted', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();
      const metaHeaders = buildMetaHeaders(meta);
      const failedFallbacks: FailedFallback[] = [
        { model: 'claude', provider: 'anthropic', fallbackIndex: 0, status: 500, errorBody: 'x' },
      ];
      const autofix: AutofixRecord = {
        groupId: 'grp-exh',
        outcome: 'unfixable',
        original_http_status: 400,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: {},
            http_status: 400,
            error: { message: 'x' },
          },
        ],
      };

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        400,
        'Bad Request',
        failedFallbacks,
        recorder as any,
        undefined,
        undefined,
        undefined,
        autofix,
      );

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        'gpt-4o',
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({ autofix, httpStatus: 400 }),
      );
      expect(recorder.recordAutofixOriginal).not.toHaveBeenCalled();
    });

    it('preserves provider context overflow code when fallback chain is exhausted', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'opencode-go', model: 'opencode-go/kimi-k2.6' });
      const metaHeaders = buildMetaHeaders(meta);
      const message =
        "This model's maximum context length is 262144 tokens. However, your messages resulted in 334146 tokens.";
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 400,
          errorBody: 'also too long',
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        400,
        JSON.stringify({
          error: {
            message,
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        }),
        failedFallbacks,
        recorder as any,
      );

      expect(res.setHeader).toHaveBeenCalledWith('X-Manifest-Fallback-Exhausted', 'true');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining(message),
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            source: 'provider',
            attempted_fallbacks: [
              expect.objectContaining({
                model: 'claude-sonnet-4-6',
                provider: 'anthropic',
                status: 400,
              }),
            ],
          }),
        }),
      );
    });

    it('preserves a structured provider code when fallback chain is exhausted', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-opus-4-1' });
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 400,
          errorBody: 'also rejected',
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        400,
        JSON.stringify({
          error: {
            message: '`temperature` is deprecated for this model.',
            type: 'invalid_request_error',
            code: 'deprecated_parameter',
          },
        }),
        failedFallbacks,
        recorder as any,
      );

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('`temperature` is deprecated for this model.'),
            type: 'invalid_request_error',
            code: 'deprecated_parameter',
            source: 'provider',
          }),
        }),
      );
    });

    it('attributes a code-less structured fallback error to the provider', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-opus-4-1' });
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 400,
          errorBody: 'also rejected',
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        400,
        JSON.stringify({
          error: {
            message: '`temperature` is deprecated for this model.',
            type: 'invalid_request_error',
          },
        }),
        failedFallbacks,
        recorder as any,
      );

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: null,
            source: 'provider',
          }),
        }),
      );
    });

    it('uses an Anthropic error envelope when Messages fallbacks are exhausted', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-opus-4-1' });
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 400,
          errorBody: 'also rejected',
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        400,
        JSON.stringify({ error: { message: 'Invalid request', type: 'invalid_request_error' } }),
        failedFallbacks,
        recorder as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({ source: 'provider' }),
        }),
      );
    });

    it('should record simple error when failedFallbacks present but meta has fallbackFromModel', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o' });
      const metaHeaders = buildMetaHeaders(meta);
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-3-haiku',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 429,
          errorBody: '',
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        500,
        'Error',
        failedFallbacks,
        recorder as any,
      );

      // Should NOT enter fallback-exhausted path since fallbackFromModel is set
      expect(recorder.recordProviderError).toHaveBeenCalled();
      expect(recorder.recordFailedFallbacks).not.toHaveBeenCalled();
    });

    it('should handle empty failedFallbacks array as non-fallback error', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();
      const metaHeaders = buildMetaHeaders(meta);

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        404,
        'Not Found',
        [],
        recorder as any,
      );

      expect(recorder.recordProviderError).toHaveBeenCalled();
      expect(recorder.recordFailedFallbacks).not.toHaveBeenCalled();
    });

    it('should not throw when recordProviderError rejects', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      recorder.recordProviderError.mockRejectedValue(new Error('DB error'));
      const meta = makeMeta();

      // Should not throw -- fire-and-forget with .catch
      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        500,
        'Error',
        undefined,
        recorder as any,
      );

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should surface actual error message in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const { res } = mockResponse();
        const recorder = mockRecorder();
        const meta = makeMeta();
        const metaHeaders = buildMetaHeaders(meta);

        await handleProviderError(
          res as any,
          testCtx,
          meta,
          metaHeaders,
          400,
          JSON.stringify({ error: { message: 'Invalid model' } }),
          undefined,
          recorder as any,
        );

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({ message: 'Invalid model' }),
          }),
        );
      } finally {
        if (originalEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalEnv;
        }
      }
    });

    it('returns provider context overflow as an OpenAI-compatible error in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const { res } = mockResponse();
        const recorder = mockRecorder();
        const meta = makeMeta({ provider: 'opencode-go', model: 'opencode-go/kimi-k2.6' });
        const message =
          "This model's maximum context length is 262144 tokens. However, your messages resulted in 334146 tokens.";

        await handleProviderError(
          res as any,
          testCtx,
          meta,
          buildMetaHeaders(meta),
          400,
          JSON.stringify({
            error: {
              message,
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
            },
          }),
          undefined,
          recorder as any,
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          error: expect.objectContaining({
            message,
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            status: 400,
            source: 'provider',
            provider: 'opencode-go',
            model: 'opencode-go/kimi-k2.6',
          }),
        });
      } finally {
        if (originalEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalEnv;
        }
      }
    });

    it('preserves structured provider 4xx fields in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const { res } = mockResponse();
        const recorder = mockRecorder();
        const meta = makeMeta({ provider: 'anthropic', model: 'claude-opus-4-1' });

        await handleProviderError(
          res as any,
          testCtx,
          meta,
          buildMetaHeaders(meta),
          400,
          JSON.stringify({
            type: 'error',
            error: {
              type: 'request_validation_error',
              message: '`temperature` is deprecated for this model.',
              param: 'temperature',
              code: 'deprecated_parameter',
            },
          }),
          undefined,
          recorder as any,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'messages',
        );

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          type: 'error',
          error: expect.objectContaining({
            message: '`temperature` is deprecated for this model.',
            type: 'request_validation_error',
            param: 'temperature',
            code: 'deprecated_parameter',
            status: 400,
            source: 'provider',
          }),
        });
      } finally {
        if (originalEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalEnv;
        }
      }
    });

    it('preserves a structured provider type for authentication errors', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        401,
        JSON.stringify({
          error: {
            message: 'Invalid API key',
            type: 'invalid_request_error',
          },
        }),
        undefined,
        recorder as any,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({
          message: 'Invalid API key',
          type: 'invalid_request_error',
          status: 401,
          source: 'provider',
        }),
      });
    });

    it.each([
      [500, 'api_error'],
      [529, 'overloaded_error'],
    ])('maps a Messages %i response to Anthropic %s', async (status, type) => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-opus-4-1' });

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        status,
        'Internal Server Error',
        undefined,
        recorder as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      expect(res.json).toHaveBeenCalledWith({
        type: 'error',
        error: expect.objectContaining({
          type,
          status,
          source: 'provider',
        }),
      });
    });
  });

  /* ── recordFallbackFailures ── */

  describe('fallback-exhausted wire shape', () => {
    const codexBody = JSON.stringify({
      detail: "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    });

    async function exhausted(opts: {
      errorStatus?: number;
      errorBody?: string;
      failedFallbacks?: FailedFallback[];
      autofix?: AutofixRecord;
      meta?: Partial<RoutingMeta>;
    }) {
      const { res, headers } = mockResponse();
      const meta = makeMeta({
        model: 'gpt-5.4-mini',
        auth_type: 'subscription',
        ...opts.meta,
      });
      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        opts.errorStatus ?? 400,
        opts.errorBody ?? 'not json',
        opts.failedFallbacks ?? [
          { model: 'grok-4.5', provider: 'xai', fallbackIndex: 0, status: 403, errorBody: 'nope' },
        ],
        mockRecorder() as any,
        undefined,
        undefined,
        undefined,
        opts.autofix,
        'request-shape',
      );
      const body = res.json.mock.calls[0][0] as { error: Record<string, unknown> };
      return { error: body.error, headers };
    }

    it('attributes an exhausted chain to the provider and keeps code free of the routing outcome', async () => {
      const { error, headers } = await exhausted({});

      expect(headers['X-Manifest-Fallback-Exhausted']).toBe('true');
      expect(error).toEqual(
        expect.objectContaining({
          source: 'provider',
          code: null,
          status: 400,
          fallback_exhausted: true,
          auth_type: 'subscription',
          primary_model: 'gpt-5.4-mini',
          primary_provider: 'openai',
        }),
      );
    });

    it('keeps a structured provider code in the code slot', async () => {
      const { error } = await exhausted({
        errorBody: JSON.stringify({
          error: { message: 'Insufficient quota', code: 'insufficient_quota' },
        }),
      });

      expect(error.code).toBe('insufficient_quota');
      expect(error.fallback_exhausted).toBe(true);
    });

    it("leads with the provider's own sentence and appends the attempt summary", async () => {
      const { error } = await exhausted({
        errorBody: codexBody,
        failedFallbacks: [
          { model: 'grok-4.5', provider: 'xai', fallbackIndex: 0, status: 403, errorBody: 'x' },
          {
            model: 'gemini-3.1-flash-lite',
            provider: 'gemini',
            fallbackIndex: 1,
            status: 403,
            errorBody: 'x',
          },
        ],
      });

      expect(error.message).toBe(
        "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account. " +
          'Every attempt failed: openai/gpt-5.4-mini 400, xai/grok-4.5 403, ' +
          'gemini/gemini-3.1-flash-lite 403.',
      );
    });

    it('projects each fallback hop with its sanitized message, code and auth type', async () => {
      const { error } = await exhausted({
        failedFallbacks: [
          {
            model: 'grok-4.5',
            provider: 'xai',
            fallbackIndex: 0,
            status: 403,
            authType: 'api_key',
            errorBody: JSON.stringify({
              error: {
                message: 'Your API key does not have access to model grok-4.5',
                code: 'permission_denied',
              },
            }),
          },
          {
            model: 'deepseek-flash',
            provider: 'opencode-go',
            fallbackIndex: 1,
            status: 403,
            errorBody: 'forbidden',
          },
        ],
      });

      expect(error.attempted_fallbacks).toEqual([
        {
          model: 'grok-4.5',
          provider: 'xai',
          auth_type: 'api_key',
          status: 403,
          code: 'permission_denied',
          message: 'Your API key does not have access to model grok-4.5',
        },
        {
          model: 'deepseek-flash',
          provider: 'opencode-go',
          auth_type: null,
          status: 403,
          code: null,
          message: 'Forbidden by upstream provider',
        },
      ]);
    });

    it('summarizes the primary Autofix attempt only when Phoenix was consulted', async () => {
      const withAutofix = await exhausted({ autofix: failedAutofixRetry() });
      expect(withAutofix.error.autofix).toEqual({
        applied: true,
        original_status: 400,
        retry_status: 422,
      });

      const without = await exhausted({});
      expect(without.error).not.toHaveProperty('autofix');
    });

    it('collapses a patched-then-failed fallback hop into one entry carrying its Autofix summary', async () => {
      const retried = failedAutofixRetry();
      const unfixable: AutofixRecord = {
        groupId: 'grp-unfixable',
        outcome: 'unfixable',
        original_http_status: 403,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: {},
            http_status: 403,
            error: { message: 'x' },
          },
        ],
      };
      const { error } = await exhausted({
        failedFallbacks: [
          {
            model: 'grok-4.5',
            provider: 'xai',
            fallbackIndex: 0,
            status: 403,
            errorBody: 'x',
            autofix: unfixable,
            autofixRole: 'original',
          },
          {
            model: 'deepseek-flash',
            provider: 'opencode-go',
            fallbackIndex: 1,
            status: 400,
            errorBody: 'x',
            autofix: retried,
            autofixRole: 'original',
          },
          {
            model: 'deepseek-flash',
            provider: 'opencode-go',
            fallbackIndex: 1,
            status: 422,
            errorBody: 'x',
            autofix: retried,
            autofixRole: 'retry',
          },
        ],
      });

      expect(error.attempted_fallbacks).toEqual([
        expect.objectContaining({
          model: 'grok-4.5',
          status: 403,
          autofix: { applied: false, original_status: 403, retry_status: null },
        }),
        expect.objectContaining({
          model: 'deepseek-flash',
          status: 422,
          autofix: { applied: true, original_status: 400, retry_status: 422 },
        }),
      ]);
      expect(error.message).toContain(
        'Every attempt failed: openai/gpt-5.4-mini 400, xai/grok-4.5 403, opencode-go/deepseek-flash 422.',
      );
    });
  });

  describe('recordFallbackFailures', () => {
    it('should return undefined when no fallbackFromModel', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();

      const result = recordFallbackFailures(testCtx, meta, undefined, recorder as any);

      expect(result).toBeUndefined();
      expect(recorder.recordPrimaryFailure).not.toHaveBeenCalled();
    });

    it('should record primary failure and return timestamp', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'gpt-4o',
        primaryErrorBody: 'rate limited',
        primaryErrorStatus: 429,
      });

      const result = recordFallbackFailures(testCtx, meta, undefined, recorder as any);

      expect(result).toBeDefined();
      expect(recorder.recordPrimaryFailure).toHaveBeenCalled();
    });

    it('should record failed fallbacks when present', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o' });
      const failedFallbacks: FailedFallback[] = [
        { model: 'claude', provider: 'anthropic', fallbackIndex: 0, status: 500, errorBody: '' },
      ];

      recordFallbackFailures(testCtx, meta, failedFallbacks, recorder as any);

      expect(recorder.recordFailedFallbacks).toHaveBeenCalled();
    });

    it('numbers an Autofix retry before its fallback attempts', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o' });
      const failedFallbacks: FailedFallback[] = [
        { model: 'claude', provider: 'anthropic', fallbackIndex: 0, status: 500, errorBody: '' },
      ];
      const autofix: AutofixRecord = {
        groupId: 'grp-order',
        outcome: 'exhausted',
        original_http_status: 400,
        chain: [
          { attempt: 0, origin: 'original', request: {}, http_status: 400 },
          { attempt: 1, origin: 'autofix', request: {}, http_status: 400 },
        ],
      };

      recordFallbackFailures(testCtx, meta, failedFallbacks, recorder as any, null, null, autofix);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
        expect.objectContaining({ attemptNumber: 2 }),
      );
      expect(recorder.recordFailedFallbacks).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        expect.anything(),
        failedFallbacks,
        expect.objectContaining({ firstAttemptNumber: 3 }),
      );
    });

    it('passes a no-patch audit to the plain primary failure', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o', primaryErrorStatus: 400 });
      const autofix: AutofixRecord = {
        groupId: 'grp-b',
        outcome: 'unfixable',
        original_http_status: 400,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: {},
            http_status: 400,
            error: { message: 'x' },
          },
        ],
      };

      recordFallbackFailures(testCtx, meta, undefined, recorder as any, null, null, autofix);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        'gpt-4o',
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({ autofix }),
      );
      expect(recorder.recordAutofixOriginal).not.toHaveBeenCalled();
    });

    it('records the original and failed Autofix retry before a successful fallback', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'gpt-4o',
        primaryErrorBody: 'Retry also failed',
        primaryErrorStatus: 422,
        primaryProvider: 'openai',
        primaryAuthType: 'api_key',
        primaryTenantProviderId: 'primary-key',
        provider: 'anthropic',
        model: 'claude-sonnet',
      });
      const autofix = failedAutofixRetry();

      recordFallbackFailures(testCtx, meta, undefined, recorder as any, null, null, autofix);

      expect(recorder.recordAutofixOriginal).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        autofix,
        expect.objectContaining({
          provider: 'openai',
          authType: 'api_key',
          tenantProviderId: 'primary-key',
        }),
      );
      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        'gpt-4o',
        'Retry also failed',
        expect.any(String),
        'api_key',
        expect.objectContaining({ autofix, httpStatus: 422 }),
      );
    });

    it('attributes the Autofix original row to the primary connection label', () => {
      // The retry that failed ran on the PRIMARY connection; meta.provider_key_label
      // already names the fallback that recovered the request, so the
      // autofix_role='original' row must read primaryKeyLabel instead —
      // otherwise it pairs the primary's tenant_provider_id with the
      // fallback's label.
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'gpt-4o',
        primaryProvider: 'openai',
        primaryAuthType: 'api_key',
        primaryTenantProviderId: 'up-work',
        primaryKeyLabel: 'Work',
        provider: 'anthropic',
        model: 'claude-sonnet',
        provider_key_label: 'Personal',
      });
      const autofix = failedAutofixRetry();

      recordFallbackFailures(testCtx, meta, undefined, recorder as any, null, null, autofix);

      expect(recorder.recordAutofixOriginal).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        autofix,
        expect.objectContaining({
          provider: 'openai',
          tenantProviderId: 'up-work',
          providerKeyLabel: 'Work',
        }),
      );
    });

    it('does not attribute the Autofix original to the fallback provider', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'gpt-4o',
        primaryProvider: undefined,
        provider: 'anthropic',
        model: 'claude-sonnet',
      });
      const autofix = failedAutofixRetry();

      recordFallbackFailures(testCtx, meta, undefined, recorder as any, null, null, autofix);

      expect(recorder.recordAutofixOriginal).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        autofix,
        expect.objectContaining({ provider: undefined }),
      );
    });

    it('should not record failed fallbacks when array is empty', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o' });

      recordFallbackFailures(testCtx, meta, [], recorder as any);

      expect(recorder.recordFailedFallbacks).not.toHaveBeenCalled();
    });

    it('should use default error message when primaryErrorBody is not set', () => {
      const recorder = mockRecorder();
      // The meta fixture represents a fallback-success flow:
      //   meta.provider  = 'openai'     ← fallback that succeeded
      //   meta.primaryProvider = 'anthropic' ← primary that failed
      // recordPrimaryFailure must attribute the primary row to the primary
      // provider, not the fallback's provider.
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryErrorStatus: 503,
        primaryProvider: 'anthropic',
      });

      recordFallbackFailures(testCtx, meta, undefined, recorder as any);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        'claude-sonnet-4',
        'Provider returned HTTP 503',
        expect.any(String),
        undefined,
        expect.objectContaining({
          requestId: expect.any(String),
          provider: 'anthropic',
          reason: 'auto',
          callerAttribution: undefined,
          httpStatus: 503,
        }),
      );
    });

    it('should use default 500 status when primaryErrorStatus is not set', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryProvider: 'anthropic',
      });

      recordFallbackFailures(testCtx, meta, undefined, recorder as any);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        'claude-sonnet-4',
        'Provider returned HTTP 500',
        expect.any(String),
        undefined,
        expect.objectContaining({
          requestId: expect.any(String),
          provider: 'anthropic',
          reason: 'auto',
        }),
      );
    });

    it('passes meta.primaryAuthType (not meta.auth_type) to recordPrimaryFailure (#1173)', () => {
      // In a fallback-success flow, meta.auth_type holds the FALLBACK's auth
      // (used to cost the success row). The primary failure row must instead
      // carry the PRIMARY's auth_type, which lives on meta.primaryAuthType.
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryProvider: 'anthropic',
        auth_type: 'subscription',
        primaryAuthType: 'api_key',
      });

      recordFallbackFailures(testCtx, meta, undefined, recorder as any);

      const call = recorder.recordPrimaryFailure.mock.calls[0];
      // 6th positional arg is `authType` on recordPrimaryFailure.
      expect(call[5]).toBe('api_key');
    });

    it('leaves primary provider undefined when meta.primaryProvider is not set', () => {
      // Guard against regression: without primaryProvider we must NOT fall
      // back to meta.provider (which is the fallback's provider in this flow).
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'claude-sonnet-4' });

      recordFallbackFailures(testCtx, meta, undefined, recorder as any);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        expect.anything(),
        'claude-sonnet-4',
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({
          requestId: expect.any(String),
          provider: undefined,
          reason: 'auto',
        }),
      );
    });
  });

  /* ── handleStreamResponse ── */

  describe('handleStreamResponse', () => {
    function mockForward(
      flags: {
        isGoogle?: boolean;
        isAnthropic?: boolean;
        isChatGpt?: boolean;
        isResponses?: boolean;
      } = {},
    ) {
      return {
        response: { body: { getReader: jest.fn() }, headers: new Headers() },
        isGoogle: flags.isGoogle ?? false,
        isAnthropic: flags.isAnthropic ?? false,
        isChatGpt: flags.isChatGpt ?? false,
        isResponses: flags.isResponses ?? false,
      };
    }

    function mockProviderClient() {
      return {
        convertGoogleStreamChunk: jest.fn(),
        createAnthropicStreamTransformer: jest.fn().mockReturnValue(jest.fn()),
        createReasoningContentStreamTransformer: jest.fn().mockReturnValue(jest.fn()),
        createChatGptStreamTransformer: jest.fn().mockReturnValue(jest.fn()),
      };
    }

    // These tests verify the branching logic (which adapter is used).
    // Full streaming is tested in stream-writer.spec.ts.
    // We mock pipeStream + pipePassthrough to avoid needing real ReadableStreams.
    let pipeStreamSpy: jest.SpyInstance;
    let pipePassthroughSpy: jest.SpyInstance;
    let initSseHeadersSpy: jest.SpyInstance;

    beforeEach(() => {
      // We need to spy on the imported functions
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const streamWriter = require('../stream-writer');
      pipeStreamSpy = jest.spyOn(streamWriter, 'pipeStream').mockResolvedValue(null);
      pipePassthroughSpy = jest.spyOn(streamWriter, 'pipePassthrough').mockResolvedValue(null);
      initSseHeadersSpy = jest.spyOn(streamWriter, 'initSseHeaders').mockImplementation(() => {});
    });

    afterEach(() => {
      pipeStreamSpy?.mockRestore();
      pipePassthroughSpy?.mockRestore();
      initSseHeadersSpy?.mockRestore();
    });

    it('should use Google adapter for Google responses', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isGoogle: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        expect.any(Function),
        undefined,
        undefined,
        { protocol: 'google_generate_content' },
      );
    });

    it('should use Anthropic adapter for Anthropic responses', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isAnthropic: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      // `undefined` is the thinking-blocks callback — absent when no
      // thinking cache is provided to the handler (OpenAI-compat contract
      // tests don't wire one up).
      expect(client.createAnthropicStreamTransformer).toHaveBeenCalledWith('gpt-4o', undefined);
    });

    it('should forward extracted thinking blocks into the thinking cache on Anthropic streams', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isAnthropic: true });
      const client = mockProviderClient();
      const meta = makeMeta({
        provider: 'anthropic',
        auth_type: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });
      const thinkingCache = { store: jest.fn() };
      const sessionKey = 'sess-anthro-stream';

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        sessionKey,
        thinkingCache as any,
      );

      // Second arg to createAnthropicStreamTransformer is the onThinkingBlocks
      // callback. Grab it and invoke it to prove the handler wires it to
      // thinkingCache.store.
      const callback = client.createAnthropicStreamTransformer.mock.calls[0][1];
      expect(typeof callback).toBe('function');
      const blocks = [{ type: 'thinking', thinking: 'r', signature: 's' }];
      callback('toolu_stream', blocks);
      expect(thinkingCache.store).toHaveBeenCalledWith(
        'sess-anthro-stream',
        'toolu_stream',
        blocks,
        {
          provider: 'anthropic',
          authType: 'subscription',
          model: 'claude-sonnet-4-5-20250929',
        },
      );
    });

    it('apiMode=messages + Anthropic upstream dispatches to pipePassthrough with the Anthropic transformer as tap (issue #1886)', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isAnthropic: true });
      const tap = jest.fn();
      const client = mockProviderClient();
      client.createAnthropicStreamTransformer.mockReturnValue(tap);
      const meta = makeMeta();

      const usage = await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      // Dispatched to pipePassthrough, not pipeStream. Tap is the Anthropic
      // stream transformer so thinking-block extraction + OpenAI-shape
      // usage parsing still happen as a side effect.
      expect(pipePassthroughSpy).toHaveBeenCalledWith(forward.response.body, res, tap, undefined, {
        protocol: 'anthropic_messages',
      });
      expect(pipeStreamSpy).not.toHaveBeenCalled();
      expect(usage).toBeNull();
    });

    it('apiMode=messages + Anthropic upstream returns the usage that pipePassthrough captured', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isAnthropic: true });
      const client = mockProviderClient();
      client.createAnthropicStreamTransformer.mockReturnValue(jest.fn());
      const meta = makeMeta();
      pipePassthroughSpy.mockResolvedValue({
        prompt_tokens: 58,
        completion_tokens: 12,
        cache_read_tokens: 5,
        cache_creation_tokens: 3,
      });

      const usage = await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      expect(usage).toEqual({
        prompt_tokens: 58,
        completion_tokens: 12,
        cache_read_tokens: 5,
        cache_creation_tokens: 3,
      });
    });

    it('should use ChatGPT adapter for ChatGPT responses', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isChatGpt: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        expect.any(Function),
        undefined,
        undefined,
        { protocol: 'openai_responses' },
      );
    });

    it('ChatGPT stream transformer delegates each chunk to a per-stream transformer', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isChatGpt: true });
      const client = mockProviderClient();
      const transformer = jest.fn().mockReturnValue('data: out\n\n');
      client.createChatGptStreamTransformer.mockReturnValue(transformer);
      const meta = makeMeta();

      let captured: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_b: unknown, _r: unknown, transform?: (c: string) => string | null) => {
          captured = transform;
          return null;
        },
      );

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(captured).toBeDefined();
      const out = captured!('data: in\n\n');
      expect(out).toBe('data: out\n\n');
      expect(client.createChatGptStreamTransformer).toHaveBeenCalledWith('gpt-4o');
      expect(transformer).toHaveBeenCalledWith('data: in\n\n');
    });

    it('converts a native Responses upstream for a Chat Completions client', async () => {
      // An Autofix heal that changes the model re-routes the Codex wire body in
      // `responses` mode, so the forward carries isResponses, not isChatGpt,
      // while the client still speaks Chat Completions.
      const { res } = mockResponse();
      const forward = mockForward({ isResponses: true });
      const client = mockProviderClient();
      const transformer = jest.fn().mockReturnValue('data: out\n\n');
      client.createChatGptStreamTransformer.mockReturnValue(transformer);
      const meta = makeMeta();

      let captured: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_b: unknown, _r: unknown, transform?: (c: string) => string | null) => {
          captured = transform;
          return null;
        },
      );

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(captured!('data: in\n\n')).toBe('data: out\n\n');
      expect(client.createChatGptStreamTransformer).toHaveBeenCalledWith('gpt-4o');
    });

    it('should pipe without transformer for standard OpenAI responses', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta();

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        undefined,
        undefined,
        undefined,
        { protocol: 'openai_chat_completions' },
      );
    });

    it('normalizes Copilot OpenAI-compatible reasoning streams through the reasoning transformer', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta({ provider: 'copilot', model: 'copilot/claude-sonnet-4.6' });
      const transformer = jest.fn((chunk: string) => `data: ${chunk}\n\n`);
      client.createReasoningContentStreamTransformer.mockReturnValue(transformer);

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(client.createReasoningContentStreamTransformer).toHaveBeenCalledWith(undefined, {
        outputStreamDeltaPaths: ['reasoning_content', 'reasoning_text'],
        clientStreamDeltaPath: 'reasoning_content',
      });
      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        expect.any(Function),
        undefined,
        undefined,
        { protocol: 'openai_chat_completions' },
      );
    });

    it('passes a finalize callback to pipeStream when apiMode=messages (default OpenAI provider)', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta();

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        expect.any(Function),
        expect.any(Function),
        undefined,
        { protocol: 'openai_chat_completions' },
      );
    });

    it('wraps the ChatGPT stream chunk converter through the messages transformer', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isChatGpt: true });
      const client = mockProviderClient();
      client.createChatGptStreamTransformer.mockReturnValue(
        jest.fn().mockReturnValue('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
      );
      const meta = makeMeta();

      let captured: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_b: unknown, _r: unknown, transform?: (c: string) => string | null) => {
          captured = transform;
          return null;
        },
      );

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      expect(captured).toBeDefined();
      const out = captured!('data: ignored\n\n');
      expect(out).toContain('event: message_start');
      expect(out).toContain('event: content_block_delta');
    });

    it('returns null when the ChatGPT-converted chunk is empty under apiMode=messages', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isChatGpt: true });
      const client = mockProviderClient();
      client.createChatGptStreamTransformer.mockReturnValue(jest.fn().mockReturnValue(null));
      const meta = makeMeta();

      let captured: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_b: unknown, _r: unknown, transform?: (c: string) => string | null) => {
          captured = transform;
          return null;
        },
      );

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      expect(captured!('chunk')).toBeNull();
    });

    it('should pass through native Responses streams without a transformer', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isResponses: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'responses',
      );

      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        undefined,
        undefined,
        expect.any(Function),
        { protocol: 'openai_responses' },
      );
    });

    it('should convert chat completion streams into the full Responses lifecycle (issue #2064)', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta();
      let capturedTransform: ((chunk: string) => string | null) | undefined;
      let capturedFinalize: (() => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (
          _body: unknown,
          _res: unknown,
          transform?: (chunk: string) => string | null,
          finalize?: () => string | null,
        ) => {
          capturedTransform = transform;
          capturedFinalize = finalize;
          return null;
        },
      );

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'responses',
      );

      // The converter must be stateful: the message item + content part are
      // opened ahead of the first delta so strict clients keep the text.
      expect(capturedTransform).toBeDefined();
      const opened = capturedTransform!(
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      )!;
      expect(opened).toContain('event: response.output_item.added');
      expect(opened).toContain('event: response.content_part.added');
      expect(opened).toContain('event: response.output_text.delta');

      // finalize must close the item and terminate the stream itself, since
      // pipeStream skips its own [DONE] when a finalize is supplied.
      expect(capturedFinalize).toBeDefined();
      const tail = capturedFinalize!()!;
      expect(tail).toContain('event: response.output_item.done');
      expect(tail).toContain('event: response.completed');
      expect(tail).toContain('"text":"Hi"');
      expect(tail.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('should cache thought_signatures from Google stream chunks', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isGoogle: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      const signatureCache = { store: jest.fn() };
      const sessionKey = 'sess-123';

      // The transformer is captured by pipeStream — we need to invoke it manually.
      let capturedTransform: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_body: unknown, _res: unknown, transform?: (chunk: string) => string | null) => {
          capturedTransform = transform;
          return null;
        },
      );

      // convertGoogleStreamChunk now returns structured { chunk, signatures }
      // so the handler can cache signatures without scraping the output.
      client.convertGoogleStreamChunk.mockReturnValue({
        chunk: 'data: {}\n\n',
        signatures: [
          { toolCallId: 'call_abc', signature: 'sig_xyz' },
          { toolCallId: 'call_def', signature: 'sig_uvw' },
        ],
      });

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        signatureCache as any,
        sessionKey,
      );

      expect(capturedTransform).toBeDefined();
      const out = capturedTransform!('{}');
      expect(out).toBe('data: {}\n\n');

      expect(signatureCache.store).toHaveBeenCalledTimes(2);
      expect(signatureCache.store).toHaveBeenCalledWith('sess-123', 'call_abc', 'sig_xyz');
      expect(signatureCache.store).toHaveBeenCalledWith('sess-123', 'call_def', 'sig_uvw');
    });

    it('should not cache when signatureCache is absent', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isGoogle: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      let capturedTransform: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_body: unknown, _res: unknown, transform?: (chunk: string) => string | null) => {
          capturedTransform = transform;
          return null;
        },
      );
      client.convertGoogleStreamChunk.mockReturnValue({
        chunk: 'data: {}\n\n',
        signatures: [{ toolCallId: 'call_abc', signature: 'sig_xyz' }],
      });

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      // Should not throw — just drops the signatures silently.
      expect(() => capturedTransform!('{}')).not.toThrow();
    });

    it('caches reasoning_content from compatible OpenAI-compatible streams', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta({ provider: 'deepseek', model: 'deepseek-chat' });
      const reasoningCache = { store: jest.fn() };
      const sessionKey = 'sess-reasoning-stream';
      const transformer = jest.fn((chunk: string) => `data: ${chunk}\n\n`);
      client.createReasoningContentStreamTransformer.mockReturnValue(transformer);

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        sessionKey,
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      const callback = client.createReasoningContentStreamTransformer.mock.calls[0][0];
      expect(typeof callback).toBe('function');
      callback('call_1', 'streamed reasoning');
      expect(reasoningCache.store).toHaveBeenCalledWith(
        'sess-reasoning-stream',
        'call_1',
        'streamed reasoning',
      );
      expect(pipeStreamSpy).toHaveBeenCalledWith(
        forward.response.body,
        res,
        expect.any(Function),
        undefined,
        undefined,
        { protocol: 'openai_chat_completions' },
      );
    });

    it('normalizes Zen reasoning streams when the cache exposes a model catalog', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta({ provider: 'opencode-zen', model: 'opencode-zen/big-pickle' });
      const reasoningCache = {
        store: jest.fn(),
        modelCatalog: { isReasoningModel: () => true },
      };
      client.createReasoningContentStreamTransformer.mockReturnValue(jest.fn());

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        'sess-zen-stream',
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      expect(client.createReasoningContentStreamTransformer).toHaveBeenCalledWith(
        expect.any(Function),
        {
          outputStreamDeltaPaths: ['reasoning_content'],
          clientStreamDeltaPath: 'reasoning_content',
        },
      );
    });

    it('does not configure assistant-message reasoning cache callbacks for streams without tool calls', async () => {
      const { res } = mockResponse();
      const forward = mockForward();
      const client = mockProviderClient();
      const meta = makeMeta({ provider: 'deepseek', model: 'deepseek-chat' });
      const reasoningCache = { store: jest.fn() };
      const sessionKey = 'sess-reasoning-stream';
      const transformer = jest.fn((chunk: string) => `data: ${chunk}\n\n`);
      client.createReasoningContentStreamTransformer.mockReturnValue(transformer);

      await handleStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        sessionKey,
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      expect(client.createReasoningContentStreamTransformer.mock.calls[0][2]).toBeUndefined();
      expect(reasoningCache.store).not.toHaveBeenCalled();
    });
  });

  /* ── handleNonStreamResponse ── */

  describe('handleNonStreamResponse', () => {
    function mockProviderClient() {
      return {
        convertGoogleResponse: jest.fn().mockReturnValue({ id: 'google-converted' }),
        convertAnthropicResponse: jest.fn().mockReturnValue({ id: 'anthropic-converted' }),
        convertChatGptResponse: jest.fn().mockReturnValue({ id: 'chatgpt-converted' }),
        collectChatGptSseResponse: jest.fn().mockReturnValue({ id: 'chatgpt-collected' }),
      };
    }

    function mockForward(
      body: unknown,
      flags: {
        isGoogle?: boolean;
        isAnthropic?: boolean;
        isChatGpt?: boolean;
        isResponses?: boolean;
        contentType?: string;
      } = {},
    ) {
      return {
        response: {
          json: jest.fn().mockResolvedValue(body),
          text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
          headers: {
            get: jest.fn().mockReturnValue(flags.contentType ?? 'application/json'),
          },
        },
        isGoogle: flags.isGoogle ?? false,
        isAnthropic: flags.isAnthropic ?? false,
        isChatGpt: flags.isChatGpt ?? false,
        isResponses: flags.isResponses ?? false,
      };
    }

    it('should convert Google response and extract usage', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      client.convertGoogleResponse.mockReturnValue({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const forward = mockForward({}, { isGoogle: true });
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(client.convertGoogleResponse).toHaveBeenCalled();
      expect(usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('apiMode=messages + Anthropic upstream returns the upstream body verbatim, preserving server-tool blocks (issue #1886)', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      // A real Anthropic Messages response with server-tool result blocks.
      // The lossy OpenAI converter (convertAnthropicResponse) only knows
      // text/thinking/tool_use; without passthrough, server_tool_use and
      // web_search_tool_result are silently dropped on the way out.
      const body = {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'cats' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [{ type: 'web_search_result', url: 'https://example.test', title: 'Cats' }],
          },
          { type: 'text', text: 'Found some cats.' },
        ],
        usage: { input_tokens: 50, output_tokens: 12, cache_read_input_tokens: 0 },
      };
      const forward = mockForward(body, { isAnthropic: true });
      const meta = makeMeta({
        provider: 'anthropic',
        auth_type: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });
      const thinkingCache = { store: jest.fn() };

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        'sess-msg-anthro',
        thinkingCache as any,
        'messages',
      );

      // Lossy converter wasn't called at all.
      expect(client.convertAnthropicResponse).not.toHaveBeenCalled();
      // Client gets the upstream body untouched.
      expect(res.json).toHaveBeenCalledWith(body);
      // Anthropic-native usage was parsed via parseUsageObject.
      expect(usage).toEqual({
        prompt_tokens: 50,
        completion_tokens: 12,
        cache_read_tokens: undefined,
        cache_creation_tokens: 0,
      });
      // No thinking blocks → no cache writes.
      expect(thinkingCache.store).not.toHaveBeenCalled();
    });

    it('apiMode=messages + Anthropic upstream stores thinking blocks keyed by first tool_use id', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const body = {
        content: [
          { type: 'thinking', thinking: 'searching...', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { q: 'x' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const forward = mockForward(body, { isAnthropic: true });
      const meta = makeMeta({
        provider: 'anthropic',
        auth_type: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });
      const thinkingCache = { store: jest.fn() };

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        'sess-x',
        thinkingCache as any,
        'messages',
      );

      expect(thinkingCache.store).toHaveBeenCalledWith(
        'sess-x',
        'toolu_1',
        [{ type: 'thinking', thinking: 'searching...', signature: 'sig' }],
        {
          provider: 'anthropic',
          authType: 'subscription',
          model: 'claude-sonnet-4-5-20250929',
        },
      );
    });

    it('should convert Anthropic response', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      client.convertAnthropicResponse.mockReturnValue({});
      const forward = mockForward({}, { isAnthropic: true });
      const meta = makeMeta({
        provider: 'anthropic',
        auth_type: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(client.convertAnthropicResponse).toHaveBeenCalled();
      expect(usage).toBeNull();
    });

    it('should cache extracted thinking blocks from Anthropic non-stream response', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const thinkingCache = { store: jest.fn() };
      const sessionKey = 'sess-anthro';

      client.convertAnthropicResponse.mockReturnValue({
        id: 'anthropic-converted',
        _extractedThinkingBlocks: {
          firstToolUseId: 'toolu_01',
          blocks: [{ type: 'thinking', thinking: 'reason', signature: 's' }],
        },
      });

      const forward = mockForward({}, { isAnthropic: true });
      const meta = makeMeta({
        provider: 'anthropic',
        auth_type: 'subscription',
        model: 'claude-sonnet-4-5-20250929',
      });

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        sessionKey,
        thinkingCache as any,
      );

      expect(thinkingCache.store).toHaveBeenCalledTimes(1);
      expect(thinkingCache.store).toHaveBeenCalledWith(
        'sess-anthro',
        'toolu_01',
        [{ type: 'thinking', thinking: 'reason', signature: 's' }],
        {
          provider: 'anthropic',
          authType: 'subscription',
          model: 'claude-sonnet-4-5-20250929',
        },
      );

      // The internal side-channel is stripped before the body reaches the client.
      const sentBody = res.json.mock.calls[0][0];
      expect(sentBody._extractedThinkingBlocks).toBeUndefined();
    });

    it('should strip _extractedThinkingBlocks even when no cache is provided', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();

      client.convertAnthropicResponse.mockReturnValue({
        id: 'anthropic-converted',
        _extractedThinkingBlocks: {
          firstToolUseId: 'toolu_02',
          blocks: [{ type: 'thinking', thinking: 'x', signature: 'y' }],
        },
      });

      const forward = mockForward({}, { isAnthropic: true });
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      const sentBody = res.json.mock.calls[0][0];
      expect(sentBody._extractedThinkingBlocks).toBeUndefined();
    });

    it('should collect ChatGPT SSE response for non-streaming requests', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const sseText = 'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n';
      const forward = mockForward(sseText, { isChatGpt: true });
      forward.response.headers.get.mockReturnValue(null);
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(client.collectChatGptSseResponse).toHaveBeenCalledWith(sseText, meta.model);
      expect(forward.response.text).toHaveBeenCalled();
    });

    it('collects native Responses SSE for a non-streaming Chat Completions client', async () => {
      // Regression: an Autofix heal that changed the model re-routed the Codex
      // wire body in `responses` mode. The forward came back isResponses (not
      // isChatGpt) and the handler JSON-parsed the SSE body, answering M500
      // `Unexpected token 'e', "event: res"... is not valid JSON`.
      const { res } = mockResponse();
      const client = mockProviderClient();
      const sseText = 'event: response.created\ndata: {"type":"response.created"}\n\n';
      const forward = mockForward(sseText, {
        isResponses: true,
        contentType: 'text/event-stream',
      });
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(forward.response.json).not.toHaveBeenCalled();
      expect(client.collectChatGptSseResponse).toHaveBeenCalledWith(sseText, meta.model);
      expect(res.json).toHaveBeenCalledWith({ id: 'chatgpt-collected' });
    });

    it('should convert a JSON Responses object via providerClient for non-streaming ChatGPT-format upstreams (Bedrock GPT-5.x)', async () => {
      // Regression for the Bedrock non-streaming bug: bedrock-mantle
      // /openai/v1/responses returns a plain JSON Responses object (not SSE)
      // when stream:false. The handler must route it through the DI-mockable
      // providerClient.convertChatGptResponse, not the SSE collector — otherwise
      // the SSE collector finds no events and content comes back null.
      const { res } = mockResponse();
      const client = mockProviderClient();
      const responsesJson = {
        object: 'response',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
      };
      const forward = mockForward(responsesJson, { isChatGpt: true });
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      // The JSON body goes through the converter, NOT the SSE collector.
      expect(client.collectChatGptSseResponse).not.toHaveBeenCalled();
      expect(client.convertChatGptResponse).toHaveBeenCalledWith(responsesJson, meta.model);
      expect(res.json).toHaveBeenCalledWith({ id: 'chatgpt-converted' });
    });

    it('should still collect SSE when a ChatGPT-format upstream streams with text/event-stream content-type', async () => {
      // Regression guard: the Codex subscription backend always returns SSE.
      const { res } = mockResponse();
      const client = mockProviderClient();
      const sseText = 'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n';
      const forward = mockForward(sseText, {
        isChatGpt: true,
        contentType: 'text/event-stream',
      });
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(client.collectChatGptSseResponse).toHaveBeenCalledWith(sseText, meta.model);
    });

    it('should pass through standard OpenAI response', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const body = {
        id: 'chatcmpl-123',
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      };
      const forward = mockForward(body);
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(usage).toEqual({
        prompt_tokens: 50,
        completion_tokens: 25,
        cache_read_tokens: undefined,
        cache_creation_tokens: undefined,
      });
      expect(res.json).toHaveBeenCalledWith(body);
    });

    it('should extract cached prompt tokens from prompt_tokens_details', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const body = {
        id: 'chatcmpl-cached',
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          prompt_tokens_details: { cached_tokens: 12 },
        },
      };
      const forward = mockForward(body);
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(usage).toEqual({
        prompt_tokens: 50,
        completion_tokens: 25,
        cache_read_tokens: 12,
        cache_creation_tokens: undefined,
      });
    });

    it('should pass through native Responses JSON and extract Responses usage', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const body = {
        id: 'resp_123',
        object: 'response',
        usage: {
          input_tokens: 50,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 25,
          total_tokens: 75,
        },
      };
      const forward = mockForward(body, { isResponses: true });
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'responses',
      );

      expect(usage).toEqual({
        prompt_tokens: 50,
        completion_tokens: 25,
        cache_read_tokens: 20,
        cache_creation_tokens: 0,
      });
      expect(res.json).toHaveBeenCalledWith(body);
    });

    it('should collect native Responses SSE for non-streaming Responses clients', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const response = { id: 'resp_done', object: 'response', output: [] };
      const sse = `event: response.completed\ndata: ${JSON.stringify({ response })}\n\n`;
      const forward = mockForward(sse, {
        isResponses: true,
        contentType: 'text/event-stream',
      });
      const meta = makeMeta();

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'responses',
      );

      expect(forward.response.text).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(response);
    });

    it('should collect native Responses SSE even when content type is not SSE', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const response = { id: 'resp_done', object: 'response', output: [] };
      const sse = `event: response.completed\ndata: ${JSON.stringify({ response })}\n\n`;
      const forward = mockForward(sse, {
        isResponses: true,
        contentType: 'application/json',
      });
      const meta = makeMeta();

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'responses',
      );

      expect(forward.response.text).toHaveBeenCalled();
      expect(forward.response.json).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(response);
    });

    it('unwraps Anthropic synthetic structured-output tool calls for Responses clients', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const schema = { type: 'object', properties: { title: { type: 'string' } } };
      client.convertAnthropicResponse.mockReturnValue({
        model: 'claude-sonnet-4',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'patient_summary', arguments: '{"title":"ok"}' },
                },
              ],
            },
          },
        ],
      });
      const forward = mockForward({}, { isAnthropic: true }) as ReturnType<typeof mockForward> & {
        structuredOutputToolName?: string;
        responsesTextFormat?: Record<string, unknown>;
      };
      forward.structuredOutputToolName = 'patient_summary';
      forward.responsesTextFormat = {
        type: 'json_schema',
        name: 'patient_summary',
        schema,
        strict: true,
      };

      await handleNonStreamResponse(
        res as any,
        forward as any,
        makeMeta({ model: 'claude-sonnet-4' }),
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'responses',
      );

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.output).toEqual([
        expect.objectContaining({
          type: 'message',
          content: [{ type: 'output_text', text: '{"title":"ok"}', annotations: [] }],
        }),
      ]);
      expect(responseBody.text).toEqual({
        format: { type: 'json_schema', name: 'patient_summary', schema, strict: true },
      });
    });

    it('converts a chat_completions response into Anthropic Messages when apiMode=messages', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const body = {
        id: 'cc_42',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 6, completion_tokens: 4 },
      };
      const forward = mockForward(body);
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        undefined,
        undefined,
        'messages',
      );

      const sent = (res.json as jest.Mock).mock.calls[0][0];
      expect(sent.type).toBe('message');
      expect(sent.role).toBe('assistant');
      expect(sent.content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(sent.stop_reason).toBe('end_turn');
      expect(sent.usage).toMatchObject({ input_tokens: 6, output_tokens: 4 });
      expect(usage).toMatchObject({ prompt_tokens: 6, completion_tokens: 4 });
    });

    it('should return null usage when no usage data in response', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const forward = mockForward({ id: 'chatcmpl-123' });
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(usage).toBeNull();
    });

    it('should return null usage when prompt_tokens is not a number', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const forward = mockForward({ usage: { prompt_tokens: 'not-a-number' } });
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(usage).toBeNull();
    });

    it('should include cache tokens in usage when present', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const body = {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cache_read_tokens: 20,
          cache_creation_tokens: 10,
        },
      };
      const forward = mockForward(body);
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_read_tokens: 20,
        cache_creation_tokens: 10,
      });
    });

    it('should default completion_tokens to 0 when missing', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const forward = mockForward({ usage: { prompt_tokens: 100 } });
      const meta = makeMeta();

      const usage = await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
      );

      expect(usage!.completion_tokens).toBe(0);
    });

    it('should cache extracted thought_signatures from Google non-stream response', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const signatureCache = { store: jest.fn() };
      const sessionKey = 'sess-456';

      // convertGoogleResponse returns a body with _extractedSignatures
      client.convertGoogleResponse.mockReturnValue({
        id: 'google-converted',
        _extractedSignatures: [
          { toolCallId: 'call_1', signature: 'sig_a' },
          { toolCallId: 'call_2', signature: 'sig_b' },
        ],
      });

      const forward = mockForward({}, { isGoogle: true });
      const meta = makeMeta();

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        signatureCache as any,
        sessionKey,
      );

      expect(signatureCache.store).toHaveBeenCalledTimes(2);
      expect(signatureCache.store).toHaveBeenCalledWith('sess-456', 'call_1', 'sig_a');
      expect(signatureCache.store).toHaveBeenCalledWith('sess-456', 'call_2', 'sig_b');

      // _extractedSignatures should be deleted from the response body
      const sentBody = res.json.mock.calls[0][0];
      expect(sentBody._extractedSignatures).toBeUndefined();
    });

    it('caches reasoning_content from compatible non-stream responses with tool calls', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const reasoningCache = { store: jest.fn() };
      const sessionKey = 'sess-reasoning-json';
      const body = {
        id: 'chatcmpl-1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'I should call the tool.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      };
      const forward = mockForward(body);
      const meta = makeMeta({ provider: 'deepseek', model: 'deepseek-chat' });

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        sessionKey,
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      expect(reasoningCache.store).toHaveBeenCalledWith(
        'sess-reasoning-json',
        'call_1',
        'I should call the tool.',
      );
      expect(res.json).toHaveBeenCalledWith(body);
    });

    it('caches Zen reasoning_content when the cache exposes a model catalog', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const reasoningCache = {
        store: jest.fn(),
        modelCatalog: { isReasoningModel: () => true },
      };
      const body = {
        id: 'chatcmpl-zen',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'zen thinking',
              tool_calls: [
                { id: 'call_zen', type: 'function', function: { name: 'x', arguments: '{}' } },
              ],
            },
          },
        ],
      };
      const forward = mockForward(body);
      const meta = makeMeta({ provider: 'opencode-zen', model: 'opencode-zen/big-pickle' });

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        'sess-zen-json',
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      expect(reasoningCache.store).toHaveBeenCalledWith(
        'sess-zen-json',
        'call_zen',
        'zen thinking',
      );
    });

    it('does not cache reasoning_content from compatible non-stream assistant responses without tool calls', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const reasoningCache = { store: jest.fn() };
      const sessionKey = 'sess-reasoning-json';
      const body = {
        id: 'chatcmpl-1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'I checked the arithmetic.',
            },
          },
        ],
      };
      const forward = mockForward(body);
      const meta = makeMeta({ provider: 'deepseek', model: 'deepseek-chat' });

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        sessionKey,
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      expect(reasoningCache.store).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(body);
    });

    it('does not cache reasoning_content from strict provider responses', async () => {
      const { res } = mockResponse();
      const client = mockProviderClient();
      const reasoningCache = { store: jest.fn() };
      const body = {
        choices: [
          {
            message: {
              reasoning_content: 'unsupported',
              tool_calls: [{ id: 'call_1', type: 'function', function: {} }],
            },
          },
        ],
      };
      const forward = mockForward(body);
      const meta = makeMeta({ provider: 'mistral', model: 'mistral-large' });

      await handleNonStreamResponse(
        res as any,
        forward as any,
        meta,
        {},
        client as any,
        undefined,
        'sess-strict',
        undefined,
        'chat_completions',
        reasoningCache as any,
      );

      expect(reasoningCache.store).not.toHaveBeenCalled();
    });
  });

  /* ── recordSuccess ── */

  describe('recordSuccess', () => {
    it('should record fallback success when fallbackFromModel is set with timestamp', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o', fallbackIndex: 1 });
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };

      recordSuccess(
        testCtx,
        meta,
        usage,
        '2025-01-01T00:00:00Z',
        recorder as any,
        'trace-1',
        'session-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'request-order',
        4,
      );

      expect(recorder.recordFallbackSuccess).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        expect.objectContaining({
          requestId: 'request-order',
          attemptNumber: 4,
          traceId: 'trace-1',
          provider: 'openai',
          fallbackFromModel: 'gpt-4o',
          fallbackIndex: 1,
          timestamp: '2025-01-01T00:00:00Z',
          authType: undefined,
          reason: 'auto',
          usage,
        }),
      );
    });

    it('should record success message when no fallback and usage exists', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };

      recordSuccess(
        testCtx,
        meta,
        usage,
        undefined,
        recorder as any,
        'trace-1',
        'session-1',
        1000,
        undefined,
        undefined,
        undefined,
        'request-1',
        1,
        'messages',
      );

      expect(recorder.recordSuccessMessage).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        'auto',
        usage,
        expect.objectContaining({
          requestId: expect.any(String),
          attemptNumber: 1,
          traceId: 'trace-1',
          provider: 'openai',
          authType: undefined,
          sessionKey: 'session-1',
          durationMs: expect.any(Number),
          specificityCategory: undefined,
          apiMode: 'messages',
        }),
      );
    });

    it('should record with zero-value usage when no fallback and no usage data', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();

      recordSuccess(testCtx, meta, null, undefined, recorder as any);

      expect(recorder.recordFallbackSuccess).not.toHaveBeenCalled();
      expect(recorder.recordSuccessMessage).toHaveBeenCalledWith(
        testCtx,
        meta.model,
        meta.tier,
        meta.reason,
        { prompt_tokens: 0, completion_tokens: 0 },
        expect.objectContaining({ authType: meta.auth_type }),
      );
    });

    it('should not record fallback success when fallbackFromModel but no timestamp', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o' });
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };

      recordSuccess(testCtx, meta, usage, undefined, recorder as any);

      expect(recorder.recordFallbackSuccess).not.toHaveBeenCalled();
      expect(recorder.recordSuccessMessage).toHaveBeenCalled();
    });

    it('should compute durationMs when startTime is provided', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };
      const startTime = Date.now() - 500;

      recordSuccess(
        testCtx,
        meta,
        usage,
        undefined,
        recorder as any,
        undefined,
        undefined,
        startTime,
      );

      const call = recorder.recordSuccessMessage.mock.calls[0];
      const opts = call[5]; // 6th argument (opts object)
      expect(opts.durationMs).toBeGreaterThanOrEqual(400);
      expect(opts.durationMs).toBeLessThan(1000);
    });

    it('should pass undefined durationMs when startTime is not provided', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };

      recordSuccess(testCtx, meta, usage, undefined, recorder as any);

      const call = recorder.recordSuccessMessage.mock.calls[0];
      const opts = call[5]; // 6th argument (opts object)
      expect(opts.durationMs).toBeUndefined();
    });

    it('should pass streamUsage as undefined when null in fallback success', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o', fallbackIndex: 0 });

      recordSuccess(testCtx, meta, null, '2025-01-01T00:00:00Z', recorder as any);

      expect(recorder.recordFallbackSuccess).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        expect.objectContaining({
          requestId: expect.any(String),
          traceId: undefined,
          provider: 'openai',
          fallbackFromModel: 'gpt-4o',
          fallbackIndex: 0,
          timestamp: '2025-01-01T00:00:00Z',
          authType: undefined,
          reason: 'auto',
          usage: undefined,
        }),
      );
    });

    it('defaults fallbackIndex to 0 when meta does not set one', () => {
      const recorder = mockRecorder();
      // fallbackFromModel is set, timestamp is set, but fallbackIndex is undefined.
      // Exercises the `meta.fallbackIndex ?? 0` branch.
      const meta = makeMeta({ fallbackFromModel: 'claude-3' });

      recordSuccess(testCtx, meta, null, '2025-01-01T00:00:00Z', recorder as any);

      expect(recorder.recordFallbackSuccess).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        expect.objectContaining({ fallbackIndex: 0 }),
      );
    });

    it('forwards the winning fallback Autofix record to the fallback-success row', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o', fallbackIndex: 1 });
      const fallbackAutofix: AutofixRecord = {
        groupId: 'fallback-group',
        outcome: 'healed',
        original_http_status: 400,
        chain: [
          { attempt: 0, origin: 'original', request: {}, http_status: 400 },
          { attempt: 1, origin: 'autofix', request: {}, http_status: 200 },
        ],
      };

      recordSuccess(
        testCtx,
        meta,
        null,
        '2025-01-01T00:00:00Z',
        recorder as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        fallbackAutofix,
      );

      expect(recorder.recordFallbackSuccess).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        expect.objectContaining({ fallbackAutofix }),
      );
    });

    it('should pass specificityCategory when set on meta', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ specificity_category: 'coding' });
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };

      recordSuccess(testCtx, meta, usage, undefined, recorder as any, 'trace-1', 'session-1');

      expect(recorder.recordSuccessMessage).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        'auto',
        usage,
        expect.objectContaining({ specificityCategory: 'coding' }),
      );
    });

    // A healed Autofix chain: the failed original attempt is recorded as its
    // own auto_fixed row, linked to the successful-retry success row above.
    const healedAutofix: AutofixRecord = {
      groupId: 'grp-1',
      outcome: 'healed',
      original_http_status: 400,
      chain: [
        {
          attempt: 0,
          origin: 'original',
          request: {},
          http_status: 400,
          error: { message: 'Unknown parameter' },
        },
        { attempt: 1, origin: 'autofix', request: {}, http_status: 200 },
      ],
    };

    it('records the failed Autofix original(s) when the chain has a failed entry (healed)', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();
      const usage: StreamUsage = { prompt_tokens: 100, completion_tokens: 50 };

      recordSuccess(
        testCtx,
        meta,
        usage,
        undefined,
        recorder as any,
        'trace-1',
        'session-1',
        undefined,
        null,
        undefined,
        healedAutofix,
      );

      expect(recorder.recordAutofixOriginal).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        healedAutofix,
        expect.objectContaining({ provider: 'openai', reason: 'auto', traceId: 'trace-1' }),
      );
      expect(recorder.recordManifestBlockedRequest).not.toHaveBeenCalled();
    });

    it('does NOT record a separate auto_fixed original when healed but a fallback took over', () => {
      // Edge: heal succeeded (outcome 'healed') but a later stream fallback took
      // the request, so meta.fallbackFromModel is set and meta.model is now the
      // fallback route. A standalone auto_fixed row here would be mis-attributed
      // under the fallback model — the fallback path already carries the stamp.
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'claude-opus', fallbackIndex: 0 });

      recordSuccess(
        testCtx,
        meta,
        { prompt_tokens: 1, completion_tokens: 1 },
        '2025-01-01T00:00:00Z',
        recorder as any,
        'trace-1',
        'session-1',
        undefined,
        null,
        undefined,
        healedAutofix,
      );

      expect(recorder.recordFallbackSuccess).toHaveBeenCalled();
      expect(recorder.recordAutofixOriginal).not.toHaveBeenCalled();
    });

    it('does NOT record a separate auto_fixed original when healing EXHAUSTED but a fallback then succeeded', () => {
      // Fallback-success path: meta.fallbackFromModel is set (so the
      // recordFallbackSuccess branch runs) and the Autofix chain carries a
      // failed attempt — but healing did NOT heal. The failed primary is
      // already recorded exactly once as the `fallback_error` row (stamped with
      // the Autofix audit by recordFallbackFailures), so emitting an
      // `auto_fixed` row here too would double-count it under the fallback model.
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'claude-opus', fallbackIndex: 0 });
      const exhaustedAutofix: AutofixRecord = {
        groupId: 'grp-exhausted',
        outcome: 'exhausted',
        original_http_status: 400,
        chain: [
          {
            attempt: 0,
            origin: 'original',
            request: {},
            http_status: 400,
            error: { message: 'x' },
          },
        ],
      };

      recordSuccess(
        testCtx,
        meta,
        { prompt_tokens: 1, completion_tokens: 1 },
        '2025-01-01T00:00:00Z',
        recorder as any,
        undefined,
        undefined,
        undefined,
        null,
        undefined,
        exhaustedAutofix,
      );

      // The success itself came from the fallback model.
      expect(recorder.recordFallbackSuccess).toHaveBeenCalled();
      expect(recorder.recordSuccessMessage).not.toHaveBeenCalled();
      // …and no duplicate auto_fixed row is written for the failed primary.
      expect(recorder.recordAutofixOriginal).not.toHaveBeenCalled();
    });

    it('does not record Autofix originals when healing did not heal (outcome !== healed)', () => {
      // An Autofix record that did not heal must not trigger
      // recordAutofixOriginal — the guard is the presence of a real retry.
      const recorder = mockRecorder();
      const meta = makeMeta();
      const emptyChainAutofix: AutofixRecord = {
        groupId: 'grp-empty',
        outcome: 'exhausted',
        original_http_status: 400,
        chain: [],
      };

      recordSuccess(
        testCtx,
        meta,
        { prompt_tokens: 1, completion_tokens: 1 },
        undefined,
        recorder as any,
        undefined,
        undefined,
        undefined,
        null,
        undefined,
        emptyChainAutofix,
      );

      expect(recorder.recordAutofixOriginal).not.toHaveBeenCalled();
    });

    it('does not record Autofix originals when autofix is absent', () => {
      // Guards the `autofix && …` short-circuit: no autofix record at all.
      const recorder = mockRecorder();
      const meta = makeMeta();

      recordSuccess(
        testCtx,
        meta,
        { prompt_tokens: 1, completion_tokens: 1 },
        undefined,
        recorder as any,
      );

      expect(recorder.recordAutofixOriginal).not.toHaveBeenCalled();
    });
  });

  describe('requestHeaders propagation', () => {
    const headers = { 'x-custom-foo': 'bar' };

    it('handleProviderError forwards requestHeaders to recordProviderError', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();
      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        500,
        'boom',
        undefined,
        recorder as any,
        'trace-1',
        null,
        headers,
      );
      expect(recorder.recordProviderError).toHaveBeenCalledWith(
        testCtx,
        500,
        'boom',
        expect.objectContaining({ requestHeaders: headers }),
      );
    });

    it('fallback-exhausted path forwards requestHeaders to both failure recorders', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta();
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-3-haiku',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 429,
          errorBody: '',
        },
      ];
      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        502,
        'fail',
        failedFallbacks,
        recorder as any,
        undefined,
        null,
        headers,
      );
      expect(recorder.recordFailedFallbacks).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'gpt-4o',
        failedFallbacks,
        expect.objectContaining({ requestHeaders: headers }),
      );
      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'gpt-4o',
        'fail',
        expect.any(String),
        undefined,
        expect.objectContaining({ requestHeaders: headers }),
      );
    });

    it('recordFallbackFailures forwards requestHeaders to both failure recorders', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryProvider: 'anthropic',
      });
      const failedFallbacks: FailedFallback[] = [
        { model: 'x', provider: 'y', fallbackIndex: 0, status: 500, errorBody: '' },
      ];
      recordFallbackFailures(testCtx, meta, failedFallbacks, recorder as any, null, headers);
      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'claude-sonnet-4',
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({ requestHeaders: headers }),
      );
      expect(recorder.recordFailedFallbacks).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'claude-sonnet-4',
        failedFallbacks,
        expect.objectContaining({ requestHeaders: headers }),
      );
    });

    it('recordFallbackFailures threads meta.reason into the recordFailedFallbacks opts', () => {
      // Sibling rows (the failed fallbacks of a fallback-success flow) must
      // inherit the same routing_reason as the success row, otherwise the
      // Messages log shows split reasons for one logical request.
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryProvider: 'anthropic',
        reason: 'header-match',
      });
      const failedFallbacks: FailedFallback[] = [
        { model: 'x', provider: 'y', fallbackIndex: 0, status: 500, errorBody: '' },
      ];
      recordFallbackFailures(testCtx, meta, failedFallbacks, recorder as any);
      expect(recorder.recordFailedFallbacks).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'claude-sonnet-4',
        failedFallbacks,
        expect.objectContaining({ reason: 'header-match' }),
      );
    });

    it('recordFallbackFailures attributes the primary label, not the winning fallback one', () => {
      // In a fallback-success flow meta.provider_key_label holds the connection
      // that RECOVERED the request; the primary-failure row must keep the one
      // that actually failed (mirrors primaryTenantProviderId).
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryProvider: 'anthropic',
        provider_key_label: 'Fallback key',
        primaryKeyLabel: 'Primary key',
      });
      const failedFallbacks: FailedFallback[] = [
        { model: 'x', provider: 'y', fallbackIndex: 0, status: 500, errorBody: '' },
      ];

      recordFallbackFailures(testCtx, meta, failedFallbacks, recorder as any);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'claude-sonnet-4',
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({ providerKeyLabel: 'Primary key' }),
      );
      expect(recorder.recordFailedFallbacks).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'claude-sonnet-4',
        failedFallbacks,
        expect.objectContaining({ providerKeyLabel: 'Primary key' }),
      );
    });

    it('recordFallbackFailures falls back to provider_key_label when no primary label was preserved', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({
        fallbackFromModel: 'claude-sonnet-4',
        primaryProvider: 'anthropic',
        provider_key_label: 'Only key',
      });

      recordFallbackFailures(testCtx, meta, [], recorder as any);

      expect(recorder.recordPrimaryFailure).toHaveBeenCalledWith(
        testCtx,
        'standard',
        'claude-sonnet-4',
        expect.any(String),
        expect.any(String),
        undefined,
        expect.objectContaining({ providerKeyLabel: 'Only key' }),
      );
    });

    it('recordSuccess forwards requestHeaders on the success-message path', () => {
      const recorder = mockRecorder();
      const meta = makeMeta();
      recordSuccess(
        testCtx,
        meta,
        { prompt_tokens: 1, completion_tokens: 1 },
        undefined,
        recorder as any,
        undefined,
        undefined,
        undefined,
        null,
        headers,
      );
      expect(recorder.recordSuccessMessage).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        'auto',
        expect.anything(),
        expect.objectContaining({ requestHeaders: headers }),
      );
    });

    it('recordSuccess forwards requestHeaders on the fallback-success path', () => {
      const recorder = mockRecorder();
      const meta = makeMeta({ fallbackFromModel: 'gpt-4o', fallbackIndex: 1 });
      recordSuccess(
        testCtx,
        meta,
        { prompt_tokens: 1, completion_tokens: 1 },
        '2025-01-01T00:00:00Z',
        recorder as any,
        undefined,
        undefined,
        undefined,
        null,
        headers,
      );
      expect(recorder.recordFallbackSuccess).toHaveBeenCalledWith(
        testCtx,
        'gpt-4o',
        'standard',
        expect.objectContaining({ requestHeaders: headers }),
      );
    });
  });

  describe('CodeAssist envelope in handleStreamResponse', () => {
    function mockForward(
      flags: {
        isGoogle?: boolean;
        isCodeAssist?: boolean;
      } = {},
    ) {
      return {
        response: { body: { getReader: jest.fn() } },
        isGoogle: flags.isGoogle ?? false,
        isAnthropic: false,
        isChatGpt: false,
        isResponses: false,
        isCodeAssist: flags.isCodeAssist ?? false,
      };
    }

    function mockProviderClient() {
      return {
        convertGoogleStreamChunk: jest
          .fn()
          .mockReturnValue({ chunk: 'data: out\n\n', signatures: [] }),
        createAnthropicStreamTransformer: jest.fn().mockReturnValue(jest.fn()),
        createChatGptStreamTransformer: jest.fn().mockReturnValue(jest.fn()),
      };
    }

    let pipeStreamSpy: jest.SpyInstance;
    let initSseHeadersSpy: jest.SpyInstance;

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const streamWriter = require('../stream-writer');
      pipeStreamSpy = jest.spyOn(streamWriter, 'pipeStream').mockResolvedValue(null);
      initSseHeadersSpy = jest.spyOn(streamWriter, 'initSseHeaders').mockImplementation(() => {});
    });

    afterEach(() => {
      pipeStreamSpy?.mockRestore();
      initSseHeadersSpy?.mockRestore();
    });

    it('unwraps CodeAssist envelope before passing chunk to convertGoogleStreamChunk', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isGoogle: true, isCodeAssist: true });
      const client = mockProviderClient();
      const meta = makeMeta();

      let capturedTransform: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_b: unknown, _r: unknown, transform?: (c: string) => string | null) => {
          capturedTransform = transform;
          return null;
        },
      );
      client.convertGoogleStreamChunk.mockReturnValue({
        chunk: 'data: converted\n\n',
        signatures: [],
      });

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      expect(capturedTransform).toBeDefined();
      // pipeStream passes the parsed SSE payload, not the raw data: line.
      const inner = { candidates: [{ content: 'hello' }] };
      const wrapped = JSON.stringify({ response: inner });
      capturedTransform!(wrapped);

      // convertGoogleStreamChunk receives the bare Gemini payload.
      const calledWith = client.convertGoogleStreamChunk.mock.calls[0][0] as string;
      expect(calledWith).toBe(JSON.stringify(inner));
    });

    it('does not unwrap when isCodeAssist is false (plain Google path)', async () => {
      const { res } = mockResponse();
      const forward = mockForward({ isGoogle: true, isCodeAssist: false });
      const client = mockProviderClient();
      const meta = makeMeta();

      let capturedTransform: ((chunk: string) => string | null) | undefined;
      pipeStreamSpy.mockImplementation(
        async (_b: unknown, _r: unknown, transform?: (c: string) => string | null) => {
          capturedTransform = transform;
          return null;
        },
      );
      client.convertGoogleStreamChunk.mockReturnValue({ chunk: 'data: out\n\n', signatures: [] });

      await handleStreamResponse(res as any, forward as any, meta, {}, client as any);

      const wrapped = `data: ${JSON.stringify({ response: { candidates: [] } })}\n`;
      capturedTransform!(wrapped);

      // Without unwrapping, the raw wrapped chunk is passed through.
      const calledWith = client.convertGoogleStreamChunk.mock.calls[0][0] as string;
      expect(calledWith).toContain('"response"');
    });
  });

  describe('CodeAssist envelope in handleNonStreamResponse', () => {
    function makeNonStreamForward(
      body: unknown,
      flags: { isGoogle?: boolean; isCodeAssist?: boolean } = {},
    ) {
      return {
        response: {
          json: jest.fn().mockResolvedValue(body),
          text: jest.fn().mockResolvedValue(JSON.stringify(body)),
          headers: { get: jest.fn().mockReturnValue('application/json') },
        },
        isGoogle: flags.isGoogle ?? false,
        isAnthropic: false,
        isChatGpt: false,
        isResponses: false,
        isCodeAssist: flags.isCodeAssist ?? false,
      };
    }

    function mockNonStreamClient() {
      return {
        convertGoogleResponse: jest.fn().mockReturnValue({ id: 'converted' }),
        convertAnthropicResponse: jest.fn(),
        convertChatGptResponse: jest.fn(),
        collectChatGptSseResponse: jest.fn(),
      };
    }

    it('unwraps CodeAssist response envelope before calling convertGoogleResponse', async () => {
      const { res } = mockResponse();
      const client = mockNonStreamClient();
      const inner = { candidates: [{ text: 'hello' }] };
      const wrapped = { response: inner, traceId: 'abc' };
      const forward = makeNonStreamForward(wrapped, { isGoogle: true, isCodeAssist: true });
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      // The unwrapped inner object must be passed to convertGoogleResponse.
      expect(client.convertGoogleResponse).toHaveBeenCalledWith(inner, meta.model);
    });

    it('does not unwrap for plain Google responses (no CodeAssist envelope)', async () => {
      const { res } = mockResponse();
      const client = mockNonStreamClient();
      const rawBody = { candidates: [{ text: 'hello' }] };
      const forward = makeNonStreamForward(rawBody, { isGoogle: true, isCodeAssist: false });
      const meta = makeMeta();

      await handleNonStreamResponse(res as any, forward as any, meta, {}, client as any);

      // Raw body (not unwrapped) is passed to convertGoogleResponse.
      expect(client.convertGoogleResponse).toHaveBeenCalledWith(rawBody, meta.model);
    });
  });

  describe('handleProviderError with specificity', () => {
    it('should pass specificityCategory to recordProviderError', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ specificity_category: 'coding' });
      const metaHeaders = buildMetaHeaders(meta);

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        metaHeaders,
        500,
        'Internal Server Error',
        undefined,
        recorder as any,
        'trace-1',
      );

      expect(recorder.recordProviderError).toHaveBeenCalledWith(
        testCtx,
        500,
        'Internal Server Error',
        expect.objectContaining({ specificityCategory: 'coding' }),
      );
    });
  });
  /* ── Credential scrubbing in log output ── */

  describe('secret scrubbing of logged upstream error bodies', () => {
    // Anthropic 401s echo the caller's own auth header back inside the error
    // body. Everything we log has to go through scrubSecrets first.
    const ANTHROPIC_KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
    const BEARER_TOKEN = 'sk-proj-1111222233334444555566667777';
    const LEAKY_401_BODY = JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: `invalid x-api-key: ${ANTHROPIC_KEY}`,
      },
      request_headers: {
        'x-api-key': ANTHROPIC_KEY,
        authorization: `Bearer ${BEARER_TOKEN}`,
      },
    });

    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    function loggedLines(): string {
      return warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    }

    it('scrubs credentials from the "Upstream error" log line', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-sonnet-4' });

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        401,
        LEAKY_401_BODY,
        undefined,
        recorder as any,
        'trace-secret-1',
      );

      const logged = loggedLines();
      expect(logged).toContain('Upstream error 401');
      expect(logged).toContain('[REDACTED]');
      expect(logged).not.toContain(ANTHROPIC_KEY);
      expect(logged).not.toContain(BEARER_TOKEN);
    });

    it('scrubs credentials from the "Fallback chain exhausted" log line', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-sonnet-4' });
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-3-haiku',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 401,
          errorBody: LEAKY_401_BODY,
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        401,
        LEAKY_401_BODY,
        failedFallbacks,
        recorder as any,
        'trace-secret-2',
      );

      const logged = loggedLines();
      expect(logged).toContain('Fallback chain exhausted');
      expect(logged).toContain('[REDACTED]');
      expect(logged).not.toContain(ANTHROPIC_KEY);
      expect(logged).not.toContain(BEARER_TOKEN);
    });

    it('masks a key that straddles the truncation boundary', async () => {
      const { res } = mockResponse();
      const recorder = mockRecorder();
      const meta = makeMeta({ provider: 'anthropic', model: 'claude-sonnet-4' });
      // A 300-char key pushes the sentinel past the 200-char slice. Only
      // scrub-then-slice collapses the key first and keeps the sentinel in the
      // log; slice-then-scrub cuts inside the key and drops the sentinel.
      const longKey = `sk-ant-api03-${'A'.repeat(300)}`;
      const straddling = `${'x'.repeat(100)} ${longKey} TAIL_SENTINEL`;
      const failedFallbacks: FailedFallback[] = [
        {
          model: 'claude-3-haiku',
          provider: 'anthropic',
          fallbackIndex: 0,
          status: 401,
          errorBody: straddling,
        },
      ];

      await handleProviderError(
        res as any,
        testCtx,
        meta,
        buildMetaHeaders(meta),
        401,
        straddling,
        failedFallbacks,
        recorder as any,
        'trace-secret-3',
      );

      const logged = loggedLines();
      expect(logged).toContain('[REDACTED]');
      expect(logged).toContain('TAIL_SENTINEL');
      expect(logged).not.toContain('sk-ant-api03-AAAA');
    });
  });
});
