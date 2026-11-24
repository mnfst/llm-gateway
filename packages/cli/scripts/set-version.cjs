#!/usr/bin/env node
/**
 * Stamps one version onto every file in packages/cli that carries it.
 *
 * The CLI's version tracks the Manifest release it ships with, so there is no
 * separate changeset target for it (`mnfst-gateway-cli` stays in the
 * `.changeset/config.json` ignore list). The publish-npm job in release.yml
 * calls this with the version from packages/manifest/package.json before
 * building and packing.
 *
 * Deliberately NOT called from the root `version-packages` script. Bumping
 * packages/cli/package.json there makes changesets/action believe the CLI was
 * released, so it tries to read packages/cli/CHANGELOG.md to build the version
 * PR body. That file does not exist, because the CLI is in the ignore list, and
 * the action dies with ENOENT, taking the whole Release workflow down with it.
 * The committed CLI version therefore drifts from the Manifest version between
 * releases. That is cosmetic: the published version is stamped here, at publish
 * time, from packages/manifest/package.json.
 *
 * Three files carry the version and must move together, or the next test run
 * turns red: index.spec.ts pins src/version.ts to package.json, and
 * skill-content.spec.ts pins the generated SKILL_VERSION to package.json too.
 * (`npm run gen` also rewrites the generated file, but it needs manifest-shared
 * built; this script deliberately does not, so it can run before the build.)
 *
 * Every write is resolved before any of them is performed, so a renamed or
 * reformatted declaration fails with the tree untouched instead of leaving
 * package.json on the new version and the sources on the old one.
 *
 * Usage:
 *   node scripts/set-version.cjs            # read packages/manifest/package.json
 *   node scripts/set-version.cjs 6.24.0     # explicit
 */
const fs = require('fs');
const path = require('path');

const CLI_DIR = path.join(__dirname, '..');
const PKG_PATH = path.join(CLI_DIR, 'package.json');
const VERSION_TS_PATH = path.join(CLI_DIR, 'src', 'version.ts');
const SKILL_GEN_PATH = path.join(CLI_DIR, 'src', 'skill-content.gen.ts');

// Same shape changesets produces: no pre-release or build metadata is expected
// here, and accepting one silently would publish an npm tag nobody asked for.
const SEMVER = /^\d+\.\d+\.\d+$/;

function resolveVersion(argv) {
  const explicit = argv[0];
  if (explicit) return explicit;
  const manifestPkg = JSON.parse(
    fs.readFileSync(path.join(CLI_DIR, '..', 'manifest', 'package.json'), 'utf8'),
  );
  return manifestPkg.version;
}

/** Returns the rewritten package.json without writing it. */
function planPackageJson(version) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  pkg.version = version;
  // Trailing newline keeps the file byte-identical to what Prettier writes.
  return { path: PKG_PATH, contents: JSON.stringify(pkg, null, 2) + '\n' };
}

/** Returns a rewritten `export const <name> = '<version>';` module, or throws. */
function planDeclaration(filePath, name, version, hint) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const pattern = new RegExp('^export const ' + name + " = '[^']*';$", 'm');
  if (!pattern.test(raw)) {
    throw new Error('Could not find the ' + name + ' declaration in ' + filePath + '. ' + hint);
  }
  const replacement = 'export const ' + name + " = '" + version + "';";
  return { path: filePath, contents: raw.replace(pattern, replacement) };
}

function planVersionTs(version) {
  return planDeclaration(
    VERSION_TS_PATH,
    'VERSION',
    version,
    'Update set-version.cjs if the declaration was reformatted.',
  );
}

function planSkillVersion(version) {
  return planDeclaration(
    SKILL_GEN_PATH,
    'SKILL_VERSION',
    version,
    'Update set-version.cjs if generate-skill-content.cjs changed its output.',
  );
}

function main(argv) {
  const version = resolveVersion(argv);
  if (!SEMVER.test(version)) {
    throw new Error('Refusing to stamp a non-semver version: ' + JSON.stringify(version));
  }
  // Resolve every write first; only then touch the disk.
  const writes = [planPackageJson(version), planVersionTs(version), planSkillVersion(version)];
  for (const write of writes) {
    fs.writeFileSync(write.path, write.contents);
  }
  console.log(
    'Stamped mnfst-gateway-cli ' +
      version +
      ' onto package.json, src/version.ts and src/skill-content.gen.ts',
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}

module.exports = { resolveVersion, planPackageJson, planVersionTs, planSkillVersion, main };
