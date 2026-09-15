import { resolveForwardEndpoint } from './forward-endpoint-resolver';

const fakeLogger = () => ({ warn: jest.fn() });

describe('resolveForwardEndpoint', () => {
  it('leaves the model untouched and sets no override for a plain provider', () => {
    const out = resolveForwardEndpoint({
      provider: 'openai',
      authType: 'api_key',
      model: 'gpt-4o',
    });
    expect(out.forwardModel).toBe('gpt-4o');
    expect(out.customEndpoint).toBeUndefined();
  });

  it('strips the copilot/ prefix', () => {
    const out = resolveForwardEndpoint({
      provider: 'copilot',
      authType: 'subscription',
      model: 'copilot/gpt-4o',
    });
    expect(out.forwardModel).toBe('gpt-4o');
    expect(out.customEndpoint).toBeUndefined();
  });

  it('builds the MiniMax CN endpoint for API-key credentials', () => {
    const out = resolveForwardEndpoint({
      provider: 'minimax',
      authType: 'api_key',
      model: 'minimax/MiniMax-M3',
      providerRegion: 'cn',
    });
    expect(out.forwardModel).toBe('minimax/MiniMax-M3');
    expect(out.customEndpoint?.baseUrl).toBe('https://api.minimaxi.com');
    expect(out.customEndpoint?.buildPath(out.forwardModel)).toBe('/v1/chat/completions');
  });

  it('normalises a legacy MiniMax resource_url before building the region endpoint', () => {
    const out = resolveForwardEndpoint({
      provider: 'minimax',
      authType: 'subscription',
      model: 'minimax/abab',
      resourceUrl: 'https://api.minimaxi.com/anthropic',
    });
    expect(out.forwardModel).toBe('abab');
    expect(out.customEndpoint?.baseUrl).toBe('https://api.minimaxi.com/anthropic/v1');
  });

  it('warns and builds no endpoint for an invalid minimax resource_url (still strips prefix)', () => {
    const logger = fakeLogger();
    const out = resolveForwardEndpoint({
      provider: 'minimax',
      authType: 'subscription',
      model: 'minimax/abab',
      resourceUrl: 'https://evil.example/anthropic',
      logger,
    });
    expect(out.forwardModel).toBe('abab');
    expect(out.customEndpoint).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('falls back to the persisted cn region for a minimax token without a resource_url', () => {
    const out = resolveForwardEndpoint({
      provider: 'minimax',
      authType: 'subscription',
      model: 'minimax/abab',
      providerRegion: 'cn',
    });
    expect(out.customEndpoint).toBeDefined();
    expect(out.forwardModel).toBe('abab');
  });

  it('sets no minimax override for a non-cn region without a resource_url', () => {
    const out = resolveForwardEndpoint({
      provider: 'minimax',
      authType: 'subscription',
      model: 'minimax/abab',
      providerRegion: 'global',
    });
    expect(out.customEndpoint).toBeUndefined();
  });

  it('builds the zai cn endpoint and strips the z-ai/ prefix', () => {
    const out = resolveForwardEndpoint({
      provider: 'zai',
      authType: 'subscription',
      model: 'z-ai/glm-4.6',
      providerRegion: 'cn',
    });
    expect(out.forwardModel).toBe('glm-4.6');
    expect(out.customEndpoint).toBeDefined();
  });

  it('strips the zai/ prefix variant', () => {
    const out = resolveForwardEndpoint({
      provider: 'zai',
      authType: 'subscription',
      model: 'zai/glm-4.6',
      providerRegion: 'global',
    });
    expect(out.forwardModel).toBe('glm-4.6');
    // global zai needs no override
    expect(out.customEndpoint).toBeUndefined();
  });

  it('builds the Xiaomi Token Plan region endpoint and strips the xiaomi/ prefix', () => {
    const out = resolveForwardEndpoint({
      provider: 'xiaomi',
      authType: 'subscription',
      model: 'xiaomi/mimo-v2.5-pro',
      providerRegion: 'ams',
    });
    expect(out.forwardModel).toBe('mimo-v2.5-pro');
    expect(out.customEndpoint?.baseUrl).toBe('https://token-plan-ams.xiaomimimo.com');
  });

  it('builds the Xiaomi Token Plan endpoint for provider aliases', () => {
    const out = resolveForwardEndpoint({
      provider: 'mimo',
      authType: 'subscription',
      model: 'mimo/mimo-v2.5-pro',
      providerRegion: 'sgp',
    });
    expect(out.forwardModel).toBe('mimo-v2.5-pro');
    expect(out.customEndpoint?.baseUrl).toBe('https://token-plan-sgp.xiaomimimo.com');
  });

  it('strips the xiaomi-mimo/ model prefix variant', () => {
    const out = resolveForwardEndpoint({
      provider: 'xiaomi-mimo',
      authType: 'subscription',
      model: 'xiaomi-mimo/mimo-v2.5-pro',
      providerRegion: 'cn',
    });
    expect(out.forwardModel).toBe('mimo-v2.5-pro');
    expect(out.customEndpoint?.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com');
  });

  it('sets no Xiaomi override for an unknown persisted region', () => {
    const out = resolveForwardEndpoint({
      provider: 'xiaomi',
      authType: 'subscription',
      model: 'xiaomi/mimo-v2.5-pro',
      providerRegion: null,
    });
    expect(out.forwardModel).toBe('mimo-v2.5-pro');
    expect(out.customEndpoint).toBeUndefined();
  });

  it('builds the qwen region endpoint for a resolved region', () => {
    const out = resolveForwardEndpoint({
      provider: 'qwen',
      authType: 'api_key',
      model: 'qwen-max',
      providerRegion: 'beijing',
    });
    expect(out.customEndpoint).toBeDefined();
  });

  it('builds the qwen endpoint from a stored Alibaba Model Studio base URL', () => {
    const out = resolveForwardEndpoint({
      provider: 'qwen',
      authType: 'api_key',
      model: 'qwen-max',
      providerRegion: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
    });
    expect(out.forwardModel).toBe('qwen-max');
    expect(out.customEndpoint?.baseUrl).toBe(
      'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode',
    );
  });

  it('builds the AWS Bedrock Mantle endpoint for a selected region', () => {
    const out = resolveForwardEndpoint({
      provider: 'bedrock',
      authType: 'api_key',
      model: 'mistral.ministral-3-8b-instruct',
      providerRegion: 'eu-west-1',
    });
    expect(out.forwardModel).toBe('mistral.ministral-3-8b-instruct');
    expect(out.customEndpoint?.baseUrl).toBe('https://bedrock-mantle.eu-west-1.api.aws');
    expect(out.customEndpoint?.buildPath(out.forwardModel)).toBe('/v1/chat/completions');
  });

  it('leaves Vertex on the express base URL when no deployment is stored', () => {
    const out = resolveForwardEndpoint({
      provider: 'vertex',
      authType: 'api_key',
      model: 'gemini-2.5-flash',
      providerRegion: null,
    });

    // No override: the built-in express endpoint already resolves the project
    // from the API key.
    expect(out.customEndpoint).toBeUndefined();
    expect(out.forwardModel).toBe('gemini-2.5-flash');
  });

  it('addresses Vertex by project and location when the region carries them', () => {
    const out = resolveForwardEndpoint({
      provider: 'vertex',
      authType: 'api_key',
      model: 'gemini-2.5-flash',
      providerRegion: 'my-project/europe-west4',
    });

    expect(out.customEndpoint?.baseUrl).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/my-project/locations/europe-west4',
    );
    expect(out.customEndpoint?.buildPath(out.forwardModel)).toBe(
      '/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(out.customEndpoint?.format).toBe('google');
  });

  it('falls back to express when the stored Vertex deployment is malformed', () => {
    const out = resolveForwardEndpoint({
      provider: 'vertex',
      authType: 'api_key',
      model: 'gemini-2.5-flash',
      providerRegion: 'us-central1',
    });

    expect(out.customEndpoint).toBeUndefined();
  });

  it('keeps the selected Bedrock region for OpenAI Responses models', () => {
    const out = resolveForwardEndpoint({
      provider: 'bedrock',
      authType: 'api_key',
      model: 'openai.gpt-5.6-luna',
      providerRegion: 'us-west-2',
    });

    expect(out.customEndpoint?.baseUrl).toBe('https://bedrock-mantle.us-west-2.api.aws');
    expect(out.customEndpoint?.format).toBe('chatgpt');
    expect(out.customEndpoint?.buildPath(out.forwardModel)).toBe('/openai/v1/responses');
  });

  it('keeps the selected Bedrock region for Anthropic Messages models', () => {
    const out = resolveForwardEndpoint({
      provider: 'bedrock',
      authType: 'api_key',
      model: 'anthropic.claude-sonnet-5',
      providerRegion: 'ap-southeast-2',
    });

    expect(out.customEndpoint?.baseUrl).toBe('https://bedrock-mantle.ap-southeast-2.api.aws');
    expect(out.customEndpoint?.format).toBe('anthropic');
    expect(out.customEndpoint?.buildPath(out.forwardModel)).toBe('/anthropic/v1/messages');
  });

  it('sets no qwen override for an unresolved region', () => {
    const out = resolveForwardEndpoint({
      provider: 'qwen',
      authType: 'api_key',
      model: 'qwen-max',
      providerRegion: null,
    });
    expect(out.customEndpoint).toBeUndefined();
  });

  it('builds a custom-provider endpoint and forwards the bare model id', () => {
    const out = resolveForwardEndpoint({
      provider: 'custom:abc',
      authType: 'api_key',
      model: 'custom:abc/meta-llama/Llama-3.1-8B',
      customProvider: { base_url: 'https://nebius.example/v1', api_kind: 'openai' },
    });
    expect(out.customEndpoint).toBeDefined();
    expect(out.forwardModel).toBe('meta-llama/Llama-3.1-8B');
  });

  it('sets no override for a custom provider whose row is missing', () => {
    const out = resolveForwardEndpoint({
      provider: 'custom:gone',
      authType: 'api_key',
      model: 'custom:gone/foo',
      customProvider: null,
    });
    expect(out.customEndpoint).toBeUndefined();
  });
});
