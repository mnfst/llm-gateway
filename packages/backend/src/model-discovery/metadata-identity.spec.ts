import { metadataIdentities, resolveMetadataEntry } from './metadata-identity';

describe('metadataIdentities', () => {
  it('returns a single identity for a plain provider-native id', () => {
    expect(metadataIdentities('openai', 'gpt-4o')).toEqual([
      { provider: 'openai', model: 'gpt-4o' },
    ]);
  });

  it('puts the underlying vendor first and the gateway second for a gateway id', () => {
    expect(metadataIdentities('opencode-go', 'opencode-go/deepseek-v4.1-flash')).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    ]);
  });

  it('collapses to one identity when the bare id matches no other vendor', () => {
    // `hy3` matches no vendor prefix, so the gateway is already the only
    // catalog that could answer — there is nothing to fall back to.
    expect(metadataIdentities('opencode-go', 'opencode-go/hy3')).toEqual([
      { provider: undefined, model: 'hy3' },
    ]);
  });
});

describe('resolveMetadataEntry', () => {
  it('prefers the underlying vendor catalog when it has the model', () => {
    const lookup = jest.fn((providerId: string, modelId: string) =>
      providerId === 'deepseek' && modelId === 'deepseek-v4-pro'
        ? { name: 'DeepSeek V4 Pro' }
        : null,
    );

    const resolved = resolveMetadataEntry('opencode-go', 'opencode-go/deepseek-v4-pro', lookup);

    expect(resolved.entry).toEqual({ name: 'DeepSeek V4 Pro' });
    expect(resolved.metadata).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });

  it("falls back to the gateway's own catalog when the vendor has no entry", () => {
    const lookup = (providerId: string, modelId: string) =>
      providerId === 'opencode-go' && modelId === 'deepseek-v4.1-flash'
        ? { name: 'DeepSeek V4.1 Flash' }
        : null;

    const resolved = resolveMetadataEntry('opencode-go', 'opencode-go/deepseek-v4.1-flash', lookup);

    expect(resolved.entry).toEqual({ name: 'DeepSeek V4.1 Flash' });
    expect(resolved.metadata).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  });

  it('substitutes the connection provider when no vendor can be inferred', () => {
    const lookup = jest.fn(() => null);

    const resolved = resolveMetadataEntry('opencode-go', 'opencode-go/hy3', lookup);

    expect(lookup).toHaveBeenCalledWith('opencode-go', 'hy3');
    expect(resolved.entry).toBeNull();
    expect(resolved.metadata).toEqual({ provider: undefined, model: 'hy3' });
  });

  it('treats a falsy entry as a hit, not a miss', () => {
    const resolved = resolveMetadataEntry('opencode-go', 'opencode-go/deepseek-v4.1-flash', (p) =>
      p === 'deepseek' ? 0 : 1,
    );

    expect(resolved.entry).toBe(0);
    expect(resolved.metadata).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' });
  });

  it('returns the primary identity with a null entry when nothing matches', () => {
    const resolved = resolveMetadataEntry('openai', 'gpt-nonexistent', () => undefined);

    expect(resolved).toEqual({
      metadata: { provider: 'openai', model: 'gpt-nonexistent' },
      entry: null,
    });
  });
});
