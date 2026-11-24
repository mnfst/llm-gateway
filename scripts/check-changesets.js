const fs = require('fs');
const path = require('path');

// Guardrail: every changeset must target a *releasable* package.
//
// `.changeset/config.json` ignores manifest-backend / -frontend / -shared and
// mnfst-gateway-cli (the CLI version tracks the Manifest release), so a
// changeset that targets only those is silently dropped by `changeset version`:
// it produces no version bump, yet still trips changesets/action into pushing an
// empty `changeset-release/main` branch. Creating the version PR then fails with
// "No commits between main and changeset-release/main", which aborts the Release
// job *before* the version-bump detection and Docker publish steps run.
//
// This check fails a PR early with a clear message instead. Empty changesets
// (`changeset add --empty`) have no targets and are allowed.

const DEFAULT_DIR = path.join(__dirname, '..', '.changeset');

function loadIgnored(dir) {
  const config = JSON.parse(
    fs.readFileSync(path.join(dir, 'config.json'), 'utf8'),
  );
  return new Set(config.ignore ?? []);
}

function parseTargets(frontMatter) {
  return frontMatter
    .split('\n')
    .map((line) => line.match(/^\s*["']?([^"':\s]+)["']?\s*:/))
    .filter(Boolean)
    .map((match) => match[1]);
}

function findViolations(dir = DEFAULT_DIR) {
  const ignored = loadIgnored(dir);
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'README.md');

  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontMatter) continue; // no front matter => nothing to release
    const targets = parseTargets(frontMatter[1]);
    const ignoredTargets = targets.filter((name) => ignored.has(name));
    if (ignoredTargets.length > 0) {
      violations.push({ file, ignoredTargets });
    }
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('OK: all changesets target a releasable package.');
    return;
  }
  console.error('Changeset(s) target ignored packages:\n');
  for (const { file, ignoredTargets } of violations) {
    console.error(`  .changeset/${file} -> ${ignoredTargets.join(', ')}`);
  }
  console.error(
    '\nOnly "manifest" is releasable. manifest-backend / -frontend / -shared\n' +
      'and mnfst-gateway-cli are ignored in .changeset/config.json, so\n' +
      '`changeset version` silently drops them. A changeset that targets them\n' +
      'makes versioning a no-op and breaks the Release workflow ("No commits\n' +
      'between main and changeset-release/main").\n\n' +
      "Fix: change the front matter to `'manifest': patch` (or minor / major).",
  );
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { findViolations, parseTargets };
