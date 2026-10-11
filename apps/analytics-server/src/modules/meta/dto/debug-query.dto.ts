import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Debug 查询窗口（phase: clklog-analytics-debug-query-v1）。
 * 原口径是「固定最近 7 天」；实测 7 天 + 设备/账号维度要读近 1 亿行、数十秒，
 * 故拆成三档并默认 24h（见 docs/product/prd-clklog-analytics-debug-query-v1.md §3.3）。
 */
export const DEBUG_WINDOWS = ['1h', '24h', '7d'] as const;
export type DebugWindow = (typeof DEBUG_WINDOWS)[number];
export const DEBUG_DEFAULT_WINDOW: DebugWindow = '24h';

export class DebugQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  distinct_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  user_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  event?: string;

  @IsOptional()
  @IsIn(DEBUG_WINDOWS)
  window?: DebugWindow;

  /** 只校验「是整数」；越界（0 / 负数 / >100）由 service 收敛，与 GET /recent 行为保持一致 */
  @IsOptional()
  @IsInt()
  limit?: number;
}

/** 项目级留档开关（F2）：权限同项目时区设置（ops.owner.assign） */
export class DebugArchiveToggleDto {
  @IsBoolean()
  enabled: boolean;
}
