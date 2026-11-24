import {
  MODEL_PREFIX_MAP,
  inferProviderFromModel,
  resolveProviderMetadataIdentity,
  resolveUnderlyingModelIdentity,
  underlyingGatewayModel,
} from '../src/provider-inference';

describe('MODEL_PREFIX_MAP', () => {
  it('is a non-empty array of [RegExp, string] entries', () => {
    expect(MODEL_PREFIX_MAP.length).toBeGreaterThan(0);
    for (const [re, id] of MODEL_PREFIX_MAP) {
      expect(re).toBeInstanceOf(RegExp);
      expect(typeof id).toBe('string');
    }
  });
});

describe('inferProviderFromModel', () => {
  it.each([
    ['claude-sonnet-4', 'anthropic'],
    ['claude-opus-4-6', 'anthropic'],
    ['gpt-4o', 'openai'],
    ['gpt-4-turbo', 'openai'],
    ['o3-mini', 'openai'],
    ['o1-preview', 'openai'],
    ['o4-mini', 'openai'],
    ['chatgpt-4o-latest', 'openai'],
    ['gemini-2.0-flash', 'gemini'],
    ['gemma-2-9b', 'gemini'],
    ['deepseek-r1', 'deepseek'],
    ['grok-3', 'xai'],
    ['mistral-large-latest', 'mistral'],
    ['codestral-2501', 'mistral'],
    ['pixtral-large', 'mistral'],
    ['open-mistral-nemo', 'mistral'],
    ['kimi-k2', 'moonshot'],
    ['moonshot-v1', 'moonshot'],
    ['k3', 'moonshot'],
    ['k3-256k', 'moonshot'],
    ['kimi-for-coding', 'moonshot'],
    ['kimi-for-coding-highspeed', 'moonshot'],
    ['MiniMax-M2.5', 'minimax'],
    ['mimo-v2.5-pro', 'xiaomi'],
    ['mimo-v2-flash', 'xiaomi'],
    ['glm-4', 'zai'],
    ['qwen2.5-coder', 'qwen'],
    ['qwq-32b', 'qwen'],
    ['copilot/gpt-5.4', 'copilot'],
    ['copilot/claude-opus-4.6', 'copilot'],
    ['commandcode/claude-sonnet-4-6', 'commandcode'],
    ['commandcode/deepseek/deepseek-v4-flash', 'commandcode'],
    ['pioneer/auto', 'pioneer'],
    ['opencode-go/glm-5.1', 'opencode-go'],
    ['opencode-go/kimi-k2.5', 'opencode-go'],
    ['opencode-go/minimax-m2.7', 'opencode-go'],
    ['opencode-zen/qwen3.6-plus', 'opencode-zen'],
    ['opencode-zen/claude-opus-4-7', 'opencode-zen'],
    ['opencode-zen/gpt-5.5', 'opencode-zen'],
    ['llamacpp/Qwen3.5-9B-Q4_K_M.gguf', 'llamacpp'],
    ['llamacpp/mistral-7b-instruct-v0.3.Q4_K_M.gguf', 'llamacpp'],
    ['openrouter/auto', 'openrouter'],
    ['anthropic/claude-sonnet-4', 'openrouter'],
  ])('infers %s as %s', (model, expected) => {
    expect(inferProviderFromModel(model)).toBe(expected);
  });

  it('returns "custom" for custom: prefix', () => {
    expect(inferProviderFromModel('custom:abc-123/gpt-4o')).toBe('custom');
  });

  it('returns "ollama" for models with colon tags', () => {
    expect(inferProviderFromModel('qwen2.5:0.5b')).toBe('ollama');
    expect(inferProviderFromModel('llama3:latest')).toBe('ollama');
  });

  it('does not treat OpenRouter vendor/model:variant as ollama', () => {
    expect(inferProviderFromModel('anthropic/claude-sonnet-4:thinking')).toBe('openrouter');
    expect(inferProviderFromModel('nvidia/llama-3.1-nemotron-70b-instruct:extended')).toBe(
      'openrouter',
    );
    expect(inferProviderFromModel('meta-llama/llama-4-scout:free')).toBe('openrouter');
  });

  it('does not treat :free suffix as ollama', () => {
    expect(inferProviderFromModel('openrouter/model:free')).not.toBe('ollama');
  });

  it('returns undefined for unrecognized models', () => {
    expect(inferProviderFromModel('unknown-model')).toBeUndefined();
  });

  it('matches only exact k3 or k3-<suffix>, not unrelated k3-prefixed ids', () => {
    expect(inferProviderFromModel('k3pro')).toBeUndefined();
    expect(inferProviderFromModel('k30')).toBeUndefined();
    expect(inferProviderFromModel('k3.5-turbo')).toBeUndefined();
  });
});

describe('underlyingGatewayModel', () => {
  it('strips the gateway prefix from gateway model ids', () => {
    expect(underlyingGatewayModel('opencode-go/deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(underlyingGatewayModel('opencode-go/kimi-k2.6')).toBe('kimi-k2.6');
    expect(underlyingGatewayModel('opencode-zen/qwen3.6-plus')).toBe('qwen3.6-plus');
  });

  it('returns null for non-gateway model ids', () => {
    expect(underlyingGatewayModel('deepseek-v4-pro')).toBeNull();
    expect(underlyingGatewayModel('openrouter/anthropic/claude-sonnet-4')).toBeNull();
  });
});

describe('resolveUnderlyingModelIdentity', () => {
  it('resolves a gateway model id to its provenance provider and bare model', () => {
    expect(resolveUnderlyingModelIdentity('opencode-go', 'opencode-go/glm-5.1')).toEqual({
      provider: 'zai',
      model: 'glm-5.1',
    });
    expect(resolveUnderlyingModelIdentity('opencode-go', 'opencode-go/kimi-k2.6')).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.6',
    });
    expect(resolveUnderlyingModelIdentity('opencode-zen', 'opencode-zen/qwen3.6-plus')).toEqual({
      provider: 'qwen',
      model: 'qwen3.6-plus',
    });
  });

  it('resolves MiMo gateway models to Xiaomi', () => {
    expect(resolveUnderlyingModelIdentity('opencode-go', 'opencode-go/mimo-v2.5')).toEqual({
      provider: 'xiaomi',
      model: 'mimo-v2.5',
    });
  });

  it('returns an undefined provider when the underlying id matches no known provider', () => {
    expect(resolveUnderlyingModelIdentity('opencode-go', 'opencode-go/big-pickle')).toEqual({
      provider: undefined,
      model: 'big-pickle',
    });
    expect(resolveUnderlyingModelIdentity('opencode-zen', 'opencode-zen/big-pickle')).toEqual({
      provider: undefined,
      model: 'big-pickle',
    });
  });

  it('returns non-gateway pairs unchanged', () => {
    expect(resolveUnderlyingModelIdentity('zai', 'glm-5.1')).toEqual({
      provider: 'zai',
      model: 'glm-5.1',
    });
    expect(resolveUnderlyingModelIdentity(undefined, 'deepseek-v4-pro')).toEqual({
      provider: undefined,
      model: 'deepseek-v4-pro',
    });
  });
});

describe('resolveProviderMetadataIdentity', () => {
  it('keeps non-Bedrock route identities unchanged', () => {
    expect(resolveProviderMetadataIdentity('anthropic', 'claude-opus-4.8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4.8',
    });
  });

  it('unwraps Bedrock provider-prefixed model ids for metadata lookups', () => {
    expect(resolveProviderMetadataIdentity('bedrock', 'anthropic.claude-opus-4.8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4.8',
    });
    expect(resolveProviderMetadataIdentity('bedrock', 'openai.gpt-oss-120b')).toEqual({
      provider: 'openai',
      model: 'gpt-oss-120b',
    });
  });

  it('unwraps Bedrock cross-region profile prefixes before the vendor segment', () => {
    expect(resolveProviderMetadataIdentity('bedrock', 'us.anthropic.claude-opus-4.8')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4.8',
    });
  });

  it('unwraps Bedrock vendor aliases that contain dots', () => {
    expect(resolveProviderMetadataIdentity('bedrock', 'z.ai.glm-4.6')).toEqual({
      provider: 'zai',
      model: 'glm-4.6',
    });
    expect(resolveProviderMetadataIdentity('bedrock', 'us.z.ai.glm-4.6')).toEqual({
      provider: 'zai',
      model: 'glm-4.6',
    });
  });

  it('leaves unknown Bedrock vendors unchanged', () => {
    expect(resolveProviderMetadataIdentity('bedrock', 'amazon.nova-pro-v1:0')).toEqual({
      provider: 'bedrock',
      model: 'amazon.nova-pro-v1:0',
    });
  });

  it('still unwraps gateway models for metadata lookups', () => {
    expect(resolveProviderMetadataIdentity('opencode-go', 'opencode-go/glm-5.1')).toEqual({
      provider: 'zai',
      model: 'glm-5.1',
    });
  });
});
