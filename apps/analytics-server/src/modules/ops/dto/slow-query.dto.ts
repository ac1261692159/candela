import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OpsProjectParamDto } from './ops-query-base.dto';

/**
 * 慢 SQL 列表查询参数（phase: clklog-analytics-ops-console-v1）。
 *
 * 时间范围上限 72 小时：生产实测 `system.query_log` 只保留约 2.5 天，
 * 放宽到更久只会让用户在空结果上误判「没有慢查询」。
 */
export class SlowQueryListDto extends OpsProjectParamDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(72)
  hours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600_000)
  min_duration_ms?: number;

  @IsOptional()
  @IsIn(['all', 'success', 'failed'])
  status?: 'all' | 'success' | 'failed';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
