import {
  inputModalitiesFromCapabilities,
  parseModalities,
  resolveModelCapabilityMetadata,
} from './model-capabilities';
import type { DiscoveredModel } from './model-fetcher';
import type { ModelsDevModelEntry } from '../database/models-dev-sync.service';

function makeModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
    ...overrides,
  };
}

function makeModelsDevEntry(overrides: Partial<ModelsDevModelEntry> = {}): ModelsDevModelEntry {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilities: ['text', 'image'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    ...overrides,
  };
}

describe('parseModalities', () => {
  it('returns known modalities in canonical order, ignoring case and unknown values', () => {
    expect(parseModalities(['Video', 'pdf', 'TEXT', 42, 'text'])).toEqual(['text', 'video']);
  });

  it('returns undefined when nothing is recognised', () => {
    expect(parseModalities(undefined)).toBeUndefined();
    expect(parseModalities('text')).toBeUndefined();
    expect(parseModalities(['embedding'])).toBeUndefined();
  });
});

describe('inputModalitiesFromCapabilities', () => {
  it('keeps text first and appends each novel capability once', () => {
    const out = inputModalitiesFromCapabilities([
      'text',
      'stream',
      'tools',
      'image',
      'image',
      'audio',
    ] as never);
    expect(out).toEqual(['text', 'image', 'audio']);
  });

  it('defaults to text-only for nullish capabilities', () => {
    expect(inputModalitiesFromCapabilities(null)).toEqual(['text']);
  });
});

describe('resolveModelCapabilityMetadata', () => {
  const paramSpecs = { getCapabilities: jest.fn() };
  const modelsDevSync = { lookupModelCapabilities: jest.fn() };

  beforeEach(() => {
    paramSpecs.getCapabilities.mockReset().mockResolvedValue(null);
    modelsDevSync.lookupModelCapabilities.mockReset().mockReturnValue(null);
  });

  it('merges discovery, models.dev, param-spec, and streaming-heuristic capabilities', async () => {
    paramSpecs.getCapabilities.mockResolvedValue(['tools']);
    modelsDevSync.lookupModelCapabilities.mockReturnValue(makeModelsDevEntry());

    const resolved = await resolveModelCapabilityMetadata(
      makeModel({ capabilities: ['audio'], authType: 'subscription' }),
      paramSpecs,
      modelsDevSync,
    );

    expect(paramSpecs.getCapabilities).toHaveBeenCalledWith('openai', 'subscription', 'gpt-4o');
    expect(resolved.capabilities).toEqual(['audio', 'text', 'image', 'tools', 'stream']);
    expect(resolved.inputModalities).toEqual(['text', 'image']);
    expect(resolved.outputModalities).toEqual(['text']);
    expect(resolved.modelsDevEntry).not.toBeNull();
  });

  it('prefers modalities the provider stated over models.dev', async () => {
    modelsDevSync.lookupModelCapabilities.mockReturnValue(makeModelsDevEntry());

    const resolved = await resolveModelCapabilityMetadata(
      makeModel({ inputModalities: ['text'], outputModalities: ['text', 'audio'] }),
      paramSpecs,
      modelsDevSync,
    );

    expect(resolved.inputModalities).toEqual(['text']);
    expect(resolved.outputModalities).toEqual(['text', 'audio']);
  });

  it('leaves everything undefined when no source knows the model', async () => {
    const resolved = await resolveModelCapabilityMetadata(
      makeModel({ id: 'mystery', provider: 'kiro' }),
      paramSpecs,
      modelsDevSync,
    );

    expect(paramSpecs.getCapabilities).toHaveBeenCalledWith('kiro', 'api_key', 'mystery');
    expect(resolved).toEqual({
      capabilities: undefined,
      inputModalities: undefined,
      outputModalities: undefined,
      modelsDevEntry: null,
    });
  });

  it('marks custom provider models as stream-capable', async () => {
    const resolved = await resolveModelCapabilityMetadata(
      makeModel({ id: 'custom:cp-1/local-model', provider: 'custom:cp-1' }),
      paramSpecs,
      modelsDevSync,
    );

    expect(resolved.capabilities).toEqual(['stream']);
  });

  it('keeps discovery-time modalities when models.dev has no entry', async () => {
    const resolved = await resolveModelCapabilityMetadata(
      makeModel({
        id: 'mystery',
        provider: 'kiro',
        inputModalities: ['text'],
        outputModalities: ['text'],
      }),
      paramSpecs,
      modelsDevSync,
    );

    expect(resolved.inputModalities).toEqual(['text']);
    expect(resolved.outputModalities).toEqual(['text']);
  });

  it('falls back to curated known capability facts when discovery and models.dev are silent', async () => {
    const resolved = await resolveModelCapabilityMetadata(
      makeModel({ id: 'gpt-5.4-mini', provider: 'openai', authType: 'subscription' }),
      paramSpecs,
      modelsDevSync,
    );

    expect(resolved.inputModalities).toEqual(['text', 'image']);
    expect(resolved.outputModalities).toEqual(['text']);
    expect(resolved.capabilities).toEqual(['stream', 'text', 'image', 'tools']);
  });

  it('prefers discovered modalities over the curated known list', async () => {
    const resolved = await resolveModelCapabilityMetadata(
      makeModel({
        id: 'gpt-5.4-mini',
        provider: 'openai',
        inputModalities: ['text'],
        outputModalities: ['text'],
      }),
      paramSpecs,
      modelsDevSync,
    );

    expect(resolved.inputModalities).toEqual(['text']);
    expect(resolved.outputModalities).toEqual(['text']);
  });

  it('keeps the vendor prefix on OpenRouter ids so the OpenRouter catalog answers', async () => {
    // OpenRouter is not a transparent gateway: it resells a vendor's model
    // under its own catalog entry, so `openai/gpt-4o-mini` must be looked up
    // whole rather than split into ('openai', 'gpt-4o-mini') (#2737).
    await resolveModelCapabilityMetadata(
      makeModel({ id: 'openai/gpt-4o-mini', provider: 'openrouter' }),
      paramSpecs,
      modelsDevSync,
    );

    expect(modelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith(
      'openrouter',
      'openai/gpt-4o-mini',
    );
  });

  it('looks up metadata under the underlying provider for vendor-prefixed ids', async () => {
    await resolveModelCapabilityMetadata(
      makeModel({ id: 'anthropic.claude-sonnet-5-v1:0', provider: 'bedrock' }),
      paramSpecs,
      modelsDevSync,
    );

    expect(modelsDevSync.lookupModelCapabilities).toHaveBeenCalledWith(
      'anthropic',
      'claude-sonnet-5-v1:0',
    );
  });
});

describe('resolveModelCapabilityMetadata — gateway ids', () => {
  const paramSpecs = { getCapabilities: jest.fn() };

  beforeEach(() => {
    paramSpecs.getCapabilities.mockReset().mockResolvedValue(null);
  });

  /** models.dev knows the gateway's own catalog but not the vendor's. */
  const gatewayOnlySync = {
    lookupModelCapabilities: (providerId: string, modelId: string) =>
      providerId === 'opencode-go' && modelId === 'deepseek-v4.1-flash'
        ? makeModelsDevEntry({
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            capabilities: ['text', 'tools'],
            inputModalities: ['text'],
          })
        : null,
  };

  it('falls back to the gateway catalog when the vendor has no entry', async () => {
    const resolved = await resolveModelCapabilityMetadata(
      makeModel({
        id: 'opencode-go/deepseek-v4.1-flash',
        displayName: 'opencode-go/deepseek-v4.1-flash',
        provider: 'opencode-go',
        authType: 'subscription',
      }),
      paramSpecs,
      gatewayOnlySync,
    );

    expect(resolved.modelsDevEntry?.name).toBe('DeepSeek V4.1 Flash');
    expect(resolved.capabilities).toContain('tools');
  });

  it('still prefers the underlying vendor entry when it exists', async () => {
    const bothSync = {
      lookupModelCapabilities: (providerId: string, modelId: string) => {
        if (providerId === 'deepseek' && modelId === 'deepseek-v4-pro') {
          return makeModelsDevEntry({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' });
        }
        if (providerId === 'opencode-go' && modelId === 'deepseek-v4-pro') {
          return makeModelsDevEntry({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (New)' });
        }
        return null;
      },
    };

    const resolved = await resolveModelCapabilityMetadata(
      makeModel({
        id: 'opencode-go/deepseek-v4-pro',
        provider: 'opencode-go',
        authType: 'subscription',
      }),
      paramSpecs,
      bothSync,
    );

    expect(resolved.modelsDevEntry?.name).toBe('DeepSeek V4 Pro');
  });
});
