import { getMetadataArgsStorage } from 'typeorm';
import { TenantRequestUsage } from './tenant-request-usage.entity';

describe('TenantRequestUsage', () => {
  it('maps the tenant and quota window as the composite primary key', () => {
    const primaryColumns = getMetadataArgsStorage()
      .columns.filter(
        (column) => column.target === TenantRequestUsage && column.options.primary === true,
      )
      .map((column) => column.propertyName)
      .sort();

    expect(primaryColumns).toEqual(['tenant_id', 'window_start']);
  });

  it('tracks whether the historical baseline was initialized', () => {
    const baselineColumn = getMetadataArgsStorage().columns.find(
      (column) =>
        column.target === TenantRequestUsage && column.propertyName === 'baseline_counted',
    );

    expect(baselineColumn?.options).toMatchObject({ default: false });
  });
});
