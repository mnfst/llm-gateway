/**
 * Position of a streamed Chat Completions tool call delta among the calls of a response.
 *
 * Providers stream `delta.tool_calls[].index`, but some OpenAI-compatible ones (Gemini's
 * endpoint, for example) leave it out and send each call whole in its own chunk. Without an
 * index, a delta starts the next call when it brings a new id, or a name without an id once
 * the latest call already has a name; anything else continues the latest call.
 */
export function resolveToolCallIndex(
  delta: { index?: unknown; id?: unknown; function?: unknown },
  latest: { index: number; id?: string; name?: string } | undefined,
): number {
  if (typeof delta.index === 'number') return delta.index;
  if (!latest) return 0;
  const hasId = typeof delta.id === 'string' && delta.id !== '';
  const fn = typeof delta.function === 'object' && delta.function !== null ? delta.function : {};
  const name = (fn as { name?: unknown }).name;
  const startsNewCall =
    (hasId && !!latest.id && delta.id !== latest.id) ||
    (!hasId && typeof name === 'string' && name !== '' && !!latest.name);
  return startsNewCall ? latest.index + 1 : latest.index;
}
