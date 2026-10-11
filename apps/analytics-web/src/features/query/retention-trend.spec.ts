import { describe, expect, it } from 'vitest';
import { RETENTION_TIME_COLUMN, retentionTrendResult } from './retention-trend';
import type { QueryResult } from '../../types/dsl.types';

describe('retention-trend', () => {
  it('留存结果转为趋势图结果（cohort_date 时间列 + *_rate 指标列）', () => {
    const result = {
      columns: [
        { key: 'cohort_date', title: '同期群' },
        { key: 'cohort_size', title: '人数' },
        { key: 'day_1_rate', title: '次日留存' },
        { key: 'day_7_rate', title: '7日留存' },
      ],
      rows: [
        { cohort_date: '2026-09-01', cohort_size: 100, day_1_rate: 0.4, day_7_rate: 0.2 },
        { cohort_date: '2026-09-02', cohort_size: 110, day_1_rate: 0.42, day_7_rate: 0 },
      ],
      elapsed_ms: 12,
    } as unknown as QueryResult;

    const trend = retentionTrendResult(result);
    expect(trend).not.toBeNull();
    expect(trend!.columns[0]).toEqual({ name: RETENTION_TIME_COLUMN, type: 'Date' });
    expect(trend!.columns.map((c) => c.name)).toEqual(['cohort_date', 'day_1_rate', 'day_7_rate']);
    expect(trend!.columns[1].type).toBe('Float64');
    // 非 *_rate 列（cohort_size）不进入指标
    expect(trend!.rows[0]).toEqual({ cohort_date: '2026-09-01', day_1_rate: 0.4, day_7_rate: 0.2 });
  });

  it('null 值按 0 处理（与曲线视图口径一致，未到期窗口参与拟合）', () => {
    const result = {
      columns: [
        { key: 'cohort_date', title: '同期群' },
        { key: 'day_1_rate', title: '次日留存' },
      ],
      rows: [{ cohort_date: '2026-09-06', day_1_rate: null }],
      elapsed_ms: 5,
    } as unknown as QueryResult;

    const trend = retentionTrendResult(result);
    expect(trend!.rows[0].day_1_rate).toBe(0);
  });

  it('无行 / 无列 / 无留存率列时返回 null（避免画出假趋势）', () => {
    expect(retentionTrendResult(null)).toBeNull();
    expect(retentionTrendResult({ columns: [], rows: [] } as unknown as QueryResult)).toBeNull();
    expect(
      retentionTrendResult({
        columns: [
          { key: 'cohort_date', title: '同期群' },
          { key: 'cohort_size', title: '人数' },
        ],
        rows: [{ cohort_date: '2026-09-01', cohort_size: 100 }],
      } as unknown as QueryResult),
    ).toBeNull();
  });
});
