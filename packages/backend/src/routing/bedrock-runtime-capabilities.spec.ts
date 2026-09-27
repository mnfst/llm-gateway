import {
  BEDROCK_RUNTIME_CAPABILITY_CATALOG,
  bedrockRuntimeOpenAiEndpoints,
  bedrockRuntimeSupportsApi,
  getBedrockRuntimeCapabilities,
  isBedrockRuntimeModelCatalogued,
  isBedrockRuntimeOpenAiCompatible,
} from './bedrock-runtime-capabilities';

describe('Bedrock Runtime capability catalog', () => {
  it('has unique exact model IDs and review metadata', () => {
    const ids = BEDROCK_RUNTIME_CAPABILITY_CATALOG.map((entry) => entry.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of BEDROCK_RUNTIME_CAPABILITY_CATALOG) {
      expect(entry.modelId).toBe(entry.modelId.toLowerCase());
      expect(entry.modelId).not.toMatch(/^(?:global|us|eu|apac)\./);
      expect(entry.apis.length).toBeGreaterThan(0);
      expect(entry.sourceUrl).toMatch(/^https:\/\/docs\.aws\.amazon\.com\//);
      expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('resolves the same capabilities from base and geographic profile IDs', () => {
    expect(getBedrockRuntimeCapabilities('openai.gpt-6-sol')?.modelId).toBe('openai.gpt-6-sol');
    expect(getBedrockRuntimeCapabilities('global.openai.gpt-6-sol')?.modelId).toBe(
      'openai.gpt-6-sol',
    );
    expect(getBedrockRuntimeCapabilities('bedrock/eu.openai.gpt-6-sol')?.modelId).toBe(
      'openai.gpt-6-sol',
    );
  });

  it('publishes Chat and Responses for Kimi K3 and GPT-6', () => {
    for (const model of [
      'global.moonshotai.kimi-k3',
      'us.openai.gpt-6-astra',
      'global.openai.gpt-6-sol',
      'us.openai.gpt-6-luna',
    ]) {
      expect(bedrockRuntimeOpenAiEndpoints(model)).toEqual([
        '/v1/chat/completions',
        '/v1/responses',
      ]);
      expect(bedrockRuntimeSupportsApi(model, 'chat_completions')).toBe(true);
      expect(bedrockRuntimeSupportsApi(model, 'responses')).toBe(true);
    }
  });

  it('publishes only Chat for a verified Chat-only model', () => {
    const model = 'us.moonshotai.kimi-k2.5';
    expect(bedrockRuntimeOpenAiEndpoints(model)).toEqual(['/v1/chat/completions']);
    expect(bedrockRuntimeSupportsApi(model, 'responses')).toBe(false);
    expect(isBedrockRuntimeOpenAiCompatible(model)).toBe(true);
  });

  it('hides Converse-only and unknown profiles from the OpenAI catalog', () => {
    expect(bedrockRuntimeOpenAiEndpoints('us.moonshotai.kimi-k2-thinking')).toEqual([]);
    expect(isBedrockRuntimeOpenAiCompatible('us.moonshotai.kimi-k2-thinking')).toBe(false);
    expect(getBedrockRuntimeCapabilities('global.vendor.future-model:1')).toBeNull();
    expect(isBedrockRuntimeOpenAiCompatible('global.vendor.future-model:1')).toBe(false);
  });

  it('matches model IDs exactly (a mis-cased ID must not inherit capabilities)', () => {
    // The catalog is a safety contract: only the exact verified ID resolves.
    expect(getBedrockRuntimeCapabilities('openai.gpt-6-sol')).not.toBeNull();
    expect(getBedrockRuntimeCapabilities('OpenAI.GPT-6-Sol')).toBeNull();
    expect(getBedrockRuntimeCapabilities('global.OPENAI.GPT-6-SOL')).toBeNull();
    expect(bedrockRuntimeSupportsApi('OpenAI.GPT-6-Sol', 'chat_completions')).toBe(false);
  });

  it('reports catalog membership via isBedrockRuntimeModelCatalogued', () => {
    expect(isBedrockRuntimeModelCatalogued('global.openai.gpt-6-sol')).toBe(true);
    expect(isBedrockRuntimeModelCatalogued('openai.gpt-6-sol')).toBe(true);
    expect(isBedrockRuntimeModelCatalogued('global.vendor.future-model:1')).toBe(false);
    expect(isBedrockRuntimeModelCatalogued('OpenAI.GPT-6-Sol')).toBe(false);
  });
});
