import {
  getClaudeCodeSettingsSnippet,
  getCodexConfigSnippet,
  getCodexKeyExportSnippet,
  getNanobotConfigSnippet,
  getOpenClawSnippet,
  PLATFORM_SETUP_SNIPPETS,
} from '../src/setup-snippets';

describe('setup snippets', () => {
  const URL = 'https://app.manifest.build/v1';
  const KEY = 'mnfst_test_key';

  it('openclaw snippet wires the provider and restarts the gateway', () => {
    const s = getOpenClawSnippet(URL, KEY);
    expect(s).toContain('models.providers.manifest');
    expect(s).toContain(URL);
    expect(s).toContain(KEY);
    expect(s).toContain('openclaw gateway restart');
  });

  it('claude-code snippet strips /v1 (SDK appends /v1/messages itself)', () => {
    const s = getClaudeCodeSettingsSnippet(URL, KEY);
    expect(s).toContain('"ANTHROPIC_BASE_URL": "https://app.manifest.build"');
    expect(s).toContain(KEY);
    const noV1 = getClaudeCodeSettingsSnippet('https://x.test', KEY);
    expect(noV1).toContain('"ANTHROPIC_BASE_URL": "https://x.test"');
  });

  it('nanobot snippet uses the custom provider slot', () => {
    const s = getNanobotConfigSnippet(URL, KEY);
    expect(s).toContain('"provider": "custom"');
    expect(s).toContain(URL);
    expect(s).toContain(KEY);
  });

  it('codex config pins the Responses wire API and the key export is shell-safe', () => {
    const config = getCodexConfigSnippet(URL);
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain(`base_url = "${URL}"`);
    expect(getCodexKeyExportSnippet(KEY)).toBe(`export MANIFEST_API_KEY="${KEY}"`);
  });

  it('registry maps platforms to their renderers', () => {
    expect(PLATFORM_SETUP_SNIPPETS['openclaw']('u', 'k')).toContain('openclaw');
    expect(PLATFORM_SETUP_SNIPPETS['codex']('u/v1', 'k')).toContain('wire_api = "responses"');
    expect(PLATFORM_SETUP_SNIPPETS['n8n']('u/v1', 'k')).toContain('Base URL: u');
    expect(Object.keys(PLATFORM_SETUP_SNIPPETS).sort()).toEqual([
      'claude-code',
      'codex',
      'n8n',
      'nanobot',
      'openclaw',
    ]);
  });
});
