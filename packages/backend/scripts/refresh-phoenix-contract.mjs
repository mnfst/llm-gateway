#!/usr/bin/env node
/**
 * Refresh the vendored Phoenix OpenAPI contract from its source of truth.
 *
 * Phoenix (`mnfst/phoenix`) is a private repo, so the spec is fetched through the
 * authenticated GitHub CLI rather than a raw URL. Run after Phoenix changes its
 * `/api/heal*` contract, then review the diff and reconcile `phoenix.types.ts`.
 *
 *   npm run contract:refresh --workspace=packages/backend
 *
 * Requires `gh auth login` with read access to mnfst/phoenix. The scheduled
 * `.github/workflows/phoenix-contract-drift.yml` runs this and fails on any diff.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'mnfst/phoenix';
const REF = process.env.PHOENIX_CONTRACT_REF ?? 'main';
const SPEC = 'phoenix-openapi.yaml';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'src', 'routing', 'autofix', 'contract', 'phoenix-openapi.yaml');

const base64 = execFileSync(
  'gh',
  ['api', `repos/${REPO}/contents/${SPEC}?ref=${REF}`, '--jq', '.content'],
  { encoding: 'utf8' },
);
writeFileSync(dest, Buffer.from(base64, 'base64'));
console.log(`Refreshed ${dest}\n  from ${REPO}@${REF}:${SPEC}`);
