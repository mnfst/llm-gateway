import { currentMinimaxModelChoices, minimaxTextModelRank } from '../src/minimax-model-choices';

describe('MiniMax advertised text choices', () => {
  it.each([
    ['minimax', 'MiniMax-M3.1-Flash', 0],
    ['MINIMAX', 'minimax/MiniMax-M3', 1],
    ['minimax', 'MiniMax-M2.7', 2],
    ['minimax', 'abab6.5-chat', 2],
    ['minimax', 'speech-02-hd', null],
    ['minimax', 'image-01', null],
    ['openrouter', 'minimax/minimax-m3.1-flash:free', 0],
    ['openrouter', 'minimax/minimax-m3', 1],
    ['openrouter', 'minimax/minimax-01', 2],
    ['openrouter', 'anthropic/claude-sonnet-4.6', null],
    ['opencode-go', 'opencode-go/minimax-m3', 1],
    ['opencode-zen', 'minimax-m3.1-flash', 0],
    ['opencode-zen', 'opencode-zen/minimax-m2.7', 2],
    ['custom:tenant', 'minimax/minimax-m2.7', null],
    ['openai', 'gpt-5', null],
  ])('%s/%s has rank %s', (provider, model, rank) => {
    expect(minimaxTextModelRank(provider as string, model as string)).toBe(rank);
  });

  it('orders Flash first without rewriting or mutating saved, custom or media entries', () => {
    const models = [
      { provider: 'minimax', id: 'MiniMax-M2.7' },
      { provider: 'minimax', id: 'MiniMax-M3' },
      { provider: 'custom:tenant', id: 'MiniMax-M2.7' },
      { provider: 'minimax', id: 'speech-02-hd' },
      { provider: 'openrouter', id: 'minimax/minimax-m3.1-flash:free' },
      { provider: 'openai', id: 'gpt-5' },
    ];
    const snapshot = structuredClone(models);
    expect(currentMinimaxModelChoices(models)).toEqual([
      models[4],
      models[1],
      models[2],
      models[3],
      models[5],
    ]);
    expect(models).toEqual(snapshot);
    expect(currentMinimaxModelChoices([])).toEqual([]);
  });
});
