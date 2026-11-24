import { ProviderParamSpecService } from '../provider-param-spec.service';

// Canary for the vendored modelparams seed: it reads the real installed package
// (no fs mock) and pins a few model ids on purpose, coupling to third-party data
// so a bump that drops or renames them is caught. If this fails after a
// modelparams bump, update the pinned ids, not the loader.
describe('ProviderParamSpecService vendored modelparams seed', () => {
  const originalApiDisabled = process.env.MODELPARAMS_API_DISABLED;
  let service: ProviderParamSpecService;

  beforeAll(() => {
    process.env.MODELPARAMS_API_DISABLED = 'true';
    service = new ProviderParamSpecService();
  });

  afterAll(() => {
    if (originalApiDisabled === undefined) delete process.env.MODELPARAMS_API_DISABLED;
    else process.env.MODELPARAMS_API_DISABLED = originalApiDisabled;
  });

  it.each([
    ['anthropic', 'claude-fable-5-1'],
    ['openai', 'gpt-6-luna'],
  ])('lists %s %s and has params for it', async (provider, model) => {
    expect(service.listModelIds()).toContainEqual({ provider, authType: 'api_key', model });
    const specs = await service.getSpecs(provider, 'api_key', model);
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each([
    ['bedrock', 'global.openai.gpt-6-luna'],
    ['bedrock', 'global.anthropic.claude-fable-5-1'],
  ])('resolves params for %s %s', async (provider, model) => {
    const specs = await service.getSpecs(provider, 'api_key', model);
    expect(specs.length).toBeGreaterThan(0);
  });
});
