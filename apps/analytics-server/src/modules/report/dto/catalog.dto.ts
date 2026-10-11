import { IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TimeRangeDto } from './time-range.dto';

export class CatalogExecuteCardDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TimeRangeDto)
  time_range?: TimeRangeDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  limit?: number;
}
