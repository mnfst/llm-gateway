#!/usr/bin/env node
// Diff-only design-token check for packages/frontend.
//
// Scans the ADDED lines of the current diff for styling values that bypass
// the design tokens (packages/frontend/src/styles/tokens.css): raw hex
// colors, hsl()/rgb() literals not going through var(--token), font-family
// literals, font-size in px, z-index literals above local stacking, and
// pill radii written as 99/999/9999px. Token definitions themselves
// (--foo: lines) are exempt, so adding a new token never trips the check.
//
// Usage:  node scripts/check-design-tokens.mjs [base-ref]
//   base-ref defaults to the merge-base with origin/main; the diff includes
//   uncommitted changes, so it works mid-implementation as well as on a PR.
//
// Review tool, not a CI gate: exit 1 on findings so verifier agents can
// treat findings as a failed step; a human judges intentional exceptions
// (justify them in the PR description).

import { execSync } from 'node:child_process';

const run = (cmd) =>
  execSync(cmd, { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let base = process.argv[2];
if (!base) {
  try {
    base = run('git merge-base HEAD origin/main').trim();
  } catch {
    base = 'origin/main';
  }
}

// Only frontend source is checked.
const INCLUDED = /^packages\/frontend\/src\//;

const EXCLUDED_PATHS = [
  /^packages\/frontend\/src\/styles\/tokens\.css$/, // the tokens live here
  /ProviderIcon\.tsx$/, // provider BRAND colors (data, not design) — sole color allowlist
  /provider-icons\//, // future brand-icon library (same rationale)
  /\.svg$/,
  /\.md$/,
];

const CHECKED_EXT = /\.(css|tsx|ts)$/;

// A line that DEFINES a custom property is the one legitimate home for raw values.
const TOKEN_DEF = /^\s*--[\w-]+\s*:/;
// Raw hex colors: #fff, #ffffff, #ffffff80.
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
// hsl(38 92% 50%) / hsla(...) literals — the #1 bypass in this codebase.
// hsl(var(--x)) and hsl(var(--x) / 0.5) stay legal.
const HSL_LITERAL = /hsla?\(\s*[\d.]/;
// rgb()/rgba() literals.
const RGB_LITERAL = /rgba?\(\s*[\d.]/;
// font-family literals are only allowed when they reference a token.
const FONT_FAMILY = /font-family\s*:/;
const FONT_OK = /font-family\s*:\s*(var\(--|inherit)/;
// The font-size scale lives in tokens.css (--font-size-3xs … 4xl).
const FONT_SIZE_PX = /font-size\s*:\s*[\d.]+px/;
// z-index 0-2 is local in-component stacking; anything above takes a --z-* layer.
const Z_INDEX = /z-index\s*:\s*(\d+)|zIndex\s*[:=]\s*['"]?(\d+)/;
// Pill radii hand-written as 99px / 999px / 9999px.
const PILL_RADIUS = /border-radius\s*:[^;}\n]*\b9{2,4}px\b/;

function maskInlineComments(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      out += char;
      if (char === quote && line[i - 1] !== '\\') quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && line[i + 1] === '/') {
      break;
    } else if (char === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) break;
      out += ' '.repeat(end + 2 - i);
      i = end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

function isInsideString(line, index) {
  let quote = null;
  for (let i = 0; i < index; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== '\\') quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    }
  }
  return quote !== null;
}

function matchCode(regex, line) {
  const match = line.match(regex);
  return match && !isInsideString(line, match.index ?? 0) ? match : null;
}

let diff;
try {
  diff = run(`git diff --unified=0 ${base} -- packages/frontend/src`);
} catch (e) {
  console.error(`Could not diff against ${base}: ${e.message}`);
  process.exit(2);
}

const findings = [];
let file = null;
let skip = true;
let lineNo = 0;

for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ b/')) {
    file = raw.slice(6);
    skip =
      !INCLUDED.test(file) || !CHECKED_EXT.test(file) || EXCLUDED_PATHS.some((re) => re.test(file));
    continue;
  }
  if (raw.startsWith('@@')) {
    const m = raw.match(/\+(\d+)/);
    lineNo = m ? Number(m[1]) - 1 : 0;
    continue;
  }
  if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
  lineNo += 1;
  if (skip) continue;

  const line = raw.slice(1);
  const code = maskInlineComments(line);
  if (TOKEN_DEF.test(code)) continue;

  if (matchCode(RAW_HEX, code)) {
    findings.push({
      file,
      lineNo,
      line: line.trim(),
      rule: 'raw hex color — use hsl(var(--token))',
    });
  } else if (matchCode(HSL_LITERAL, code)) {
    findings.push({
      file,
      lineNo,
      line: line.trim(),
      rule: 'hsl() literal — use hsl(var(--token))',
    });
  } else if (matchCode(RGB_LITERAL, code)) {
    findings.push({
      file,
      lineNo,
      line: line.trim(),
      rule: 'rgb()/rgba() literal — use hsl(var(--token) / alpha)',
    });
  }
  if (matchCode(FONT_FAMILY, code) && !matchCode(FONT_OK, code)) {
    findings.push({
      file,
      lineNo,
      line: line.trim(),
      rule: 'font-family literal — use var(--font-*)',
    });
  }
  if (matchCode(FONT_SIZE_PX, code)) {
    findings.push({
      file,
      lineNo,
      line: line.trim(),
      rule: 'font-size in px — use var(--font-size-*)',
    });
  }
  const z = matchCode(Z_INDEX, code);
  if (z && Number(z[1] ?? z[2]) > 2) {
    findings.push({ file, lineNo, line: line.trim(), rule: 'z-index literal — use var(--z-*)' });
  }
  if (matchCode(PILL_RADIUS, code)) {
    findings.push({
      file,
      lineNo,
      line: line.trim(),
      rule: 'pill radius literal — use var(--radius-pill)',
    });
  }
}

if (findings.length === 0) {
  console.log(`✓ design-token check clean (diff vs ${base.slice(0, 12)})`);
  process.exit(0);
}

// Generated or repeated template lines: group by identical offending content
// so one source bug reads as one finding.
const groups = new Map();
for (const f of findings) {
  const key = `${f.rule}::${f.line}`;
  const g = groups.get(key) ?? { ...f, count: 0, files: new Set() };
  g.count += 1;
  g.files.add(f.file);
  groups.set(key, g);
}
const sorted = [...groups.values()].sort((a, b) => b.count - a.count);

const verbose = process.argv.includes('--all');
console.log(
  `✗ ${findings.length} added line(s) bypass the design tokens — ${sorted.length} distinct violation(s) (diff vs ${base.slice(0, 12)}):\n`,
);
for (const g of sorted) {
  console.log(`  ×${g.count} in ${g.files.size} file(s)  [${g.rule}]  e.g. ${g.file}:${g.lineNo}`);
  console.log(`      ${g.line.slice(0, 140)}`);
}
if (verbose) {
  console.log('\nFull list:');
  for (const f of findings) console.log(`  ${f.file}:${f.lineNo}  ${f.line.slice(0, 120)}`);
}
console.log('\nFix: use the tokens from packages/frontend/src/styles/tokens.css.');
console.log(
  'Intentional exception? Justify it in the PR description. Re-run with --all for every line.',
);
process.exit(1);
