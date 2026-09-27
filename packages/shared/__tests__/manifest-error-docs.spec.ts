import { MANIFEST_ERRORS_DOCS_BASE, manifestErrorDocsUrl } from '../src/manifest-error-docs';

describe('manifest error docs', () => {
  it('points at the public error documentation', () => {
    expect(MANIFEST_ERRORS_DOCS_BASE).toBe('https://manifest.build/llm-gateway/docs/errors');
  });

  it('deep links a code to its own page', () => {
    expect(manifestErrorDocsUrl('M100')).toBe('https://manifest.build/llm-gateway/docs/errors/M100/');
    expect(manifestErrorDocsUrl('M300')).toBe('https://manifest.build/llm-gateway/docs/errors/M300/');
  });
});
