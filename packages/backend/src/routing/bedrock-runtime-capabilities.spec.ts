import {
  BEDROCK_RUNTIME_CAPABILITY_CATALOG,
  getBedrockRuntimeCapabilities,
  getBedrockRuntimeSupportedEndpoints,
} from './bedrock-runtime-capabilities';

describe('Bedrock Runtime capability catalog', () => {
  it('lists each base model once, with its AWS model card and verification date', () => {
    const ids = BEDROCK_RUNTIME_CAPABILITY_CATALOG.map((entry) => entry.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of BEDROCK_RUNTIME_CAPABILITY_CATALOG) {
      expect(entry.modelId).not.toMatch(/^(?:global|us|eu|apac)\./);
      expect(entry.sourceUrl).toMatch(
        /^https:\/\/docs\.aws\.amazon\.com\/bedrock\/latest\/userguide\/model-card-[a-z0-9-]+\.html$/,
      );
      expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('only accepts models that serve both Chat Completions and Responses', () => {
    // Manifest keeps the agent's API on Runtime and does not convert between the
    // two there, so a Chat-only or Responses-only model cannot be added as is.
    for (const entry of BEDROCK_RUNTIME_CAPABILITY_CATALOG) {
      expect([...entry.apis].sort()).toEqual(['chat_completions', 'responses']);
    }
  });

  it('resolves CRIS profiles of catalogued models', () => {
    expect(getBedrockRuntimeCapabilities('us.openai.gpt-6-sol')?.modelId).toBe('openai.gpt-6-sol');
    expect(getBedrockRuntimeCapabilities('bedrock/global.moonshotai.kimi-k3')).toMatchObject({
      modelId: 'moonshotai.kimi-k3',
      chatTokenParameter: 'max_tokens',
    });
    expect(getBedrockRuntimeCapabilities('eu.openai.gpt-5.6-luna')?.chatTokenParameter).toBe(
      'max_completion_tokens',
    );
  });

  it('matches nothing but exact CRIS profiles of catalogued models', () => {
    // Base model IDs are served by Mantle.
    expect(getBedrockRuntimeCapabilities('openai.gpt-6-sol')).toBeNull();
    expect(getBedrockRuntimeCapabilities('us.anthropic.claude-sonnet-5')).toBeNull();
    expect(getBedrockRuntimeCapabilities('us.OpenAI.GPT-6-Sol')).toBeNull();
    expect(getBedrockRuntimeCapabilities('ca.openai.gpt-6-sol')).toBeNull();
  });

  it('publishes the Manifest endpoints that serve a catalogued profile', () => {
    expect(getBedrockRuntimeSupportedEndpoints('global.openai.gpt-6-luna')).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
    ]);
    expect(getBedrockRuntimeSupportedEndpoints('us.anthropic.claude-sonnet-5')).toEqual([]);
  });
});
