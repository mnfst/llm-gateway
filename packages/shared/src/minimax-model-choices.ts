/** Recommendation policy only: never use this to validate an explicit route. */
export function minimaxTextModelRank(provider: string, model: string): number | null {
  const providerId = provider.toLowerCase();
  let id = model.toLowerCase();
  if (providerId === 'minimax') {
    id = id.replace(/^minimax\//, '');
  } else if (providerId === 'openrouter') {
    if (!id.startsWith('minimax/')) return null;
    id = id.slice('minimax/'.length).replace(/:free$/, '');
  } else if (providerId === 'opencode-go' || providerId === 'opencode-zen') {
    id = id.replace(/^opencode-(?:go|zen)\//, '');
    if (id === 'minimax-m3.1-flash-free') return 0;
  } else {
    // In particular, custom providers own their model names and catalogs.
    return null;
  }
  if (id === 'minimax-m3.1-flash') return 0;
  if (id === 'minimax-m3') return 1;
  // Speech, image and video models are outside this text recommendation policy.
  return /^(?:minimax-(?:m\d|text|0\d)|abab\d)/.test(id) ? 2 : null;
}

/** Keep provider-discovered IDs intact, including gateway-specific suffixes. */
export function currentMinimaxModelChoices<T extends { provider: string; id: string }>(
  models: readonly T[],
): T[] {
  return models
    .filter((model) => minimaxTextModelRank(model.provider, model.id) !== 2)
    .sort(
      (a, b) =>
        (minimaxTextModelRank(a.provider, a.id) ?? 2) -
        (minimaxTextModelRank(b.provider, b.id) ?? 2),
    );
}
