import {
  PROVIDER_REGISTRY,
  PROVIDER_BY_ID,
  PROVIDER_BY_ID_OR_ALIAS,
  OPENROUTER_PREFIX_TO_PROVIDER,
  ALL_PROVIDER_IDS,
  expandProviderNames,
  ProviderRegistryEntry,
} from './providers';

describe('PROVIDER_REGISTRY', () => {
  it('ollama-cloud has localOnly=false and requiresApiKey=false', () => {
    const cloud = PROVIDER_REGISTRY.find((p) => p.id === 'ollama-cloud');
    expect(cloud).toBeDefined();
    expect(cloud!.displayName).toBe('Ollama Cloud');
    expect(cloud!.localOnly).toBe(false);
    expect(cloud!.requiresApiKey).toBe(false);
    expect(cloud!.aliases).toEqual([]);
    expect(cloud!.openRouterPrefixes).toEqual([]);
  });

  it('every entry has all required fields', () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.displayName).toBe('string');
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(Array.isArray(entry.openRouterPrefixes)).toBe(true);
      expect(typeof entry.requiresApiKey).toBe('boolean');
      expect(typeof entry.localOnly).toBe('boolean');
    }
  });

  it('has no duplicate provider IDs', () => {
    const ids = PROVIDER_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no alias that resolves to multiple different providers', () => {
    const aliasToProvider: Map<string, string> = new Map();
    for (const entry of PROVIDER_REGISTRY) {
      for (const alias of entry.aliases) {
        expect(aliasToProvider.has(alias)).toBe(false);
        aliasToProvider.set(alias, entry.id);
      }
    }
  });

  it('ollama has localOnly=true and requiresApiKey=false', () => {
    const ollama = PROVIDER_REGISTRY.find((p) => p.id === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.localOnly).toBe(true);
    expect(ollama!.requiresApiKey).toBe(false);
  });

  it('openrouter has requiresApiKey=true', () => {
    const openrouter = PROVIDER_REGISTRY.find((p) => p.id === 'openrouter');
    expect(openrouter).toBeDefined();
    expect(openrouter!.requiresApiKey).toBe(true);
  });

  it('anthropic has no aliases', () => {
    const anthropic = PROVIDER_REGISTRY.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.aliases).toEqual([]);
  });

  it('copilot has requiresApiKey=false and localOnly=false', () => {
    const copilot = PROVIDER_REGISTRY.find((p) => p.id === 'copilot');
    expect(copilot).toBeDefined();
    expect(copilot!.displayName).toBe('GitHub Copilot');
    expect(copilot!.requiresApiKey).toBe(false);
    expect(copilot!.localOnly).toBe(false);
    expect(copilot!.aliases).toEqual([]);
    expect(copilot!.openRouterPrefixes).toEqual([]);
  });

  it('opencode-go is registered with opencodego alias and no OpenRouter prefix', () => {
    const og = PROVIDER_REGISTRY.find((p) => p.id === 'opencode-go');
    expect(og).toBeDefined();
    expect(og!.displayName).toBe('OpenCode Go');
    expect(og!.aliases).toEqual(['opencodego']);
    expect(og!.openRouterPrefixes).toEqual([]);
    expect(og!.requiresApiKey).toBe(true);
    expect(og!.localOnly).toBe(false);
  });

  it('opencode-zen is registered as an API-key provider with opencodezen alias', () => {
    const oz = PROVIDER_REGISTRY.find((p) => p.id === 'opencode-zen');
    expect(oz).toBeDefined();
    expect(oz!.displayName).toBe('OpenCode Zen');
    expect(oz!.aliases).toEqual(['opencodezen']);
    expect(oz!.openRouterPrefixes).toEqual([]);
    expect(oz!.requiresApiKey).toBe(true);
    expect(oz!.localOnly).toBe(false);
  });

  it('kilo is registered as a non-local gateway provider', () => {
    const kilo = PROVIDER_REGISTRY.find((p) => p.id === 'kilo');
    expect(kilo).toBeDefined();
    expect(kilo!.displayName).toBe('Kilo');
    expect(kilo!.aliases).toEqual(['kilocode', 'kilo-code']);
    expect(kilo!.openRouterPrefixes).toEqual([]);
    expect(kilo!.requiresApiKey).toBe(true);
    expect(kilo!.localOnly).toBe(false);
    expect(kilo!.color).toBe('#f0e68c');
  });

  it('fireworks is registered as an API-key provider', () => {
    const fireworks = PROVIDER_REGISTRY.find((p) => p.id === 'fireworks');
    expect(fireworks).toBeDefined();
    expect(fireworks!.displayName).toBe('Fireworks AI');
    expect(fireworks!.aliases).toEqual(['fireworks-ai', 'fireworks ai', 'fireworksai']);
    expect(fireworks!.openRouterPrefixes).toEqual([]);
    expect(fireworks!.requiresApiKey).toBe(true);
    expect(fireworks!.localOnly).toBe(false);
    expect(fireworks!.keyPrefix).toBe('fw_');
  });

  it('huggingface is registered as an API-key provider', () => {
    const huggingface = PROVIDER_REGISTRY.find((p) => p.id === 'huggingface');
    expect(huggingface).toBeDefined();
    expect(huggingface!.displayName).toBe('Hugging Face');
    expect(huggingface!.aliases).toEqual(['hugging-face', 'hugging face', 'hf']);
    expect(huggingface!.openRouterPrefixes).toEqual([]);
    expect(huggingface!.requiresApiKey).toBe(true);
    expect(huggingface!.localOnly).toBe(false);
    expect(huggingface!.keyPrefix).toBe('hf_');
  });

  it('kiro is registered as a CLI OAuth subscription provider', () => {
    const kiro = PROVIDER_REGISTRY.find((p) => p.id === 'kiro');
    expect(kiro).toBeDefined();
    expect(kiro!.displayName).toBe('Kiro');
    expect(kiro!.aliases).toEqual([]);
    expect(kiro!.openRouterPrefixes).toEqual([]);
    expect(kiro!.requiresApiKey).toBe(false);
    expect(kiro!.localOnly).toBe(false);
    expect(kiro!.keyPrefix).toBe('');
  });

  it('byteplus is registered as a ModelArk Coding Plan token provider', () => {
    const byteplus = PROVIDER_REGISTRY.find((p) => p.id === 'byteplus');
    expect(byteplus).toBeDefined();
    expect(byteplus!.displayName).toBe('BytePlus');
    expect(byteplus!.aliases).toEqual([
      'byteplus-plan',
      'byteplus plan',
      'modelark',
      'modelark-coding-plan',
    ]);
    expect(byteplus!.openRouterPrefixes).toEqual([]);
    expect(byteplus!.requiresApiKey).toBe(true);
    expect(byteplus!.localOnly).toBe(false);
    expect(byteplus!.keyPlaceholder).toBe('ModelArk Coding Plan API key');
  });

  it('cerebras is registered as an API-key provider', () => {
    const cerebras = PROVIDER_REGISTRY.find((p) => p.id === 'cerebras');
    expect(cerebras).toBeDefined();
    expect(cerebras!.displayName).toBe('Cerebras');
    expect(cerebras!.aliases).toEqual([]);
    expect(cerebras!.openRouterPrefixes).toEqual([]);
    expect(cerebras!.requiresApiKey).toBe(true);
    expect(cerebras!.localOnly).toBe(false);
    expect(cerebras!.keyPrefix).toBe('');
    expect(cerebras!.keyPlaceholder).toBe('Cerebras API key');
  });

  it('pioneer is registered as an API-key provider', () => {
    const pioneer = PROVIDER_REGISTRY.find((p) => p.id === 'pioneer');
    expect(pioneer).toBeDefined();
    expect(pioneer!.displayName).toBe('Pioneer');
    expect(pioneer!.aliases).toEqual(['pioneer-ai', 'pioneer ai']);
    expect(pioneer!.openRouterPrefixes).toEqual([]);
    expect(pioneer!.requiresApiKey).toBe(true);
    expect(pioneer!.localOnly).toBe(false);
    expect(pioneer!.keyPrefix).toBe('pio_sk_');
    expect(pioneer!.keyPlaceholder).toBe('pio_sk_...');
  });

  it('meta is registered as an API-key provider with an OpenRouter fallback prefix', () => {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === 'meta');
    expect(meta).toBeDefined();
    expect(meta!.displayName).toBe('Meta');
    expect(meta!.openRouterPrefixes).toEqual(['meta']);
    expect(meta!.requiresApiKey).toBe(true);
    expect(meta!.localOnly).toBe(false);
    expect(meta!.keyPrefix).toBe('LLM_');
    expect(meta!.keyPlaceholder).toBe('LLM_...');
  });
});

describe('PROVIDER_BY_ID', () => {
  it('resolves every provider ID back to its registry entry', () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(PROVIDER_BY_ID.get(entry.id)).toBe(entry);
    }
    expect(PROVIDER_BY_ID.size).toBe(PROVIDER_REGISTRY.length);
  });

  it('returns undefined for an unknown ID', () => {
    expect(PROVIDER_BY_ID.get('nonexistent')).toBeUndefined();
  });
});

describe('PROVIDER_BY_ID_OR_ALIAS', () => {
  it('resolves every provider ID', () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(PROVIDER_BY_ID_OR_ALIAS.get(entry.id)).toBe(entry);
    }
  });

  it('resolves google alias to gemini entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('google') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('gemini');
    expect(entry.displayName).toBe('Google');
  });

  it('resolves alibaba alias to qwen entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('alibaba') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('qwen');
    expect(entry.displayName).toBe('Alibaba Cloud');
  });

  it('resolves kimi alias to moonshot entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('kimi') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('moonshot');
  });

  it('resolves z.ai alias to zai entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('z.ai') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('zai');
    expect(entry.displayName).toBe('Z.ai');
  });

  it('resolves opencodezen alias to opencode-zen entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('opencodezen') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('opencode-zen');
  });

  it('resolves kilocode alias to kilo entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('kilocode') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('kilo');
    expect(entry.displayName).toBe('Kilo');
  });

  it('resolves fireworks-ai alias to fireworks entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('fireworks-ai') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('fireworks');
    expect(entry.displayName).toBe('Fireworks AI');
  });

  it('resolves modelark alias to byteplus entry', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('modelark') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('byteplus');
    expect(entry.displayName).toBe('BytePlus');
  });

  it('resolves cerebras by canonical id', () => {
    const entry = PROVIDER_BY_ID_OR_ALIAS.get('cerebras') as ProviderRegistryEntry;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('cerebras');
    expect(entry.displayName).toBe('Cerebras');
  });

  it('resolves pioneer aliases to the canonical provider entry', () => {
    for (const name of ['pioneer', 'pioneer-ai', 'pioneer ai']) {
      const entry = PROVIDER_BY_ID_OR_ALIAS.get(name) as ProviderRegistryEntry;
      expect(entry).toBeDefined();
      expect(entry.id).toBe('pioneer');
      expect(entry.displayName).toBe('Pioneer');
    }
  });

  it('returns undefined for an unknown alias', () => {
    expect(PROVIDER_BY_ID_OR_ALIAS.get('nonexistent')).toBeUndefined();
  });
});

describe('OPENROUTER_PREFIX_TO_PROVIDER', () => {
  it('maps every openRouterPrefix to its provider displayName', () => {
    for (const entry of PROVIDER_REGISTRY) {
      for (const prefix of entry.openRouterPrefixes) {
        expect(OPENROUTER_PREFIX_TO_PROVIDER.get(prefix)).toBe(entry.displayName);
      }
    }
  });

  it('total size equals the total number of openRouterPrefixes across all entries', () => {
    const totalPrefixes = PROVIDER_REGISTRY.reduce(
      (sum, p) => sum + p.openRouterPrefixes.length,
      0,
    );
    expect(OPENROUTER_PREFIX_TO_PROVIDER.size).toBe(totalPrefixes);
  });

  it('maps xai and x-ai prefixes to xAI', () => {
    expect(OPENROUTER_PREFIX_TO_PROVIDER.get('xai')).toBe('xAI');
    expect(OPENROUTER_PREFIX_TO_PROVIDER.get('x-ai')).toBe('xAI');
  });

  it('returns undefined for an unknown prefix', () => {
    expect(OPENROUTER_PREFIX_TO_PROVIDER.get('unknown-vendor')).toBeUndefined();
  });
});

describe('ALL_PROVIDER_IDS', () => {
  it('includes all provider IDs', () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(ALL_PROVIDER_IDS.has(entry.id)).toBe(true);
    }
  });

  it('includes all aliases', () => {
    for (const entry of PROVIDER_REGISTRY) {
      for (const alias of entry.aliases) {
        expect(ALL_PROVIDER_IDS.has(alias)).toBe(true);
      }
    }
  });

  it('has size equal to the count of all IDs plus aliases', () => {
    const expected = PROVIDER_REGISTRY.reduce((sum, p) => sum + 1 + p.aliases.length, 0);
    expect(ALL_PROVIDER_IDS.size).toBe(expected);
  });
});

describe('expandProviderNames', () => {
  it('should expand a provider ID to include its aliases', () => {
    const result = expandProviderNames(['gemini']);
    expect(result.has('gemini')).toBe(true);
    expect(result.has('google')).toBe(true);
  });

  it('should expand an alias to include the canonical ID and all sibling aliases', () => {
    const result = expandProviderNames(['google']);
    expect(result.has('google')).toBe(true);
    expect(result.has('gemini')).toBe(true);
  });

  it('should expand moonshot and kimi alias bidirectionally', () => {
    const fromId = expandProviderNames(['moonshot']);
    expect(fromId.has('moonshot')).toBe(true);
    expect(fromId.has('kimi')).toBe(true);

    const fromAlias = expandProviderNames(['kimi']);
    expect(fromAlias.has('moonshot')).toBe(true);
    expect(fromAlias.has('kimi')).toBe(true);
  });

  it('should not expand custom: prefixed names', () => {
    const result = expandProviderNames(['custom:my-provider']);
    expect(result.has('custom:my-provider')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('should lowercase the input names', () => {
    const result = expandProviderNames(['GEMINI']);
    expect(result.has('gemini')).toBe(true);
    expect(result.has('google')).toBe(true);
    expect(result.has('GEMINI')).toBe(false);
  });

  it('should pass through unknown names without expansion', () => {
    const result = expandProviderNames(['unknown-provider']);
    expect(result.has('unknown-provider')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('should handle multiple names in a single call', () => {
    const result = expandProviderNames(['anthropic', 'gemini', 'custom:foo']);
    expect(result.has('anthropic')).toBe(true);
    expect(result.has('gemini')).toBe(true);
    expect(result.has('google')).toBe(true);
    expect(result.has('custom:foo')).toBe(true);
  });

  it('should handle an empty iterable', () => {
    const result = expandProviderNames([]);
    expect(result.size).toBe(0);
  });

  it('should accept any iterable, not just arrays', () => {
    const inputSet = new Set(['qwen']);
    const result = expandProviderNames(inputSet);
    expect(result.has('qwen')).toBe(true);
    expect(result.has('alibaba')).toBe(true);
  });

  it('should lowercase custom: prefix to match the startsWith check', () => {
    const result = expandProviderNames(['Custom:SomeThing']);
    expect(result.has('custom:something')).toBe(true);
    expect(result.size).toBe(1);
  });
});
