#!/usr/bin/env node
'use strict';
/**
 * Generates src/provider-catalog.gen.ts from manifest-shared so the CLI can
 * answer "what can I connect?" offline while staying zero-runtime-dependency.
 * Runs as part of `npm run build`; the output is committed. The drift spec
 * (provider-catalog.spec.ts) fails whenever the committed file is stale.
 */
const fs = require('fs');
const path = require('path');

/** Derive the CLI-facing agent-category list (source: AGENT_CATEGORIES). */
function deriveCategories(shared) {
  return [...shared.AGENT_CATEGORIES];
}

/** Derive the CLI-facing platform catalog (id + native proxy surface). */
function derivePlatforms(shared) {
  return shared.AGENT_PLATFORMS.map((id) => ({
    id,
    surface: shared.PLATFORM_API_SURFACES[id],
  }));
}

/**
 * Render each platform's setup snippet with placeholder tokens — functions
 * become data. {{ORIGIN}} is the bare host (no /v1); snippets that need the
 * proxy base receive {{ORIGIN}}/v1 and ones that strip /v1 end up with the
 * bare origin, matching what each platform's SDK expects.
 */
function deriveSetupTemplates(shared) {
  const out = {};
  for (const [platform, render] of Object.entries(shared.PLATFORM_SETUP_SNIPPETS)) {
    out[platform] = render('{{ORIGIN}}/v1', '{{API_KEY}}');
  }
  return out;
}

/** Derive the CLI-facing catalog from the shared registry. */
function deriveCatalog(shared) {
  return shared.SHARED_PROVIDERS.map((p) => {
    const subscription = shared.SUPPORTED_SUBSCRIPTION_PROVIDER_IDS.includes(p.id);
    const authTypes = [
      ...(p.localOnly ? ['local'] : []),
      ...(p.requiresApiKey ? ['api_key'] : []),
      ...(subscription ? ['subscription'] : []),
    ];
    return {
      id: p.id,
      displayName: p.displayName,
      ...(p.aliases && p.aliases.length ? { aliases: p.aliases } : {}),
      authTypes,
    };
  });
}

async function main() {
  let shared;
  try {
    shared = require('manifest-shared');
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    // A clean checkout has no built workspace dependency; fail with the fix
    // instead of a bare MODULE_NOT_FOUND. Genuine load errors rethrow above.
    console.error(
      'manifest-shared is not built. Build it first:\n  npm run build --workspace=packages/shared',
    );
    process.exitCode = 1;
    return;
  }
  const catalog = deriveCatalog(shared);
  const platforms = derivePlatforms(shared);
  const categories = deriveCategories(shared);
  const setupTemplates = deriveSetupTemplates(shared);
  const surfaceUnion = shared.API_SURFACES.map((s) => `'${s}'`).join(' | ');
  const out = `// GENERATED FILE — do not edit by hand.
// Source: manifest-shared (SHARED_PROVIDERS + SUPPORTED_SUBSCRIPTION_PROVIDER_IDS).
// Refresh with: npm run gen (runs automatically in npm run build).

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  aliases?: readonly string[];
  authTypes: readonly string[];
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = ${JSON.stringify(catalog, null, 2)};

export interface PlatformCatalogEntry {
  id: string;
  surface: ${surfaceUnion};
}

export const PLATFORM_CATALOG: readonly PlatformCatalogEntry[] = ${JSON.stringify(platforms, null, 2)};

/** Valid --category values (source: manifest-shared AGENT_CATEGORIES). */
export const CATEGORY_CATALOG: readonly string[] = ${JSON.stringify(categories, null, 2)};

/** Setup snippets with {{ORIGIN}} / {{API_KEY}} placeholders, rendered from manifest-shared. */
export const SETUP_TEMPLATES: Readonly<Record<string, string>> = ${JSON.stringify(setupTemplates, null, 2)};
`;
  const dest = path.join(__dirname, '..', 'src', 'provider-catalog.gen.ts');
  // Format with the repo's prettier config before writing: the pre-commit hook
  // prettifies src/**/*.ts, so an unformatted write would differ from the
  // committed file and make CI's `git diff --exit-code` drift check fail on a
  // catalog that is actually up to date.
  const prettier = require('prettier');
  const config = await prettier.resolveConfig(dest);
  fs.writeFileSync(dest, await prettier.format(out, { ...config, filepath: dest }));
  console.log(`wrote ${dest}: ${catalog.length} providers`);
}

module.exports = { deriveCatalog, derivePlatforms, deriveCategories, deriveSetupTemplates };
if (require.main === module) main();
