import {
  filterNonChatModels,
  UNIVERSAL_NON_CHAT_RE,
  PROVIDER_NON_CHAT,
  PROVIDER_BLOCKLIST,
} from './provider-model-fetcher.service';
import { DiscoveredModel } from './model-fetcher';

function makeModel(id: string, provider = 'test'): DiscoveredModel {
  return {
    id,
    displayName: id,
    provider,
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
  };
}

describe('filterNonChatModels', () => {
  describe('universal non-chat patterns', () => {
    const nonChatIds = [
      'text-embedding-ada-002',
      'text-embedding-3-large',
      'tts-1',
      'tts-1-hd',
      'whisper-1',
      'dall-e-3',
      'dall-e-2',
      'imagen-3.0-generate-002',
      'cogview-3-plus',
      'wanx-v1',
      'sambert-v1',
      'paraformer-v2',
      'speech-to-text-model',
      'voice-alloy',
      'audio-turbo-v1',
    ];

    it.each(nonChatIds)('filters out "%s" for any provider', (modelId) => {
      const models = [makeModel(modelId), makeModel('gpt-4o')];
      const result = filterNonChatModels(models, 'unknown-provider');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    it('keeps chat-compatible models through universal filter', () => {
      const chatModels = [
        makeModel('gpt-4o'),
        makeModel('claude-sonnet-4'),
        makeModel('gemini-2.5-flash'),
        makeModel('deepseek-chat'),
      ];
      const result = filterNonChatModels(chatModels, 'unknown-provider');
      expect(result).toHaveLength(4);
    });
  });

  describe('universal regex', () => {
    it('matches embed case-insensitively', () => {
      expect(UNIVERSAL_NON_CHAT_RE.test('text-EMBEDDING-large')).toBe(true);
    });

    it('does not match partial words that happen to contain "embed"', () => {
      // "embed" substring in the middle still matches by design
      expect(UNIVERSAL_NON_CHAT_RE.test('some-embed-model')).toBe(true);
    });
  });

  describe('OpenAI-specific patterns', () => {
    const openaiNonChat = [
      'text-moderation-latest',
      'davinci-002',
      'babbage-002',
      'text-davinci-003',
      'gpt-4o-mini-realtime-preview',
      'gpt-4o-transcribe',
      'sora-v1',
      'gpt-3.5-turbo-instruct',
      'gpt-4o-audio-preview',
      'chatgpt-image-latest',
      'chatgpt-image-i-20250326',
    ];

    it.each(openaiNonChat)('filters out "%s" for openai config key', (modelId) => {
      const models = [makeModel(modelId), makeModel('gpt-4o')];
      const result = filterNonChatModels(models, 'openai');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    it('keeps chat models for openai', () => {
      const models = [makeModel('gpt-4o'), makeModel('gpt-4o-mini')];
      const result = filterNonChatModels(models, 'openai');
      expect(result).toHaveLength(2);
    });

    it('filters search-api models for openai', () => {
      const models = [makeModel('gpt-5-search-api'), makeModel('gpt-4o-search-preview')];
      const result = filterNonChatModels(models, 'openai');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o-search-preview']);
    });
  });

  describe('OpenAI subscription patterns', () => {
    it('filters moderation models for openai-subscription', () => {
      const models = [makeModel('text-moderation-latest'), makeModel('gpt-4o')];
      const result = filterNonChatModels(models, 'openai-subscription');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    it('filters audio models for openai-subscription', () => {
      const models = [makeModel('gpt-4o-audio-preview'), makeModel('gpt-4o')];
      const result = filterNonChatModels(models, 'openai-subscription');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    it('filters chatgpt-image models for openai-subscription', () => {
      const models = [makeModel('chatgpt-image-latest'), makeModel('gpt-4o')];
      const result = filterNonChatModels(models, 'openai-subscription');
      expect(result.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    it('filters ChatGPT-account unsupported Codex models for openai-subscription', () => {
      const models = [
        makeModel('gpt-5.5'),
        makeModel('gpt-5.3-codex'),
        makeModel('gpt-5.2-codex'),
        makeModel('gpt-5.2'),
        makeModel('gpt-5.1-codex-max'),
        makeModel('gpt-5.1-codex'),
        makeModel('gpt-5.3-codex-spark'),
      ];

      const result = filterNonChatModels(models, 'openai-subscription');

      expect(result.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.3-codex-spark']);
    });
  });

  describe('Gemini-specific patterns', () => {
    it('filters aqs- prefixed models', () => {
      const models = [makeModel('aqs-gemini-model'), makeModel('gemini-2.5-flash')];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    });

    it('filters nano-banana models', () => {
      const models = [makeModel('nano-banana'), makeModel('gemini-2.5-pro')];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-pro']);
    });

    it('filters deep-research models', () => {
      const models = [
        makeModel('deep-research-pro-preview-12-2025'),
        makeModel('gemini-2.5-flash'),
      ];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    });

    it('filters computer-use models', () => {
      const models = [
        makeModel('gemini-2.5-computer-use-preview-10-2025'),
        makeModel('gemini-2.5-flash'),
      ];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    });

    it('filters lyria models', () => {
      const models = [makeModel('lyria-3-clip-preview'), makeModel('gemini-2.5-pro')];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-pro']);
    });

    it('filters deprecated gemini-2.0-flash-lite', () => {
      const models = [makeModel('gemini-2.0-flash-lite'), makeModel('gemini-2.5-flash')];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    });

    it('filters flash-lite-preview deprecated snapshots', () => {
      const models = [
        makeModel('gemini-2.5-flash-lite-preview-09-2025'),
        makeModel('gemini-3.0-flash-lite-preview-01-2026'),
        makeModel('gemini-2.5-flash'),
      ];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    });

    it('keeps non-preview flash-lite models', () => {
      const models = [makeModel('gemini-2.5-flash-lite'), makeModel('gemini-3.0-flash-lite')];
      const result = filterNonChatModels(models, 'gemini');
      expect(result).toHaveLength(2);
    });

    it('keeps canonical flash-lite-preview aliases without a date suffix', () => {
      // Issue #1814: gemini-3.1-flash-lite-preview is the live, non-deprecated
      // preview alias. Only the dated snapshot variants are deprecated.
      const models = [
        makeModel('gemini-3.1-flash-lite-preview'),
        makeModel('gemini-3-flash-lite-preview'),
      ];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual([
        'gemini-3.1-flash-lite-preview',
        'gemini-3-flash-lite-preview',
      ]);
    });

    it('keeps gemini-image models but filters robotics models', () => {
      const models = [
        makeModel('gemini-2.5-flash-image'),
        makeModel('gemini-3-pro-image-preview'),
        makeModel('gemini-robotics-er-1.5-preview'),
      ];
      const result = filterNonChatModels(models, 'gemini');
      expect(result.map((m) => m.id)).toEqual([
        'gemini-2.5-flash-image',
        'gemini-3-pro-image-preview',
      ]);
    });
  });

  describe('Gemini Free LiteLLM catalog', () => {
    it('keeps usable Gemini chat models', () => {
      const models = [
        makeModel('gemini/gemini-2.5-flash'),
        makeModel('gemini/gemini-2.5-pro'),
        makeModel('gemini/gemini-3-flash-preview'),
      ];
      expect(filterNonChatModels(models, 'gemini-free')).toEqual(models);
    });

    it('filters media-only, retired, and experimental Gemini models', () => {
      const models = [
        makeModel('gemini/gemini-2.5-flash'),
        makeModel('gemini/gemini-2.5-flash-image'),
        makeModel('gemini/gemini-2.5-flash-native-audio-latest'),
        makeModel('gemini/gemini-1.5-flash'),
        makeModel('gemini/gemini-exp-1206'),
        makeModel('gemini/veo-3.1-generate-001'),
      ];
      expect(filterNonChatModels(models, 'gemini-free').map((model) => model.id)).toEqual([
        'gemini/gemini-2.5-flash',
      ]);
    });
  });

  describe('Mistral-specific patterns', () => {
    it('filters mistral-ocr model', () => {
      const models = [makeModel('mistral-ocr'), makeModel('mistral-large-latest')];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('filters mistral-moderation models', () => {
      const models = [
        makeModel('mistral-moderation-latest'),
        makeModel('mistral-moderation-2411'),
        makeModel('mistral-large-latest'),
      ];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('filters voxtral transcribe models', () => {
      const models = [makeModel('voxtral-mini-transcribe-2507'), makeModel('mistral-large-latest')];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('filters voxtral realtime models', () => {
      const models = [
        makeModel('voxtral-mini-realtime-latest'),
        makeModel('voxtral-mini-realtime-2602'),
        makeModel('voxtral-mini-transcribe-realtime-2602'),
        makeModel('mistral-large-latest'),
      ];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('keeps voxtral chat models', () => {
      const models = [makeModel('voxtral-mini-latest'), makeModel('voxtral-small-latest')];
      const result = filterNonChatModels(models, 'mistral');
      expect(result).toHaveLength(2);
    });

    it('filters mistral-vibe-cli models', () => {
      const models = [
        makeModel('mistral-vibe-cli-latest'),
        makeModel('mistral-vibe-cli-fast'),
        makeModel('mistral-vibe-cli-with-tools'),
        makeModel('mistral-large-latest'),
      ];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('keeps mistral-vibe-cli models for subscription discovery', () => {
      const models = [makeModel('mistral-vibe-cli-latest'), makeModel('mistral-large-latest')];
      const result = filterNonChatModels(models, 'mistral-subscription');
      expect(result.map((m) => m.id)).toEqual(['mistral-vibe-cli-latest', 'mistral-large-latest']);
    });

    it('filters labs-prefixed models', () => {
      const models = [makeModel('labs-leanstral-2603'), makeModel('mistral-large-latest')];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('filters any future labs-* model', () => {
      const models = [makeModel('labs-future-model-2707'), makeModel('codestral-latest')];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['codestral-latest']);
    });

    it('filters blocklisted model voxtral-mini-2602', () => {
      const models = [makeModel('voxtral-mini-2602'), makeModel('mistral-large-latest')];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });

    it('filters all labs- prefixed models including labs-devstral', () => {
      const models = [
        makeModel('labs-devstral-small-2512'),
        makeModel('labs-mistral-small-creative'),
        makeModel('mistral-large-latest'),
      ];
      const result = filterNonChatModels(models, 'mistral');
      expect(result.map((m) => m.id)).toEqual(['mistral-large-latest']);
    });
  });

  describe('xAI-specific patterns', () => {
    const xaiNonChat = ['grok-imagine-image', 'grok-imagine-image-pro', 'grok-imagine-video'];

    it.each(xaiNonChat)('filters out "%s" for xai config key', (modelId) => {
      const models = [makeModel(modelId), makeModel('grok-3')];
      const result = filterNonChatModels(models, 'xai');
      expect(result.map((m) => m.id)).toEqual(['grok-3']);
    });

    it('keeps chat models for xai', () => {
      const models = [makeModel('grok-3'), makeModel('grok-3-mini')];
      const result = filterNonChatModels(models, 'xai');
      expect(result).toHaveLength(2);
    });

    it('keeps xAI multi-agent models because the proxy routes them to Responses API', () => {
      const models = [makeModel('grok-4.20-multi-agent-0309'), makeModel('grok-3')];
      const result = filterNonChatModels(models, 'xai');
      expect(result.map((m) => m.id)).toEqual(['grok-4.20-multi-agent-0309', 'grok-3']);
    });

    it('keeps future xAI multi-agent models for Responses API routing', () => {
      const models = [makeModel('grok-5-multi-agent-0612'), makeModel('grok-3')];
      const result = filterNonChatModels(models, 'xai');
      expect(result.map((m) => m.id)).toEqual(['grok-5-multi-agent-0612', 'grok-3']);
    });
  });

  describe('Fireworks-specific patterns', () => {
    it('filters non-chat serverless models while preserving chat account IDs', () => {
      const models = [
        makeModel('accounts/fireworks/models/deepseek-v3p1'),
        makeModel('accounts/fireworks/models/flux-1-schnell'),
        makeModel('accounts/fireworks/models/nomic-embed-text-v1'),
        makeModel('accounts/fireworks/models/fireworks-rerank-v1'),
      ];
      const result = filterNonChatModels(models, 'fireworks');
      expect(result.map((m) => m.id)).toEqual(['accounts/fireworks/models/deepseek-v3p1']);
    });
  });

  describe('providers without specific filters', () => {
    it('only applies universal filter for unknown config keys', () => {
      const models = [makeModel('some-chat-model'), makeModel('text-embedding-ada')];
      const result = filterNonChatModels(models, 'anthropic');
      expect(result.map((m) => m.id)).toEqual(['some-chat-model']);
    });
  });

  describe('empty input', () => {
    it('returns empty array when given empty input', () => {
      expect(filterNonChatModels([], 'openai')).toEqual([]);
    });
  });

  describe('Bedrock-specific patterns', () => {
    it('filters Voxtral models returned through Bedrock while keeping other Mistral Bedrock models', () => {
      const models = [
        makeModel('mistral.voxtral-mini-3b-2507'),
        makeModel('mistral.voxtral-small-24b-2507'),
        makeModel('mistral.ministral-3-8b-instruct'),
      ];
      const result = filterNonChatModels(models, 'bedrock');
      expect(result.map((m) => m.id)).toEqual(['mistral.ministral-3-8b-instruct']);
    });
  });

  describe('PROVIDER_NON_CHAT registry', () => {
    it('has entries for openai, openai-subscription, fireworks, gemini, mistral, and xai', () => {
      expect(PROVIDER_NON_CHAT).toHaveProperty('openai');
      expect(PROVIDER_NON_CHAT).toHaveProperty('openai-subscription');
      expect(PROVIDER_NON_CHAT).toHaveProperty('fireworks');
      expect(PROVIDER_NON_CHAT).toHaveProperty('gemini');
      expect(PROVIDER_NON_CHAT).toHaveProperty('mistral');
      expect(PROVIDER_NON_CHAT).toHaveProperty('xai');
      expect(PROVIDER_NON_CHAT).toHaveProperty('bedrock');
    });
  });

  describe('PROVIDER_BLOCKLIST', () => {
    it('has blocklist entry for ChatGPT-account unsupported OpenAI subscription models', () => {
      expect(PROVIDER_BLOCKLIST).toHaveProperty('openai-subscription');
      expect(PROVIDER_BLOCKLIST['openai-subscription'].has('gpt-5.3-codex')).toBe(true);
      expect(PROVIDER_BLOCKLIST['openai-subscription'].has('gpt-5.2-codex')).toBe(true);
      expect(PROVIDER_BLOCKLIST['openai-subscription'].has('gpt-5.2')).toBe(true);
      expect(PROVIDER_BLOCKLIST['openai-subscription'].has('gpt-5.1-codex-max')).toBe(true);
      expect(PROVIDER_BLOCKLIST['openai-subscription'].has('gpt-5.1-codex')).toBe(true);
    });

    it('has blocklist entry for mistral voxtral-mini-2602', () => {
      expect(PROVIDER_BLOCKLIST).toHaveProperty('mistral');
      expect(PROVIDER_BLOCKLIST.mistral.has('voxtral-mini-2602')).toBe(true);
    });

    it('does not blocklist valid voxtral models', () => {
      expect(PROVIDER_BLOCKLIST.mistral.has('voxtral-mini-latest')).toBe(false);
      expect(PROVIDER_BLOCKLIST.mistral.has('voxtral-mini-2507')).toBe(false);
    });
  });
});
