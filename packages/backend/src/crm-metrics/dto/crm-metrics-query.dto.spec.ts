import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CrmMetricsQueryDto } from './crm-metrics-query.dto';

function parse(query: Record<string, unknown>): CrmMetricsQueryDto {
  return plainToInstance(CrmMetricsQueryDto, query, { enableImplicitConversion: false });
}

describe('CrmMetricsQueryDto', () => {
  it('coerces the query string into a number', () => {
    const dto = parse({ days: '30' });

    expect(dto.days).toBe(30);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('allows the parameter to be omitted', () => {
    const dto = parse({});

    expect(dto.days).toBeUndefined();
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('accepts the window bounds', () => {
    expect(validateSync(parse({ days: '1' }))).toHaveLength(0);
    expect(validateSync(parse({ days: '365' }))).toHaveLength(0);
  });

  it('rejects a window outside the bounds', () => {
    expect(validateSync(parse({ days: '0' }))).not.toHaveLength(0);
    expect(validateSync(parse({ days: '366' }))).not.toHaveLength(0);
  });

  it('rejects a non-integer window', () => {
    expect(validateSync(parse({ days: '7.5' }))).not.toHaveLength(0);
    expect(validateSync(parse({ days: 'lots' }))).not.toHaveLength(0);
  });
});
