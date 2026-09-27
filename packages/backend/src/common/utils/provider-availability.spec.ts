import {
  filterProvidersForDeployment,
  isLocalOnlyProvider,
  isProviderAvailableForDeployment,
} from './provider-availability';

describe('provider availability', () => {
  const previousMode = process.env['MANIFEST_MODE'];

  afterEach(() => {
    if (previousMode === undefined) delete process.env['MANIFEST_MODE'];
    else process.env['MANIFEST_MODE'] = previousMode;
  });

  it('recognizes canonical local providers and their aliases', () => {
    expect(isLocalOnlyProvider('ollama')).toBe(true);
    expect(isLocalOnlyProvider(' LM Studio ')).toBe(true);
    expect(isLocalOnlyProvider('lm.studio')).toBe(true);
    expect(isLocalOnlyProvider('llama.cpp')).toBe(true);
    expect(isLocalOnlyProvider('llama_cpp')).toBe(true);
    expect(isLocalOnlyProvider('openai')).toBe(false);
    expect(isLocalOnlyProvider('custom:runtime-id')).toBe(false);
  });

  it('allows built-in local providers only in self-hosted mode', () => {
    process.env['MANIFEST_MODE'] = 'cloud';
    expect(isProviderAvailableForDeployment('ollama')).toBe(false);
    expect(isProviderAvailableForDeployment('custom:runtime-id')).toBe(true);

    process.env['MANIFEST_MODE'] = 'selfhosted';
    expect(isProviderAvailableForDeployment('ollama')).toBe(true);
  });

  it('filters local provider rows in cloud without cloning unchanged arrays', () => {
    process.env['MANIFEST_MODE'] = 'cloud';
    const providers = [{ provider: 'openai' }, { provider: 'ollama' }];
    expect(filterProvidersForDeployment(providers)).toEqual([{ provider: 'openai' }]);

    const unchanged = [{ provider: 'custom:runtime-id' }];
    expect(filterProvidersForDeployment(unchanged)).toBe(unchanged);
  });

  it('keeps all provider rows in self-hosted mode', () => {
    process.env['MANIFEST_MODE'] = 'selfhosted';
    const providers = [{ provider: 'openai' }, { provider: 'ollama' }];
    expect(filterProvidersForDeployment(providers)).toBe(providers);
  });
});
