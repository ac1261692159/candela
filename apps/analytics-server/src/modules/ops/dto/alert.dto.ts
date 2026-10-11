import { IsInt, IsOptional, IsIn, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OpsProjectParamDto } from './ops-query-base.dto';

/** 磁盘趋势：前端默认 180 天，小时上限 = 180 × 24 */
export const DISK_TREND_MAX_HOURS = 24 * 180;

export class DiskTrendDto extends OpsProjectParamDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISK_TREND_MAX_HOURS)
  hours?: number;

  /** 监控路径（可选）：须在服务端白名单内（/data、receiver 日志目录等） */
  @IsOptional()
  @IsIn(['/', '/data', '/data/clklog/clklog-docker-compose/clklog_dc_data/receiver'])
  path?: string;
}
