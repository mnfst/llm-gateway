import {
  BEDROCK_RUNTIME_CAPABILITY_CATALOG,
  getBedrockRuntimeCapabilities,
  getBedrockRuntimeSupportedEndpoints,
  BEDROCK_RUNTIME_CLAUDE_MESSAGES_MODELS,
  isBedrockRuntimeClaudeProfile,
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
    expect(getBedrockRuntimeSupportedEndpoints('us.anthropic.claude-sonnet-4-6')).toEqual([]);
    expect(getBedrockRuntimeSupportedEndpoints('us.openai.unlisted')).toEqual([]);
  });

  it('keeps the OpenAI-API catalog free of Claude models', () => {
    expect(getBedrockRuntimeCapabilities('us.anthropic.claude-sonnet-5-5')).toBeNull();
    expect(
      BEDROCK_RUNTIME_CAPABILITY_CATALOG.some((entry) => entry.modelId.startsWith('anthropic.')),
    ).toBe(false);
  });
});

describe('Bedrock Runtime Claude Messages list', () => {
  const VERIFIED_IDS = [
    'anthropic.claude-sonnet-5',
    'anthropic.claude-sonnet-5-5',
    'anthropic.claude-opus-4-7',
    'anthropic.claude-opus-4-8',
    'anthropic.claude-opus-5',
    'anthropic.claude-opus-5-5',
    'anthropic.claude-haiku-4-5-20251001-v1:0',
  ];
  const UNSUPPORTED_IDS = [
    'anthropic.claude-opus-4-1-20250805-v1:0',
    'anthropic.claude-opus-4-5-20251101-v1:0',
    'anthropic.claude-opus-4-6-v1',
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
    'anthropic.claude-sonnet-4-6',
    'anthropic.claude-fable-5',
    'anthropic.claude-fable-5-1',
    'anthropic.claude-3-haiku-20240307-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
  ];

  it('lists each verified base model once, with a verification date', () => {
    const ids = BEDROCK_RUNTIME_CLAUDE_MESSAGES_MODELS.map((entry) => entry.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...VERIFIED_IDS].sort());
    for (const entry of BEDROCK_RUNTIME_CLAUDE_MESSAGES_MODELS) {
      expect(entry.modelId.startsWith('anthropic.')).toBe(true);
      expect(entry.modelId).not.toMatch(/^(?:global|us|eu|apac)\./);
      expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never lists a model that Runtime Messages rejects', () => {
    const ids = BEDROCK_RUNTIME_CLAUDE_MESSAGES_MODELS.map((entry) => entry.modelId);
    for (const unsupported of UNSUPPORTED_IDS) {
      expect(ids).not.toContain(unsupported);
    }
  });

  it.each(VERIFIED_IDS.flatMap((id) => ['global', 'us', 'eu', 'apac'].map((s) => `${s}.${id}`)))(
    'recognises the CRIS profile %s',
    (profile) => {
      expect(isBedrockRuntimeClaudeProfile(profile)).toBe(true);
      expect(isBedrockRuntimeClaudeProfile(`bedrock/${profile}`)).toBe(true);
      expect(getBedrockRuntimeSupportedEndpoints(profile)).toEqual([
        '/v1/chat/completions',
        '/v1/messages',
      ]);
    },
  );

  it('rejects base model IDs without a CRIS scope', () => {
    expect(isBedrockRuntimeClaudeProfile('anthropic.claude-sonnet-5-5')).toBe(false);
    expect(isBedrockRuntimeClaudeProfile('bedrock/anthropic.claude-sonnet-5-5')).toBe(false);
    expect(getBedrockRuntimeSupportedEndpoints('anthropic.claude-sonnet-5-5')).toEqual([]);
  });

  it.each(UNSUPPORTED_IDS)('rejects the unsupported profile us.%s', (id) => {
    expect(isBedrockRuntimeClaudeProfile(`us.${id}`)).toBe(false);
    expect(getBedrockRuntimeSupportedEndpoints(`us.${id}`)).toEqual([]);
  });

  it('rejects non-Claude profiles, unknown scopes, and wrong casing', () => {
    expect(isBedrockRuntimeClaudeProfile('us.openai.gpt-6-sol')).toBe(false);
    expect(isBedrockRuntimeClaudeProfile('ca.anthropic.claude-sonnet-5-5')).toBe(false);
    expect(isBedrockRuntimeClaudeProfile('us.Anthropic.Claude-Sonnet-5-5')).toBe(false);
    expect(isBedrockRuntimeClaudeProfile('')).toBe(false);
  });

  it('does not match a listed id that is only a prefix of the model', () => {
    expect(isBedrockRuntimeClaudeProfile('us.anthropic.claude-sonnet-5-5-extra')).toBe(false);
    expect(isBedrockRuntimeClaudeProfile('us.anthropic.claude-opus-5-50')).toBe(false);
  });
});
