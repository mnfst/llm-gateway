import {
  SHARED_PROVIDERS,
  SHARED_PROVIDER_BY_ID,
  SHARED_PROVIDER_BY_ID_OR_ALIAS,
  LOCAL_SERVER_HINTS,
  META_MODEL_API_CONTEXT_WINDOW,
  META_MODEL_API_MODELS,
  META_MODEL_API_MODEL_BY_ID,
  normalizeProviderName,
} from '../src/providers';

describe('normalizeProviderName', () => {
  it('lowercases the input', () => {
    expect(normalizeProviderName('LM Studio')).toBe('lmstudio');
    expect(normalizeProviderName('ANTHROPIC')).toBe('anthropic');
  });

  it('collapses whitespace, dots, hyphens, and underscores', () => {
    // All variants of the same name must hash to the same key so the
    // registry lookup works regardless of how the user typed the name.
    expect(normalizeProviderName('lm studio')).toBe('lmstudio');
    expect(normalizeProviderName('lm-studio')).toBe('lmstudio');
    expect(normalizeProviderName('lm.studio')).toBe('lmstudio');
    expect(normalizeProviderName('lm_studio')).toBe('lmstudio');
    expect(normalizeProviderName('llama.cpp')).toBe('llamacpp');
    expect(normalizeProviderName('llama-cpp')).toBe('llamacpp');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeProviderName('  openai  ')).toBe('openai');
  });

  it('collapses runs of separators to a single removal (not a single dash)', () => {
    // "a -_ b" must produce "ab", not "a-b" or "a_b".
    expect(normalizeProviderName('a -_ b')).toBe('ab');
  });
});

describe('SHARED_PROVIDER_BY_ID_OR_ALIAS', () => {
  it('resolves canonical ids to their shared entry', () => {
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get('anthropic')?.id).toBe('anthropic');
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get('openai')?.id).toBe('openai');
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get('llamacpp')?.id).toBe('llamacpp');
  });

  it('resolves every declared alias to the same entry as its canonical id', () => {
    for (const p of SHARED_PROVIDERS) {
      for (const alias of p.aliases) {
        const entryByAlias = SHARED_PROVIDER_BY_ID_OR_ALIAS.get(alias);
        expect(entryByAlias?.id).toBe(p.id);
      }
    }
  });

  it('resolves llama.cpp and lm-studio aliases to their canonical tile-only entries', () => {
    // These are the aliases consumed by CustomProviderService.canonicalTileIdForName
    // to rewrite `custom:<uuid>` provider rows into first-class dashboard entries.
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName('llama.cpp'))?.id).toBe(
      'llamacpp',
    );
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName('LM Studio'))?.id).toBe(
      'lmstudio',
    );
  });

  it('resolves NVIDIA NIM aliases to the canonical provider entry', () => {
    for (const name of ['nvidia', 'nvidia-nim', 'nvidia nim', 'nim']) {
      expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName(name))?.id).toBe('nvidia');
    }
  });

  it('resolves Fireworks AI aliases to the canonical provider entry', () => {
    for (const name of ['fireworks', 'fireworks-ai', 'fireworks ai']) {
      expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName(name))?.id).toBe('fireworks');
    }
  });

  it('resolves Atlas Cloud aliases to its canonical provider entry', () => {
    for (const name of ['atlascloud', 'atlas-cloud', 'atlas cloud']) {
      expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalizeProviderName(name))?.id).toBe(
        'atlascloud',
      );
    }
  });

  it('resolves Hugging Face aliases to the canonical provider entry', () => {
    for (const name of ['huggingface', 'hugging-face', 'Hugging Face', 'hf']) {
      const normalized = normalizeProviderName(name);
      const entry =
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
      expect(entry?.id).toBe('huggingface');
    }
  });

  it('resolves Command Code aliases to the canonical provider entry', () => {
    for (const name of ['commandcode', 'command-code', 'Command Code', 'cmd']) {
      const normalized = normalizeProviderName(name);
      const entry =
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
      expect(entry?.id).toBe('commandcode');
    }
  });

  it('resolves BytePlus ModelArk aliases to the canonical provider entry', () => {
    for (const name of ['byteplus', 'byteplus-plan', 'BytePlus Plan', 'ModelArk']) {
      const normalized = normalizeProviderName(name);
      const entry =
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
      expect(entry?.id).toBe('byteplus');
    }
  });

  it('resolves AWS Bedrock aliases to the canonical provider entry', () => {
    for (const name of ['bedrock', 'aws-bedrock', 'Amazon Bedrock']) {
      const normalized = normalizeProviderName(name);
      const entry =
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
      expect(entry?.id).toBe('bedrock');
    }
  });

  it('resolves Xiaomi MiMo aliases to the canonical provider entry', () => {
    for (const name of ['xiaomi', 'mimo', 'xiaomi-mimo', 'Xiaomi MiMo']) {
      const normalized = normalizeProviderName(name);
      const entry =
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
      expect(entry?.id).toBe('xiaomi');
    }
  });

  it('resolves Nous Research aliases to the canonical provider entry', () => {
    for (const name of ['nous', 'nousresearch', 'nous-research', 'Nous Research']) {
      const normalized = normalizeProviderName(name);
      const entry =
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(normalized) ??
        SHARED_PROVIDER_BY_ID_OR_ALIAS.get(name.toLowerCase());
      expect(entry?.id).toBe('nous');
    }
  });

  it('returns undefined for unknown names', () => {
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get('unknownprovider')).toBeUndefined();
  });
});

describe('SHARED_PROVIDER_BY_ID', () => {
  it('is keyed by canonical id only (aliases do not resolve)', () => {
    // Alibaba has alias 'alibaba' → both must resolve via BY_ID_OR_ALIAS
    // but only the canonical 'qwen' must resolve via BY_ID.
    expect(SHARED_PROVIDER_BY_ID.get('qwen')?.id).toBe('qwen');
    expect(SHARED_PROVIDER_BY_ID.get('alibaba')).toBeUndefined();
    expect(SHARED_PROVIDER_BY_ID_OR_ALIAS.get('alibaba')?.id).toBe('qwen');
  });

  it('groq has no openRouter prefixes (native /models is authoritative)', () => {
    // Mapping OpenRouter's `groq/*` prefix here would surface OR-cached
    // models that the user can't actually call (e.g. compound-*) and would
    // render them with the OpenRouter logo instead of the Groq one.
    const groq = SHARED_PROVIDER_BY_ID.get('groq');
    expect(groq).toBeDefined();
    expect(groq!.openRouterPrefixes).toEqual([]);
  });

  it('registers Gemini Free separately from the Google provider', () => {
    const provider = SHARED_PROVIDER_BY_ID.get('gemini-free');
    expect(provider).toBeDefined();
    expect(provider!.displayName).toBe('Gemini Free');
    expect(provider!.aliases).toEqual(['gemini free']);
    expect(provider!.openRouterPrefixes).toEqual([]);
    expect(provider!.keyPlaceholder).toBe('sk-...');
    expect(provider!.managedFree).toBe(true);
  });

  it('nvidia has no openRouter prefixes (native NIM /models is authoritative)', () => {
    const nvidia = SHARED_PROVIDER_BY_ID.get('nvidia');
    expect(nvidia).toBeDefined();
    expect(nvidia!.openRouterPrefixes).toEqual([]);
  });

  it('fireworks has no openRouter prefixes (native serverless /models is authoritative)', () => {
    const fireworks = SHARED_PROVIDER_BY_ID.get('fireworks');
    expect(fireworks).toBeDefined();
    expect(fireworks!.openRouterPrefixes).toEqual([]);
  });

  it('huggingface exposes API-key provider metadata', () => {
    const huggingface = SHARED_PROVIDER_BY_ID.get('huggingface');
    expect(huggingface).toBeDefined();
    expect(huggingface!.displayName).toBe('Hugging Face');
    expect(huggingface!.openRouterPrefixes).toEqual([]);
    expect(huggingface!.keyPrefix).toBe('hf_');
    expect(huggingface!.minKeyLength).toBe(20);
    expect(huggingface!.keyPlaceholder).toBe('hf_...');
  });

  it('commandcode has no openRouter prefixes (native Provider API /models is authoritative)', () => {
    const commandcode = SHARED_PROVIDER_BY_ID.get('commandcode');
    expect(commandcode).toBeDefined();
    expect(commandcode!.displayName).toBe('Command Code');
    expect(commandcode!.openRouterPrefixes).toEqual([]);
    expect(commandcode!.keyPrefix).toBe('user_');
  });

  it('byteplus has no OpenRouter prefixes (native Coding Plan /models is authoritative)', () => {
    const byteplus = SHARED_PROVIDER_BY_ID.get('byteplus');
    expect(byteplus).toBeDefined();
    expect(byteplus!.displayName).toBe('BytePlus');
    expect(byteplus!.openRouterPrefixes).toEqual([]);
    expect(byteplus!.keyPlaceholder).toBe('ModelArk Coding Plan API key');
  });

  it('cerebras exposes API-key provider metadata', () => {
    const cerebras = SHARED_PROVIDER_BY_ID.get('cerebras');
    expect(cerebras).toBeDefined();
    expect(cerebras!.displayName).toBe('Cerebras');
    expect(cerebras!.openRouterPrefixes).toEqual([]);
    expect(cerebras!.keyPrefix).toBe('');
    expect(cerebras!.minKeyLength).toBe(20);
    expect(cerebras!.keyPlaceholder).toBe('Cerebras API key');
  });

  it('pioneer exposes API-key provider metadata', () => {
    const pioneer = SHARED_PROVIDER_BY_ID.get('pioneer');
    expect(pioneer).toBeDefined();
    expect(pioneer!.displayName).toBe('Pioneer');
    expect(pioneer!.openRouterPrefixes).toEqual([]);
    expect(pioneer!.keyPrefix).toBe('pio_sk_');
    expect(pioneer!.minKeyLength).toBe(20);
    expect(pioneer!.keyPlaceholder).toBe('pio_sk_...');
  });

  it('nous exposes subscription-gateway provider metadata', () => {
    const nous = SHARED_PROVIDER_BY_ID.get('nous');
    expect(nous).toBeDefined();
    expect(nous!.displayName).toBe('NousResearch');
    expect(nous!.openRouterPrefixes).toEqual([]);
    expect(nous!.keyPrefix).toBe('');
    expect(nous!.minKeyLength).toBe(10);
    expect(nous!.keyPlaceholder).toBe('NousResearch API key');
  });

  it('bedrock has no OpenRouter prefixes and accepts raw AWS bearer token metadata', () => {
    const bedrock = SHARED_PROVIDER_BY_ID.get('bedrock');
    expect(bedrock).toBeDefined();
    expect(bedrock!.displayName).toBe('AWS Bedrock');
    expect(bedrock!.openRouterPrefixes).toEqual([]);
    expect(bedrock!.keyPrefix).toBe('');
    expect(bedrock!.keyPlaceholder).toBe('ABSK...');
  });

  it('xiaomi exposes the MiMo API-key provider metadata', () => {
    const xiaomi = SHARED_PROVIDER_BY_ID.get('xiaomi');
    expect(xiaomi).toBeDefined();
    expect(xiaomi!.displayName).toBe('Xiaomi MiMo');
    expect(xiaomi!.openRouterPrefixes).toEqual(['xiaomi']);
    expect(xiaomi!.keyPrefix).toBe('sk-');
    expect(xiaomi!.minKeyLength).toBe(50);
    expect(xiaomi!.keyPlaceholder).toBe('sk-xxxxx');
  });

  it('meta exposes Model API credentials and the current Muse Spark catalog', () => {
    const meta = SHARED_PROVIDER_BY_ID.get('meta');
    expect(meta).toBeDefined();
    expect(meta!.displayName).toBe('Meta');
    expect(meta!.openRouterPrefixes).toEqual(['meta']);
    expect(meta!.keyPrefix).toBe('LLM_');
    expect(meta!.minKeyLength).toBe(20);
    expect(meta!.keyPlaceholder).toBe('LLM_...');
    expect(META_MODEL_API_CONTEXT_WINDOW).toBe(1_048_576);
    expect(META_MODEL_API_MODELS.map((model) => model.id)).toEqual([
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ]);
    expect(META_MODEL_API_MODEL_BY_ID.get('muse-spark-1.2-contributor')?.displayName).toMatch(
      /may train Meta/,
    );
  });
});

describe('LOCAL_SERVER_HINTS', () => {
  it('provides a setup hint for every tileOnly / localOnly registry entry that users connect via the tile UI', () => {
    // Every provider with a local-server setup flow (llama.cpp, LM Studio,
    // Ollama) must ship a hint so the failure state has something to show.
    // Ollama-cloud is NOT local so it's excluded.
    const tileLocalIds = SHARED_PROVIDERS.filter(
      (p) => p.tileOnly || (p.localOnly && p.id !== 'ollama-cloud'),
    ).map((p) => p.id);
    for (const id of tileLocalIds) {
      expect(LOCAL_SERVER_HINTS[id]).toBeDefined();
      expect(LOCAL_SERVER_HINTS[id].setupCommand).toBeTruthy();
      expect(LOCAL_SERVER_HINTS[id].installUrl).toBeTruthy();
    }
  });

  it('supplies a notReachableHint for llama.cpp (pre-b3800 builds have no /v1/models)', () => {
    // The failure state surfaces this as a clickable escape hatch to the
    // custom-provider form when the probe 404s on old llama-server builds.
    const hint = LOCAL_SERVER_HINTS.llamacpp;
    expect(hint.notReachableHint).toBeDefined();
    expect(hint.notReachableHint!.linkLabel).toBe('Add custom provider');
    expect(hint.notReachableHint!.before).toMatch(/\/v1\/models/);
    expect(hint.notReachableHint!.after).toMatch(/register the model/);
  });

  it('sets persistsBindAcrossLaunches only for LM Studio (GUI-wrapped providers)', () => {
    // The frontend gates the "Developer → Start Server" fallback copy on
    // this flag; CLI-only servers (llama.cpp) must NOT trigger it.
    expect(LOCAL_SERVER_HINTS.lmstudio.persistsBindAcrossLaunches).toBe(true);
    expect(LOCAL_SERVER_HINTS.llamacpp.persistsBindAcrossLaunches).toBeUndefined();
    expect(LOCAL_SERVER_HINTS.ollama.persistsBindAcrossLaunches).toBeUndefined();
  });
});
