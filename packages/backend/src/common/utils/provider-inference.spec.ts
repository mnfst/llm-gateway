import { inferProviderFromModel } from './provider-inference';

describe('inferProviderFromModel', () => {
  it('returns "custom" for custom:<uuid>/model pattern', () => {
    expect(inferProviderFromModel('custom:abc-123/my-llama')).toBe('custom');
  });

  it('returns "ollama" for colon-tagged models (not :free)', () => {
    expect(inferProviderFromModel('qwen2.5:0.5b')).toBe('ollama');
    expect(inferProviderFromModel('llama3:latest')).toBe('ollama');
  });

  it('returns "openrouter" for openrouter/ prefix', () => {
    expect(inferProviderFromModel('openrouter/auto')).toBe('openrouter');
  });

  it('returns "anthropic" for claude- prefix', () => {
    expect(inferProviderFromModel('claude-opus-4-6')).toBe('anthropic');
    expect(inferProviderFromModel('claude-3-5-sonnet-20241022')).toBe('anthropic');
  });

  it('returns "openai" for gpt- and o-series models', () => {
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('gpt-4.1')).toBe('openai');
    expect(inferProviderFromModel('o3-mini')).toBe('openai');
    expect(inferProviderFromModel('o4-mini')).toBe('openai');
    expect(inferProviderFromModel('chatgpt-4o-latest')).toBe('openai');
  });

  it('returns "gemini" for gemini- prefix', () => {
    expect(inferProviderFromModel('gemini-2.0-flash')).toBe('gemini');
    expect(inferProviderFromModel('gemini-2.5-pro')).toBe('gemini');
  });

  it('returns "deepseek" for deepseek- prefix', () => {
    expect(inferProviderFromModel('deepseek-chat')).toBe('deepseek');
    expect(inferProviderFromModel('deepseek-reasoner')).toBe('deepseek');
  });

  it('returns "xai" for grok- prefix', () => {
    expect(inferProviderFromModel('grok-3')).toBe('xai');
  });

  it('returns "mistral" for mistral-/codestral/pixtral/open-mistral', () => {
    expect(inferProviderFromModel('mistral-large')).toBe('mistral');
    expect(inferProviderFromModel('codestral')).toBe('mistral');
    expect(inferProviderFromModel('pixtral-large-latest')).toBe('mistral');
    expect(inferProviderFromModel('open-mistral-nemo')).toBe('mistral');
  });

  it('returns "moonshot" for kimi-/moonshot- prefix', () => {
    expect(inferProviderFromModel('kimi-k2')).toBe('moonshot');
    expect(inferProviderFromModel('moonshot-v1-128k')).toBe('moonshot');
  });

  it('returns "moonshot" for the bare Kimi Coding Plan wire ids', () => {
    expect(inferProviderFromModel('k3')).toBe('moonshot');
    expect(inferProviderFromModel('k3-256k')).toBe('moonshot');
    expect(inferProviderFromModel('kimi-for-coding')).toBe('moonshot');
    expect(inferProviderFromModel('kimi-for-coding-highspeed')).toBe('moonshot');
  });

  it('does not infer moonshot for unrelated k3-prefixed ids', () => {
    expect(inferProviderFromModel('k3pro')).toBeUndefined();
    expect(inferProviderFromModel('k30')).toBeUndefined();
  });

  it('returns "minimax" for minimax- prefix', () => {
    expect(inferProviderFromModel('MiniMax-M2.5')).toBe('minimax');
  });

  it('returns "xiaomi" for mimo-v prefix', () => {
    expect(inferProviderFromModel('mimo-v2.5-pro')).toBe('xiaomi');
  });

  it('returns "zai" for glm- prefix', () => {
    expect(inferProviderFromModel('glm-5')).toBe('zai');
  });

  it('returns "qwen" for qwen/qwq models', () => {
    expect(inferProviderFromModel('qwen2.5-72b-instruct')).toBe('qwen');
    expect(inferProviderFromModel('qwen3-235b-a22b')).toBe('qwen');
    expect(inferProviderFromModel('qwq-32b')).toBe('qwen');
  });

  it('returns "kiro" for Kiro subscription model IDs before generic vendor fallback', () => {
    expect(inferProviderFromModel('kiro/auto')).toBe('kiro');
    expect(inferProviderFromModel('kiro/claude-sonnet-4.5')).toBe('kiro');
  });

  it('returns "openrouter" for vendor/model format', () => {
    expect(inferProviderFromModel('stepfun/step-3.5-flash:free')).toBe('openrouter');
  });

  it('does not treat vendor/model:variant as ollama', () => {
    expect(inferProviderFromModel('anthropic/claude-sonnet-4:thinking')).toBe('openrouter');
    expect(inferProviderFromModel('nvidia/llama-3.1-nemotron-70b-instruct:extended')).toBe(
      'openrouter',
    );
  });

  it('returns undefined for unrecognized models', () => {
    expect(inferProviderFromModel('whisper-large')).toBeUndefined();
    expect(inferProviderFromModel('unknown-model')).toBeUndefined();
  });
});
