#!/usr/bin/env node
// Generates the design-system registry from the frontend stylesheets.
//
//   node design-system/generate-registry.mjs           write registry/*
//   node design-system/generate-registry.mjs --check   exit 1 if registry/* is stale
//
// The registry is the machine-readable design system: the cascade-resolved
// token tables (light + dark), every BEM block with its classes, the list of
// primitives (src/components/ui), the legacy→primitive migration map
// (design-system/migration-map.json, hand-kept), the canonical rule wherever
// the same selector+property is declared twice (the one that renders, with
// its source), and the ghost rules that always lose. Generated output is
// committed; `--check` keeps it from drifting.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, relative } from 'node:path';
import { loadCascade, resolveConflicts, resolveTokens, groupBlocks } from './lib/cascade.mjs';
import { buildRegistry, buildLlmsTxt } from './lib/emit.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stylesDir = join(root, 'packages/frontend/src/styles');
const uiDir = join(root, 'packages/frontend/src/components/ui');
const registryDir = join(root, 'design-system/registry');

function listPrimitives() {
  if (!existsSync(uiDir)) return [];
  return readdirSync(uiDir)
    .filter((f) => /^[A-Z][\w]*\.tsx$/.test(f))
    .sort()
    .map((f) => ({ name: f.replace(/\.tsx$/, ''), file: `src/components/ui/${f}` }));
}

function readMigrationMap() {
  const path = join(root, 'design-system/migration-map.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed.map ?? {};
}

/**
 * Stylesheets imported directly by components (Vite loads them per chunk,
 * after the global theme.css tree). Returns { files: sorted absolute paths,
 * importers: cssBasename → [component paths] }.
 */
function scanComponentImports() {
  const importers = new Map();
  const srcDir = join(root, 'packages/frontend/src');
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && basename(path) !== 'index.tsx') scanFile(path);
    }
  };
  const scanFile = (path) => {
    for (const m of readFileSync(path, 'utf8').matchAll(/import\s+['"](\.[^'"]+\.css)['"]/g)) {
      const cssPath = join(dirname(path), m[1]);
      if (!cssPath.startsWith(stylesDir)) continue;
      const key = basename(cssPath);
      (importers.get(key) ?? importers.set(key, []).get(key)).push(
        relative(srcDir, path).replaceAll('\\', '/'),
      );
    }
  };
  walk(srcDir);
  const files = [...importers.keys()].sort().map((f) => join(stylesDir, f));
  return { files, importers };
}

function generate() {
  const { files: componentFiles, importers } = scanComponentImports();
  const { order, rules, missing, entryTreeSize } = loadCascade(
    join(stylesDir, 'theme.css'),
    componentFiles,
  );
  const imported = new Set(order.map((p) => basename(p)));
  const orphans = readdirSync(stylesDir)
    .filter((f) => f.endsWith('.css') && !imported.has(f))
    .sort();
  const componentSheets = Object.fromEntries(
    order
      .slice(entryTreeSize)
      .map((p) => [basename(p), (importers.get(basename(p)) ?? ['(via @import)']).sort()]),
  );
  const tokens = resolveTokens(rules);
  const registry = buildRegistry({
    tokens,
    blocks: groupBlocks(rules),
    ...resolveConflicts(rules),
    orphans,
    componentSheets,
    outOfSource: tokens.outOfSource,
    primitives: listPrimitives(),
    migrationMap: readMigrationMap(),
  });
  if (missing.length) registry.missingImports = missing;
  return {
    'components.json': JSON.stringify(registry, null, 2) + '\n',
    'llms.txt': buildLlmsTxt(registry),
    stats: registry.stats,
  };
}

const { stats, ...files } = generate();

if (process.argv.includes('--check')) {
  const stale = Object.entries(files).filter(([name, content]) => {
    try {
      return readFileSync(join(registryDir, name), 'utf8') !== content;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`✗ design-system registry is stale (${stale.map(([n]) => n).join(', ')}).`);
    console.error('  Run: npm run design:registry — and commit the result.');
    process.exit(1);
  }
  console.log('✓ design-system registry is up to date');
} else {
  mkdirSync(registryDir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(registryDir, name), content);
  console.log(
    `✓ registry written: ${stats.tokens} tokens, ${stats.blocks} blocks / ${stats.classes} classes, ` +
      `${stats.canonicalRules} canonical rules, ${stats.ghostRules} ghosts`,
  );
}
