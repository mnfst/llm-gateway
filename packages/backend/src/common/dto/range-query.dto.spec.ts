import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RangeQueryDto } from './range-query.dto';

describe('RangeQueryDto', () => {
  it('validates with valid range', async () => {
    const dto = plainToInstance(RangeQueryDto, { range: '24h' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('validates with all accepted ranges', async () => {
    for (const range of ['1h', '6h', '24h', '7d', '30d', '90d', '365d']) {
      const dto = plainToInstance(RangeQueryDto, { range });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects invalid range', async () => {
    const dto = plainToInstance(RangeQueryDto, { range: '2h' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates with optional agent_name', async () => {
    const dto = plainToInstance(RangeQueryDto, { range: '7d', agent_name: 'demo' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('validates empty object (all optional)', async () => {
    const dto = plainToInstance(RangeQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
