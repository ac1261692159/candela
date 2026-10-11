import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { COHORT_NAME_PATTERN } from '../cohort-definition';

export class CreateCohortDto {
  @IsString()
  @Matches(COHORT_NAME_PATTERN, {
    message: '分群名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
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

  @IsIn(['condition', 'id_upload', 'sql'])
  kind: 'condition' | 'id_upload' | 'sql';

  @IsOptional()
  @IsObject()
  definition_json?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['manual', 'daily'])
  schedule?: 'manual' | 'daily';

  @IsOptional()
  @IsString()
  csv_text?: string;

  @IsOptional()
  @IsString()
  subject_id?: string;
}

export class UpdateCohortDto {
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

export class CreateResultCohortDto {
  @IsString()
  @Matches(COHORT_NAME_PATTERN, {
    message: '分群名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
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

  @IsIn(['event', 'funnel', 'retention'])
  source: 'event' | 'funnel' | 'retention';

  @IsObject()
  dsl: Record<string, unknown>;

  @IsObject()
  cell: Record<string, unknown>;

  @IsOptional()
  @IsString()
  subject_id?: string;
}

export class PreviewSqlCohortDto {
  @IsOptional()
  @IsObject()
  definition_json?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class PreviewResultCohortDto {
  @IsIn(['event', 'funnel', 'retention'])
  source: 'event' | 'funnel' | 'retention';

  @IsObject()
  dsl: Record<string, unknown>;

  @IsObject()
  cell: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class PreviewConditionCohortDto {
  @IsObject()
  definition_json: Record<string, unknown>;

  @IsOptional()
  @IsString()
  subject_id?: string;

  /** 示例 ID 条数；0 = 只算人数不取样例 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  limit?: number;
}

export class ReplaceCohortMembersDto {
  @IsString()
  @MinLength(1)
  csv_text: string;
}
