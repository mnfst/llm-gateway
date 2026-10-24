import { resolveToolCallIndex } from '../src/tool-call-index';

describe('resolveToolCallIndex', () => {
  it('uses the index the provider sent', () => {
    expect(resolveToolCallIndex({ index: 2, id: 'call_c' }, { index: 0, id: 'call_a' })).toBe(2);
  });

  it('places the first call without an index at 0', () => {
    expect(resolveToolCallIndex({ id: 'call_a' }, undefined)).toBe(0);
  });

  it('starts the next call when an index-less delta brings a new id', () => {
    expect(resolveToolCallIndex({ id: 'call_b' }, { index: 0, id: 'call_a' })).toBe(1);
  });

  it('continues the latest call when an index-less delta has no id or the same id', () => {
    expect(resolveToolCallIndex({}, { index: 1, id: 'call_b' })).toBe(1);
    expect(resolveToolCallIndex({ id: '' }, { index: 1, id: 'call_b' })).toBe(1);
    expect(resolveToolCallIndex({ id: 'call_b' }, { index: 1, id: 'call_b' })).toBe(1);
  });

  it('continues the latest call when that call has no id yet', () => {
    expect(resolveToolCallIndex({ id: 'call_a' }, { index: 0 })).toBe(0);
  });

  it('starts the next call when an index-less delta brings a name without an id after a named call', () => {
    const latest = { index: 0, id: 'call_a', name: 'get_weather' };
    expect(resolveToolCallIndex({ function: { name: 'get_time' } }, latest)).toBe(1);
    expect(resolveToolCallIndex({ function: { arguments: '{}' } }, latest)).toBe(0);
    expect(
      resolveToolCallIndex({ function: { name: 'get_time' } }, { index: 0, id: 'call_a' }),
    ).toBe(0);
  });
});
