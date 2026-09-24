import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPECIFICITY_CATEGORIES } from 'manifest-shared';

/**
 * Parity guard for the frontend's `SPECIFICITY_STAGES` list.
 *
 * Backend tests can't import the frontend package, but they can read the
 * file. SPECIFICITY_STAGES is a static array of `{ id: '...' }` literals —
 * the frontend test at packages/frontend/tests/services/specificity-stages.test.ts
 * asserts runtime parity against SPECIFICITY_CATEGORIES, and this test statically
 * asserts the same from the backend side so the omission is caught no matter
 * which package's suite runs in isolation.
 */
describe('frontend SPECIFICITY_STAGES parity (static)', () => {
  it('declares a stage id for every shared specificity category', () => {
    const source = readFileSync(
      join(__dirname, '../../../../frontend/src/services/providers.ts'),
      'utf8',
    );
    const markerIndex = source.indexOf('export const SPECIFICITY_STAGES');
    expect(markerIndex).toBeGreaterThanOrEqual(0);

    const terminatorIndex = source.indexOf('\n];', markerIndex);
    expect(terminatorIndex).toBeGreaterThan(markerIndex);

    const stagesSource = source.slice(markerIndex, terminatorIndex);
    const stageIds = [...stagesSource.matchAll(/id:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    for (const category of SPECIFICITY_CATEGORIES) {
      expect(stageIds.includes(category)).toBe(true);
    }
  });
});
