import { openAiModelCapabilities } from '../openai-model-capabilities';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';

function makeModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: 0.0000025,
    outputPricePerToken: 0.00001,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 4,
    authType: 'api_key',
    ...overrides,
  };
}

describe('openAiModelCapabilities', () => {
  it('returns undefined when nothing is known — unknown is not reported as unsupported', () => {
    expect(openAiModelCapabilities(makeModel())).toBeUndefined();
    expect(
      openAiModelCapabilities(
        makeModel({ inputModalities: [], outputModalities: [], supportedEndpoints: [] }),
      ),
    ).toBeUndefined();
  });

  it('projects input and output modalities as separate fields', () => {
    expect(
      openAiModelCapabilities(
        makeModel({ inputModalities: ['text', 'image'], outputModalities: ['text'] }),
      ),
    ).toEqual({
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    });
  });

  it('keeps only endpoint features from the merged capability list', () => {
    expect(
      openAiModelCapabilities(makeModel({ capabilities: ['text', 'image', 'stream', 'tools'] })),
    ).toEqual({ features: ['stream', 'tools'] });
  });

  it('omits features when the capability list carries no endpoint features', () => {
    expect(openAiModelCapabilities(makeModel({ capabilities: ['text'] }))).toBeUndefined();
  });

  it('passes supported endpoints through verbatim', () => {
    expect(openAiModelCapabilities(makeModel({ supportedEndpoints: ['/responses'] }))).toEqual({
      supported_endpoints: ['/responses'],
    });
  });
});
