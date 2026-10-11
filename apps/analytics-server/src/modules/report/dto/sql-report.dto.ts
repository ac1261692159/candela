import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TimeRangeDto } from './time-range.dto';

export class ExecuteSqlDto {
  @IsString()
  @IsIn(['sql', 'builder'])
  mode: 'sql' | 'builder';

  @IsOptional()
  @IsString()
  sql?: string;

  @IsOptional()
  dsl?: unknown;

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

export class FieldMapDto {
  @IsString()
  key: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  type?: string;
}

export class SaveSqlReportDto {
  @IsString()
  @MaxLength(200)
  name: string;

  /** 描述可为空；空串在 service 归一为 null */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @IsString()
  @IsIn(['sql', 'builder'])
  mode: 'sql' | 'builder';

  @IsOptional()
  @IsString()
  sql_text?: string;

  @IsOptional()
  dsl?: unknown;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FieldMapDto)
  field_map?: FieldMapDto[];

  @IsOptional()
  chart_config?: unknown;

  @IsOptional()
  @ValidateNested()
  @Type(() => TimeRangeDto)
  time_range?: TimeRangeDto;
}
