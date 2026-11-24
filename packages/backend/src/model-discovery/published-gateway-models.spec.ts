import { dropShadowedGatewayModels, publishedOpencodeGoIds } from './published-gateway-models';

function row(model_name: string, display_name: string | null, provider = 'opencode-go') {
  return { model_name, provider, display_name };
}

const docs = { list: jest.fn() };
const modelsDev = { getModelsForProvider: jest.fn() };

beforeEach(() => {
  docs.list.mockReset().mockResolvedValue([{ id: 'deepseek-v4.1-flash' }]);
  modelsDev.getModelsForProvider.mockReset().mockReturnValue([{ id: 'glm-5' }]);
});

describe('publishedOpencodeGoIds', () => {
  it('unions the docs catalog and the models.dev catalog', async () => {
    const ids = await publishedOpencodeGoIds([{ provider: 'opencode-go' }], docs, modelsDev);

    expect([...ids].sort()).toEqual(['deepseek-v4.1-flash', 'glm-5']);
  });

  it('skips both catalogs when no OpenCode Go model is in play', async () => {
    const ids = await publishedOpencodeGoIds([{ provider: 'openai' }], docs, modelsDev);

    expect(ids.size).toBe(0);
    expect(docs.list).not.toHaveBeenCalled();
    expect(modelsDev.getModelsForProvider).not.toHaveBeenCalled();
  });

  it('returns an empty set when no catalog is wired', async () => {
    expect((await publishedOpencodeGoIds([{ provider: 'opencode-go' }], null, null)).size).toBe(0);
  });
});

describe('dropShadowedGatewayModels', () => {
  const published = new Set(['deepseek-v4.1-flash', 'glm-5', 'hy3']);

  it('hides an unpublished id a published one already stands for', () => {
    const rows = [
      row('opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
      row('opencode-go/deepseek-flash', 'DeepSeek V4.1 Flash'),
    ];

    expect(dropShadowedGatewayModels(rows, published).map((r) => r.model_name)).toEqual([
      'opencode-go/deepseek-v4.1-flash',
    ]);
  });

  it('keeps an unpublished model that no published one shadows', () => {
    // `hy3-preview` is its own model, not an alias of `hy3`.
    const rows = [row('opencode-go/hy3', 'Hy3'), row('opencode-go/hy3-preview', 'Hy3 Preview')];

    expect(dropShadowedGatewayModels(rows, published)).toHaveLength(2);
  });

  it('keeps an unnamed unpublished model, comparing on the id it prints', () => {
    const rows = [row('opencode-go/glm-5', 'GLM-5'), row('opencode-go/brand-new', null)];

    expect(dropShadowedGatewayModels(rows, published).map((r) => r.model_name)).toEqual([
      'opencode-go/glm-5',
      'opencode-go/brand-new',
    ]);
  });

  it('accepts an unprefixed id against the same allow-list', () => {
    const rows = [row('glm-5', 'GLM-5'), row('deepseek-flash', 'GLM-5')];

    expect(dropShadowedGatewayModels(rows, published).map((r) => r.model_name)).toEqual(['glm-5']);
  });

  it('never touches another provider, even on a name collision', () => {
    const rows = [
      row('opencode-go/glm-5', 'GLM-5'),
      row('glm-5', 'GLM-5', 'zai'),
      row('opencode-go/glm-5-alias', 'GLM-5'),
    ];

    expect(dropShadowedGatewayModels(rows, published).map((r) => r.model_name)).toEqual([
      'opencode-go/glm-5',
      'glm-5',
    ]);
  });

  it('keeps everything when no id is published', () => {
    const rows = [row('opencode-go/deepseek-flash', 'DeepSeek V4.1 Flash')];

    expect(dropShadowedGatewayModels(rows, new Set())).toBe(rows);
  });

  it('keeps everything when the published ids are absent from this agent', () => {
    const rows = [row('opencode-go/deepseek-flash', 'DeepSeek V4.1 Flash')];

    expect(dropShadowedGatewayModels(rows, new Set(['some-other-model']))).toBe(rows);
  });
});
