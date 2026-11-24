import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';
import { AGENT_PLATFORMS } from 'manifest-shared';
import { HEAL_STATUSES, ISSUE_STATUSES, OUTCOME_STATUSES } from '../phoenix.types';

/**
 * Contract test — the anti-drift guardrail. Manifest's hand-written Phoenix types
 * (phoenix.types.ts) must stay in lockstep with Phoenix's OpenAPI spec, vendored
 * at ./contract/phoenix-openapi.yaml and refreshed with `npm run contract:refresh`.
 *
 * This is what would have caught, in CI, both drifts we hit by hand:
 *  - Phase 0: `traceId` became required (we still sent `requestId`).
 *  - Phase 1: the status enums were renamed (pending_confirmation → unverified, …).
 */

const SPEC_PATH = join(__dirname, '..', 'contract', 'phoenix-openapi.yaml');

interface SchemaObject {
  properties?: Record<string, { enum?: string[] }>;
}
interface OpenApiDoc {
  security: Array<Record<string, unknown[]>>;
  paths: Record<string, Record<string, { security?: Array<Record<string, unknown[]>> }>>;
  components: {
    schemas: Record<string, SchemaObject>;
    parameters: Record<string, { schema?: { enum?: string[] } }>;
    securitySchemes: Record<string, unknown>;
  };
}

const doc = load(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDoc;
const schemas = doc.components.schemas;

/** The `status` enum a schema declares in the vendored spec. */
function statusEnum(schemaName: string): string[] {
  const values = schemas[schemaName]?.properties?.status?.enum;
  if (!values) throw new Error(`${schemaName}.status enum missing from the vendored spec`);
  return values;
}

// Register just the schemas subtree so `$ref: #/components/schemas/X` resolves and
// ajv never scans `securitySchemes` (whose `type: apiKey` is not a JSON-Schema type).
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addSchema({ components: { schemas } }, 'phoenix');

function validator(schemaName: string): ValidateFunction {
  const validate = ajv.getSchema(`phoenix#/components/schemas/${schemaName}`);
  if (!validate) throw new Error(`schema ${schemaName} not found in the vendored spec`);
  return validate;
}

describe('Phoenix wire contract (vendored OpenAPI)', () => {
  describe('status enums stay in lockstep with the spec', () => {
    it('HealResult.status === HEAL_STATUSES', () => {
      expect([...HEAL_STATUSES].sort()).toEqual([...statusEnum('HealResult')].sort());
    });
    it('IssueView.status === ISSUE_STATUSES', () => {
      expect([...ISSUE_STATUSES].sort()).toEqual([...statusEnum('IssueView')].sort());
    });
    it('OutcomeResult.status === OUTCOME_STATUSES', () => {
      expect([...OUTCOME_STATUSES].sort()).toEqual([...statusEnum('OutcomeResult')].sort());
    });
  });

  describe('HealRequest — the body HttpHealingClient sends', () => {
    const validate = validator('HealRequest');
    // Mirrors the heal() call in AutofixService.runHealOnce — keep them aligned.
    const valid = {
      traceId: 'trace-abc',
      tenantId: 'tenant-abc',
      provider: 'openai',
      authType: 'api_key',
      api: 'chat_completions',
      url: 'https://api.openai.com/v1/chat/completions',
      request: { model: 'gpt-4o', max_tokens: 100 },
      response: {
        statusCode: 400,
        error: {
          message: 'unknown parameter',
          code: 'unknown_parameter',
          param: 'max_tokens',
          type: 'invalid_request_error',
        },
      },
    };

    it('accepts the request the client builds', () => {
      expect(validate(valid)).toBe(true);
    });

    it('rejects a request missing the required traceId (the Phase 0 break)', () => {
      const noTrace: Record<string, unknown> = { ...valid };
      delete noTrace.traceId;
      expect(validate(noTrace)).toBe(false);
      expect(JSON.stringify(validate.errors)).toContain('traceId');
    });

    it('rejects an `api` value outside the enum', () => {
      expect(validate({ ...valid, api: 'completions' })).toBe(false);
    });

    it('rejects an auth type outside the enum', () => {
      expect(validate({ ...valid, authType: 'oauth' })).toBe(false);
    });
  });

  describe('instance identification', () => {
    it('exposes no registration handshake', () => {
      // The id is announced, never issued: there is nothing to register for.
      expect(doc.paths['/api/instances/register']).toBeUndefined();
    });

    it('accepts a static key or a bare instance id on the gateway operations', () => {
      expect(doc.security).toEqual([{ ApiKeyAuth: [] }]);
      for (const operation of [
        doc.paths['/api/heal'].post,
        doc.paths['/api/heal/observe'].post,
        doc.paths['/api/heal-attempts/{id}'].patch,
      ]) {
        expect(operation.security).toEqual([{ ApiKeyAuth: [] }, { ManifestInstanceAuth: [] }]);
      }
      expect(doc.components.securitySchemes).toHaveProperty('ApiKeyAuth');
      expect(doc.components.securitySchemes).toHaveProperty('ManifestInstanceAuth');
    });

    it('carries no bearer-secret scheme', () => {
      // Identifier, not credential — a secret scheme reappearing here means
      // Phoenix went back to issuing credentials and Manifest must follow.
      expect(doc.components.securitySchemes).not.toHaveProperty('InstanceBearerAuth');
      const scheme = doc.components.securitySchemes.ManifestInstanceAuth as {
        in: string;
        name: string;
      };
      expect(scheme.in).toBe('header');
      expect(scheme.name).toBe('X-Manifest-Instance');
    });

    it('keeps the harness header allowlist in lockstep with AGENT_PLATFORMS', () => {
      expect(doc.components.parameters.ManifestHarness.schema?.enum).toEqual([...AGENT_PLATFORMS]);
    });
  });

  describe('HealOutcome — the PATCH body', () => {
    const validate = validator('HealOutcome');
    it('accepts a 2xx outcome and a >=400 outcome with an error', () => {
      expect(validate({ retryStatusCode: 200 })).toBe(true);
      expect(validate({ retryStatusCode: 400, error: { message: 'still bad' } })).toBe(true);
    });
  });

  describe('response shapes the client parses', () => {
    const UUID = '11111111-1111-4111-8111-111111111111';

    it('HealResult: an unverified served patch validates', () => {
      const validate = validator('HealResult');
      expect(
        validate({
          status: 'unverified',
          issueId: UUID,
          patchId: UUID,
          healAttemptId: UUID,
          operations: [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }],
          healedBody: { model: 'gpt-4o', max_output_tokens: 100 },
        }),
      ).toBe(true);
    });

    it('OutcomeResult validates', () => {
      const validate = validator('OutcomeResult');
      expect(
        validate({ healAttemptId: UUID, status: 'succeeded', issueStatus: 'unverified' }),
      ).toBe(true);
    });
  });
});
