import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OverviewQueryDto } from './overview-query.dto';

describe('OverviewQueryDto', () => {
  it('validates the fast overview flag', async () => {
    const dto = plainToInstance(OverviewQueryDto, { range: '365d', fast: 'true' });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects an invalid fast overview flag', async () => {
    const dto = plainToInstance(OverviewQueryDto, { fast: 'yes' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
