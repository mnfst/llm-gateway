import { ModelsDevReasoningCatalog } from '../reasoning-model-catalog';
import type { ModelsDevModelEntry } from '../../../database/models-dev-sync.service';

function entry(reasoning: boolean): ModelsDevModelEntry {
  return {
    id: 'stub',
    name: 'stub',
    reasoning,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilities: [],
    inputModalities: [],
    outputModalities: [],
  };
}

class FakeSync {
  readonly providerLookups: Array<[string, string]> = [];
  readonly crossProviderLookups: string[] = [];

  constructor(
    private readonly byProvider: Record<string, ModelsDevModelEntry> = {},
    private readonly byModel: Record<string, ModelsDevModelEntry> = {},
    /** models.dev keys these endpoints; anything else has no catalog of its own. */
    private readonly supportedProviders: string[] = ['opencode-zen', 'opencode-go'],
  ) {}

  isProviderSupported(providerId: string): boolean {
    return this.supportedProviders.includes(providerId);
  }

  lookupModel(providerId: string, modelId: string): ModelsDevModelEntry | null {
    this.providerLookups.push([providerId, modelId]);
    return this.byProvider[`${providerId}:${modelId}`] ?? null;
  }

  lookupModelAcrossProviders(modelId: string): ModelsDevModelEntry | null {
    this.crossProviderLookups.push(modelId);
    return this.byModel[modelId] ?? null;
  }
}

function catalogWith(sync: FakeSync): ModelsDevReasoningCatalog {
  return new ModelsDevReasoningCatalog(sync as never);
}

describe('ModelsDevReasoningCatalog', () => {
  it('resolves a gateway slug after stripping the gateway prefix', () => {
    const sync = new FakeSync({ 'opencode-zen:big-pickle': entry(true) });

    expect(catalogWith(sync).isReasoningModel('opencode-zen', 'opencode-zen/big-pickle')).toBe(
      true,
    );
  });

  it('reports a catalogued non-reasoning model as false', () => {
    const sync = new FakeSync({ 'opencode-zen:kimi-k2': entry(false) });

    expect(catalogWith(sync).isReasoningModel('opencode-zen', 'opencode-zen/kimi-k2')).toBe(false);
  });

  it('returns undefined when the catalog has never seen the model', () => {
    const sync = new FakeSync();

    expect(catalogWith(sync).isReasoningModel('opencode-zen', 'opencode-zen/unknown-slug')).toBe(
      undefined,
    );
  });

  it('keeps the vendor prefix for OpenRouter before falling back to the bare id', () => {
    const sync = new FakeSync({ 'openrouter:deepseek/deepseek-r1': entry(true) });

    expect(catalogWith(sync).isReasoningModel('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    expect(sync.providerLookups[0]).toEqual(['openrouter', 'deepseek/deepseek-r1']);
  });

  it('falls back to the bare id when the vendor-prefixed id is not catalogued', () => {
    const sync = new FakeSync({ 'opencode-go:glm-5': entry(true) });

    expect(catalogWith(sync).isReasoningModel('opencode-go', 'opencode-go/glm-5')).toBe(true);
  });

  it('looks a custom provider model up across providers', () => {
    const sync = new FakeSync({}, { 'kimi-k3': entry(true) });

    expect(catalogWith(sync).isReasoningModel('custom:5000149d', 'moonshotai/kimi-k3')).toBe(true);
    expect(sync.crossProviderLookups).toContain('kimi-k3');
  });

  it('falls back to the cross-provider lookup for aggregators the catalog does not key', () => {
    // models.dev has no `openrouter` provider, so the endpoint-scoped lookup
    // always misses; the vendor prefix is what resolves it.
    const sync = new FakeSync({}, { 'deepseek/deepseek-r1': entry(true) });

    expect(catalogWith(sync).isReasoningModel('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    expect(sync.crossProviderLookups).toContain('deepseek/deepseek-r1');
  });

  it('reports an aggregator model the catalog marks non-reasoning as false', () => {
    const sync = new FakeSync({}, { 'moonshotai/kimi-k2': entry(false) });

    expect(catalogWith(sync).isReasoningModel('openrouter', 'moonshotai/kimi-k2')).toBe(false);
  });

  it('stays silent for a gateway models.dev keys, rather than guessing across providers', () => {
    // A same-named model under an unrelated provider must not answer for Zen:
    // a definitive false here would strip the field that the family fallback
    // would have preserved.
    const sync = new FakeSync({}, { 'glm-5': entry(false) });

    expect(catalogWith(sync).isReasoningModel('opencode-zen', 'opencode-zen/glm-5')).toBe(
      undefined,
    );
    expect(sync.crossProviderLookups).toEqual([]);
  });

  it('returns undefined when no sync service is wired', () => {
    expect(new ModelsDevReasoningCatalog().isReasoningModel('opencode-zen', 'anything')).toBe(
      undefined,
    );
  });
});
