import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_KINDS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'past_n',
  'recent_n',
  'from_date_to_yesterday',
  'from_date_to_today',
  'custom_offsets',
] as const;

class TimeRangeRelativeDto {
  @IsString()
  @IsIn(RELATIVE_KINDS)
  kind: (typeof RELATIVE_KINDS)[number];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  n?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(366)
  from_offset?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(366)
  to_offset?: number;

  @IsOptional()
  @IsString()
  @Matches(YMD)
  anchor_start?: string;
}

export class TimeRangeDto {
  @IsString()
  start: string;

  @IsString()
  end: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TimeRangeRelativeDto)
  relative?: TimeRangeRelativeDto;

  /** 展示时区（IANA 名；缺省 = 平台时区，phase: clklog-analytics-timezone-v1） */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
