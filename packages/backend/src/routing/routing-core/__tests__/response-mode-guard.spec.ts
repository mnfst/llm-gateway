import { BadRequestException } from '@nestjs/common';
import type { ModelRoute } from 'manifest-shared';
import {
  assertStreamableResponseMode,
  effectiveRoutesForResponseMode,
} from '../response-mode-guard';

const route = (provider: string, model: string): ModelRoute => ({
  provider,
  authType: 'api_key',
  model,
});

describe('assertStreamableResponseMode', () => {
  it('rejects stream mode when no saved route supports streaming', () => {
    const nonStreaming = route('openai', 'gpt-image-1');

    expect(() =>
      assertStreamableResponseMode('stream', 'tier "default"', nonStreaming, null),
    ).toThrow(BadRequestException);
    expect(() =>
      assertStreamableResponseMode('stream', 'tier "default"', nonStreaming, null),
    ).toThrow(/add at least one stream-capable model/);
  });

  it('allows custom provider routes in stream mode', () => {
    const custom = route('custom:abc', 'custom:abc/local-model');

    expect(() =>
      assertStreamableResponseMode('stream', 'custom tier "local"', custom, null),
    ).not.toThrow();
  });

  it('allows a non-stream primary when a stream-capable fallback exists', () => {
    const nonStreaming = route('openai', 'gpt-image-1');
    const openai = route('openai', 'gpt-4o');

    expect(() =>
      assertStreamableResponseMode('stream', 'tier "default"', nonStreaming, [openai]),
    ).not.toThrow();
  });

  it('allows a non-stream fallback when the primary supports streaming', () => {
    const openai = route('openai', 'gpt-4o');
    const nonStreaming = route('openai', 'gpt-image-1');

    expect(() =>
      assertStreamableResponseMode('stream', 'tier "default"', openai, [nonStreaming]),
    ).not.toThrow();
  });

  it('allows OpenCode Go routes in stream mode', () => {
    const opencodeGo = route('opencode-go', 'opencode-go/qwen3.7-max');

    expect(() =>
      assertStreamableResponseMode('stream', 'tier "reasoning"', opencodeGo, null),
    ).not.toThrow();
  });
});

describe('effectiveRoutesForResponseMode', () => {
  it('keeps the persisted chain unchanged in buffered mode', () => {
    const custom = route('custom:abc', 'custom:abc/local-model');
    const openai = route('openai', 'gpt-4o');

    expect(effectiveRoutesForResponseMode('buffered', custom, [openai])).toEqual({
      primaryRoute: custom,
      fallbackRoutes: [openai],
    });
  });

  it('lifts the first stream-capable fallback when streaming skips the primary', () => {
    const nonStreaming = route('openai', 'gpt-image-1');
    const openai = route('openai', 'gpt-4o');
    const anthropic = route('anthropic', 'claude-3-5-sonnet');

    expect(effectiveRoutesForResponseMode('stream', nonStreaming, [openai, anthropic])).toEqual({
      primaryRoute: openai,
      fallbackRoutes: [anthropic],
    });
  });

  it('filters non-stream fallbacks while keeping a stream-capable primary', () => {
    const openai = route('openai', 'gpt-4o');
    const nonStreaming = route('openai', 'gpt-image-1');

    expect(effectiveRoutesForResponseMode('stream', openai, [nonStreaming])).toEqual({
      primaryRoute: openai,
      fallbackRoutes: null,
    });
  });
});
