/**
 * The set of analytics range tokens accepted by range-query DTOs. Single
 * source of truth so DTO validation and {@link rangeToInterval} cannot drift.
 */
export const RANGE_VALUES = ['1h', '6h', '24h', '7d', '30d', '90d', '365d'] as const;
export type RangeValue = (typeof RANGE_VALUES)[number];

export function rangeToInterval(range: string): string {
  switch (range) {
    case '1h':
      return '1 hour';
    case '6h':
      return '6 hours';
    case '24h':
      return '24 hours';
    case '7d':
      return '7 days';
    case '30d':
      return '30 days';
    case '90d':
      return '90 days';
    case '365d':
      return '365 days';
    default:
      return '24 hours';
  }
}

export function rangeToPreviousInterval(range: string): string {
  switch (range) {
    case '1h':
      return '2 hours';
    case '6h':
      return '12 hours';
    case '24h':
      return '48 hours';
    case '7d':
      return '14 days';
    case '30d':
      return '60 days';
    case '90d':
      return '180 days';
    case '365d':
      return '730 days';
    default:
      return '48 hours';
  }
}

export function isHourlyRange(range: string): boolean {
  return ['1h', '6h', '24h'].includes(range);
}
