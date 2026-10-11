import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class DashboardCohortFilterDto {
  @IsString()
  @Matches(/^cohort_[A-Za-z0-9_-]{6,32}$/)
  cohort_id: string;

  @IsIn(['in', 'not_in'])
  op: 'in' | 'not_in';
}

export class CreateDashboardDto {
  @IsString()
  @MaxLength(200)
  name: string;

  /** 描述可为空；空串在 service 归一为 null */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  layout_json?: unknown;

  @IsOptional()
  @IsBoolean()
  create_share_token?: boolean;

  @IsOptional()
  @IsInt()
  @IsIn([0, 30, 60, 300, 900])
  refresh_interval_sec?: number;

  @IsOptional()
  @IsInt()
  @IsIn([30, 60, 300, 900, 3600])
  cache_ttl_sec?: number;

  @IsOptional()
  @IsInt()
  @IsIn([12, 16, 24])
  grid_columns?: number;

  @IsOptional()
  @IsBoolean()
  show_card_type?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value != null)
  @ValidateNested()
  @Type(() => DashboardCohortFilterDto)
  cohort_filter?: DashboardCohortFilterDto | null;

  @IsOptional()
  @ValidateIf((_, value) => value != null)
  @IsString()
  folder_id?: string | null;
}

export class UpdateDashboardDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** 传空串表示清空描述 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  layout_json?: unknown;

  @IsOptional()
  @IsBoolean()
  create_share_token?: boolean;

  @IsOptional()
  @IsInt()
  @IsIn([0, 30, 60, 300, 900])
  refresh_interval_sec?: number;

  @IsOptional()
  @IsInt()
  @IsIn([30, 60, 300, 900, 3600])
  cache_ttl_sec?: number;

  @IsOptional()
  @IsInt()
  @IsIn([12, 16, 24])
  grid_columns?: number;

  @IsOptional()
  @IsBoolean()
  show_card_type?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value != null)
  @ValidateNested()
  @Type(() => DashboardCohortFilterDto)
  cohort_filter?: DashboardCohortFilterDto | null;

  @IsOptional()
  @ValidateIf((_, value) => value != null)
  @IsString()
  folder_id?: string | null;
}
