const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findViolations, parseTargets } = require('./check-changesets.js');

const IGNORE = ['manifest-backend', 'manifest-frontend', 'manifest-shared'];

function makeChangesetDir(files, ignore = IGNORE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-test-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ignore }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('flags a changeset that targets only an ignored package', () => {
  const dir = makeChangesetDir({
    'bad.md': "---\n'manifest-frontend': patch\n---\n\nSummary.\n",
  });
  const violations = findViolations(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'bad.md');
  assert.deepEqual(violations[0].ignoredTargets, ['manifest-frontend']);
});

test('flags a changeset with multiple ignored targets', () => {
  const dir = makeChangesetDir({
    'multi.md':
      "---\n'manifest-backend': patch\n'manifest-shared': patch\n---\n\nSummary.\n",
  });
  const violations = findViolations(dir);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].ignoredTargets, [
    'manifest-backend',
    'manifest-shared',
  ]);
});

test('flags a mix of manifest and an ignored target', () => {
  const dir = makeChangesetDir({
    'mixed.md':
      "---\n'manifest': patch\n'manifest-backend': patch\n---\n\nSummary.\n",
  });
  const violations = findViolations(dir);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].ignoredTargets, ['manifest-backend']);
});

test('accepts a changeset that targets manifest', () => {
  const dir = makeChangesetDir({
    'good.md': "---\n'manifest': patch\n---\n\nSummary.\n",
  });
  assert.deepEqual(findViolations(dir), []);
});

test('accepts an unquoted manifest target', () => {
  const dir = makeChangesetDir({ 'good.md': '---\nmanifest: minor\n---\n\nx\n' });
  assert.deepEqual(findViolations(dir), []);
});

test('accepts an empty changeset', () => {
  const dir = makeChangesetDir({ 'empty.md': '---\n---\n' });
  assert.deepEqual(findViolations(dir), []);
});

test('ignores README.md even if it looks like a changeset', () => {
  const dir = makeChangesetDir({
    'README.md': "---\n'manifest-frontend': patch\n---\n\nnot a changeset\n",
  });
  assert.deepEqual(findViolations(dir), []);
});

test('parseTargets handles quoted, double-quoted and bare names', () => {
  assert.deepEqual(parseTargets("'manifest': patch"), ['manifest']);
  assert.deepEqual(parseTargets('"manifest-backend": patch'), [
    'manifest-backend',
  ]);
  assert.deepEqual(parseTargets('manifest: minor'), ['manifest']);
  assert.deepEqual(parseTargets(''), []);
});
