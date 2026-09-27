// Dependency-free CSS parser for the registry generator.
//
// Walks a stylesheet with a brace-depth scanner and yields flat rules:
//   { selector, declarations: [{ prop, value, line }], media, layer, file, line }
// @media/@supports blocks recurse with their conditional context tracked;
// @layer blocks keep a separate cascade-layer context;
// @keyframes and @font-face bodies are opaque (their inner "selectors" are
// not classes); @import lines are collected for the cascade walk.

/** Replace comments with spaces, preserving newlines so line numbers hold. */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    if (quote) {
      out += char;
      if (char === quote && !isEscaped(source, i)) quote = null;
      i++;
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
      i++;
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) out += source[i] === '\n' ? '\n' : ' ';
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Parse `prop: value; …` inside a rule body. */
function parseDeclarations(body, baseText, baseIndex) {
  const declarations = [];
  for (const part of splitTop(body, ';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (!prop || !value) continue;
    const line = lineAt(baseText, baseIndex + part.offset);
    declarations.push({ prop, value, line });
  }
  return declarations;
}

/** Split on a separator, ignoring separators nested in (), [] or strings. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(withOffset(text.slice(start, i), start));
      start = i + 1;
    }
  }
  parts.push(withOffset(text.slice(start), start));
  return parts;
}

function withOffset(str, offset) {
  const s = new String(str.trim());
  s.offset = offset + (str.length - str.trimStart().length);
  return s;
}

/** Find the index of the matching close brace for the open brace at `open`. */
function matchBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote && !isEscaped(text, i)) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return text.length;
}

const OPAQUE_AT = /^@(keyframes|-webkit-keyframes|font-face|property|counter-style|page)\b/;
const NESTING_AT = /^@(media|supports|layer|container)\b/;

/**
 * Parse one stylesheet.
 * Returns rules plus import metadata and layers in first-declaration order.
 */
export function parseCss(source, file, options = {}) {
  const text = stripComments(source);
  const rules = [];
  const imports = [];
  const layers = [];
  const layerEvents = [];
  const ctx = {
    text,
    file,
    rules,
    imports,
    layers,
    layerEvents,
    anonymousLayers: 0,
    anonymousScope: options.anonymousScope ?? 0,
  };
  walk(text, 0, text.length, { media: '', layer: options.layerPrefix ?? '' }, ctx);
  return { rules, imports, layers, layerEvents };
}

function walk(text, from, to, context, ctx) {
  let i = from;
  while (i < to) {
    const brace = text.indexOf('{', i);
    const semi = text.indexOf(';', i);
    if (semi !== -1 && (brace === -1 || semi < brace) && semi < to) {
      const statement = text.slice(i, semi).trim();
      const m = statement.match(
        /^@import\s+(?:url\(\s*)?(?:['"]([^'"]+)['"]|([^)\s;]+))\s*\)?(.*)$/,
      );
      const specifier = m?.[1] ?? m?.[2];
      if (specifier) {
        const layerMatch = m?.[3]?.match(/(?:^|\s)layer(?:\(\s*([^)]+?)\s*\))?(?:\s|$)/i);
        ctx.imports.push({
          specifier,
          layer: layerMatch ? (layerMatch[1]?.trim() ?? true) : null,
          offset: i,
        });
      }
      const layerStatement = statement.match(/^@layer\s+(.+)$/);
      if (layerStatement) {
        for (const name of layerStatement[1].split(',').map((value) => value.trim())) {
          if (name) registerLayer(ctx, qualifyLayer(context.layer, name), i);
        }
      }
      i = semi + 1;
      continue;
    }
    if (brace === -1 || brace >= to) return;
    const raw = text.slice(i, brace);
    const preludeStart = i + (raw.length - raw.trimStart().length);
    const close = matchBrace(text, brace);
    handleBlock(raw.trim(), brace, close, context, ctx, preludeStart);
    i = close + 1;
  }
}

function handleBlock(prelude, brace, close, context, ctx, preludeStart) {
  const { text, file } = ctx;
  if (OPAQUE_AT.test(prelude)) return;
  if (prelude.startsWith('@layer')) {
    const rawName = prelude.replace(/^@layer\s*/, '').trim();
    const name = rawName || `__anonymous_${ctx.anonymousScope}_${++ctx.anonymousLayers}`;
    const layer = qualifyLayer(context.layer, name);
    registerLayer(ctx, layer, preludeStart);
    walk(text, brace + 1, close, { ...context, layer }, ctx);
    return;
  }
  if (NESTING_AT.test(prelude)) {
    const condition = prelude.startsWith('@media') ? prelude.replace(/^@media\s*/, '') : prelude;
    const media = [context.media, condition].filter(Boolean).join(' && ');
    walk(text, brace + 1, close, { ...context, media }, ctx);
    return;
  }
  if (prelude.startsWith('@')) return;
  const body = text.slice(brace + 1, close);
  const declarations = parseDeclarations(body, text, brace + 1);
  if (declarations.length === 0) return;
  for (const sel of splitTop(prelude, ',')) {
    const selector = String(sel).replace(/\s+/g, ' ');
    if (!selector) continue;
    ctx.rules.push({
      selector,
      declarations,
      media: context.media,
      layer: context.layer,
      file,
      line: lineAt(text, preludeStart),
    });
  }
}

function qualifyLayer(parent, name) {
  return parent ? `${parent}.${name}` : name;
}

function registerLayer(ctx, layer, offset) {
  if (layer && !ctx.layers.includes(layer)) {
    ctx.layers.push(layer);
    ctx.layerEvents.push({ layer, offset });
  }
}
