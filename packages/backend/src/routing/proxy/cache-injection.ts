/**
 * Cache control injection utilities for providers that support
 * prompt caching via the OpenAI-compatible format.
 */

const CACHE_CONTROL = { type: 'ephemeral' } as const;

type OpenRouterCacheMode = 'anthropic' | 'message';

function injectCacheControlIntoContent(message: Record<string, unknown>): boolean {
  if (typeof message.content === 'string') {
    message.content = [
      {
        type: 'text',
        text: message.content,
        cache_control: CACHE_CONTROL,
      },
    ];
    return true;
  }

  if (!Array.isArray(message.content)) return false;
  const blocks = message.content as Array<Record<string, unknown>>;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    block.cache_control = CACHE_CONTROL;
    return true;
  }
  return false;
}

/**
 * Injects cache_control breakpoints into an OpenAI-format body for
 * OpenRouter requests targeting models that require explicit prompt caching.
 */
export function injectOpenRouterCacheControl(
  body: Record<string, unknown>,
  mode: OpenRouterCacheMode = 'anthropic',
): void {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!messages) return;

  if (mode === 'message') {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'system' && msg.role !== 'developer' && msg.role !== 'user') continue;
      if (injectCacheControlIntoContent(msg)) return;
    }
    return;
  }

  // Find the last system/developer message and inject cache_control on its content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'system' && msg.role !== 'developer') continue;

    injectCacheControlIntoContent(msg);
    break;
  }

  // Inject cache_control on the last tool definition
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    tools[tools.length - 1].cache_control = CACHE_CONTROL;
  }
}

export function injectOpenAiMessageCacheControl(body: Record<string, unknown>): void {
  injectOpenRouterCacheControl(body, 'message');
}
