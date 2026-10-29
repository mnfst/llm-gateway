/**
 * Rank of the current MiniMax text models (Flash first, then M3), or null for
 * every other model. Recommendation order only: never use this to validate an
 * explicit route.
 */
export function minimaxTextModelRank(provider: string, model: string): number | null {
  const providerId = provider.toLowerCase();
  let id = model.toLowerCase();
  if (providerId === 'minimax') {
    id = id.replace(/^minimax\//, '');
  } else if (providerId === 'openrouter') {
    if (!id.startsWith('minimax/')) return null;
    id = id.slice('minimax/'.length).replace(/:free$/, '');
  } else if (providerId === 'opencode-go' || providerId === 'opencode-zen') {
    id = id.replace(/^opencode-(?:go|zen)\//, '').replace(/-free$/, '');
  } else {
    // In particular, custom providers own their model names and catalogs.
    return null;
  }
  if (id === 'minimax-m3.1-flash') return 0;
  if (id === 'minimax-m3') return 1;
  return null;
}

/**
 * Lists Flash, then M3, ahead of everything else. Nothing is dropped: older and
 * newer MiniMax models stay listed so saved routes and model menus keep them.
 */
export function currentMinimaxModelChoices<T extends { provider: string; id: string }>(
  models: readonly T[],
): T[] {
  return [...models].sort(
    (a, b) =>
      (minimaxTextModelRank(a.provider, a.id) ?? 2) - (minimaxTextModelRank(b.provider, b.id) ?? 2),
  );
}

/** MiniMax documents `reasoning_effort` for M3 and M3.1 Flash only. */
export function minimaxSupportsReasoningEffort(model: string): boolean {
  return minimaxTextModelRank('minimax', model) !== null;
}
