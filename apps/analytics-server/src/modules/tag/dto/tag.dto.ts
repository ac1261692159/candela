import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { COHORT_NAME_PATTERN } from '../../cohort/cohort-definition';

export class CreateTagDto {
  @IsString()
  @Matches(COHORT_NAME_PATTERN, {
    message: '标签名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
  })
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  display_name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;

  @IsObject()
  definition_json: Record<string, unknown>;

  @IsOptional()
  @IsIn(['manual', 'daily'])
  schedule?: 'manual' | 'daily';

  @IsOptional()
  @IsString()
  subject_id?: string;
}

export class UpdateTagDto {
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
  @IsIn(['manual', 'daily'])
  schedule?: 'manual' | 'daily';
}
