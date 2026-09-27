const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const parser = import('../design-system/lib/parse-css.mjs');
const cascade = import('../design-system/lib/cascade.mjs');
const emitter = import('../design-system/lib/emit.mjs');

test('CSS comment stripping preserves comment markers inside strings', async () => {
  const { stripComments } = await parser;
  const source = '.a { content: "/* not a comment */"; } /* remove me */\n.b { color: red; }';
  const stripped = stripComments(source);

  assert.match(stripped, /"\/\* not a comment \*\/"/);
  assert.doesNotMatch(stripped, /remove me/);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});

test('CSS parsing ignores braces inside quoted declaration values', async () => {
  const { parseCss } = await parser;
  const { rules } = parseCss('.a { content: "}"; color: red; } .b { color: blue; }', 'x.css');

  assert.deepEqual(
    rules.map((rule) => rule.selector),
    ['.a', '.b'],
  );
});

test('CSS parsing accepts unquoted url imports', async () => {
  const { parseCss } = await parser;
  const { imports } = parseCss('@import url(base.css);', 'x.css');

  assert.deepEqual(imports, [{ specifier: 'base.css', layer: null, offset: 0 }]);
});

test('CSS parsing captures import layer metadata', async () => {
  const { parseCss } = await parser;
  const { imports } = parseCss('@import "base.css" LAYER(theme);', 'x.css');

  assert.equal(imports[0].specifier, 'base.css');
  assert.equal(imports[0].layer, 'theme');
});

test('conditional at-rules remain separate from unconditional cascade rules', async () => {
  const { parseCss } = await parser;
  const { resolveConflicts } = await cascade;
  const { rules } = parseCss(
    '@supports (display: grid) { .a { display: grid; } } .a { display: block; }',
    'x.css',
  );
  const ordered = rules.map((rule, orderIndex) => ({ ...rule, orderIndex }));

  assert.equal(rules[0].media, '@supports (display: grid)');
  assert.deepEqual(resolveConflicts(ordered), { canonical: [], ghosts: [] });
});

test('important declarations beat later non-important declarations', async () => {
  const { resolveConflicts } = await cascade;
  const declarations = (value, line) => [{ prop: 'color', value, line }];
  const rules = [
    {
      selector: '.a',
      declarations: declarations('red !important', 1),
      media: '',
      file: 'first.css',
      orderIndex: 0,
    },
    {
      selector: '.a',
      declarations: declarations('blue', 1),
      media: '',
      file: 'second.css',
      orderIndex: 1,
    },
  ];

  const result = resolveConflicts(rules);
  assert.equal(result.canonical[0].value, 'red !important');
  assert.equal(result.ghosts[0].value, 'blue');
});

test('important detection accepts values without whitespace before the suffix', async () => {
  const { resolveConflicts } = await cascade;
  const declarations = (value) => [{ prop: 'color', value, line: 1 }];
  const rules = [
    {
      selector: '.a',
      declarations: declarations('red!important'),
      media: '',
      layer: '',
      file: 'first.css',
      orderIndex: 0,
    },
    {
      selector: '.a',
      declarations: declarations('blue'),
      media: '',
      layer: '',
      file: 'second.css',
      orderIndex: 1,
    },
  ];

  assert.equal(resolveConflicts(rules).canonical[0].value, 'red!important');
});

test('unlayered normal declarations beat declarations inside a layer', async () => {
  const { parseCss } = await parser;
  const { applyLayerRanks, resolveConflicts } = await cascade;
  const { rules, layers } = parseCss(
    '@layer components { .a { color: red; } } .a { color: blue; }',
    'x.css',
  );
  const ordered = applyLayerRanks(
    rules.map((rule, orderIndex) => ({ ...rule, orderIndex })),
    layers,
  );

  assert.equal(rules[0].layer, 'components');
  assert.equal(rules[0].media, '');
  assert.equal(resolveConflicts(ordered).canonical[0].value, 'blue');
});

test('important layer precedence reverses normal layer precedence', async () => {
  const { parseCss } = await parser;
  const { applyLayerRanks, resolveConflicts } = await cascade;
  const { rules, layers } = parseCss(
    '@layer base, components; @layer base { .a { color: red!important; } } @layer components { .a { color: blue!important; } } .a { color: green!important; }',
    'x.css',
  );
  const ordered = applyLayerRanks(
    rules.map((rule, orderIndex) => ({ ...rule, orderIndex })),
    layers,
  );

  assert.equal(resolveConflicts(ordered).canonical[0].value, 'red!important');
});

test('direct parent-layer declarations beat nested layers for normal rules', async () => {
  const { parseCss } = await parser;
  const { applyLayerRanks, resolveConflicts } = await cascade;
  const { rules, layers } = parseCss(
    '@layer framework { @layer components { .a { color: red; } } .a { color: blue; } }',
    'x.css',
  );
  const ordered = applyLayerRanks(
    rules.map((rule, orderIndex) => ({ ...rule, orderIndex })),
    layers,
  );

  assert.equal(resolveConflicts(ordered).canonical[0].value, 'blue');
});

test('anonymous layer identities are unique across parser scopes', async () => {
  const { parseCss } = await parser;
  const first = parseCss('@layer { .a { color: red; } }', 'a.css', { anonymousScope: 1 });
  const second = parseCss('@layer { .a { color: blue; } }', 'b.css', { anonymousScope: 2 });

  assert.notEqual(first.rules[0].layer, second.rules[0].layer);
});

test('cascade loading propagates import layers and unique anonymous identities', async (t) => {
  const { loadCascade, resolveConflicts } = await cascade;
  const dir = mkdtempSync(join(tmpdir(), 'manifest-registry-layers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'entry.css'),
    '@import "first.css" layer(theme); @import "second.css" layer; .a { color: blue; }',
  );
  writeFileSync(join(dir, 'first.css'), '@layer { .a { color: red; } }');
  writeFileSync(join(dir, 'second.css'), '@layer { .a { color: green; } }');

  const { rules } = loadCascade(join(dir, 'entry.css'));

  assert.match(rules[0].layer, /^theme\.__anonymous_/);
  assert.match(rules[1].layer, /^__anonymous_import_1\.__anonymous_/);
  assert.notEqual(rules[0].layer, rules[1].layer);
  assert.equal(resolveConflicts(rules).canonical[0].value, 'blue');
});

test('token resolution applies the same layer precedence as ordinary declarations', async () => {
  const { parseCss } = await parser;
  const { applyLayerRanks, resolveTokens } = await cascade;
  const { rules, layers } = parseCss(
    '@layer base { :root { --brand: red; } } :root { --brand: blue; }',
    'tokens.css',
  );
  const ordered = applyLayerRanks(
    rules.map((rule, orderIndex) => ({ ...rule, orderIndex })),
    layers,
  );

  assert.equal(resolveTokens(ordered).light.get('--brand').value, 'blue');
});

test('layout tokens are categorized before sidebar tokens', async () => {
  const { categorize } = await emitter;

  assert.equal(categorize('--sidebar-width'), 'layout');
  assert.equal(categorize('--sidebar-bg'), 'sidebar');
});
