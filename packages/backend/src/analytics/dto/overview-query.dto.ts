import { IsIn, IsOptional } from 'class-validator';
import { RangeQueryDto } from '../../common/dto/range-query.dto';

export class OverviewQueryDto extends RangeQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  fast?: string;
}
