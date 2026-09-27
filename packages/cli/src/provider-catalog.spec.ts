import { CATEGORY_CATALOG, PROVIDER_CATALOG, SETUP_TEMPLATES } from './provider-catalog.gen';

const {
  deriveCatalog,
  deriveCategories,
  deriveSetupTemplates,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('../scripts/generate-provider-catalog.cjs') as {
  deriveCatalog: (shared: unknown) => unknown;
  deriveCategories: (shared: unknown) => unknown;
  deriveSetupTemplates: (shared: unknown) => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require('manifest-shared');

describe('provider catalog', () => {
  it('committed generated file matches manifest-shared (drift guard)', () => {
    // Same derivation the generator runs at build time — if this fails,
    // run `npm run gen --workspace=packages/cli` and commit the result.
    expect(JSON.parse(JSON.stringify(PROVIDER_CATALOG))).toEqual(deriveCatalog(shared));
  });

  it('committed setup templates match manifest-shared (drift guard)', () => {
    expect(JSON.parse(JSON.stringify(SETUP_TEMPLATES))).toEqual(deriveSetupTemplates(shared));
  });

  it('committed category catalog matches manifest-shared (drift guard)', () => {
    expect([...CATEGORY_CATALOG]).toEqual(deriveCategories(shared));
  });

  it('every entry has an id and at least one auth type', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.authTypes.length).toBeGreaterThan(0);
    }
  });

  it('well-known providers are present with expected auth types', () => {
    const byId = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]));
    expect(byId.get('openai')?.authTypes).toEqual(['api_key', 'subscription']);
    expect(byId.get('ollama')?.authTypes).toContain('local');
    expect(byId.get('gemini')?.aliases).toContain('google');
  });
});
