import { ProviderModelFetcherService, PROVIDER_CONFIGS } from './provider-model-fetcher.service';
import { CODEX_CLI_VERSION } from '../common/constants/subscription-clients';

describe('ProviderModelFetcherService', () => {
  let service: ProviderModelFetcherService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new ProviderModelFetcherService();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /* ── PROVIDER_CONFIGS sanity ── */

  it('should have configs for all providers including subscription variants', () => {
    const expected = [
      'openai',
      'openai-subscription',
      'bedrock',
      'cerebras',
      'deepseek',
      'byteplus',
      'commandcode',
      'fireworks',
      'groq',
      'huggingface',
      'kilo',
      'mistral',
      'mistral-subscription',
      'moonshot',
      'pioneer',
      'nous',
      'nvidia',
      'xai',
      'minimax',
      'meta',
      'minimax-subscription',
      'xiaomi',
      'xiaomi-subscription',
      'qwen',
      'zai',
      'zai-subscription',
      'anthropic',
      'atria',
      'gemini',
      'openrouter',
      'gemini-free',
      'ollama',
      'ollama-cloud',
      'copilot',
      'opencode-zen',
    ];
    for (const id of expected) {
      expect(PROVIDER_CONFIGS[id]).toBeDefined();
    }
  });

  it('discovers only Gemini models from the Gemini Free LiteLLM catalog', async () => {
    process.env['CREDITS_BASE_URL'] = 'https://credits.test';
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-5' },
          { id: 'gemini-2.5-flash' },
          { id: 'gemini/gemini-2.5-flash' },
          { id: 'gemini/gemini-2.5-pro' },
          { id: 'gemini/*' },
        ],
      }),
    });

    const result = await service.fetch('gemini-free', 'sk-virtual');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://credits.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-virtual',
        }),
      }),
    );
    expect(result.map((model) => model.id)).toEqual([
      'gemini/gemini-2.5-flash',
      'gemini/gemini-2.5-pro',
    ]);
  });

  describe('huggingface provider', () => {
    it('discovers chat models using the fastest live provider metadata', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'Qwen/Qwen3-Coder',
              architecture: {
                input_modalities: ['text', 'image', 'unknown'],
                output_modalities: ['text'],
              },
              providers: [
                {
                  provider: 'slow-provider',
                  status: 'live',
                  context_length: 128000,
                  pricing: { input: 0.2, output: 0.8 },
                  supports_tools: false,
                  throughput: 20,
                },
                {
                  provider: 'fast-provider',
                  status: 'live',
                  context_length: 262144,
                  pricing: { input: 0.5, output: 1.5 },
                  supports_tools: true,
                  throughput: 80,
                },
              ],
            },
            {
              id: 'unavailable/model',
              providers: [{ provider: 'down', status: 'error' }],
            },
          ],
        }),
      });

      const result = await service.fetch('huggingface', 'hf_test_token');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://router.huggingface.co/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer hf_test_token' },
        }),
      );
      expect(result).toEqual([
        expect.objectContaining({
          id: 'Qwen/Qwen3-Coder',
          provider: 'huggingface',
          contextWindow: 262144,
          inputPricePerToken: 0.5 / 1_000_000,
          outputPricePerToken: 1.5 / 1_000_000,
          capabilityCode: true,
          capabilities: ['text', 'image', 'stream', 'tools'],
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
        }),
      ]);
    });

    it('uses safe defaults when optional provider metadata is absent', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'openai/gpt-oss-120b', providers: [{ status: 'live' }] }],
        }),
      });

      const result = await service.fetch('huggingface', 'hf_test_token');

      expect(result[0]).toMatchObject({
        contextWindow: 128000,
        inputPricePerToken: null,
        outputPricePerToken: null,
        capabilityCode: false,
        capabilities: ['stream'],
      });
    });

    it('ignores malformed model and provider metadata', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 42, providers: [] },
            { id: '', providers: [] },
            { id: 'missing-provider-array', providers: {} },
            {
              id: 'mixed/metadata',
              architecture: {
                input_modalities: ['text', 42],
                output_modalities: [],
              },
              providers: [
                null,
                { status: 'live', throughput: 'unknown' },
                { status: 'live', throughput: 10 },
                { status: 'live' },
              ],
            },
          ],
        }),
      });

      const result = await service.fetch('huggingface', 'hf_test_token');

      expect(result).toEqual([
        expect.objectContaining({
          id: 'mixed/metadata',
          capabilities: ['text', 'stream'],
          inputModalities: ['text'],
        }),
      ]);
      expect(result[0]).not.toHaveProperty('outputModalities');
    });

    it('returns no models when the catalog data is malformed', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await expect(service.fetch('huggingface', 'hf_test_token')).resolves.toEqual([]);
    });
  });

  it('should fetch AWS Bedrock models from the selected Mantle region', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'mistral.ministral-3-8b-instruct' },
          { id: 'mistral.voxtral-small-24b-2507' },
          { id: 'amazon.titan-embed-text-v2:0' },
        ],
      }),
    });

    const result = await service.fetch(
      'bedrock',
      'bedrock-api-key-test',
      'api_key',
      'https://bedrock-mantle.eu-west-1.api.aws',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bedrock-mantle.eu-west-1.api.aws/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer bedrock-api-key-test',
        }),
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['mistral.ministral-3-8b-instruct']);
  });

  it('should fetch Cerebras models from the OpenAI-compatible models endpoint', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-oss-120b' }, { id: 'zai-glm-4.7' }, { id: 'text-embedding-test' }],
      }),
    });

    const result = await service.fetch('cerebras', 'cerebras-api-key');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.cerebras.ai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer cerebras-api-key' },
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['gpt-oss-120b', 'zai-glm-4.7']);
    expect(result[0]).toMatchObject({
      provider: 'cerebras',
      contextWindow: 128000,
      inputPricePerToken: null,
      outputPricePerToken: null,
    });
  });

  it('should fetch Atria Dawn Preview from the Atria OpenAI-compatible models endpoint', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'Atria-Dawn-Preview' }, { id: 'unverified-atria-model' }],
      }),
    });

    const result = await service.fetch('atria', 'atr_test_key');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.atria-asi.ai/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer atr_test_key' },
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'Atria-Dawn-Preview',
        displayName: 'Atria-Dawn-Preview',
        provider: 'atria',
        contextWindow: 262144,
        capabilityCode: true,
        inputPricePerToken: null,
        outputPricePerToken: null,
      }),
    ]);
  });

  it('should fetch Pioneer models from the OpenAI-compatible models endpoint', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'pioneer/auto', display_name: 'Pioneer Auto' },
            {
              id: 'claude-sonnet-4-6',
              display_name: 'Claude Sonnet 4.6',
              context_length: 1000000,
            },
            { id: 'fastino/gliner2-base-v1', display_name: 'GLiNER2 Base' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              id: 'claude-sonnet-4-6',
              label: 'Claude Sonnet 4.6',
              context_window: 1000000,
              input_price_per_million: 3,
              output_price_per_million: 15,
              supports_image_input: true,
            },
            {
              id: 'fastino/gliner2-base-v1',
              label: 'GLiNER2 Base',
              input_price_per_million: 0.15,
              output_price_per_million: 0.15,
            },
          ],
        }),
      });

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.pioneer.ai/v1/models',
      expect.objectContaining({
        headers: { 'X-API-Key': 'pio_sk_test_key' },
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.pioneer.ai/base-models',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.map((m) => m.id)).toEqual(['pioneer/auto', 'claude-sonnet-4-6']);
    expect(result[0]).toMatchObject({
      provider: 'pioneer',
      displayName: 'Pioneer Auto',
      contextWindow: 128000,
      inputPricePerToken: null,
      outputPricePerToken: null,
    });
    expect(result[1]).toMatchObject({
      displayName: 'Claude Sonnet 4.6',
      contextWindow: 1000000,
      inputPricePerToken: 3 / 1_000_000,
      outputPricePerToken: 15 / 1_000_000,
      inputModalities: ['text', 'image'],
    });
  });

  it('should keep Pioneer model discovery when the pricing catalog is unavailable', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o', display_name: 'GPT-4o' }],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      inputPricePerToken: null,
      outputPricePerToken: null,
    });
  });

  it('should keep Pioneer model discovery when the pricing catalog fetch fails', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o', display_name: 'GPT-4o' }],
        }),
      })
      .mockRejectedValueOnce(new Error('catalog down'));

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      inputPricePerToken: null,
      outputPricePerToken: null,
    });
  });

  it('should keep Pioneer model discovery when the pricing catalog is malformed', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: 'not-array' }),
      });

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gpt-4o',
      displayName: 'gpt-4o',
      inputPricePerToken: null,
      outputPricePerToken: null,
    });
  });

  it('should ignore invalid Pioneer pricing rows and invalid prices', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'bare-model' },
            { id: 'invalid-prices', display_name: 'Invalid Prices', context_length: 64000 },
            { id: 'label-fallback', display_name: 'Label Fallback', context_length: 32000 },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { id: '' },
            { id: 123 },
            {
              id: 'invalid-prices',
              label: 'Invalid Prices',
              input_price_per_million: -1,
              output_price_per_million: Number.POSITIVE_INFINITY,
              is_chat_model: false,
            },
            {
              id: 'label-fallback',
              label: '',
              context_window: undefined,
              input_price_per_million: null,
              output_price_per_million: undefined,
              supports_image_input: false,
            },
          ],
        }),
      });

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(result.map((m) => m.id)).toEqual(['bare-model', 'invalid-prices', 'label-fallback']);
    expect(result[0]).toMatchObject({
      displayName: 'bare-model',
      contextWindow: 128000,
    });
    expect(result[1]).toMatchObject({
      displayName: 'Invalid Prices',
      contextWindow: 64000,
      inputPricePerToken: null,
      outputPricePerToken: null,
      capabilityCode: false,
    });
    expect(result[2]).toMatchObject({
      displayName: 'Label Fallback',
      contextWindow: 32000,
      inputPricePerToken: null,
      outputPricePerToken: null,
    });
    expect(result[2].inputModalities).toBeUndefined();
  });

  it('should return [] when Pioneer model discovery is unavailable', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should return [] when Pioneer model discovery throws', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('pioneer down'));

    const result = await service.fetch('pioneer', 'pio_sk_test_key');

    expect(result).toEqual([]);
  });

  /* ── Unknown provider ── */

  it('should return [] for unknown provider', async () => {
    const result = await service.fetch('nonexistent', 'key123');
    expect(result).toEqual([]);
  });

  /* ── Network error ── */

  it('should return [] on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('network failure'));
    const result = await service.fetch('openai', 'key123');
    expect(result).toEqual([]);
  });

  it('should return [] on non-Error throw', async () => {
    fetchSpy.mockRejectedValue('string error');
    const result = await service.fetch('openai', 'key123');
    expect(result).toEqual([]);
  });

  /* ── Non-OK response ── */

  it('should return [] when response is not ok', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });
    const result = await service.fetch('openai', 'key123');
    expect(result).toEqual([]);
  });

  /* ── Timeout handling ── */

  it('should abort on timeout', async () => {
    fetchSpy.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    jest.useFakeTimers();
    const promise = service.fetch('openai', 'key123');
    jest.advanceTimersByTime(6000);
    const result = await promise;
    expect(result).toEqual([]);
    jest.useRealTimers();
  });

  /* ── OpenAI parser (used by openai, deepseek, mistral, etc.) ── */

  describe('parseOpenAI (via openai provider)', () => {
    it('should parse valid OpenAI response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
            { id: 'gpt-3.5-turbo', object: 'model' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'gpt-4o',
          displayName: 'gpt-4o',
          provider: 'openai',
          contextWindow: 128000,
          inputPricePerToken: null,
          outputPricePerToken: null,
          qualityScore: 3,
        }),
      );
    });

    it('should filter out entries without string id', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: '', object: 'model' },
            { id: 123, object: 'model' },
            { object: 'model' },
            { id: 'valid-model' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid-model');
    });

    it('should return [] when data is not an array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: 'not-array' }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toEqual([]);
    });

    it('should return [] when data is missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toEqual([]);
    });

    it('should filter out non-chat OpenAI models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o' },
            { id: 'gpt-4.1' },
            { id: 'text-embedding-3-small' },
            { id: 'tts-1' },
            { id: 'tts-1-hd' },
            { id: 'whisper-1' },
            { id: 'dall-e-3' },
            { id: 'text-moderation-latest' },
            { id: 'gpt-3.5-turbo-instruct' },
            { id: 'davinci-002' },
            { id: 'babbage-002' },
            { id: 'sora-2' },
            { id: 'sora-2-pro' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4.1']);
    });

    it('should keep GPT-5.6 models returned by OpenAI', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-5.6-sol', object: 'model', created: 1782228018, owned_by: 'system' },
            { id: 'gpt-5.6-terra', object: 'model', created: 1782228459, owned_by: 'system' },
            { id: 'gpt-5.6-luna', object: 'model', created: 1782228658, owned_by: 'system' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');

      expect(result.map((model) => model.id)).toEqual([
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ]);
    });

    it('should keep Responses-only chat models (Codex/-pro/o1-pro/deep-research) so the proxy can route them to /v1/responses', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-5-chat-latest' },
            { id: 'gpt-5-codex' },
            { id: 'gpt-5-pro' },
            { id: 'gpt-5.1-codex' },
            { id: 'gpt-5.1-codex-mini' },
            { id: 'gpt-5.2-codex' },
            { id: 'gpt-5.2-pro' },
            { id: 'gpt-5.4-pro' },
            { id: 'gpt-5.3-codex' },
            { id: 'codex-mini-latest' },
            { id: 'gpt-image-1' },
            { id: 'gpt-image-1-mini' },
            { id: 'gpt-image-1.5' },
            { id: 'o1-pro' },
            { id: 'o4-mini-deep-research' },
            { id: 'o3' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      // Image-gen is not chat and stays filtered; everything else passes through
      // so the proxy can swap to openai-responses at forward time.
      expect(result.map((m) => m.id)).toEqual([
        'gpt-5-chat-latest',
        'gpt-5-codex',
        'gpt-5-pro',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.2-codex',
        'gpt-5.2-pro',
        'gpt-5.4-pro',
        'gpt-5.3-codex',
        'codex-mini-latest',
        'o1-pro',
        'o4-mini-deep-research',
        'o3',
      ]);
    });

    it('should drop image-generation models from discovery (not chat-compatible)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-image-1' },
            { id: 'gpt-image-1-mini' },
            { id: 'gpt-image-1.5' },
            { id: 'gpt-image-2' },
            { id: 'gpt-4o' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    it('should not filter non-OpenAI providers with similar model names', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        }),
      });

      // DeepSeek uses the generic parseOpenAI (no filtering)
      const result = await service.fetch('deepseek', 'sk-test');
      expect(result).toHaveLength(2);
    });

    it('should keep both codex-mini-latest (chat-compatible) and Responses-only Codex variants (routed at proxy time)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'codex-mini-latest' }, { id: 'gpt-5-codex' }],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result.map((m) => m.id)).toEqual(['codex-mini-latest', 'gpt-5-codex']);
    });

    it('should deduplicate dated snapshots when alias exists', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4o-mini-2024-07-18' },
            { id: 'gpt-4o' },
            { id: 'gpt-4o-2024-08-06' },
            { id: 'o3-mini-2025-01-31' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      // Dated snapshots removed when alias exists; o3-mini-2025-01-31 kept (no alias)
      expect(result.map((m) => m.id)).toEqual(['gpt-4o-mini', 'gpt-4o', 'o3-mini-2025-01-31']);
    });
  });

  /* ── xAI provider ── */

  describe('xai provider', () => {
    it('uses the dynamic xAI models endpoint for subscription auth', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'grok-3' }, { id: 'grok-4' }],
        }),
      });

      const result = await service.fetch('xai', 'xai-test-key', 'subscription');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.x.ai/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer xai-test-key' },
        }),
      );
      expect(result.map((m) => m.id)).toEqual(['grok-3', 'grok-4']);
      expect(result.every((m) => m.provider === 'xai')).toBe(true);
    });
  });

  describe('meta provider', () => {
    it('discovers only current Muse Spark models with their native capabilities', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'muse-spark-1.2' },
            { id: 'muse-spark-1.2-contributor' },
            { id: 'muse-spark-1.1' },
            { id: 'retired-or-unrelated-model' },
          ],
        }),
      });

      const result = await service.fetch('meta', 'LLM_test-meta-key-value');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.meta.ai/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer LLM_test-meta-key-value' },
        }),
      );
      expect(result.map((model) => model.id)).toEqual([
        'muse-spark-1.2',
        'muse-spark-1.2-contributor',
        'muse-spark-1.1',
      ]);
      expect(result[1]).toMatchObject({
        displayName: 'Muse Spark 1.2 Contributor (inputs and outputs may train Meta)',
        provider: 'meta',
        contextWindow: 1_048_576,
        capabilityReasoning: true,
        capabilityCode: true,
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
      });
    });
  });

  /* ── Fireworks provider ── */

  describe('fireworks provider', () => {
    it('fetches serverless models from the Fireworks account API with pagination', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [
              {
                name: 'accounts/fireworks/models/deepseek-v3p1',
                displayName: 'DeepSeek V3.1',
                contextLength: 160000,
                supportsServerless: true,
                supportsTools: true,
              },
            ],
            nextPageToken: 'page-2',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [
              {
                name: 'accounts/fireworks/models/flux-1-schnell',
                displayName: 'FLUX.1 schnell',
                contextLength: 4096,
                supportsServerless: true,
              },
              {
                name: 'accounts/fireworks/models/kimi-k2-instruct',
                displayName: 'Kimi K2',
                supportsServerless: true,
                supportsTools: false,
              },
            ],
          }),
        });

      const result = await service.fetch('fireworks', 'fw-test-key');

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200',
        expect.objectContaining({
          headers: { Authorization: 'Bearer fw-test-key' },
        }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200&pageToken=page-2',
        expect.objectContaining({
          headers: { Authorization: 'Bearer fw-test-key' },
        }),
      );
      expect(result.map((m) => m.id)).toEqual([
        'accounts/fireworks/models/deepseek-v3p1',
        'accounts/fireworks/models/kimi-k2-instruct',
      ]);
      expect(result[0]).toEqual(
        expect.objectContaining({
          displayName: 'DeepSeek V3.1',
          contextWindow: 160000,
          provider: 'fireworks',
          capabilityCode: true,
        }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({
          displayName: 'Kimi K2',
          contextWindow: 128000,
          provider: 'fireworks',
          capabilityCode: false,
        }),
      );
    });

    it('stops pagination when Fireworks repeats a page token', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: 'accounts/fireworks/models/chat-a', supportsServerless: true }],
            nextPageToken: 'page-2',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [{ name: 'accounts/fireworks/models/chat-b', supportsServerless: true }],
            nextPageToken: 'page-2',
          }),
        });

      const result = await service.fetch('fireworks', 'fw-test-key');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.map((m) => m.id)).toEqual([
        'accounts/fireworks/models/chat-a',
        'accounts/fireworks/models/chat-b',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Stopping Fireworks model pagination after repeated token page-2',
      );

      warnSpy.mockRestore();
    });

    it('caps Fireworks pagination when unique page tokens never stop', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      Array.from({ length: 25 }, (_, index) => {
        fetchSpy.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            models: [
              {
                name: `accounts/fireworks/models/chat-${index}`,
                supportsServerless: true,
              },
            ],
            nextPageToken: `page-${index + 1}`,
          }),
        });
      });

      const result = await service.fetch('fireworks', 'fw-test-key');

      expect(fetchSpy).toHaveBeenCalledTimes(20);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        'https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200&pageToken=page-19',
        expect.objectContaining({
          headers: { Authorization: 'Bearer fw-test-key' },
        }),
      );
      expect(result).toHaveLength(20);
      expect(warnSpy).toHaveBeenCalledWith('Stopping Fireworks model pagination after 20 pages');

      warnSpy.mockRestore();
    });
  });

  /* ── Mistral-specific filter ── */

  describe('parseMistralChatOnly (via mistral provider)', () => {
    it('should filter out OCR models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-large-latest' },
            { id: 'mistral-ocr-2512' },
            { id: 'mistral-ocr-latest' },
            { id: 'mistral-ocr-2503' },
            { id: 'codestral-latest' },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest', 'codestral-latest']);
    });

    it('should keep all regular Mistral chat models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-medium-latest' },
            { id: 'magistral-small-latest' },
            { id: 'devstral-medium-2507' },
            { id: 'voxtral-small-latest' },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(4);
    });
  });

  /* ── Mistral metadata filtering ── */

  describe('parseMistral metadata filtering', () => {
    it('should filter out models with deprecation set', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
            { id: 'old-model', capabilities: { completion_chat: true }, deprecation: '2025-12-01' },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('should filter out models without completion_chat capability', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
            { id: 'mistral-ocr-2503', capabilities: { completion_chat: false } },
            { id: 'labs-leanstral-2603', capabilities: { completion_chat: false } },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('should keep models when capabilities field is absent', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'mistral-large-latest' }, { id: 'codestral-latest' }],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(2);
    });

    it('should keep models when completion_chat is true', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
            {
              id: 'codestral-latest',
              capabilities: { completion_chat: true, completion_fim: true },
            },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(2);
    });

    it('should filter by both metadata and regex patterns', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
            {
              id: 'deprecated-model',
              capabilities: { completion_chat: true },
              deprecation: '2025-06-01',
            },
            { id: 'labs-experimental', capabilities: { completion_chat: true } },
            { id: 'voxtral-mini-2602', capabilities: { completion_chat: true } },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      // deprecated-model filtered by metadata, labs-experimental by regex, voxtral-mini-2602 by blocklist
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });
  });

  /* ── Nous Portal subscription routing ── */

  it('should fetch Nous Portal models from its OpenAI-compatible catalog', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-4.5',
            name: 'Anthropic: Claude Sonnet 4.5',
            context_length: 200000,
            architecture: { output_modalities: ['text'] },
            pricing: { prompt: '0.000003', completion: '0.000015' },
          },
          {
            id: 'google/gemini-3-pro-image',
            name: 'Google: Gemini 3 Pro Image',
            architecture: { output_modalities: ['image', 'text'] },
          },
        ],
      }),
    });

    const result = await service.fetch('nous', 'nous-api-key', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://inference-api.nousresearch.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer nous-api-key' },
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 'anthropic/claude-sonnet-4.5',
        displayName: 'Anthropic: Claude Sonnet 4.5',
        provider: 'nous',
        contextWindow: 200000,
        inputPricePerToken: 0.000003,
        outputPricePerToken: 0.000015,
      }),
    ]);
  });

  /* ── Z.ai subscription routing ── */

  it('should fetch BytePlus ModelArk Coding Plan models with Bearer auth', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'ark-code-latest' },
          { id: 'deepseek-v4-flash' },
          { id: 'seedream-3-0-t2i-250415' },
        ],
      }),
    });

    const result = await service.fetch('byteplus', 'bp-sub-key', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://ark.ap-southeast.bytepluses.com/api/coding/v3/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer bp-sub-key' }),
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['ark-code-latest', 'deepseek-v4-flash']);
    expect(result.every((m) => m.provider === 'byteplus')).toBe(true);
  });

  it('should return glm-5.1 from zai models (no longer blocklisted)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'glm-4.5' }, { id: 'glm-5' }, { id: 'glm-5.1' }],
      }),
    });

    const result = await service.fetch('zai', 'key');
    expect(result.map((m) => m.id)).toEqual(['glm-4.5', 'glm-5', 'glm-5.1']);
  });

  it('should route zai+subscription to Coding Plan models endpoint', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.1' }, { id: 'glm-4.7' }] }),
    });

    const result = await service.fetch('zai', 'zai-sub-key', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.z.ai/api/coding/paas/v4/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer zai-sub-key' }),
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['glm-5.1', 'glm-4.7']);
  });

  it('should route zai+subscription endpoint override to selected Coding Plan models endpoint', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.1' }] }),
    });

    await service.fetch(
      'zai',
      'zai-sub-key',
      'subscription',
      'https://open.bigmodel.cn/api/coding/paas/v4',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/coding/paas/v4/models',
      expect.any(Object),
    );
  });

  it('should route zai+api_key to standard models endpoint', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-4.7' }] }),
    });

    await service.fetch('zai', 'zai-key');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/models',
      expect.any(Object),
    );
  });

  /* ── Qwen Token Plan subscription routing ── */

  it('should fetch Qwen Token Plan models and filter image-only models', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'qwen3.6-plus', object: 'model' },
          { id: 'qwen-image-2.0', object: 'model' },
          { id: 'wan2.7-image-pro', object: 'model' },
          { id: 'deepseek-v4-pro', object: 'model' },
        ],
      }),
    });

    const result = await service.fetch('qwen', 'sk-sp-token-plan-key', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-sp-token-plan-key' },
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['qwen3.6-plus', 'deepseek-v4-pro']);
    expect(result[0]).toMatchObject({
      contextWindow: 991000,
      inputPricePerToken: 0,
      outputPricePerToken: 0,
    });
  });

  it('should apply endpoint override for Qwen Token Plan subscription discovery', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch(
      'qwen',
      'sk-sp-token-plan-key',
      'subscription',
      'https://dashscope-intl.aliyuncs.com/compatible-mode',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-sp-token-plan-key' },
      }),
    );
  });

  /* ── Xiaomi MiMo Token Plan subscription routing ── */

  it('should fetch Xiaomi MiMo API-key models and filter media-only models', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'mimo-v2.5-pro' },
          { id: 'mimo-v2.5' },
          { id: 'mimo-v2.5-asr-preview' },
          { id: 'mimo-v2.5-tts-preview' },
          { id: 'not-mimo-chat' },
        ],
      }),
    });

    const result = await service.fetch('xiaomi', 'sk-mimo-test');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.xiaomimimo.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-mimo-test' },
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['mimo-v2.5-pro', 'mimo-v2.5']);
    expect(result[0]).toMatchObject({
      provider: 'xiaomi',
      contextWindow: 1048576,
      inputPricePerToken: null,
      outputPricePerToken: null,
      capabilityCode: true,
    });
  });

  it('should route Xiaomi subscription discovery to the default Token Plan models endpoint', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'mimo-v2.5-pro' }, { id: 'mimo-v2-flash' }],
      }),
    });

    const result = await service.fetch('xiaomi', 'tp-mimo-token', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://token-plan-cn.xiaomimimo.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tp-mimo-token' },
      }),
    );
    expect(result.map((m) => m.id)).toEqual(['mimo-v2.5-pro', 'mimo-v2-flash']);
    expect(result[1].contextWindow).toBe(262144);
  });

  it('should apply endpoint override for Xiaomi MiMo Token Plan subscription discovery', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch(
      'xiaomi',
      'tp-mimo-token',
      'subscription',
      'https://token-plan-ams.xiaomimimo.com',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://token-plan-ams.xiaomimimo.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tp-mimo-token' },
      }),
    );
  });

  /* ── Kimi Coding Plan subscription routing ── */

  it('should skip live model fetching for moonshot subscription auth', async () => {
    const result = await service.fetch('moonshot', 'kimi-code-key', 'subscription');

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /* ── Kiro subscription provider ── */

  it('should fetch Kiro models dynamically through the Kiro model-list operation', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              model_id: 'auto',
              model_name: 'auto',
              context_window_tokens: 1000000,
            },
          ],
          nextToken: 'next-page',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              modelId: 'claude-sonnet-4.5',
              modelName: 'Claude Sonnet 4.5',
              tokenLimits: { maxInputTokens: 200000 },
            },
          ],
        }),
      });

    const result = await service.fetch('kiro', 'ksk_test', 'subscription');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://q.us-east-1.amazonaws.com',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer ksk_test',
          'Content-Type': 'application/x-amz-json-1.0',
          'x-amz-target': 'AmazonCodeWhispererService.ListAvailableModels',
        },
      }),
    );
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      origin: 'KIRO_CLI',
      maxResults: 100,
    });
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
      origin: 'KIRO_CLI',
      maxResults: 100,
      nextToken: 'next-page',
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: 'kiro/auto',
        displayName: 'auto',
        provider: 'kiro',
        contextWindow: 1000000,
        inputPricePerToken: 0,
        outputPricePerToken: 0,
        capabilityCode: true,
      }),
      expect.objectContaining({
        id: 'kiro/claude-sonnet-4.5',
        displayName: 'Claude Sonnet 4.5',
        contextWindow: 200000,
      }),
    ]);
  });

  it('should return [] when Kiro model discovery rejects the API key', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
    });

    const result = await service.fetch('kiro', 'ksk_bad', 'subscription');

    expect(result).toEqual([]);
  });

  it('should clear the Kiro model discovery timeout when fetch rejects', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    fetchSpy.mockRejectedValue(new Error('network failure'));

    const result = await service.fetch('kiro', 'ksk_test', 'subscription');

    expect(result).toEqual([]);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  /* ── Groq provider ── */

  describe('groq provider', () => {
    it('should parse Groq models and filter non-chat entries', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'llama-3.3-70b-versatile' },
            { id: 'llama-3.1-8b-instant' },
            { id: 'whisper-large-v3' },
            { id: 'whisper-large-v3-turbo' },
            { id: 'meta-llama/llama-prompt-guard-2-86m' },
            { id: 'openai/gpt-oss-20b' },
            { id: 'openai/gpt-oss-safeguard-20b' },
            { id: 'compound-beta' },
            { id: 'compound-mini' },
            { id: 'groq/compound' },
            { id: 'groq/compound-mini' },
            { id: 'canopylabs/orpheus-v1-english' },
          ],
        }),
      });

      const result = await service.fetch('groq', 'gsk_test');
      // whisper filtered by universal filter; prompt-guard, orpheus and
      // every compound variant (start-of-string, slash-prefixed, hyphen-
      // prefixed) filtered by groq-specific filter. gpt-oss-safeguard-20b
      // is a real chat model and must NOT be filtered.
      expect(result.map((m) => m.id)).toEqual([
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'openai/gpt-oss-20b',
        'openai/gpt-oss-safeguard-20b',
      ]);
    });

    it('should hit the Groq models endpoint with bearer auth', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await service.fetch('groq', 'gsk_test_key');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer gsk_test_key' },
        }),
      );
    });
  });

  describe('kilo provider', () => {
    it('fetches the public Kilo Gateway model catalog with bearer auth', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'kilo-auto/frontier',
              name: 'Auto Frontier',
              context_length: 1000000,
              pricing: { prompt: '0.000005', completion: '0.000025' },
              supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'],
              architecture: { output_modalities: ['text'] },
            },
            {
              id: 'anthropic/claude-sonnet-4.5',
              name: 'Claude Sonnet 4.5',
              top_provider: { context_length: 200000 },
              supported_parameters: ['max_tokens', 'tools'],
              architecture: { output_modalities: ['text'] },
            },
          ],
        }),
      });

      const result = await service.fetch('kilo', 'kilo-token');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.kilo.ai/api/gateway/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer kilo-token' },
        }),
      );
      expect(result).toEqual([
        expect.objectContaining({
          id: 'kilo-auto/frontier',
          displayName: 'Auto Frontier',
          provider: 'kilo',
          contextWindow: 1000000,
          inputPricePerToken: 0.000005,
          outputPricePerToken: 0.000025,
          capabilityReasoning: true,
          capabilityCode: true,
        }),
        expect.objectContaining({
          id: 'anthropic/claude-sonnet-4.5',
          displayName: 'Claude Sonnet 4.5',
          provider: 'kilo',
          contextWindow: 200000,
          capabilityReasoning: false,
          capabilityCode: true,
        }),
      ]);
    });

    it('filters non-text output models from the Kilo catalog', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'openai/gpt-5.4', architecture: { output_modalities: ['text'] } },
            { id: 'openai/gpt-image-2', architecture: { output_modalities: ['image'] } },
          ],
        }),
      });

      const result = await service.fetch('kilo', 'kilo-token');

      expect(result.map((m) => m.id)).toEqual(['openai/gpt-5.4']);
    });

    it('returns [] when the Kilo catalog data field is missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await service.fetch('kilo', 'kilo-token');

      expect(result).toEqual([]);
    });
  });

  /* ── NVIDIA NIM provider ── */

  describe('nvidia provider', () => {
    it('should hit the hosted NVIDIA NIM models endpoint with bearer auth', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await service.fetch('nvidia', 'nvapi-test-key');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://integrate.api.nvidia.com/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer nvapi-test-key' },
        }),
      );
    });

    it('should deduplicate models and filter non-chat NIM catalog entries', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'deepseek-ai/deepseek-v4-pro' },
            { id: 'deepseek-ai/deepseek-v4-pro' },
            { id: 'nvidia/nemotron-3-super-120b-a12b' },
            { id: 'openai/gpt-oss-20b' },
            { id: 'nvidia/embed-qa-4' },
            { id: 'black-forest-labs/flux_1-schnell' },
            { id: 'nvidia/ai-synthetic-video-detector' },
            { id: 'nvidia/nemotron-4-340b-reward' },
            { id: 'nvidia/llama-3.1-nemoguard-8b-content-safety' },
          ],
        }),
      });

      const result = await service.fetch('nvidia', 'nvapi-test-key');
      expect(result.map((m) => m.id)).toEqual([
        'deepseek-ai/deepseek-v4-pro',
        'nvidia/nemotron-3-super-120b-a12b',
        'openai/gpt-oss-20b',
      ]);
      expect(result.every((m) => m.provider === 'nvidia')).toBe(true);
    });
  });

  /* ── OpenAI-compatible providers use same parser ── */

  it('should work for deepseek provider', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'deepseek-chat' }] }),
    });

    const result = await service.fetch('deepseek', 'key');
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('deepseek');
  });

  /* ── Bearer auth header ── */

  it('should send bearer auth header for openai', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch('openai', 'sk-abc');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-abc' },
      }),
    );
  });

  it('should use the endpoint override for MiniMax subscription discovery', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch('minimax', 'sk-test', 'subscription', 'https://api.minimaxi.com/anthropic');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.minimaxi.com/anthropic/v1/models?limit=100',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer sk-test',
          'anthropic-version': '2023-06-01',
        },
      }),
    );
  });

  it('should ignore invalid endpoint overrides for MiniMax subscription discovery', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch('minimax', 'sk-test', 'subscription', 'http://127.0.0.1:8080/anthropic');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.minimax.io/anthropic/v1/models?limit=100',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer sk-test',
          'anthropic-version': '2023-06-01',
        },
      }),
    );
  });

  it('should use the endpoint override for Qwen discovery', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch(
      'qwen',
      'sk-qwen',
      'api_key',
      'https://dashscope-intl.aliyuncs.com/compatible-mode',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-qwen' },
      }),
    );
  });

  it('warns and ignores an invalid Qwen endpoint override', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    // `not a url` is rejected by normalizeQwenCompatibleBaseUrl → the fetcher
    // logs a warning and falls back to the default Qwen URL.
    await service.fetch('qwen', 'sk-qwen', 'api_key', 'not a url');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid Qwen endpoint override'),
    );
    // Default Qwen endpoint should still be hit (no override applied).
    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain('not a url');
    expect(calledUrl).toMatch(/^https:\/\//);
    warnSpy.mockRestore();
  });

  it('fetches Qwen models from an Alibaba Model Studio compatible-mode base URL', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch(
      'qwen',
      'sk-qwen',
      'api_key',
      'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-qwen' },
      }),
    );
  });

  /* ── Anthropic provider ── */

  describe('parseAnthropic (via anthropic provider)', () => {
    it('should parse valid Anthropic response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-3-opus', display_name: 'Claude 3 Opus', type: 'model' },
            { id: 'claude-3-sonnet', type: 'model' },
          ],
        }),
      });

      const result = await service.fetch('anthropic', 'sk-ant-test');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'claude-3-opus',
          displayName: 'Claude 3 Opus',
          provider: 'anthropic',
          contextWindow: 200000,
        }),
      );
      expect(result[1].displayName).toBe('claude-3-sonnet');
    });

    it('should filter out entries without type=model', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-3-opus', type: 'model' },
            { id: 'not-a-model', type: 'other' },
            { id: 'no-type' },
          ],
        }),
      });

      const result = await service.fetch('anthropic', 'sk-ant-test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('claude-3-opus');
    });

    it('should return [] when data is not array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: null }),
      });

      const result = await service.fetch('anthropic', 'key');
      expect(result).toEqual([]);
    });

    it('should send x-api-key header for api_key auth', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await service.fetch('anthropic', 'sk-ant-test');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'anthropic-version': '2023-06-01',
            'x-api-key': 'sk-ant-test',
          }),
        }),
      );
    });

    it('should send Claude Code-shaped bearer headers for subscription auth', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await service.fetch('anthropic', 'token', 'subscription');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'anthropic-version': '2023-06-01',
            Authorization: 'Bearer token',
            'anthropic-beta': expect.stringContaining('claude-code-20250219'),
            'anthropic-dangerous-direct-browser-access': 'true',
            'user-agent': expect.stringContaining('claude-cli/'),
            'x-app': 'cli',
          }),
        }),
      );
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    });
  });

  /* ── Gemini provider ── */

  describe('parseGemini (via gemini provider)', () => {
    it('should parse valid Gemini response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: ['generateContent'],
              inputTokenLimit: 1000000,
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'gemini-key');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          provider: 'gemini',
          contextWindow: 1000000,
        }),
      );
    });

    it('should use id as displayName when displayName missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-flash',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      expect(result[0].displayName).toBe('gemini-flash');
    });

    it('should default contextWindow to 1000000 when inputTokenLimit missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-test',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      expect(result[0].contextWindow).toBe(1000000);
    });

    it('should filter out models without generateContent', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-pro',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/embedding-001',
              supportedGenerationMethods: ['embedContent'],
            },
            {
              name: 'models/no-methods',
            },
            {
              name: 123,
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gemini-pro');
    });

    it('should return [] when models is not array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: 'wrong' }),
      });

      const result = await service.fetch('gemini', 'key');
      expect(result).toEqual([]);
    });

    it('should deduplicate versioned models when alias exists', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.0-flash',
              displayName: 'Gemini 2.0 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-2.0-flash-001',
              displayName: 'Gemini 2.0 Flash 001',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      // gemini-2.0-flash-001 should be dropped because gemini-2.0-flash exists
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['gemini-2.0-flash', 'gemini-2.5-pro']);
    });

    it('should keep versioned model when alias does not exist', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.0-flash-001',
              displayName: 'Gemini 2.0 Flash 001',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gemini-2.0-flash-001');
    });

    it('should embed key in URL and send no headers', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await service.fetch('gemini', 'my-gem-key');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('key=my-gem-key'),
        expect.objectContaining({ headers: {} }),
      );
    });

    it('should return [] immediately without any HTTP call when authType is subscription', async () => {
      // CodeAssist does not expose a /models endpoint; the discovery fallback
      // chain handles Gemini subscription models via the OpenRouter cache.
      const result = await service.fetch('gemini', 'ya29.some-oauth-access-token', 'subscription');

      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  /* ── OpenRouter provider ── */

  describe('parseOpenRouter (via openrouter provider)', () => {
    it('should parse valid OpenRouter response with pricing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'openai/gpt-4',
              name: 'GPT-4',
              context_length: 8192,
              architecture: { output_modalities: ['text'] },
              pricing: { prompt: '0.00003', completion: '0.00006' },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'openai/gpt-4',
          displayName: 'GPT-4',
          provider: 'openrouter',
          contextWindow: 8192,
          inputPricePerToken: 0.00003,
          outputPricePerToken: 0.00006,
        }),
      );
    });

    it('should filter out :batch variants (only served via the async Batch API)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'openai/gpt-5',
              name: 'GPT-5',
              context_length: 400000,
              architecture: { output_modalities: ['text'] },
            },
            {
              id: 'openai/gpt-5:batch',
              name: 'GPT-5 (batch)',
              context_length: 400000,
              architecture: { output_modalities: ['text'] },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('openai/gpt-5');
    });

    it('should normalize OpenRouter input and output modalities', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'deepseek/deepseek-v4-flash',
              architecture: {
                input_modalities: ['text'],
                output_modalities: ['text'],
              },
            },
            {
              id: 'google/gemini-2.5-flash',
              architecture: {
                input_modalities: ['file', 'image', 'text', 'audio', 'video'],
                output_modalities: ['text'],
              },
            },
            {
              id: 'file-only',
              architecture: {
                input_modalities: ['file'],
                output_modalities: ['text'],
              },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');

      expect(result).toEqual([
        expect.objectContaining({
          inputModalities: ['text'],
          outputModalities: ['text'],
        }),
        expect.objectContaining({
          inputModalities: ['text', 'image', 'audio', 'video'],
          outputModalities: ['text'],
        }),
        expect.objectContaining({
          outputModalities: ['text'],
        }),
      ]);
      expect(result[2]).not.toHaveProperty('inputModalities');
    });

    it('should filter out non-text output modality models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'text-only',
              architecture: { output_modalities: ['text'] },
            },
            {
              id: 'image-model',
              architecture: { output_modalities: ['image'] },
            },
            {
              id: 'multi-modal',
              architecture: { output_modalities: ['text', 'image'] },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('text-only');
    });

    it('should include models with empty output_modalities', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'empty-modalities',
              architecture: { output_modalities: [] },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toHaveLength(1);
    });

    it('should include models without architecture field', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'no-arch' }],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toHaveLength(1);
    });

    it('should handle missing pricing fields', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'no-pricing' }],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should handle non-finite pricing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'bad-pricing',
              pricing: { prompt: 'NaN', completion: 'Infinity' },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should treat negative pricing as null', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'neg-pricing',
              pricing: { prompt: '-0.001', completion: '-0.002' },
            },
          ],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result[0].inputPricePerToken).toBeNull();
      expect(result[0].outputPricePerToken).toBeNull();
    });

    it('should use id as displayName when name is missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'model/test' }],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result[0].displayName).toBe('model/test');
    });

    it('should default contextWindow to 128000', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'no-ctx' }],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result[0].contextWindow).toBe(128000);
    });

    it('should filter out entries without string id', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ name: 'no-id' }, { id: 42 }],
        }),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toEqual([]);
    });

    it('should return [] when data is not array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await service.fetch('openrouter', '');
      expect(result).toEqual([]);
    });
  });

  /* ── Ollama provider ── */

  describe('parseOllama (via ollama provider)', () => {
    it('should parse valid Ollama response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3:latest', details: { family: 'llama', parameter_size: '8B' } },
            { name: 'codellama', details: { family: 'llama' } },
          ],
        }),
      });

      const result = await service.fetch('ollama', '');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'llama3',
          displayName: 'llama3',
          provider: 'ollama',
          contextWindow: 128000,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          qualityScore: 2,
        }),
      );
      expect(result[1].id).toBe('codellama');
    });

    it('should strip :latest suffix from model name', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'mistral:latest' }],
        }),
      });

      const result = await service.fetch('ollama', '');
      expect(result[0].id).toBe('mistral');
    });

    it('should preserve author-prefixed third-party model ids', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: 'mdq100/qwen3.5-flash:35b' },
            { name: 'hf.co/acon96/Home-Llama-3.2-3B:F16' },
          ],
        }),
      });

      const result = await service.fetch('ollama', '');
      expect(result.map((model) => model.id)).toEqual([
        'mdq100/qwen3.5-flash:35b',
        'hf.co/acon96/Home-Llama-3.2-3B:F16',
      ]);
    });

    it('should filter out entries without string name', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: 'valid' }, { name: 123 }, {}],
        }),
      });

      const result = await service.fetch('ollama', '');
      expect(result).toHaveLength(1);
    });

    it('should return [] when models is not array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: null }),
      });

      const result = await service.fetch('ollama', '');
      expect(result).toEqual([]);
    });

    it('should send no headers', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await service.fetch('ollama', '');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: {} }),
      );
    });
  });

  /* ── Ollama Cloud provider ── */

  describe('ollama-cloud provider', () => {
    it('should hit the ollama.com api/tags endpoint', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await service.fetch('ollama-cloud', 'sk-test-key');

      expect(fetchSpy).toHaveBeenCalledWith('https://ollama.com/api/tags', expect.any(Object));
    });

    it('should include Bearer auth header built via the shared bearerHeaders helper', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await service.fetch('ollama-cloud', 'sk-test-key');

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: 'Bearer sk-test-key' },
        }),
      );
    });

    it('should parse models with price 0 and strip :latest suffix', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: 'deepseek-v3.2', details: { family: 'deepseek' } },
            { name: 'qwen3.5:latest', details: { family: 'qwen' } },
          ],
        }),
      });

      const result = await service.fetch('ollama-cloud', 'sk-test-key');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'deepseek-v3.2',
          provider: 'ollama-cloud',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          qualityScore: 2,
        }),
      );
      expect(result[1].id).toBe('qwen3.5');
    });

    it('should return [] on non-ok response', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 403 });
      const result = await service.fetch('ollama-cloud', 'sk-test-key');
      expect(result).toEqual([]);
    });
  });

  /* ── OpenAI subscription parser ── */

  describe('parseOpenaiSubscription (via openai provider with subscription authType)', () => {
    it('should parse valid Codex models response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              slug: 'gpt-5.5',
              display_name: 'GPT-5.5',
              context_window: 192000,
              visibility: 'list',
              supported_in_api: true,
              priority: 10,
            },
            {
              slug: 'gpt-5.4',
              display_name: 'GPT-5.4',
              context_window: 200000,
              visibility: 'list',
              supported_in_api: true,
            },
          ],
        }),
      });

      const result = await service.fetch('openai', 'oauth-token', 'subscription');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          provider: 'openai',
          contextWindow: 192000,
          contextWindowSource: 'provider',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          capabilityCode: true,
          qualityScore: 3,
        }),
      );
      expect(result[1].id).toBe('gpt-5.4');
    });

    it('should filter ChatGPT-account unsupported Codex models from the models response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { slug: 'gpt-5.5', visibility: 'list' },
            { slug: 'gpt-5.3-codex', visibility: 'list' },
            { slug: 'gpt-5.2-codex', visibility: 'list' },
            { slug: 'gpt-5.2', visibility: 'list' },
            { slug: 'gpt-5.1-codex-max', visibility: 'list' },
            { slug: 'gpt-5.1-codex', visibility: 'list' },
            { slug: 'gpt-5.3-codex-spark', visibility: 'list' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'oauth-token', 'subscription');

      expect(result.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.3-codex-spark']);
    });

    it('should filter out models with visibility !== list', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { slug: 'visible-model', visibility: 'list' },
            { slug: 'hidden-model', visibility: 'hidden' },
            { slug: 'no-visibility' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'token', 'subscription');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('visible-model');
    });

    it('should use slug as displayName when display_name is missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ slug: 'gpt-5.4', visibility: 'list' }],
        }),
      });

      const result = await service.fetch('openai', 'token', 'subscription');
      expect(result[0].displayName).toBe('gpt-5.4');
    });

    it('should default context_window to 200000', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ slug: 'test-model', visibility: 'list' }],
        }),
      });

      const result = await service.fetch('openai', 'token', 'subscription');
      expect(result[0].contextWindow).toBe(200000);
      expect(result[0].contextWindowSource).toBe('subscription_config');
    });

    it('should return [] when models is not an array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: 'not-array' }),
      });

      const result = await service.fetch('openai', 'token', 'subscription');
      expect(result).toEqual([]);
    });

    it('should return [] when models is missing', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const result = await service.fetch('openai', 'token', 'subscription');
      expect(result).toEqual([]);
    });

    it('should filter out entries without string slug', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { slug: 123, visibility: 'list' },
            { visibility: 'list' },
            { slug: 'valid', visibility: 'list' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'token', 'subscription');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid');
    });

    it('should send Codex CLI headers', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await service.fetch('openai', 'my-oauth-token', 'subscription');

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-oauth-token',
            originator: 'codex_cli_rs',
          }),
        }),
      );
    });
  });

  /* ── Copilot parser ── */

  describe('parseCopilot (via copilot provider)', () => {
    it('should parse Copilot models and add copilot/ prefix', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'claude-opus-4.6',
              object: 'model',
              supported_endpoints: ['/chat/completions', '/v1/messages'],
            },
            { id: 'gpt-4o', object: 'model' },
          ],
        }),
      });

      const result = await service.fetch('copilot', 'tid=copilot-token');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'copilot/claude-opus-4.6',
          displayName: 'claude-opus-4.6',
          provider: 'copilot',
          contextWindow: 128000,
          inputPricePerToken: 0,
          outputPricePerToken: 0,
          qualityScore: 3,
          supportedEndpoints: ['/chat/completions', '/v1/messages'],
        }),
      );
      expect(result[1].id).toBe('copilot/gpt-4o');
    });

    it('should convert Copilot AI-credit prices to USD per token', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'claude-sonnet-4.6',
              billing: {
                token_prices: {
                  batch_size: 1_000_000,
                  default: {
                    input_price: 300,
                    output_price: 1500,
                    cache_read_price: 30,
                    cache_write_price: 375,
                    max_prompt_tokens: 200_000,
                  },
                  long_context: {
                    input_price: 600,
                    output_price: 2250,
                    cache_read_price: 60,
                    cache_write_price: 750,
                    max_prompt_tokens: 936_000,
                  },
                },
              },
            },
          ],
        }),
      });

      const result = await service.fetch('copilot', 'tid=token');

      expect(result[0]).toMatchObject({
        inputPricePerToken: 3 / 1_000_000,
        outputPricePerToken: 15 / 1_000_000,
        cacheReadPricePerToken: 0.3 / 1_000_000,
        cacheWritePricePerToken: 3.75 / 1_000_000,
        longContextPricing: {
          thresholdTokens: 200_000,
          inputPricePerToken: 6 / 1_000_000,
          outputPricePerToken: 22.5 / 1_000_000,
          cacheReadPricePerToken: 0.6 / 1_000_000,
          cacheWritePricePerToken: 7.5 / 1_000_000,
        },
      });
    });

    it('should preserve Copilot long-context prices and their prompt threshold', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'gpt-5.6-terra',
              billing: {
                token_prices: {
                  default: {
                    input_price: 200,
                    output_price: 1200,
                    cache_price: 20,
                    cache_write_price: 250,
                    context_max: 272_000,
                  },
                  long_context: {
                    input_price: 400,
                    output_price: 1800,
                    cache_price: 40,
                    cache_write_price: 500,
                    context_max: 936_000,
                  },
                },
              },
            },
          ],
        }),
      });

      const result = await service.fetch('copilot', 'tid=token');

      expect(result[0]).toMatchObject({
        contextWindow: 936_000,
        inputPricePerToken: 2 / 1_000_000,
        outputPricePerToken: 12 / 1_000_000,
        cacheReadPricePerToken: 0.2 / 1_000_000,
        cacheWritePricePerToken: 2.5 / 1_000_000,
        longContextPricing: {
          thresholdTokens: 272_000,
          inputPricePerToken: 4 / 1_000_000,
          outputPricePerToken: 18 / 1_000_000,
          cacheReadPricePerToken: 0.4 / 1_000_000,
          cacheWritePricePerToken: 5 / 1_000_000,
        },
      });
    });

    it('should omit unavailable Copilot cache prices', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'gpt-5-mini',
              billing: {
                token_prices: {
                  batch_size: 1_000_000,
                  default: { input_price: 25, output_price: 200 },
                },
              },
            },
          ],
        }),
      });

      const result = await service.fetch('copilot', 'tid=token');

      expect(result[0]).toMatchObject({
        inputPricePerToken: 0.25 / 1_000_000,
        outputPricePerToken: 2 / 1_000_000,
      });
      expect(result[0]).not.toHaveProperty('cacheReadPricePerToken');
      expect(result[0]).not.toHaveProperty('cacheWritePricePerToken');
    });

    it('should keep subscription pricing at zero when Copilot billing is invalid', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'gpt-4o',
              billing: {
                token_prices: {
                  batch_size: 0,
                  default: { input_price: 100, output_price: 500 },
                },
              },
            },
            {
              id: 'gpt-4.1',
              billing: {
                token_prices: {
                  batch_size: 1_000_000,
                  default: { input_price: -1, output_price: Number.POSITIVE_INFINITY },
                },
              },
            },
          ],
        }),
      });

      const result = await service.fetch('copilot', 'tid=token');

      expect(result[0]).toMatchObject({
        inputPricePerToken: 0,
        outputPricePerToken: 0,
      });
      expect(result[1]).toMatchObject({
        inputPricePerToken: 0,
        outputPricePerToken: 0,
      });
    });

    it('should send correct Copilot headers', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await service.fetch('copilot', 'tid=test-token');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.githubcopilot.com/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer tid=test-token',
            'Editor-Version': 'vscode/1.100.0',
            'Copilot-Integration-Id': 'vscode-chat',
          }),
        }),
      );
    });

    it('should return [] for empty data array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const result = await service.fetch('copilot', 'tid=token');
      expect(result).toEqual([]);
    });

    it('should filter out entries with missing or empty id', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'valid-model' }, { name: 'no-id-field' }, { id: '' }],
        }),
      });

      const result = await service.fetch('copilot', 'tid=token');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('copilot/valid-model');
    });

    it('should return [] when data is not an array', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: 'not-array' }),
      });

      const result = await service.fetch('copilot', 'tid=token');
      expect(result).toEqual([]);
    });

    it('should filter out internal Azure routing models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-opus-4.7' },
            { id: 'gpt-4o' },
            { id: 'accounts/msft/routers/f185i3v4' },
            { id: 'accounts/msft/routers/fmfeto88' },
            { id: 'accounts/msft/routers/gdjv4v2v' },
          ],
        }),
      });

      const result = await service.fetch('copilot', 'tid=token');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('copilot/claude-opus-4.7');
      expect(result[1].id).toBe('copilot/gpt-4o');
    });
  });

  describe('opencode-go provider', () => {
    it('fetches the live OpenCode Go /models catalog and namespaces model ids', async () => {
      const catalog = {
        list: jest.fn().mockResolvedValue([]),
        refresh: jest
          .fn()
          .mockResolvedValue([
            { id: 'glm-5.1', displayName: 'GLM-5.1', format: 'openai' as const },
          ]),
      };
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'glm-5.2', object: 'model', owned_by: 'opencode' },
            { id: 'glm-5.1', object: 'model', owned_by: 'opencode' },
          ],
        }),
      });
      const withCatalog = new ProviderModelFetcherService(
        catalog as unknown as ConstructorParameters<typeof ProviderModelFetcherService>[0],
      );

      const result = await withCatalog.fetch('opencode-go', 'og-token', 'subscription');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer og-token' }),
        }),
      );
      expect(catalog.list).not.toHaveBeenCalled();
      expect(catalog.refresh).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'opencode-go/glm-5.2',
          displayName: 'opencode-go/glm-5.2',
          provider: 'opencode-go',
          inputPricePerToken: 0,
          outputPricePerToken: 0,
        }),
      );
      expect(result[1].id).toBe('opencode-go/glm-5.1');
    });

    it('falls back to a refreshed docs catalog when live /models is empty', async () => {
      const catalog = {
        list: jest.fn().mockResolvedValue([]),
        refresh: jest
          .fn()
          .mockResolvedValue([
            { id: 'glm-5.2', displayName: 'GLM-5.2', format: 'openai' as const },
          ]),
      };
      const withCatalog = new ProviderModelFetcherService(
        catalog as unknown as ConstructorParameters<typeof ProviderModelFetcherService>[0],
      );
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const result = await withCatalog.fetch('opencode-go', 'og-token', 'subscription', undefined, {
        forceRefresh: true,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://opencode.ai/zen/go/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer og-token' }),
        }),
      );
      expect(catalog.refresh).toHaveBeenCalledTimes(1);
      expect(catalog.list).not.toHaveBeenCalled();
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: 'opencode-go/glm-5.2',
          displayName: 'GLM-5.2',
          provider: 'opencode-go',
        }),
      );
    });

    it('falls back to the docs catalog when live /models returns an error', async () => {
      const catalog = {
        list: jest
          .fn()
          .mockResolvedValue([
            { id: 'glm-5.1', displayName: 'GLM-5.1', format: 'openai' as const },
          ]),
        refresh: jest.fn().mockResolvedValue([]),
      };
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      });
      const withCatalog = new ProviderModelFetcherService(
        catalog as unknown as ConstructorParameters<typeof ProviderModelFetcherService>[0],
      );

      const result = await withCatalog.fetch('opencode-go', 'og-token', 'subscription');

      expect(catalog.list).toHaveBeenCalledTimes(1);
      expect(catalog.refresh).not.toHaveBeenCalled();
      expect(result.map((m) => m.id)).toEqual(['opencode-go/glm-5.1']);
    });

    it('falls back to the docs catalog when live /models throws', async () => {
      const catalog = {
        list: jest
          .fn()
          .mockResolvedValue([
            { id: 'glm-5.1', displayName: 'GLM-5.1', format: 'openai' as const },
          ]),
        refresh: jest.fn().mockResolvedValue([]),
      };
      fetchSpy.mockRejectedValue(new Error('network down'));
      const withCatalog = new ProviderModelFetcherService(
        catalog as unknown as ConstructorParameters<typeof ProviderModelFetcherService>[0],
      );

      const result = await withCatalog.fetch('opencode-go', 'og-token', 'subscription');

      expect(catalog.list).toHaveBeenCalledTimes(1);
      expect(catalog.refresh).not.toHaveBeenCalled();
      expect(result.map((m) => m.id)).toEqual(['opencode-go/glm-5.1']);
    });

    it('uses live models even when no docs catalog service is wired up', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'glm-5.2' }] }),
      });

      const result = await service.fetch('opencode-go', 'og-token', 'subscription');
      expect(result.map((m) => m.id)).toEqual(['opencode-go/glm-5.2']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('commandcode provider', () => {
    it('fetches the Provider API /models catalog with Bearer auth and namespaces model ids', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
              context_length: 1000000,
            },
            {
              id: 'deepseek/deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              context_length: 1000000,
            },
          ],
        }),
      });

      const result = await service.fetch('commandcode', 'user_test', 'subscription');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.commandcode.ai/provider/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer user_test' }),
        }),
      );
      expect(result).toEqual([
        expect.objectContaining({
          id: 'commandcode/claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          provider: 'commandcode',
          contextWindow: 1000000,
          capabilityCode: true,
        }),
        expect.objectContaining({
          id: 'commandcode/deepseek/deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          provider: 'commandcode',
          contextWindow: 1000000,
          capabilityCode: true,
        }),
      ]);
    });
  });

  describe('cline-pass provider', () => {
    it('returns known subscription models with configured context windows', async () => {
      const result = await service.fetch('cline-pass', 'cp-token', 'subscription');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'cline-pass/deepseek-v4-flash',
            provider: 'cline-pass',
            contextWindow: 200000,
            capabilityReasoning: true,
            capabilityCode: true,
          }),
        ]),
      );
      expect(result.every((model) => model.contextWindow === 200000)).toBe(true);
    });
  });

  describe('opencode-zen provider', () => {
    it('fetches the OpenAI-compatible /v1/models catalog with Bearer auth and namespaces every model id', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'qwen3.6-plus', object: 'model', owned_by: 'opencode' },
            { id: 'claude-opus-4-7', object: 'model', owned_by: 'opencode' },
            { id: 'gemini-3-flash', object: 'model', owned_by: 'opencode' },
          ],
        }),
      });

      const result = await service.fetch('opencode-zen', 'oz-token');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://opencode.ai/zen/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer oz-token' }),
        }),
      );
      expect(result).toHaveLength(3);
      // IDs must be prefixed so they cannot collide with the same bare model
      // names served by a directly-connected Google/Qwen/Anthropic provider.
      expect(result.map((m) => m.id)).toEqual([
        'opencode-zen/qwen3.6-plus',
        'opencode-zen/claude-opus-4-7',
        'opencode-zen/gemini-3-flash',
      ]);
      expect(result[0]).toEqual(
        expect.objectContaining({ provider: 'opencode-zen', displayName: 'qwen3.6-plus' }),
      );
    });
  });

  /* ── OpenAI subscription routing ── */

  it('should route openai+subscription to openai-subscription config', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });

    await service.fetch('openai', 'token', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('chatgpt.com/backend-api/codex/models'),
      expect.anything(),
    );
  });

  it('should use regular openai config when authType is not subscription', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch('openai', 'sk-key', 'api_key');

    expect(fetchSpy).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.anything());
  });

  /* ── Case insensitivity ── */

  it('should handle provider ID case-insensitively', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model' }] }),
    });

    const result = await service.fetch('OpenAI', 'key');
    expect(result).toHaveLength(1);
  });

  /* ── Endpoint function (gemini) ── */

  it('should call endpoint function when endpoint is a function', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });

    await service.fetch('gemini', 'special&key');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('key=special%26key'),
      expect.anything(),
    );
  });

  /* ── Non-ok response masks api key ── */

  it('should mask api key in warning log for non-ok response', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 403 });

    const result = await service.fetch('gemini', 'secret-key');
    expect(result).toEqual([]);
  });

  /* ── Mistral-specific filter: edge cases ── */

  describe('parseMistralChatOnly edge cases', () => {
    it('should preserve voxtral models (speech-capable chat models)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'voxtral-small-latest' }, { id: 'voxtral-medium-2507' }],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['voxtral-small-latest', 'voxtral-medium-2507']);
    });

    it('should preserve magistral models (reasoning chat models)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'magistral-small-latest' }, { id: 'magistral-medium-latest' }],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual([
        'magistral-small-latest',
        'magistral-medium-latest',
      ]);
    });

    it('should preserve devstral models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'devstral-medium-2507' }],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('devstral-medium-2507');
    });

    it('should filter out embed models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'mistral-embed' }, { id: 'mistral-large-latest' }],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('mistral-large-latest');
    });

    it('should filter out all OCR variants', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'mistral-ocr-2512' },
            { id: 'mistral-ocr-latest' },
            { id: 'mistral-ocr-2503' },
            { id: 'codestral-latest' },
          ],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('codestral-latest');
    });

    it('should keep model with "ocr" in the middle of the name but not at start', async () => {
      // The regex is /^mistral-ocr|embed/i — only filters "mistral-ocr-*" prefix, not "ocr" mid-name
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'pixtral-large-latest' }, { id: 'some-ocr-model' }],
        }),
      });

      const result = await service.fetch('mistral', 'key');
      // Both pass: pixtral has no "mistral-ocr" prefix, "some-ocr-model" has "ocr" mid-name not prefix
      expect(result).toHaveLength(2);
    });

    it('filters the Vibe CLI model from API-key discovery and restricts subscription discovery to it', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'mistral-vibe-cli-latest' }, { id: 'mistral-large-latest' }],
        }),
      });

      const apiKeyResult = await service.fetch('mistral', 'mistral-api-key', 'api_key');
      const subscriptionResult = await service.fetch('mistral', 'mistral-vibe-key', 'subscription');

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://api.mistral.ai/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer mistral-api-key' } }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'https://api.mistral.ai/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer mistral-vibe-key' } }),
      );
      expect(apiKeyResult.map((m) => m.id)).toEqual(['mistral-large-latest']);
      expect(subscriptionResult.map((m) => m.id)).toEqual(['mistral-vibe-cli-latest']);
    });
  });

  /* ── OpenAI parseOpenAIChatOnly edge cases ── */

  describe('parseOpenAIChatOnly edge cases', () => {
    it('should filter out realtime models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o-realtime-preview' }, { id: 'gpt-4o' }],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });

    it('should filter out transcribe models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o-audio-transcribe' },
            { id: 'gpt-4o-mini-audio-transcribe' },
            { id: 'gpt-4o' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });

    it('should filter out sora models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'sora-2' }, { id: 'sora-2-pro' }, { id: 'o3' }],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('o3');
    });

    it('should keep all Codex variants in discovery (proxy routes them to /v1/responses)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'codex-mini-latest' },
            { id: 'gpt-5-codex' },
            { id: 'gpt-5.1-codex' },
            { id: 'gpt-5.2-codex' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result.map((m) => m.id)).toEqual([
        'codex-mini-latest',
        'gpt-5-codex',
        'gpt-5.1-codex',
        'gpt-5.2-codex',
      ]);
    });

    it('should keep gpt-5 -pro variants alongside gpt-5-chat-latest (proxy routes -pro to /v1/responses)', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-5-pro' },
            { id: 'gpt-5.2-pro' },
            { id: 'gpt-5-chat-latest' },
            { id: 'gpt-5' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result.map((m) => m.id)).toEqual([
        'gpt-5-pro',
        'gpt-5.2-pro',
        'gpt-5-chat-latest',
        'gpt-5',
      ]);
    });

    it('should filter out audio models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o-audio-preview' },
            { id: 'gpt-4o-mini-audio-preview' },
            { id: 'gpt-4o' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });

    it('should filter out text-moderation models', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'text-moderation-latest' },
            { id: 'text-moderation-stable' },
            { id: 'gpt-4o' },
          ],
        }),
      });

      const result = await service.fetch('openai', 'sk-test');
      // text-moderation-* matches both the moderation pattern and the text- prefix pattern
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gpt-4o');
    });
  });

  /* ── Gemini dedup edge cases ── */

  describe('parseGemini dedup edge cases', () => {
    it('should keep multiple versioned models when no alias exists for any', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.0-flash-001',
              displayName: 'Flash 001',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-2.0-flash-002',
              displayName: 'Flash 002',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      // Neither has an alias without -NNN suffix, so both should be kept
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['gemini-2.0-flash-001', 'gemini-2.0-flash-002']);
    });

    it('should keep non-versioned model even when versioned variant exists', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-2.5-flash-001',
              displayName: 'Flash 001',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      // gemini-2.5-flash-001 has alias gemini-2.5-flash, so it's dropped
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gemini-2.5-flash');
    });

    it('should not treat non-3-digit suffixes as version suffixes', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-2.5-pro-preview-03-25',
              displayName: 'Preview',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      });

      const result = await service.fetch('gemini', 'key');
      // -03-25 is not a 3-digit version suffix, so the model stays
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('gemini-2.5-pro-preview-03-25');
    });
  });

  /* ── MiniMax subscription routing ── */

  it('should route minimax+subscription to minimax-subscription config', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch('minimax', 'token', 'subscription');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('api.minimax.io'),
      expect.anything(),
    );
  });

  it('should use regular minimax config when authType is not subscription', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await service.fetch('minimax', 'api-key', 'api_key');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('api.minimaxi.chat'),
      expect.anything(),
    );
  });
});
