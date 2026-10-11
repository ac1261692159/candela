import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const SAVED_METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export class CreateSavedMetricDto {
  @IsString()
  @Matches(SAVED_METRIC_NAME_PATTERN, {
    message: '指标名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
  })
  name: string;

  @IsString()
  @MaxLength(80)
  display_name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;

  @IsIn(['event', 'retention'])
  kind: 'event' | 'retention';

  @IsObject()
  definition_json: Record<string, unknown>;

  @IsOptional()
  @IsIn(['number', 'percent'])
  format?: 'number' | 'percent';
}

export class UpdateSavedMetricDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;

  @IsOptional()
  @IsObject()
  definition_json?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['number', 'percent'])
  format?: 'number' | 'percent';
}
