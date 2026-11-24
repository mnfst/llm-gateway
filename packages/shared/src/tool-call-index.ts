/**
 * Position of a streamed Chat Completions tool call delta among the calls of a response.
 *
 * Providers stream `delta.tool_calls[].index`, but some OpenAI-compatible ones (Gemini's
 * endpoint, for example) leave it out and send each call whole in its own chunk, each with its
 * own id. Without an index, a delta starts the next call when it brings an id that differs from
 * the latest call's id (a latest call with no id yet takes it instead); anything else continues
 * the latest call, so argument and name fragments still merge.
 */
export function resolveToolCallIndex(
  delta: { index?: unknown; id?: unknown },
  latest: { index: number; id?: string } | undefined,
): number {
  if (typeof delta.index === 'number') return delta.index;
  if (!latest) return 0;
  const startsNewCall =
    typeof delta.id === 'string' && delta.id !== '' && !!latest.id && delta.id !== latest.id;
  return startsNewCall ? latest.index + 1 : latest.index;
}
