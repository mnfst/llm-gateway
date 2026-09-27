import { rangeToInterval, rangeToPreviousInterval, isHourlyRange } from './range.util';

describe('rangeToInterval', () => {
  it.each([
    ['1h', '1 hour'],
    ['6h', '6 hours'],
    ['24h', '24 hours'],
    ['7d', '7 days'],
    ['30d', '30 days'],
    ['90d', '90 days'],
    ['365d', '365 days'],
  ])('maps %s to %s', (input, expected) => {
    expect(rangeToInterval(input)).toBe(expected);
  });

  it('defaults to 24 hours for unknown ranges', () => {
    expect(rangeToInterval('unknown')).toBe('24 hours');
    expect(rangeToInterval('')).toBe('24 hours');
  });
});

describe('rangeToPreviousInterval', () => {
  it.each([
    ['1h', '2 hours'],
    ['6h', '12 hours'],
    ['24h', '48 hours'],
    ['7d', '14 days'],
    ['30d', '60 days'],
    ['90d', '180 days'],
    ['365d', '730 days'],
  ])('maps %s to %s', (input, expected) => {
    expect(rangeToPreviousInterval(input)).toBe(expected);
  });

  it('defaults to 48 hours for unknown ranges', () => {
    expect(rangeToPreviousInterval('unknown')).toBe('48 hours');
  });
});

describe('isHourlyRange', () => {
  it('returns true for hourly ranges', () => {
    expect(isHourlyRange('1h')).toBe(true);
    expect(isHourlyRange('6h')).toBe(true);
    expect(isHourlyRange('24h')).toBe(true);
  });

  it('returns false for daily ranges', () => {
    expect(isHourlyRange('7d')).toBe(false);
    expect(isHourlyRange('30d')).toBe(false);
    expect(isHourlyRange('90d')).toBe(false);
    expect(isHourlyRange('365d')).toBe(false);
  });

  it('returns false for unknown ranges', () => {
    expect(isHourlyRange('unknown')).toBe(false);
  });
});
