import {
  CUSTOM_PROVIDER_ALIAS_PATTERN,
  deriveCustomProviderAlias,
  isReservedCustomProviderAlias,
  normalizeCustomProviderAlias,
} from '../src/custom-provider-alias';

describe('custom provider alias', () => {
  describe('CUSTOM_PROVIDER_ALIAS_PATTERN', () => {
    it.each(['vercel', 'vercel-ai-gateway', 'llama.cpp', 'gw2', 'a'])('accepts %s', (alias) => {
      expect(CUSTOM_PROVIDER_ALIAS_PATTERN.test(alias)).toBe(true);
    });

    it.each(['', 'Vercel', 'vercel ai', 'vercel/ai', '-vercel', 'vercel-', 'a--b', 'a.-b', '.a'])(
      'rejects %j',
      (alias) => {
        expect(CUSTOM_PROVIDER_ALIAS_PATTERN.test(alias)).toBe(false);
      },
    );
  });

  describe('normalizeCustomProviderAlias', () => {
    it('trims and lowercases', () => {
      expect(normalizeCustomProviderAlias('  Vercel-GW ')).toBe('vercel-gw');
    });

    it('maps empty, blank, null and undefined to null', () => {
      expect(normalizeCustomProviderAlias('')).toBeNull();
      expect(normalizeCustomProviderAlias('   ')).toBeNull();
      expect(normalizeCustomProviderAlias(null)).toBeNull();
      expect(normalizeCustomProviderAlias(undefined)).toBeNull();
    });
  });

  describe('isReservedCustomProviderAlias', () => {
    it('reserves the synthetic routes and the custom prefix', () => {
      expect(isReservedCustomProviderAlias('auto')).toBe(true);
      expect(isReservedCustomProviderAlias('manifest')).toBe(true);
      expect(isReservedCustomProviderAlias('custom')).toBe(true);
    });

    it('reserves built-in provider ids and their aliases', () => {
      expect(isReservedCustomProviderAlias('openai')).toBe(true);
      expect(isReservedCustomProviderAlias('google')).toBe(true);
      expect(isReservedCustomProviderAlias('ollama')).toBe(true);
    });

    it('leaves other names free', () => {
      expect(isReservedCustomProviderAlias('vercel-ai-gateway')).toBe(false);
    });

    it('leaves tile-only local providers free, since they only exist as custom providers', () => {
      expect(isReservedCustomProviderAlias('llama.cpp')).toBe(false);
      expect(isReservedCustomProviderAlias('lmstudio')).toBe(false);
      expect(isReservedCustomProviderAlias('lm-studio')).toBe(false);
    });
  });

  describe('deriveCustomProviderAlias', () => {
    it('slugifies a display name', () => {
      expect(deriveCustomProviderAlias('Vercel AI Gateway')).toBe('vercel-ai-gateway');
      expect(deriveCustomProviderAlias('  my_gateway  ')).toBe('my-gateway');
    });

    it('keeps dots so llama.cpp stays recognisable', () => {
      expect(deriveCustomProviderAlias('llama.cpp')).toBe('llama.cpp');
    });

    it('collapses and strips separator runs', () => {
      expect(deriveCustomProviderAlias('--My -- Provider..')).toBe('my-provider');
      expect(deriveCustomProviderAlias('a.-b')).toBe('a.b');
    });

    it('caps the alias at the maximum length without a trailing separator', () => {
      const long = `${'a'.repeat(49)}-bbbbbb`;
      expect(deriveCustomProviderAlias(long)).toBe('a'.repeat(49));
    });

    it('returns null when nothing usable remains', () => {
      expect(deriveCustomProviderAlias('***')).toBeNull();
      expect(deriveCustomProviderAlias('')).toBeNull();
    });

    it('returns null for reserved names so built-in routes stay unambiguous', () => {
      expect(deriveCustomProviderAlias('OpenAI')).toBeNull();
      expect(deriveCustomProviderAlias('auto')).toBeNull();
    });
  });
});
