import { PROVIDER_REGISTRY } from '../../../common/constants/providers';
import {
  buildCustomEndpoint,
  buildEndpointOverride,
  resolveBedrockEndpointKey,
  resolveEndpointKey,
  PROVIDER_ENDPOINTS,
} from '../provider-endpoints';
import { buildProviderExtraHeaders, resolveSubscriptionEndpointKey } from '../provider-hooks';

describe('buildCustomEndpoint', () => {
  it('strips trailing /v1 from base URL to avoid double /v1', () => {
    const endpoint = buildCustomEndpoint('https://api.groq.com/openai/v1');

    expect(endpoint.baseUrl).toBe('https://api.groq.com/openai');
    expect(endpoint.format).toBe('openai');
  });

  it('leaves base URL intact when no /v1 suffix', () => {
    const endpoint = buildCustomEndpoint('https://api.example.com');
    expect(endpoint.baseUrl).toBe('https://api.example.com');
  });

  it('uses Bearer auth headers', () => {
    const endpoint = buildCustomEndpoint('http://localhost:8000');
    const headers = endpoint.buildHeaders('sk-test');

    expect(headers).toEqual({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
  });

  it('builds OpenAI-compatible /v1/chat/completions path', () => {
    const endpoint = buildCustomEndpoint('http://localhost:8000');
    const path = endpoint.buildPath('llama-3.1-70b');

    expect(path).toBe('/v1/chat/completions');
  });

  it('requests exact streamed usage for OpenAI-compatible custom providers', () => {
    const endpoint = buildCustomEndpoint('http://localhost:8000');

    expect(endpoint.streamUsageReporting).toBe('openai_stream_options');
  });

  it('returns an Anthropic-shaped endpoint when apiKind="anthropic"', () => {
    const endpoint = buildCustomEndpoint('https://api.anthropic.com', 'anthropic');

    expect(endpoint.format).toBe('anthropic');
    expect(endpoint.buildPath('claude-sonnet-4-5')).toBe('/v1/messages');
    // Non-subscription path: x-api-key + anthropic-version, no Bearer.
    const headers = endpoint.buildHeaders('sk-ant-test');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
  });

  it('strips trailing /v1 before switching to Anthropic path so /v1/messages is not duplicated', () => {
    const endpoint = buildCustomEndpoint('https://api.anthropic.com/v1', 'anthropic');
    expect(endpoint.baseUrl).toBe('https://api.anthropic.com');
    expect(endpoint.buildPath('claude-sonnet-4-5')).toBe('/v1/messages');
  });
});

describe('resolveEndpointKey', () => {
  it('resolves known providers directly', () => {
    expect(resolveEndpointKey('openai')).toBe('openai');
    expect(resolveEndpointKey('anthropic')).toBe('anthropic');
    expect(resolveEndpointKey('bedrock')).toBe('bedrock');
    expect(resolveEndpointKey('cerebras')).toBe('cerebras');
    expect(resolveEndpointKey('pioneer')).toBe('pioneer');
    expect(resolveEndpointKey('google')).toBe('google');
    expect(resolveEndpointKey('byteplus')).toBe('byteplus');
    expect(resolveEndpointKey('deepseek')).toBe('deepseek');
    expect(resolveEndpointKey('commandcode')).toBe('commandcode');
    expect(resolveEndpointKey('fireworks')).toBe('fireworks');
    expect(resolveEndpointKey('huggingface')).toBe('huggingface');
    expect(resolveEndpointKey('gemini-free')).toBe('gemini-free');
    expect(resolveEndpointKey('nous')).toBe('nous');
    expect(resolveEndpointKey('nvidia')).toBe('nvidia');
    expect(resolveEndpointKey('ollama')).toBe('ollama');
    expect(resolveEndpointKey('kilo')).toBe('kilo');
    expect(resolveEndpointKey('zai')).toBe('zai');
    expect(resolveEndpointKey('xiaomi')).toBe('xiaomi');
  });

  it('is case-insensitive', () => {
    expect(resolveEndpointKey('OpenAI')).toBe('openai');
    expect(resolveEndpointKey('ANTHROPIC')).toBe('anthropic');
  });

  it('resolves alias gemini to google', () => {
    expect(resolveEndpointKey('gemini')).toBe('google');
    expect(resolveEndpointKey('Gemini')).toBe('google');
  });

  it('resolves alias z.ai to zai', () => {
    expect(resolveEndpointKey('z.ai')).toBe('zai');
  });

  it('resolves Fireworks AI aliases to fireworks', () => {
    expect(resolveEndpointKey('fireworks-ai')).toBe('fireworks');
    expect(resolveEndpointKey('fireworks ai')).toBe('fireworks');
  });

  it('resolves Hugging Face aliases to huggingface', () => {
    expect(resolveEndpointKey('hugging-face')).toBe('huggingface');
    expect(resolveEndpointKey('Hugging Face')).toBe('huggingface');
    expect(resolveEndpointKey('hf')).toBe('huggingface');
  });

  it('resolves Command Code aliases to commandcode', () => {
    expect(resolveEndpointKey('command-code')).toBe('commandcode');
    expect(resolveEndpointKey('Command Code')).toBe('commandcode');
    expect(resolveEndpointKey('cmd')).toBe('commandcode');
  });

  it('resolves BytePlus ModelArk aliases to byteplus', () => {
    expect(resolveEndpointKey('byteplus-plan')).toBe('byteplus');
    expect(resolveEndpointKey('ModelArk')).toBe('byteplus');
  });

  it('resolves Pioneer aliases to pioneer', () => {
    expect(resolveEndpointKey('pioneer-ai')).toBe('pioneer');
    expect(resolveEndpointKey('Pioneer AI')).toBe('pioneer');
  });

  it('resolves Xiaomi MiMo aliases to xiaomi', () => {
    expect(resolveEndpointKey('mimo')).toBe('xiaomi');
    expect(resolveEndpointKey('xiaomi-mimo')).toBe('xiaomi');
    expect(resolveEndpointKey('Xiaomi MiMo')).toBe('xiaomi');
  });

  it('resolves AWS Bedrock aliases to bedrock', () => {
    expect(resolveEndpointKey('aws-bedrock')).toBe('bedrock');
    expect(resolveEndpointKey('amazon-bedrock')).toBe('bedrock');
  });

  it('resolves qwen and alibaba to qwen', () => {
    expect(resolveEndpointKey('qwen')).toBe('qwen');
    expect(resolveEndpointKey('alibaba')).toBe('qwen');
  });

  it('returns custom: key as-is for custom providers', () => {
    expect(resolveEndpointKey('custom:abc-123')).toBe('custom:abc-123');
    expect(resolveEndpointKey('custom:uuid-456')).toBe('custom:uuid-456');
  });

  it('returns null for unknown providers', () => {
    expect(resolveEndpointKey('unknown')).toBeNull();
    expect(resolveEndpointKey('random-provider')).toBeNull();
  });

  it('exposes expected set of known providers', () => {
    const known = Object.keys(PROVIDER_ENDPOINTS);
    expect(known).toContain('openai');
    expect(known).toContain('anthropic');
    expect(known).toContain('bedrock');
    expect(known).toContain('cerebras');
    expect(known).toContain('cline-pass');
    expect(known).toContain('pioneer');
    expect(known).toContain('meta');
    expect(known).toContain('google');
    expect(known).toContain('qwen');
    expect(known).toContain('copilot');
    expect(known).toContain('byteplus');
    expect(known).toContain('byteplus-anthropic');
    expect(known).toContain('commandcode');
    expect(known).toContain('commandcode-anthropic');
    expect(known).toContain('fireworks');
    expect(known).toContain('huggingface');
    expect(known).toContain('gemini-free');
    expect(known).toContain('nous');
    expect(known).toContain('openrouter');
    expect(known).toContain('nvidia');
    expect(known).toContain('ollama');
    expect(known).toContain('ollama-cloud');
    expect(known).toContain('qwen-subscription');
    expect(known).toContain('qwen-subscription-responses');
    expect(known).toContain('xiaomi');
    expect(known).toContain('xiaomi-subscription');
    expect(known).toContain('kiro');
    expect(known).toContain('opencode-go');
    expect(known).toContain('opencode-go-anthropic');
    expect(known).toContain('opencode-go-responses');
    expect(known).toContain('opencode-zen');
    expect(known).toContain('opencode-zen-google');
  });

  it('resolves ollama-cloud to ollama-cloud', () => {
    expect(resolveEndpointKey('ollama-cloud')).toBe('ollama-cloud');
    expect(resolveEndpointKey('Ollama-Cloud')).toBe('ollama-cloud');
  });

  it('resolves opencode-go and its opencodego alias', () => {
    expect(resolveEndpointKey('opencode-go')).toBe('opencode-go');
    expect(resolveEndpointKey('OpenCode-Go')).toBe('opencode-go');
    expect(resolveEndpointKey('opencodego')).toBe('opencode-go');
  });

  it('resolves opencode-zen and its opencodezen alias', () => {
    expect(resolveEndpointKey('opencode-zen')).toBe('opencode-zen');
    expect(resolveEndpointKey('OpenCode-Zen')).toBe('opencode-zen');
    expect(resolveEndpointKey('opencodezen')).toBe('opencode-zen');
  });

  it('resolves kilo and its aliases', () => {
    expect(resolveEndpointKey('kilo')).toBe('kilo');
    expect(resolveEndpointKey('KiloCode')).toBe('kilo');
    expect(resolveEndpointKey('kilo-code')).toBe('kilo');
  });

  it('resolves Nous Research aliases to nous', () => {
    expect(resolveEndpointKey('nous')).toBe('nous');
    expect(resolveEndpointKey('NousResearch')).toBe('nous');
    expect(resolveEndpointKey('nous-research')).toBe('nous');
  });

  it('resolves every proxy-capable provider id and alias from the registry', () => {
    // tileOnly providers (LM Studio) don't have a fixed proxy endpoint —
    // they deep-link to the local-server detail view and route through
    // the `custom:<uuid>` path once connected.
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.tileOnly) continue;
      expect(resolveEndpointKey(entry.id)).not.toBeNull();
      for (const alias of entry.aliases) {
        expect(resolveEndpointKey(alias)).not.toBeNull();
      }
    }
  });
});

describe('resolveBedrockEndpointKey', () => {
  it.each(['openai.gpt-5.6-luna', 'us.openai.gpt-5.6-luna', 'bedrock/openai.gpt-5.6-luna'])(
    'routes %s through Responses',
    (model) => {
      expect(resolveBedrockEndpointKey(model)).toBe('bedrock-responses');
    },
  );

  it.each(['anthropic.claude-sonnet-5', 'us.anthropic.claude-sonnet-5'])(
    'routes %s through Messages',
    (model) => {
      expect(resolveBedrockEndpointKey(model)).toBe('bedrock-anthropic');
    },
  );

  it('keeps other Bedrock model families on Chat Completions', () => {
    expect(resolveBedrockEndpointKey('mistral.ministral-3-8b-instruct')).toBe('bedrock');
  });
});

describe('PROVIDER_ENDPOINTS', () => {
  it.each([
    'openai.gpt-5',
    'openai.gpt-5.1',
    'openai.gpt-5.4',
    'openai.gpt-5.4-2026-03-05',
    'openai.gpt-5.5',
    'openai.gpt-5.6-sol',
    'openai.gpt-5.6-terra',
    'openai.gpt-5.6-luna',
    'openai.gpt-5.99-future',
    'us.openai.gpt-5.6-luna',
    'bedrock/openai.gpt-5.6-luna',
  ])('uses the namespaced Bedrock Responses path for %s', (model) => {
    expect(PROVIDER_ENDPOINTS['bedrock-responses'].buildPath(model)).toBe('/openai/v1/responses');
  });

  it.each(['openai.gpt-oss-120b', 'openai.gpt-50'])(
    'keeps non-GPT-5 Bedrock model %s on the generic Responses path',
    (model) => {
      expect(PROVIDER_ENDPOINTS['bedrock-responses'].buildPath(model)).toBe('/v1/responses');
    },
  );

  it('routes Gemini Free through the configured LiteLLM gateway', () => {
    process.env['CREDITS_BASE_URL'] = 'https://credits.test/';
    const endpoint = PROVIDER_ENDPOINTS['gemini-free'];

    expect(endpoint.baseUrl).toBe('https://credits.test');
    expect(endpoint.buildPath('gemini/gemini-2.5-flash')).toBe('/v1/chat/completions');
    expect(endpoint.buildHeaders('sk-virtual')).toEqual({
      Authorization: 'Bearer sk-virtual',
      'Content-Type': 'application/json',
    });
  });

  it('huggingface uses the OpenAI-compatible Inference Providers endpoint', () => {
    const endpoint = PROVIDER_ENDPOINTS['huggingface'];
    expect(endpoint.baseUrl).toBe('https://router.huggingface.co');
    expect(endpoint.buildPath('openai/gpt-oss-120b')).toBe('/v1/chat/completions');
    expect(endpoint.buildHeaders('hf_test_token')).toEqual({
      Authorization: 'Bearer hf_test_token',
      'Content-Type': 'application/json',
    });
    expect(endpoint.streamUsageReporting).toBe('openai_stream_options');
  });

  it('meta uses the Model API OpenAI-compatible chat endpoint', () => {
    const endpoint = PROVIDER_ENDPOINTS['meta'];
    expect(endpoint.baseUrl).toBe('https://api.meta.ai');
    expect(endpoint.buildPath('muse-spark-1.2')).toBe('/v1/chat/completions');
    expect(endpoint.buildHeaders('LLM_test-meta-key-value')).toEqual({
      Authorization: 'Bearer LLM_test-meta-key-value',
      'Content-Type': 'application/json',
    });
    expect(endpoint.format).toBe('openai');
    expect(endpoint.streamUsageReporting).toBe('openai_stream_options');
  });

  it('zai buildPath returns correct path', () => {
    const path = PROVIDER_ENDPOINTS['zai'].buildPath('test-model');
    expect(path).toBe('/api/paas/v4/chat/completions');
  });

  it('ollama buildHeaders returns Content-Type only', () => {
    const headers = PROVIDER_ENDPOINTS['ollama'].buildHeaders('');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('ollama uses openai format', () => {
    expect(PROVIDER_ENDPOINTS['ollama'].format).toBe('openai');
  });

  it('zai uses openai format', () => {
    expect(PROVIDER_ENDPOINTS['zai'].format).toBe('openai');
  });

  it('bedrock uses the OpenAI-compatible Bedrock Mantle endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['bedrock'];
    expect(ep.baseUrl).toBe('https://bedrock-mantle.us-east-1.api.aws');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('mistral.ministral-3-8b-instruct')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('bedrock-api-key-test')).toEqual({
      Authorization: 'Bearer bedrock-api-key-test',
      'Content-Type': 'application/json',
    });
  });

  it('groq uses OpenAI-compatible format at api.groq.com/openai', () => {
    const ep = PROVIDER_ENDPOINTS['groq'];
    expect(ep.baseUrl).toBe('https://api.groq.com/openai');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('llama-3.3-70b-versatile')).toBe('/v1/chat/completions');
  });

  it('groq uses Bearer auth headers', () => {
    const headers = PROVIDER_ENDPOINTS['groq'].buildHeaders('gsk_test_key');
    expect(headers).toEqual({
      Authorization: 'Bearer gsk_test_key',
      'Content-Type': 'application/json',
    });
  });

  it('kilo uses the Kilo Gateway OpenAI-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['kilo'];
    expect(ep.baseUrl).toBe('https://api.kilo.ai/api/gateway');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('anthropic/claude-sonnet-4.5')).toBe('/chat/completions');
    expect(ep.buildHeaders('kilo-token')).toEqual({
      Authorization: 'Bearer kilo-token',
      'Content-Type': 'application/json',
    });
  });

  it('fireworks uses the Fireworks OpenAI-compatible inference endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['fireworks'];
    expect(ep.baseUrl).toBe('https://api.fireworks.ai/inference');
    expect(ep.format).toBe('openai');
    expect(ep.streamUsageReporting).toBeUndefined();
    expect(ep.buildPath('accounts/fireworks/models/deepseek-v3p1')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('fw_test_key')).toEqual({
      Authorization: 'Bearer fw_test_key',
      'Content-Type': 'application/json',
    });
  });

  it('cerebras uses the OpenAI-compatible API endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['cerebras'];
    expect(ep.baseUrl).toBe('https://api.cerebras.ai');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('gpt-oss-120b')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('cerebras-key')).toEqual({
      Authorization: 'Bearer cerebras-key',
      'Content-Type': 'application/json',
    });
  });

  it('pioneer uses the OpenAI-compatible API endpoint with X-API-Key auth', () => {
    const ep = PROVIDER_ENDPOINTS['pioneer'];
    expect(ep.baseUrl).toBe('https://api.pioneer.ai');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('pioneer/auto')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('pio_sk_test_key')).toEqual({
      'X-API-Key': 'pio_sk_test_key',
      'Content-Type': 'application/json',
    });
  });

  it('byteplus uses the ModelArk Coding Plan OpenAI-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['byteplus'];
    expect(ep.baseUrl).toBe('https://ark.ap-southeast.bytepluses.com/api/coding');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('ark-code-latest')).toBe('/v3/chat/completions');
    expect(ep.buildHeaders('bp-token')).toEqual({
      Authorization: 'Bearer bp-token',
      'Content-Type': 'application/json',
    });
  });

  it('byteplus-anthropic uses the ModelArk Coding Plan Anthropic-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['byteplus-anthropic'];
    expect(ep.baseUrl).toBe('https://ark.ap-southeast.bytepluses.com/api/coding');
    expect(ep.format).toBe('anthropic');
    expect(ep.buildPath('ark-code-latest')).toBe('/v1/messages');
    expect(ep.skipSubscriptionIdentity).toBe(true);
    expect(ep.buildHeaders('bp-token')).toEqual({
      Authorization: 'Bearer bp-token',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
  });

  it('nvidia uses the hosted NIM OpenAI-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['nvidia'];
    expect(ep.baseUrl).toBe('https://integrate.api.nvidia.com');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('nvidia/nemotron-3-super-120b-a12b')).toBe('/v1/chat/completions');
  });

  it('nvidia uses Bearer auth headers', () => {
    const headers = PROVIDER_ENDPOINTS['nvidia'].buildHeaders('nvapi-test-key');
    expect(headers).toEqual({
      Authorization: 'Bearer nvapi-test-key',
      'Content-Type': 'application/json',
    });
  });

  it('nous uses the Nous Portal OpenAI-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['nous'];
    expect(ep.baseUrl).toBe('https://inference-api.nousresearch.com');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('anthropic/claude-sonnet-4.5')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('nous-api-key')).toEqual({
      Authorization: 'Bearer nous-api-key',
      'Content-Type': 'application/json',
    });
  });

  it('qwen uses DashScope compatible-mode endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['qwen'];
    expect(ep.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode');
    expect(ep.buildPath('qwen3-235b-a22b')).toBe('/v1/chat/completions');
    expect(ep.format).toBe('openai');
  });

  it('xiaomi uses the MiMo OpenAI-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['xiaomi'];
    expect(ep.baseUrl).toBe('https://api.xiaomimimo.com');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('mimo-v2.5-pro')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('sk-mimo-test')).toEqual({
      Authorization: 'Bearer sk-mimo-test',
      'Content-Type': 'application/json',
    });
  });

  it('anthropic uses x-api-key for api_key auth', () => {
    const headers = PROVIDER_ENDPOINTS['anthropic'].buildHeaders('sk-ant-test');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('anthropic uses Claude Code-shaped headers for subscription auth', () => {
    const headers = PROVIDER_ENDPOINTS['anthropic'].buildHeaders('skst-token', 'subscription');
    expect(headers['Authorization']).toBe('Bearer skst-token');
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).toContain('context-management-2025-06-27');
    expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['user-agent']).toContain('claude-cli/');
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-stainless-runtime']).toBe('node');
    expect(headers['x-stainless-lang']).toBe('js');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('anthropic does not include oauth beta header for api_key auth', () => {
    const headers = PROVIDER_ENDPOINTS['anthropic'].buildHeaders('sk-ant-test');
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('copilot uses Bearer auth and OpenAI-compatible format', () => {
    const ep = PROVIDER_ENDPOINTS['copilot'];
    expect(ep.baseUrl).toBe('https://api.githubcopilot.com');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('copilot/claude-sonnet-4.6')).toBe('/chat/completions');
    expect(ep.buildHeaders('ghu_token')).toEqual({
      Authorization: 'Bearer ghu_token',
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.100.0',
      'Editor-Plugin-Version': 'copilot/1.300.0',
      'Copilot-Integration-Id': 'vscode-chat',
    });
  });

  it('copilot-responses targets /responses with chatgpt format and Copilot headers', () => {
    const ep = PROVIDER_ENDPOINTS['copilot-responses'];
    expect(ep.baseUrl).toBe('https://api.githubcopilot.com');
    expect(ep.format).toBe('chatgpt');
    expect(ep.buildPath('gpt-5.3-codex')).toBe('/responses');
    expect(ep.buildHeaders('ghu_token')).toEqual({
      Authorization: 'Bearer ghu_token',
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.100.0',
      'Editor-Plugin-Version': 'copilot/1.300.0',
      'Copilot-Integration-Id': 'vscode-chat',
    });
  });

  it('xai-responses targets /v1/responses with OpenAI-compatible auth headers', () => {
    const ep = PROVIDER_ENDPOINTS['xai-responses'];
    expect(ep.baseUrl).toBe('https://api.x.ai');
    expect(ep.format).toBe('chatgpt');
    expect(ep.buildPath('grok-4.20-multi-agent')).toBe('/v1/responses');
    expect(ep.buildHeaders('xai-test-key')).toEqual({
      Authorization: 'Bearer xai-test-key',
      'Content-Type': 'application/json',
    });
  });

  it('anthropic buildPath returns /v1/messages', () => {
    const path = PROVIDER_ENDPOINTS['anthropic'].buildPath('claude-sonnet-4');
    expect(path).toBe('/v1/messages');
  });

  it('vertex defaults to express mode, which resolves the project from the key', () => {
    const endpoint = PROVIDER_ENDPOINTS['vertex'];
    expect(endpoint.baseUrl).toBe('https://aiplatform.googleapis.com/v1beta1');
    expect(endpoint.format).toBe('google');
    expect(endpoint.buildPath('gemini-2.5-flash')).toBe(
      '/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    // No `?alt=sse`: provider-client appends it for every google-format
    // stream, so including it here would emit the query string twice.
    expect(endpoint.buildStreamPath?.('gemini-2.5-flash')).toBe(
      '/publishers/google/models/gemini-2.5-flash:streamGenerateContent',
    );
    expect(endpoint.buildStreamPath?.('gemini-2.5-flash')).not.toContain('alt=sse');
  });

  it('vertex composes the same path onto a project-scoped base', () => {
    // Both addressing modes end in the same suffix, so only the base differs.
    const endpoint = buildEndpointOverride(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1',
      'vertex',
    );
    expect(`${endpoint.baseUrl}${endpoint.buildPath('gemini-2.5-flash')}`).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1' +
        '/publishers/google/models/gemini-2.5-flash:generateContent',
    );
  });

  it('vertex sends the API key in x-goog-api-key like the Gemini API', () => {
    expect(PROVIDER_ENDPOINTS['vertex'].buildHeaders('AQ.test')).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'AQ.test',
    });
  });

  it('google buildHeaders sends the API key in x-goog-api-key (not query string)', () => {
    const headers = PROVIDER_ENDPOINTS['google'].buildHeaders('AIza-test');
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'AIza-test',
    });
  });

  it('google buildPath includes model name with generateContent suffix', () => {
    const path = PROVIDER_ENDPOINTS['google'].buildPath('gemini-2.0-flash');
    expect(path).toBe('/v1beta/models/gemini-2.0-flash:generateContent');
  });

  it('openrouter buildPath returns /api/v1/chat/completions', () => {
    const path = PROVIDER_ENDPOINTS['openrouter'].buildPath('openai/gpt-4o');
    expect(path).toBe('/api/v1/chat/completions');
  });

  it('openai-subscription uses chatgpt.com backend base URL', () => {
    const ep = PROVIDER_ENDPOINTS['openai-subscription'];
    expect(ep.baseUrl).toBe('https://chatgpt.com/backend-api');
  });

  it('openai-subscription builds /codex/responses path', () => {
    const path = PROVIDER_ENDPOINTS['openai-subscription'].buildPath('gpt-5');
    expect(path).toBe('/codex/responses');
  });

  it('openai-subscription uses chatgpt format', () => {
    expect(PROVIDER_ENDPOINTS['openai-subscription'].format).toBe('chatgpt');
  });

  it('openai-subscription headers include originator and user-agent', () => {
    const headers = PROVIDER_ENDPOINTS['openai-subscription'].buildHeaders('oauth-token');
    expect(headers['Authorization']).toBe('Bearer oauth-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['originator']).toBe('codex_cli_rs');
    expect(headers['user-agent']).toBe('codex_cli_rs/0.0.0 (Unknown 0; unknown) unknown');
  });

  it('minimax-subscription buildPath returns /messages', () => {
    const path = PROVIDER_ENDPOINTS['minimax-subscription'].buildPath('abab7-chat-preview');
    expect(path).toBe('/messages');
  });

  it('minimax-subscription uses Bearer auth with anthropic-version header', () => {
    const headers = PROVIDER_ENDPOINTS['minimax-subscription'].buildHeaders('oauth-token');
    expect(headers).toEqual({
      Authorization: 'Bearer oauth-token',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
  });

  it('moonshot-subscription uses Kimi Coding Plan Anthropic-compatible endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['moonshot-subscription'];
    expect(ep.baseUrl).toBe('https://api.kimi.com/coding');
    expect(ep.format).toBe('anthropic');
    expect(ep.buildPath('kimi-for-coding')).toBe('/v1/messages');
    expect(ep.skipSubscriptionIdentity).toBe(true);
  });

  it('moonshot-subscription uses Kimi Code API key headers', () => {
    const headers = PROVIDER_ENDPOINTS['moonshot-subscription'].buildHeaders('kimi-code-key');
    expect(headers).toEqual({
      'x-api-key': 'kimi-code-key',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
    expect(headers.Authorization).toBeUndefined();
  });

  it('ollama-cloud points at ollama.com with OpenAI format', () => {
    const ep = PROVIDER_ENDPOINTS['ollama-cloud'];
    expect(ep.baseUrl).toBe('https://ollama.com');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('deepseek-v3.2')).toBe('/v1/chat/completions');
  });

  it('ollama-cloud uses OpenAI-compatible Bearer auth headers', () => {
    const headers = PROVIDER_ENDPOINTS['ollama-cloud'].buildHeaders('sk-cloud-key');
    expect(headers).toEqual({
      Authorization: 'Bearer sk-cloud-key',
      'Content-Type': 'application/json',
    });
  });

  it('kiro uses the Kiro AWS JSON endpoint and target header', () => {
    const ep = PROVIDER_ENDPOINTS['kiro'];
    expect(ep.baseUrl).toBe('https://q.us-east-1.amazonaws.com');
    expect(ep.format).toBe('kiro');
    expect(ep.buildPath('kiro/auto')).toBe('/');
    expect(ep.buildHeaders('ksk_test')).toEqual({
      Authorization: 'Bearer ksk_test',
      'Content-Type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    });
  });

  it('zai-subscription uses Coding Plan base URL', () => {
    const ep = PROVIDER_ENDPOINTS['zai-subscription'];
    expect(ep.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('zai-subscription builds /chat/completions path', () => {
    const path = PROVIDER_ENDPOINTS['zai-subscription'].buildPath('glm-5.1');
    expect(path).toBe('/chat/completions');
  });

  it('zai-subscription uses openai format', () => {
    expect(PROVIDER_ENDPOINTS['zai-subscription'].format).toBe('openai');
  });

  it('zai-subscription uses Bearer auth headers', () => {
    const headers = PROVIDER_ENDPOINTS['zai-subscription'].buildHeaders('zai-api-key');
    expect(headers).toEqual({
      Authorization: 'Bearer zai-api-key',
      'Content-Type': 'application/json',
    });
  });

  it('opencode-go uses OpenCode base URL with OpenAI format', () => {
    const ep = PROVIDER_ENDPOINTS['opencode-go'];
    expect(ep.baseUrl).toBe('https://opencode.ai/zen/go');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('glm-5.1')).toBe('/v1/chat/completions');
  });

  it('opencode-go uses Bearer auth headers', () => {
    const headers = PROVIDER_ENDPOINTS['opencode-go'].buildHeaders('og-token');
    expect(headers).toEqual({
      Authorization: 'Bearer og-token',
      'Content-Type': 'application/json',
    });
  });

  it('opencode-go-anthropic uses Anthropic format with /v1/messages', () => {
    const ep = PROVIDER_ENDPOINTS['opencode-go-anthropic'];
    expect(ep.baseUrl).toBe('https://opencode.ai/zen/go');
    expect(ep.format).toBe('anthropic');
    expect(ep.buildPath('minimax-m2.7')).toBe('/v1/messages');
  });

  it('opencode-go-anthropic uses x-api-key (not Bearer) with anthropic-version header', () => {
    const headers = PROVIDER_ENDPOINTS['opencode-go-anthropic'].buildHeaders('og-token');
    expect(headers).toEqual({
      'x-api-key': 'og-token',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
    expect(headers['Authorization']).toBeUndefined();
  });

  it('opencode-go-responses targets /v1/responses with chatgpt format and Bearer auth', () => {
    const ep = PROVIDER_ENDPOINTS['opencode-go-responses'];
    expect(ep.baseUrl).toBe('https://opencode.ai/zen/go');
    expect(ep.format).toBe('chatgpt');
    expect(ep.buildPath('grok-4.5')).toBe('/v1/responses');
    expect(ep.forwardResponsesStream).toBe(true);
    expect(ep.acceptsMaxOutputTokens).toBe(true);
    expect(ep.buildHeaders('og-token')).toEqual({
      Authorization: 'Bearer og-token',
      'Content-Type': 'application/json',
    });
  });

  it('opencode-zen uses OpenCode Zen base URL with OpenAI format', () => {
    const ep = PROVIDER_ENDPOINTS['opencode-zen'];
    expect(ep.baseUrl).toBe('https://opencode.ai/zen');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('qwen3.6-plus')).toBe('/v1/chat/completions');
  });

  it('opencode-zen uses Bearer auth headers', () => {
    const headers = PROVIDER_ENDPOINTS['opencode-zen'].buildHeaders('oz-token');
    expect(headers).toEqual({
      Authorization: 'Bearer oz-token',
      'Content-Type': 'application/json',
    });
  });

  it('opencode-zen-google uses Google generateContent path with x-goog-api-key auth', () => {
    const ep = PROVIDER_ENDPOINTS['opencode-zen-google'];
    expect(ep.baseUrl).toBe('https://opencode.ai/zen');
    expect(ep.format).toBe('google');
    expect(ep.buildPath('gemini-3-flash')).toBe('/v1/models/gemini-3-flash:generateContent');
    expect(ep.buildHeaders('oz-token')).toEqual({
      'x-goog-api-key': 'oz-token',
      'Content-Type': 'application/json',
    });
  });

  it('commandcode uses the Command Code Provider API chat endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['commandcode'];
    expect(ep.baseUrl).toBe('https://api.commandcode.ai/provider');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('deepseek/deepseek-v4-flash')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('user_test')).toEqual({
      Authorization: 'Bearer user_test',
      'Content-Type': 'application/json',
    });
  });

  it('qwen-subscription uses the Token Plan OpenAI-compatible chat endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['qwen-subscription'];
    expect(ep.baseUrl).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('qwen3.6-plus')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('sk-sp-test')).toEqual({
      Authorization: 'Bearer sk-sp-test',
      'Content-Type': 'application/json',
    });
  });

  it('xiaomi-subscription uses the MiMo Token Plan OpenAI-compatible chat endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['xiaomi-subscription'];
    expect(ep.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com');
    expect(ep.format).toBe('openai');
    expect(ep.buildPath('mimo-v2.5-pro')).toBe('/v1/chat/completions');
    expect(ep.buildHeaders('tp-mimo-token')).toEqual({
      Authorization: 'Bearer tp-mimo-token',
      'Content-Type': 'application/json',
    });
  });

  it('commandcode-anthropic uses the Command Code Provider API messages endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['commandcode-anthropic'];
    expect(ep.baseUrl).toBe('https://api.commandcode.ai/provider');
    expect(ep.format).toBe('anthropic');
    expect(ep.buildPath('claude-sonnet-4-6')).toBe('/v1/messages');
    expect(ep.skipSubscriptionIdentity).toBe(true);
    expect(ep.buildHeaders('user_test')).toEqual({
      'x-api-key': 'user_test',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    });
  });

  it('qwen-subscription-responses uses the Token Plan Responses endpoint', () => {
    const ep = PROVIDER_ENDPOINTS['qwen-subscription-responses'];
    expect(ep.baseUrl).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode');
    expect(ep.format).toBe('chatgpt');
    expect(ep.buildPath('qwen3.7-max')).toBe('/v1/responses');
  });

  it('marks OpenAI-compatible streaming endpoints that support usage chunks', () => {
    const endpointKeys = [
      'openai',
      'byteplus',
      'cerebras',
      'cline-pass',
      'pioneer',
      'deepseek',
      'groq',
      'kilo',
      'mistral',
      'xai',
      'minimax',
      'meta',
      'xiaomi',
      'moonshot',
      'nous',
      'nvidia',
      'bedrock',
      'qwen',
      'qwen-subscription',
      'xiaomi-subscription',
      'zai',
      'zai-subscription',
      'copilot',
      'openrouter',
      'ollama',
      'ollama-cloud',
      'commandcode',
      'opencode-go',
      'opencode-zen',
    ];

    for (const key of endpointKeys) {
      expect(PROVIDER_ENDPOINTS[key].streamUsageReporting).toBe('openai_stream_options');
    }
  });

  it('does not send OpenAI stream usage options to native or Responses endpoints', () => {
    const endpointKeys = [
      'anthropic',
      'google',
      'gemini-subscription',
      'kiro',
      'openai-subscription',
      'openai-responses',
      'xai-responses',
      'copilot-responses',
      'commandcode-anthropic',
      'byteplus-anthropic',
      'minimax-subscription',
      'qwen-subscription-responses',
      'opencode-go-anthropic',
      'opencode-go-responses',
      'opencode-zen-google',
    ];

    for (const key of endpointKeys) {
      expect(PROVIDER_ENDPOINTS[key].streamUsageReporting).toBeUndefined();
    }
  });
});

describe('buildEndpointOverride', () => {
  it('creates endpoint using the template for a known key', () => {
    const ep = buildEndpointOverride(
      'https://custom.minimax.io/anthropic/v1',
      'minimax-subscription',
    );

    expect(ep.baseUrl).toBe('https://custom.minimax.io/anthropic/v1');
    expect(ep.format).toBe('anthropic');
    expect(ep.buildPath('model-x')).toBe('/messages');
  });

  it('throws when template key does not exist', () => {
    expect(() => buildEndpointOverride('https://example.com', 'nonexistent-template')).toThrow(
      'No provider endpoint template configured for: nonexistent-template',
    );
  });
});

describe('resolveSubscriptionEndpointKey', () => {
  it('returns gemini-subscription for google (the Gemini API-key endpoint key)', () => {
    expect(resolveSubscriptionEndpointKey('google')).toBe('gemini-subscription');
  });

  it('returns openai-subscription for openai', () => {
    expect(resolveSubscriptionEndpointKey('openai')).toBe('openai-subscription');
  });

  it('returns minimax-subscription for minimax', () => {
    expect(resolveSubscriptionEndpointKey('minimax')).toBe('minimax-subscription');
  });

  it('returns xiaomi-subscription for xiaomi', () => {
    expect(resolveSubscriptionEndpointKey('xiaomi')).toBe('xiaomi-subscription');
  });

  it('returns byteplus-anthropic for byteplus', () => {
    expect(resolveSubscriptionEndpointKey('byteplus')).toBe('byteplus-anthropic');
  });

  it('returns moonshot-subscription for moonshot', () => {
    expect(resolveSubscriptionEndpointKey('moonshot')).toBe('moonshot-subscription');
  });

  it('returns undefined for providers with no subscription override', () => {
    expect(resolveSubscriptionEndpointKey('anthropic')).toBeUndefined();
    expect(resolveSubscriptionEndpointKey('deepseek')).toBeUndefined();
    expect(resolveSubscriptionEndpointKey('unknown')).toBeUndefined();
  });
});

describe('gemini-subscription endpoint', () => {
  const ep = PROVIDER_ENDPOINTS['gemini-subscription'];

  it('exists in PROVIDER_ENDPOINTS', () => {
    expect(ep).toBeDefined();
  });

  it('uses the CodeAssist base URL', () => {
    expect(ep.baseUrl).toBe('https://cloudcode-pa.googleapis.com');
  });

  it('uses google format', () => {
    expect(ep.format).toBe('google');
  });

  it('has codeAssistEnvelope set to true', () => {
    expect(ep.codeAssistEnvelope).toBe(true);
  });

  it('buildHeaders returns Authorization: Bearer and Content-Type', () => {
    const headers = ep.buildHeaders('my-access-token');
    expect(headers['Authorization']).toBe('Bearer my-access-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('buildPath returns the non-streaming generateContent path', () => {
    expect(ep.buildPath('gemini-2.5-pro')).toBe('/v1internal:generateContent');
  });

  it('buildStreamPath returns the streamGenerateContent path', () => {
    expect(ep.buildStreamPath!('gemini-2.5-pro')).toBe('/v1internal:streamGenerateContent');
  });
});

describe('buildProviderExtraHeaders', () => {
  it('returns x-grok-conv-id for xai', () => {
    expect(buildProviderExtraHeaders('xai', 'sess-abc')).toEqual({
      'x-grok-conv-id': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
  });

  it('returns x-session-id for openrouter', () => {
    expect(buildProviderExtraHeaders('openrouter', 'ba44c58a-a1f5-4cc7-bc2a-9394d266cc2b')).toEqual(
      { 'x-session-id': expect.stringMatching(/^manifest-[a-f0-9]{32}$/) },
    );
  });

  it('does not create provider headers without an explicit cache key', () => {
    expect(buildProviderExtraHeaders('xai')).toBeUndefined();
    expect(buildProviderExtraHeaders('openrouter')).toBeUndefined();
  });

  it('is case-insensitive for provider name', () => {
    expect(buildProviderExtraHeaders('OpenRouter', 'sess-xyz')).toEqual({
      'x-session-id': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
  });

  it('returns undefined for providers with no extra headers', () => {
    expect(buildProviderExtraHeaders('anthropic', 'sess-abc')).toBeUndefined();
    expect(buildProviderExtraHeaders('openai', 'sess-abc')).toBeUndefined();
    expect(buildProviderExtraHeaders('unknown', 'sess-abc')).toBeUndefined();
  });

  it('returns x-opencode-session for opencode-go and opencode-zen', () => {
    expect(buildProviderExtraHeaders('opencode-go', 'v1:scoped-session')).toEqual({
      'x-opencode-session': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
    expect(buildProviderExtraHeaders('opencode-zen', 'v1:scoped-session')).toEqual({
      'x-opencode-session': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
  });

  it('resolves registry aliases (opencodego / opencodezen) to the canonical builder', () => {
    expect(buildProviderExtraHeaders('opencodego', 'v1:scoped-session')).toEqual({
      'x-opencode-session': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
    expect(buildProviderExtraHeaders('opencodezen', 'v1:scoped-session')).toEqual({
      'x-opencode-session': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
  });

  it('falls back to the agent scope key for opencode when no session key exists', () => {
    expect(buildProviderExtraHeaders('opencode-go', undefined, 'tenant-1\u0000agent-1')).toEqual({
      'x-opencode-session': expect.stringMatching(/^manifest-[a-f0-9]{32}$/),
    });
  });

  it('prefers the per-conversation key over the agent scope fallback', () => {
    const withSession = buildProviderExtraHeaders(
      'opencode-go',
      'v1:scoped-session',
      'tenant-1\u0000agent-1',
    );
    const fallbackOnly = buildProviderExtraHeaders(
      'opencode-go',
      undefined,
      'tenant-1\u0000agent-1',
    );
    expect(withSession!['x-opencode-session']).not.toBe(fallbackOnly!['x-opencode-session']);
    expect(withSession).toEqual(buildProviderExtraHeaders('opencode-go', 'v1:scoped-session'));
  });

  it('does not extend the agent scope fallback to xai or openrouter', () => {
    expect(buildProviderExtraHeaders('xai', undefined, 'tenant-1\u0000agent-1')).toBeUndefined();
    expect(
      buildProviderExtraHeaders('openrouter', undefined, 'tenant-1\u0000agent-1'),
    ).toBeUndefined();
  });

  it('returns undefined for opencode without any key', () => {
    expect(buildProviderExtraHeaders('opencode-go')).toBeUndefined();
    expect(buildProviderExtraHeaders('opencode-zen')).toBeUndefined();
  });
});
