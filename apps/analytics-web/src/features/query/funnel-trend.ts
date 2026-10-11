import type { SqlExecuteResult } from '../../types/report.types';
import type { FunnelQuery, FunnelResult } from '../../types/dsl.types';
import { isFunnelStepCountKey } from './funnel-display';

/**
 * 漏斗 × 趋势图（phase: clklog-analytics-trend-chart-v1，PRD §2.1）。
 *
 * 后端「按时间分组」已实现（groups: [{ scope: 'time', granularity }]），
 * 返回多桶结果（group_col = 时间桶，step_N = 各步人数）。
 * 这里只做前端转换与 DSL 装配，不动后端 SQL。
 *
 * ⚠️ 口径说明（PRD 决策 A）：时间桶按「第 1 步最早发生时间」归因，
 * 即「该时段进入漏斗的用户，在窗口内的达成情况」，不是「该时段完成的转化」。
 * UI 上必须标注，否则用户会误读趋势。
 */

export type FunnelTimeGranularity = 'none' | 'day' | 'hour';

/** 时间桶列名（ASCII：ClickHouse 23.2 不支持未加引号的中文标识符） */
export const FUNNEL_TIME_COLUMN = 'time_bucket';

/** 当前漏斗 DSL 的时间粒度 */
export function funnelTimeGranularity(dsl: FunnelQuery | null): FunnelTimeGranularity {
  const group = dsl?.groups?.find((item) => item.scope === 'time');
  if (!group) return 'none';
  return group.granularity === 'hour' ? 'hour' : 'day';
}

/**
 * 给漏斗 DSL 设置时间粒度。
 *
 * 时间分组与维度分组**互斥**：后端当前只支持单个分组
 * （groupSelect / groupByOuter 均按单列拼装），故设为时间粒度时以时间分组为准。
 */
export function withFunnelTimeGranularity(
  dsl: FunnelQuery,
  granularity: FunnelTimeGranularity,
): FunnelQuery {
  if (granularity === 'none') {
    return { ...dsl, groups: (dsl.groups ?? []).filter((item) => item.scope !== 'time') };
  }
  return { ...dsl, groups: [{ scope: 'time', granularity }] };
}

/**
 * 漏斗多桶结果 → 趋势图可用结果。
 *
 * 把 group_col 重命名为 time_bucket 并补上列类型，
 * 使 column-profiler 能识别时间列，进而让 trend adapter 正常渲染。
 */
export function funnelTrendResult(result: FunnelResult | null): SqlExecuteResult | null {
  if (!result?.rows?.length) return null;
  const hasGroupColumn = (result.columns ?? []).some((column) => column.key === 'group_col');
  if (!hasGroupColumn) return null;

  const stepColumns = (result.columns ?? []).filter((column) => isFunnelStepCountKey(column.key));
  if (!stepColumns.length) return null;

  return {
    query_id: '',
    columns: [
      { name: FUNNEL_TIME_COLUMN, type: 'Date' },
      ...stepColumns.map((column) => ({ name: column.key, type: 'UInt64' })),
    ],
    rows: result.rows.map((row) => {
      const next: Record<string, unknown> = { [FUNNEL_TIME_COLUMN]: row.group_col };
      for (const column of stepColumns) next[column.key] = row[column.key];
      return next;
    }),
    row_count: result.rows.length,
    truncated: false,
    elapsed_ms: result.elapsed_ms ?? 0,
    read_rows: 0,
    read_bytes: 0,
  };
}
