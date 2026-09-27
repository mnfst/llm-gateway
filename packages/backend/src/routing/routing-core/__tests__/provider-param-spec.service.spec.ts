import { ProviderParamSpecService } from '../provider-param-spec.service';

describe('ProviderParamSpecService', () => {
  it('loads model parameter specs from the modelparams package without network fetches', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const service = new ProviderParamSpecService();

    await expect(service.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'openai',
          authType: 'api_key',
          model: 'gpt-4o',
        }),
      ]),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('filters specs by provider, auth type, and model', async () => {
    const service = new ProviderParamSpecService();

    const apiSpecs = await service.getSpecs('openai', 'api_key', 'gpt-4o');
    const localSpecs = await service.getSpecs('openai', 'local', 'gpt-4o');

    expect(apiSpecs.map((spec) => spec.path)).toEqual(['max_tokens', 'temperature', 'top_p']);
    expect(localSpecs.map((spec) => spec.path)).toEqual([]);
  });

  it('lists model identities without param details and canonicalizes provider aliases', async () => {
    const service = new ProviderParamSpecService();

    expect(await service.listModelIds()).toEqual(
      expect.arrayContaining([
        { provider: 'openai', authType: 'api_key', model: 'gpt-4o' },
        { provider: 'zai', authType: 'api_key', model: 'glm-4.6' },
      ]),
    );
  });

  it('loads providerless subscription specs for prefixed Copilot models', async () => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('copilot', 'subscription', 'copilot/gpt-5.5');

    expect(specs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'copilot',
          authType: 'subscription',
          model: 'copilot/gpt-5.5',
          path: 'reasoning.effort',
        }),
        expect.objectContaining({
          provider: 'copilot',
          authType: 'subscription',
          model: 'copilot/gpt-5.5',
          path: 'text.verbosity',
        }),
      ]),
    );
  });

  it('accepts Copilot subscription route ids that already include the subscription suffix', async () => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('copilot', 'subscription', 'copilot/gpt-5.5-subscription');

    expect(specs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'copilot',
          authType: 'subscription',
          model: 'copilot/gpt-5.5-subscription',
          path: 'reasoning.effort',
        }),
      ]),
    );
  });

  it('normalizes Copilot Claude dotted minor versions before providerless lookup', async () => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('copilot', 'subscription', 'copilot/claude-sonnet-4.6');

    expect(specs.map((spec) => spec.path)).toEqual(
      expect.arrayContaining([
        'max_tokens',
        'output_config.effort',
        'thinking.budget_tokens',
        'thinking.type',
      ]),
    );
    expect(specs[0]).toEqual(
      expect.objectContaining({
        provider: 'copilot',
        authType: 'subscription',
        model: 'copilot/claude-sonnet-4.6',
      }),
    );
  });

  it('resolves Bedrock Claude model ids through the underlying Anthropic provider for params', async () => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('bedrock', 'api_key', 'us.anthropic.claude-opus-4.8');

    expect(specs.map((spec) => spec.path)).toEqual(
      expect.arrayContaining(['max_tokens', 'output_config.effort', 'thinking.type']),
    );
    expect(specs[0]).toEqual(
      expect.objectContaining({
        provider: 'bedrock',
        authType: 'api_key',
        model: 'us.anthropic.claude-opus-4.8',
      }),
    );
  });

  it.each([
    [
      'k3',
      [
        'max_completion_tokens',
        'stop',
        'reasoning_effort',
        'thinking.type',
        'tool_choice',
        'response_format.type',
      ],
    ],
    [
      'k3-256k',
      [
        'max_completion_tokens',
        'stop',
        'reasoning_effort',
        'thinking.type',
        'tool_choice',
        'response_format.type',
      ],
    ],
    ['kimi-for-coding', ['max_completion_tokens', 'thinking.type', 'response_format.type']],
    [
      'kimi-for-coding-highspeed',
      ['max_completion_tokens', 'thinking.type', 'response_format.type'],
    ],
  ])('resolves Moonshot wire id %s through its metadata model', async (model, paths) => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('moonshot', 'subscription', model);

    expect(specs.map((spec) => spec.path)).toEqual(paths);
    expect(specs[0]).toEqual(
      expect.objectContaining({
        provider: 'moonshot',
        authType: 'subscription',
        model,
      }),
    );
  });

  it('strips dated Bedrock model ids for providerless params while preserving the route identity', async () => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('bedrock', 'api_key', 'openai.gpt-5.4-2026-03-05');

    expect(specs.map((spec) => spec.path)).toEqual(['max_completion_tokens', 'reasoning_effort']);
    expect(specs[0]).toEqual(
      expect.objectContaining({
        provider: 'bedrock',
        authType: 'api_key',
        model: 'openai.gpt-5.4-2026-03-05',
      }),
    );
  });

  it('falls back to package API-key specs for subscription routes without subscription specs', async () => {
    const service = new ProviderParamSpecService();

    const specs = await service.getSpecs('copilot', 'subscription', 'copilot/gpt-4o-mini');

    expect(specs.map((spec) => spec.path)).toEqual(['max_tokens', 'temperature', 'top_p']);
    expect(specs[0]).toEqual(
      expect.objectContaining({
        provider: 'copilot',
        authType: 'subscription',
        model: 'copilot/gpt-4o-mini',
      }),
    );
  });

  it('returns no specs for local or missing model routes', async () => {
    const service = new ProviderParamSpecService();

    await expect(service.getSpecs('openai', 'local', 'gpt-4o')).resolves.toEqual([]);
    await expect(service.getSpecs('openai', 'api_key', 'missing-model')).resolves.toEqual([]);
    await expect(service.getSpecs('moonshot', 'api_key', 'missing-model')).resolves.toEqual([]);
    await expect(service.getCapabilities('openai', 'api_key', 'missing-model')).resolves.toBeNull();
  });
});

describe('ProviderParamSpecService API refresh', () => {
  const CATALOG_BODY = JSON.stringify({
    models: [
      {
        provider: 'openai',
        authType: 'api_key',
        model: 'gpt-refreshed',
        params: [
          {
            path: 'max_tokens',
            type: 'integer',
            label: 'Max tokens',
            description: 'Maximum number of tokens.',
            group: 'generation_length',
          },
        ],
      },
    ],
  });

  const jsonResponse = (body: string, init?: ResponseInit): Response =>
    new Response(body, { status: 200, ...init });

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.MODELPARAMS_API_DISABLED;
    delete process.env.MODELPARAMS_API_URL;
  });

  it('swaps in a fetched catalog and remembers its ETag', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(CATALOG_BODY, { headers: { etag: '"v1"' } }));
    const service = new ProviderParamSpecService();

    await expect(service.refreshCatalog()).resolves.toBe(true);
    const specs = await service.getSpecs('openai', 'api_key', 'gpt-refreshed');
    expect(specs.map((spec) => spec.path)).toEqual(['max_tokens']);

    fetchSpy.mockResolvedValue(new Response(null, { status: 304 }));
    await expect(service.refreshCatalog()).resolves.toBe(false);
    const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(secondInit.headers).toEqual({ 'if-none-match': '"v1"' });
    // The 304 keeps the previously fetched catalog.
    expect((await service.getSpecs('openai', 'api_key', 'gpt-refreshed')).length).toBe(1);
  });

  it('honors MODELPARAMS_API_URL and sends no conditional header on the first fetch', async () => {
    process.env.MODELPARAMS_API_URL = 'https://example.test/catalog.json';
    fetchSpy.mockResolvedValue(jsonResponse(CATALOG_BODY));
    const service = new ProviderParamSpecService();

    await expect(service.refreshCatalog()).resolves.toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/catalog.json');
    expect(init.headers).toBeUndefined();
  });

  it('does nothing when MODELPARAMS_API_DISABLED is set', async () => {
    process.env.MODELPARAMS_API_DISABLED = 'true';
    const service = new ProviderParamSpecService();

    await expect(service.refreshCatalog()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    let release!: (value: Response) => void;
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const service = new ProviderParamSpecService();

    const first = service.refreshCatalog();
    const second = service.refreshCatalog();
    release(jsonResponse(CATALOG_BODY));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', () => fetchSpy.mockRejectedValue(new Error('boom'))],
    ['a non-2xx status', () => fetchSpy.mockResolvedValue(new Response('nope', { status: 503 }))],
    ['invalid JSON', () => fetchSpy.mockResolvedValue(jsonResponse('{not json'))],
    ['an empty body', () => fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))],
    [
      'a body that fails catalog validation',
      () => fetchSpy.mockResolvedValue(jsonResponse(JSON.stringify({ models: 'wat' }))),
    ],
  ])('keeps the bundled catalog on %s', async (_label, arm) => {
    arm();
    const service = new ProviderParamSpecService();

    await expect(service.refreshCatalog()).resolves.toBe(false);
    const specs = await service.getSpecs('openai', 'api_key', 'gpt-4o');
    expect(specs.length).toBeGreaterThan(0);
  });

  it('rejects an oversized Content-Length without reading the body', async () => {
    const response = jsonResponse(CATALOG_BODY, {
      headers: { 'content-length': String(17 * 1024 * 1024) },
    });
    fetchSpy.mockResolvedValue(response);
    const service = new ProviderParamSpecService();

    await expect(service.refreshCatalog()).resolves.toBe(false);
    expect(response.bodyUsed).toBe(false);
  });

  it('keeps the bundled catalog when reading the response body throws', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { status: 200 }));
    const service = new ProviderParamSpecService();

    await expect(service.refreshCatalog()).resolves.toBe(false);
  });

  it('refreshes on module init and on the cron tick, surviving failures', async () => {
    fetchSpy.mockRejectedValue(new Error('offline'));
    const service = new ProviderParamSpecService();

    service.onModuleInit();
    await service.scheduledRefresh();
    expect(fetchSpy).toHaveBeenCalled();
    // Both paths swallow the failure; the bundled catalog still serves.
    expect((await service.list()).length).toBeGreaterThan(0);
  });
});
