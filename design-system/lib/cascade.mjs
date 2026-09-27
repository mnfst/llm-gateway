// Cascade resolution for the registry generator.
//
// Answers "which declaration actually renders" the way the browser does for
// same-element rules: importance and cascade-layer order, then selector
// specificity and source order (the depth-first @import order from the entry
// stylesheet). Declarations that can never win against an identical selector
// are the ghost rules.

import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { parseCss } from './parse-css.mjs';

/**
 * Depth-first @import walk from the entry file, then the extra stylesheets
 * that components import directly (Vite loads those after the global sheet;
 * they are walked in the given order, each with its own @imports first).
 * CSS places a file's own rules after its imports, so children are appended
 * before the parent. Returns { order, rules, missing, entryTreeSize }.
 */
export function loadCascade(entryPath, extras = []) {
  const order = [];
  const rules = [];
  const missing = [];
  const seen = new Set();
  const ctx = {
    order,
    rules,
    missing,
    seen,
    layers: [],
    anonymousScopes: 0,
    anonymousImports: 0,
  };
  visit(resolve(entryPath), ctx);
  const entryTreeSize = order.length;
  for (const extra of extras) visit(resolve(extra), ctx);
  return {
    order,
    rules: applyLayerRanks(rules, ctx.layers),
    missing,
    entryTreeSize,
  };
}

function visit(path, ctx, layerPrefix = '') {
  const visitKey = `${path} § ${layerPrefix}`;
  if (ctx.seen.has(visitKey)) return;
  ctx.seen.add(visitKey);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    ctx.missing.push(path);
    return;
  }
  const { rules, imports, layerEvents } = parseCss(source, basename(path), {
    layerPrefix,
    anonymousScope: ++ctx.anonymousScopes,
  });
  const events = [
    ...layerEvents.map((event) => ({ ...event, type: 'layer' })),
    ...imports.map((entry) => ({ ...entry, type: 'import' })),
  ].sort((a, b) => a.offset - b.offset);
  for (const event of events) {
    if (event.type === 'layer') {
      registerGlobalLayer(ctx, event.layer);
      continue;
    }
    let importLayer = layerPrefix;
    if (event.layer !== null) {
      const name =
        event.layer === true ? `__anonymous_import_${++ctx.anonymousImports}` : event.layer;
      importLayer = qualifyLayer(layerPrefix, name);
      registerGlobalLayer(ctx, importLayer);
    }
    visit(resolve(dirname(path), event.specifier), ctx, importLayer);
  }
  ctx.order.push(path);
  for (const rule of rules) {
    ctx.rules.push({
      ...rule,
      orderIndex: ctx.rules.length,
    });
  }
}

function qualifyLayer(parent, name) {
  return parent ? `${parent}.${name}` : name;
}

function registerGlobalLayer(ctx, layer) {
  if (layer && !ctx.layers.includes(layer)) ctx.layers.push(layer);
}

export function applyLayerRanks(rules, orderedLayers) {
  const root = { children: new Map() };
  for (const layer of orderedLayers) {
    let node = root;
    for (const name of layer.split('.')) {
      if (!node.children.has(name)) {
        node.children.set(name, { index: node.children.size, children: new Map() });
      }
      node = node.children.get(name);
    }
  }

  return rules.map((rule) => {
    if (!rule.layer) return rule;
    const rank = [];
    let node = root;
    for (const name of rule.layer.split('.')) {
      const child = node.children.get(name);
      if (!child) return rule;
      rank.push(child.index);
      node = child;
    }
    // Direct declarations in a parent layer form an implicit final sublayer.
    rank.push(node.children.size);
    return { ...rule, layerRank: rank };
  });
}

/** Specificity as a single comparable number (ids, classes/attrs/pseudos, types). */
export function specificity(selector) {
  const s = selector.replace(/::[\w-]+/g, ' ').replace(/:not\(([^)]*)\)/g, ' $1 ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g) || []).length;
  const types = (s.match(/(^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + types;
}

/**
 * Group every declaration by (selector, conditional context, property) and resolve the
 * winner. Only genuine conflicts (differing values) are reported: a repeated
 * identical value is noise, not a fork.
 * Returns { canonical: [...], ghosts: [...] }.
 */
export function resolveConflicts(rules) {
  const byKey = new Map();
  for (const rule of rules) {
    for (const d of rule.declarations) {
      if (d.prop.startsWith('--')) continue; // token definitions handled separately
      const key = `${rule.selector} § ${rule.media} § ${d.prop}`;
      const entry = {
        ...d,
        selector: rule.selector,
        media: rule.media,
        layer: rule.layer,
        layerRank: rule.layerRank,
        file: rule.file,
        orderIndex: rule.orderIndex,
      };
      (byKey.get(key) ?? byKey.set(key, []).get(key)).push(entry);
    }
  }
  const canonical = [];
  const ghosts = [];
  for (const [, entries] of byKey) {
    const values = new Set(entries.map((e) => e.value));
    if (entries.length < 2 || values.size < 2) continue;
    entries.sort(compareCascadeEntries);
    const winner = entries[entries.length - 1];
    canonical.push(strip(winner));
    for (const loser of entries.slice(0, -1))
      ghosts.push({ ...strip(loser), losesTo: `${winner.file}:${winner.line}` });
  }
  const bySource = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
  return { canonical: canonical.sort(bySource), ghosts: ghosts.sort(bySource) };
}

const isImportant = (value) => /!important\s*$/i.test(value);

function compareCascadeEntries(a, b) {
  return (
    Number(isImportant(a.value)) - Number(isImportant(b.value)) ||
    compareLayerPrecedence(a, b) ||
    specificity(a.selector) - specificity(b.selector) ||
    a.orderIndex - b.orderIndex
  );
}

function compareLayerPrecedence(a, b) {
  const important = isImportant(a.value);
  if (!a.layer && !b.layer) return 0;
  if (!a.layer) return important ? -1 : 1;
  if (!b.layer) return important ? 1 : -1;
  const comparison = compareRankVectors(a.layerRank ?? [], b.layerRank ?? []);
  return important ? -comparison : comparison;
}

function compareRankVectors(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

const strip = ({ selector, media, layer, prop, value, file, line }) => ({
  selector,
  ...(media ? { media } : {}),
  ...(layer ? { layer } : {}),
  prop,
  value,
  file,
  line,
});

const TOKEN_SCOPES = [':root', '.dark'];

/**
 * Token tables: every custom property declared on :root or .dark, cascade
 * resolved. Declarations on any other selector are component-scoped locals
 * (legal); :root/.dark declarations outside tokens.css are reported as
 * out-of-source definitions — the single-source rule forbids them.
 */
export function resolveTokens(rules) {
  const candidates = { ':root': new Map(), '.dark': new Map() };
  const outOfSource = [];
  for (const rule of rules) {
    const scope = TOKEN_SCOPES.includes(rule.selector) ? rule.selector : null;
    if (!scope) continue;
    for (const d of rule.declarations) {
      if (!d.prop.startsWith('--')) continue;
      const entry = {
        ...d,
        selector: rule.selector,
        layer: rule.layer,
        layerRank: rule.layerRank,
        file: rule.file,
        orderIndex: rule.orderIndex,
      };
      const entries = candidates[scope].get(d.prop) ?? [];
      entries.push(entry);
      candidates[scope].set(d.prop, entries);
      if (rule.file !== 'tokens.css')
        outOfSource.push({ scope, prop: d.prop, file: rule.file, line: d.line });
    }
  }
  const resolveScope = (scope) =>
    new Map(
      [...candidates[scope]].map(([prop, entries]) => {
        entries.sort(compareCascadeEntries);
        const winner = entries[entries.length - 1];
        return [prop, { value: winner.value, file: winner.file, line: winner.line }];
      }),
    );
  return { light: resolveScope(':root'), dark: resolveScope('.dark'), outOfSource };
}

/** Group class selectors into BEM blocks: block__element--modifier. */
export function groupBlocks(rules) {
  const blocks = new Map();
  for (const rule of rules) {
    for (const name of rule.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      const cls = name[1];
      const block = cls.split('__')[0].split('--')[0];
      const entry = blocks.get(block) ?? { classes: new Set(), files: new Set() };
      entry.classes.add(cls);
      entry.files.add(rule.file);
      blocks.set(block, entry);
    }
  }
  return new Map(
    [...blocks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([block, e]) => [block, { classes: [...e.classes].sort(), files: [...e.files].sort() }]),
  );
}
