import type { SqlExecuteResult } from '../../types/report.types';
import type { QueryResult } from '../../types/dsl.types';

/**
 * 留存分析 × 趋势图（phase: clklog-analytics-trend-chart-v1）。
 *
 * 留存结果天然是时间序列：cohort_date（同期群日期）+ 各期留存率（*_rate 列）。
 * 与漏斗不同，这里**无需重新查询**——现有结果直接转换为趋势图可用的
 * SqlExecuteResult（cohort_date 作时间列，*_rate 列作指标），
 * 由 trend adapter / ChartWorkbench 渲染并提供回归外推。
 *
 * ⚠️ 口径限制（已知问题，UI 需标注）：
 * 近期同期群的远期留存尚未到期（如 3 天前的 cohort 没有 day_7 数据），
 * 后端填 0。这些 0 会参与线性拟合，可能拉低预测值。
 * 预测仅供参考，应主要关注已成熟区间的走势。
 */

export const RETENTION_TIME_COLUMN = 'cohort_date';

/** 留存结果 → 趋势图结果；无行或无留存率列时返回 null（避免画出假趋势） */
export function retentionTrendResult(result: QueryResult | null): SqlExecuteResult | null {
  if (!result?.rows?.length || !result.columns?.length) return null;

  const rateColumns = result.columns.filter((column) => column.key.endsWith('_rate'));
  if (!rateColumns.length) return null;

  return {
    query_id: '',
    columns: [
      { name: RETENTION_TIME_COLUMN, type: 'Date' },
      ...rateColumns.map((column) => ({ name: column.key, type: 'Float64' })),
    ],
    rows: result.rows.map((row) => {
      const next: Record<string, unknown> = { [RETENTION_TIME_COLUMN]: row[RETENTION_TIME_COLUMN] };
      for (const column of rateColumns) {
        const value = row[column.key];
        next[column.key] = value == null ? 0 : Number(value);
      }
      return next;
    }),
    row_count: result.rows.length,
    truncated: false,
    elapsed_ms: result.elapsed_ms ?? 0,
    read_rows: 0,
    read_bytes: 0,
  };
}
