import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import type { HealingClient, HealingRequestContext } from './healing-client';
import type { ConfirmResponse, HealOutcome, HealRequest, HealResponse } from './phoenix.types';

/**
 * Deterministic in-process stand-in for Phoenix, used outside production so a
 * local run never posts real failures at the hosted healer and a test never
 * depends on the network. It implements the MVP #1 case end-to-end — an unknown-parameter 4xx
 * whose `param` has a known rename (e.g. the Responses API rejecting
 * `max_tokens`) is patched into `max_output_tokens` via a `rename_param`
 * operation. Everything else returns `no_patch`. Lets the whole heal → resend →
 * confirm loop be exercised without the external service.
 */
export const MOCK_RENAME_CATALOG: Record<string, string> = {
  max_tokens: 'max_output_tokens',
};

@Injectable()
export class MockHealingClient implements HealingClient {
  private readonly logger = new Logger(MockHealingClient.name);

  heal(input: HealRequest, _context: HealingRequestContext): Promise<HealResponse> {
    const issueId = uuid();
    const { code, param } = input.response.error;
    // `param` comes from an untrusted provider error. Use own-property checks so a
    // prototype name (`toString`, `constructor`, …) can't resolve to an inherited
    // member of the catalog or the request and trigger a bogus rename.
    const rename =
      param && Object.hasOwn(MOCK_RENAME_CATALOG, param) ? MOCK_RENAME_CATALOG[param] : undefined;

    if (code === 'unknown_parameter' && param && rename && Object.hasOwn(input.request, param)) {
      const healedBody: Record<string, unknown> = { ...input.request };
      healedBody[rename] = healedBody[param];
      delete healedBody[param];
      this.logger.debug(`mock heal: rename_param ${param} -> ${rename}`);
      // A freshly served patch is `unverified` in Phoenix (only an already-verified
      // issue answers `patched`); the mock is stateless, so it always serves unverified.
      return Promise.resolve({
        status: 'unverified',
        issueId,
        patchId: uuid(),
        healAttemptId: uuid(),
        operations: [{ type: 'rename_param', from: param, to: rename }],
        healedBody,
      });
    }

    return Promise.resolve({ status: 'no_patch', issueId });
  }

  observe(observations: HealRequest[], _context: HealingRequestContext): Promise<void> {
    this.logger.log(`mock observe: ${observations.length} observation(s) discarded`);
    return Promise.resolve();
  }

  reportOutcome(
    healAttemptId: string,
    outcome: HealOutcome,
    _context: HealingRequestContext,
  ): Promise<ConfirmResponse | null> {
    // Phoenix decides from the retry outcome: a cleared target (2xx or a
    // different error) succeeds; the same error recurring fails. The mock has no
    // memory of the original error, so it treats any non-4xx retry as success.
    const succeeded = outcome.retryStatusCode < 400;
    return Promise.resolve({
      healAttemptId,
      status: succeeded ? 'succeeded' : 'failed',
      // Reporting an outcome is evidence-only in Phoenix — it never moves the
      // issue's status — so a served patch stays `unverified` either way.
      issueStatus: 'unverified',
    });
  }
}
