import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * 对拍配置（phase: clklog-data-quality-ops-v1）。
 *
 * 阈值只有**一个语义：百分比**（历史实现把它当比例再乘 100，导致"设计 0.1%、实际 10%"两套说法）。
 */
export class SaveReconcileConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 低峰执行时刻（平台时区 HH:mm） */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: '执行时刻格式应为 HH:mm' })
  run_at?: string;

  /** 偏差阈值（百分比，0~100） */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  threshold_pct?: number;

  /** 忽略事件清单（结构差异事件先隔离，避免天天告警） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ignore_events?: string[];

  /** sa 侧是否与 raw 侧同样过滤空 event（口径对称） */
  @IsOptional()
  @IsBoolean()
  skip_empty_event?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  stale_warn_hours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  stale_error_hours?: number;
}
