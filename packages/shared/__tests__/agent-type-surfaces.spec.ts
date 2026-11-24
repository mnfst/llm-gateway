import {
  AGENT_PLATFORMS,
  API_SURFACES,
  PLATFORM_API_SURFACES,
} from '../src/agent-type';

describe('PLATFORM_API_SURFACES', () => {
  it('covers every platform with a valid surface', () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(API_SURFACES).toContain(PLATFORM_API_SURFACES[platform]);
    }
    expect(Object.keys(PLATFORM_API_SURFACES).sort()).toEqual([...AGENT_PLATFORMS].sort());
  });

  it('routes anthropic-family platforms through the messages surface', () => {
    expect(PLATFORM_API_SURFACES['claude-code']).toBe('messages');
    expect(PLATFORM_API_SURFACES['anthropic-sdk']).toBe('messages');
    expect(PLATFORM_API_SURFACES['openclaw']).toBe('chat_completions');
  });

  it('routes Codex through the Responses API and n8n through chat completions', () => {
    expect(PLATFORM_API_SURFACES['codex']).toBe('responses');
    expect(PLATFORM_API_SURFACES['n8n']).toBe('chat_completions');
  });
});
