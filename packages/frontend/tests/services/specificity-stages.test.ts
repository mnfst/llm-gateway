import { describe, it, expect } from 'vitest';
import { SPECIFICITY_CATEGORIES } from 'manifest-shared';
import { SPECIFICITY_STAGES } from '../../src/services/providers';

/**
 * Parity guard: the backend accepts/emits every category in
 * `SPECIFICITY_CATEGORIES` (manifest-shared), but the UI renders only what
 * appears in `SPECIFICITY_STAGES`. A category missing from the stages array
 * is accepted by the API and invisible in the Routing UI and log filters —
 * this is what happened to `private_docs` (fixed in the
 * feature/private-docs-specificity follow-up). Fails loudly so the next
 * category addition lands both lists together.
 */
describe('SPECIFICITY_STAGES parity with shared SPECIFICITY_CATEGORIES', () => {
  it('exposes a stage for every shared specificity category', () => {
    expect([...SPECIFICITY_STAGES.map((s) => s.id)].sort()).toEqual(
      [...SPECIFICITY_CATEGORIES].sort(),
    );
  });

  it('gives every stage a non-empty label and description', () => {
    for (const stage of SPECIFICITY_STAGES) {
      expect(stage.label.trim().length, `stage "${stage.id}" label`).toBeGreaterThan(0);
      expect(stage.desc.trim().length, `stage "${stage.id}" desc`).toBeGreaterThan(0);
    }
  });
});
