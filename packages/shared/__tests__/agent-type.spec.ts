import {
  AGENT_CATEGORIES,
  AGENT_PLATFORMS,
  CATEGORY_LABELS,
  PLATFORM_LABELS,
  PLATFORMS_BY_CATEGORY,
  PLATFORM_ICONS,
  coerceAgentPlatform,
  platformIcon,
} from '../src/agent-type';

describe('agent-type', () => {
  it('exposes the full set of categories and platforms', () => {
    expect(AGENT_CATEGORIES).toEqual(['personal', 'automation', 'app', 'coding']);
    expect(AGENT_PLATFORMS).toEqual([
      'openclaw',
      'hermes',
      'nanobot',
      'craft',
      'n8n',
      'claude-code',
      'opencode',
      'codex',
      'openai-sdk',
      'anthropic-sdk',
      'vercel-ai-sdk',
      'langchain',
      'curl',
      'other',
    ]);
  });

  it('places coding as the last category so the picker reads personal → automation → app → coding', () => {
    expect(AGENT_CATEGORIES[AGENT_CATEGORIES.length - 1]).toBe('coding');
  });

  it('provides a human label for every category and platform', () => {
    for (const category of AGENT_CATEGORIES) {
      expect(typeof CATEGORY_LABELS[category]).toBe('string');
      expect(CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
    for (const platform of AGENT_PLATFORMS) {
      expect(typeof PLATFORM_LABELS[platform]).toBe('string');
      expect(PLATFORM_LABELS[platform].length).toBeGreaterThan(0);
    }
  });

  it('labels the new coding category as "Coding Assistant"', () => {
    expect(CATEGORY_LABELS.coding).toBe('Coding Assistant');
  });

  it('labels the automation category as "Automation"', () => {
    expect(CATEGORY_LABELS.automation).toBe('Automation');
  });

  it('maps every category to a non-empty list of platforms that are all registered', () => {
    for (const category of AGENT_CATEGORIES) {
      const platforms = PLATFORMS_BY_CATEGORY[category];
      expect(platforms.length).toBeGreaterThan(0);
      for (const platform of platforms) {
        expect(AGENT_PLATFORMS).toContain(platform);
      }
    }
  });

  it('places coding assistants under coding only, not personal or app', () => {
    expect(PLATFORMS_BY_CATEGORY.coding).toContain('claude-code');
    expect(PLATFORMS_BY_CATEGORY.coding).toContain('opencode');
    expect(PLATFORMS_BY_CATEGORY.coding).toContain('codex');
    expect(PLATFORMS_BY_CATEGORY.personal).not.toContain('claude-code');
    expect(PLATFORMS_BY_CATEGORY.personal).not.toContain('opencode');
    expect(PLATFORMS_BY_CATEGORY.personal).not.toContain('codex');
    expect(PLATFORMS_BY_CATEGORY.app).not.toContain('claude-code');
    expect(PLATFORMS_BY_CATEGORY.app).not.toContain('opencode');
    expect(PLATFORMS_BY_CATEGORY.app).not.toContain('codex');
  });

  it('places n8n under automation only', () => {
    expect(PLATFORMS_BY_CATEGORY.automation).toContain('n8n');
    expect(PLATFORMS_BY_CATEGORY.personal).not.toContain('n8n');
    expect(PLATFORMS_BY_CATEGORY.app).not.toContain('n8n');
    expect(PLATFORMS_BY_CATEGORY.coding).not.toContain('n8n');
  });

  it('keeps "other" available in every category for the unknown-platform fallback', () => {
    for (const category of AGENT_CATEGORIES) {
      expect(PLATFORMS_BY_CATEGORY[category]).toContain('other');
    }
  });

  it('does not duplicate any non-other platform across categories (other is the only sentinel)', () => {
    const seen = new Map<string, string>();
    for (const category of AGENT_CATEGORIES) {
      for (const platform of PLATFORMS_BY_CATEGORY[category]) {
        if (platform === 'other') continue;
        if (seen.has(platform)) {
          throw new Error(
            `Platform "${platform}" appears in both "${seen.get(platform)}" and "${category}"`,
          );
        }
        seen.set(platform, category);
      }
    }
  });

  describe('coerceAgentPlatform', () => {
    it('preserves every registered platform', () => {
      for (const platform of AGENT_PLATFORMS) {
        expect(coerceAgentPlatform(platform)).toBe(platform);
      }
    });

    it('maps missing, unknown, and prototype-like values to other', () => {
      expect(coerceAgentPlatform(null)).toBe('other');
      expect(coerceAgentPlatform(undefined)).toBe('other');
      expect(coerceAgentPlatform('')).toBe('other');
      expect(coerceAgentPlatform('custom-harness')).toBe('other');
      expect(coerceAgentPlatform('__proto__')).toBe('other');
    });
  });

  describe('platformIcon', () => {
    it('returns undefined for missing input', () => {
      expect(platformIcon(null, null)).toBeUndefined();
      expect(platformIcon(undefined, 'personal')).toBeUndefined();
      expect(platformIcon('', 'personal')).toBeUndefined();
    });

    it('treats every falsy platform value the same regardless of category', () => {
      for (const cat of [null, undefined, 'personal', 'automation', 'app', 'coding', 'unknown']) {
        expect(platformIcon(null, cat)).toBeUndefined();
        expect(platformIcon(undefined, cat)).toBeUndefined();
        expect(platformIcon('', cat)).toBeUndefined();
      }
    });

    it('returns the personal-agent icon for "other" in the personal category', () => {
      expect(platformIcon('other', 'personal')).toBe('/icons/other-agent.svg');
    });

    it('returns the generic "other" icon for "other" in any non-personal category', () => {
      expect(platformIcon('other', 'automation')).toBe('/icons/other.svg');
      expect(platformIcon('other', 'app')).toBe('/icons/other.svg');
      expect(platformIcon('other', 'coding')).toBe('/icons/other.svg');
      expect(platformIcon('other', null)).toBe('/icons/other.svg');
      expect(platformIcon('other', undefined)).toBe('/icons/other.svg');
      expect(platformIcon('other', 'not-a-real-category')).toBe('/icons/other.svg');
    });

    it('returns the registered icon for known platforms', () => {
      expect(platformIcon('openclaw', 'personal')).toBe(PLATFORM_ICONS.openclaw);
      expect(platformIcon('hermes', 'personal')).toBe(PLATFORM_ICONS.hermes);
      expect(platformIcon('nanobot', 'personal')).toBe(PLATFORM_ICONS.nanobot);
      expect(platformIcon('n8n', 'automation')).toBe(PLATFORM_ICONS.n8n);
      expect(platformIcon('claude-code', 'coding')).toBe(PLATFORM_ICONS['claude-code']);
      expect(platformIcon('opencode', 'coding')).toBe(PLATFORM_ICONS.opencode);
      expect(platformIcon('codex', 'coding')).toBe(PLATFORM_ICONS.codex);
      expect(platformIcon('openai-sdk', 'app')).toBe(PLATFORM_ICONS['openai-sdk']);
      expect(platformIcon('anthropic-sdk', 'app')).toBe(PLATFORM_ICONS['anthropic-sdk']);
      expect(platformIcon('vercel-ai-sdk', 'app')).toBe(PLATFORM_ICONS['vercel-ai-sdk']);
      expect(platformIcon('langchain', 'app')).toBe(PLATFORM_ICONS.langchain);
    });

    it('claude-code resolves to the official providers/claude-code.svg mark on main', () => {
      // Pinning the path explicitly so a future drift away from the upstream
      // Claude mark fails this test loudly rather than silently.
      expect(platformIcon('claude-code', 'coding')).toBe('/icons/providers/claude-code.svg');
    });

    it('opencode resolves to the providers/opencode.svg mark', () => {
      expect(platformIcon('opencode', 'coding')).toBe('/icons/providers/opencode.svg');
    });

    it('codex resolves to the providers/codex.svg mark', () => {
      expect(platformIcon('codex', 'coding')).toBe('/icons/providers/codex.svg');
    });

    it('returns the platform icon regardless of the category passed (icon is keyed by platform)', () => {
      // Even if the caller passes an inconsistent (platform, category) pair —
      // e.g. a stale row in the DB — we still resolve to the registered icon
      // for the platform. Only "other" branches on category.
      expect(platformIcon('claude-code', 'personal')).toBe(PLATFORM_ICONS['claude-code']);
      expect(platformIcon('claude-code', null)).toBe(PLATFORM_ICONS['claude-code']);
      expect(platformIcon('opencode', 'personal')).toBe(PLATFORM_ICONS.opencode);
      expect(platformIcon('openclaw', 'coding')).toBe(PLATFORM_ICONS.openclaw);
    });

    it('returns undefined for platforms with no registered icon', () => {
      expect(platformIcon('curl', 'app')).toBeUndefined();
    });

    it('returns undefined for unknown platform strings (no injection via string)', () => {
      expect(platformIcon('not-a-real-platform', 'personal')).toBeUndefined();
      expect(platformIcon('__proto__', 'personal')).toBeUndefined();
      expect(platformIcon('constructor', 'personal')).toBeUndefined();
    });

    it('every registered icon path is a relative path under /icons/', () => {
      for (const path of Object.values(PLATFORM_ICONS)) {
        expect(path).toMatch(/^\/icons\//);
      }
    });
  });
});
