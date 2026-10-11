import { describe, expect, it } from 'vitest';
import { recommendChart } from './chart-recommender';
import { profileColumns } from './column-profiler';
import {
  fxChineseMetrics,
  fxCountryCount,
  fxDayEventCount,
  fxHourCount,
  fxOsUniq,
  fxPartyFunnel,
  fxRechargeDailyTrend,
  fxSingleRowMetrics,
  fxWideFunnel,
} from './chart.fixtures';
import { CHART_RECOMMENDATION_VERSION } from './chart.types';
import { cloneConfig } from './chart-config';

function infer(columns: { name: string; type: string }[], rows: Record<string, unknown>[], saved?: Parameters<typeof recommendChart>[2]) {
  return recommendChart(profileColumns(columns, rows), rows, saved);
}

describe('chart-recommender', () => {
  it('recommends a unique line for hour count and day metrics', () => {
    const hour = infer(fxHourCount.columns, fxHourCount.rows);
    expect(hour.recommended?.chartType).toBe('line');
    const day = infer(fxDayEventCount.columns, fxDayEventCount.rows);
    expect(day.recommended?.chartType).toBe('line');
    expect(day.recommended?.config?.bindings.metrics).toEqual(['event_count']);
  });

  it('recommends bar for country ranking and keeps pie as a compatible non-default', () => {
    const result = infer(fxCountryCount.columns, fxCountryCount.rows);
    expect(result.recommended?.chartType).toBe('bar');
    expect(result.recommended?.config?.options.orientation).toBe('horizontal');
    expect(result.recommended?.config?.options.top_n).toBe(20);
    const pie = result.candidates.find((item) => item.chartType === 'pie');
    expect(pie?.compatible).toBe(true);
    expect(result.recommended?.chartType).not.toBe('pie');
  });

  it('does not default pie for uniq users', () => {
    const result = infer(fxOsUniq.columns, fxOsUniq.rows);
    expect(result.recommended?.chartType).toBe('bar');
    expect(result.candidates.find((item) => item.chartType === 'pie')?.compatible).toBe(false);
  });

  it('recommends number cards for a single metric row', () => {
    const result = infer(fxSingleRowMetrics.columns, fxSingleRowMetrics.rows);
    expect(result.recommended?.chartType).toBe('number');
  });

  it('recommends a number card for the default SQL alias 事件量', () => {
    const result = infer([{ name: '事件量', type: 'UInt64' }], [{ 事件量: 375970174 }]);
    expect(result.recommended?.chartType).toBe('number');
    expect(result.issues.some((issue) => issue.code === 'AMBIGUOUS_COLUMN_ROLE')).toBe(false);
  });

  it('recommends line for daily recharge UV plus count without mixed-unit block', () => {
    const result = infer(fxRechargeDailyTrend.columns, fxRechargeDailyTrend.rows);
    expect(result.recommended?.chartType).toBe('line');
    expect(result.candidates.find((item) => item.chartType === 'line')?.compatible).toBe(true);
    expect(result.candidates.find((item) => item.chartType === 'line')?.issues.some((issue) => issue.code === 'MIXED_UNITS')).toBe(false);
  });

  it('recommends funnel for a legal wide table and requires selection for 50 scenes', () => {
    expect(infer(fxWideFunnel.columns, fxWideFunnel.rows).recommended?.chartType).toBe('funnel');
    const party = infer(fxPartyFunnel.columns, fxPartyFunnel.rows);
    expect(party.recommended?.chartType).toBe('funnel');
    expect(party.recommended?.issues.some((issue) => issue.code === 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION')).toBe(true);
  });

  it('recommends line for 日期 + same-unit metrics and falls back when units mix', () => {
    const line = infer(
      [
        { name: '日期', type: 'Date' },
        { name: '活跃用户数', type: 'UInt64' },
        { name: '发布次数', type: 'UInt64' },
      ],
      [
        { 日期: '2026-09-01', 活跃用户数: 1, 发布次数: 2 },
        { 日期: '2026-09-02', 活跃用户数: 2, 发布次数: 3 },
      ],
    );
    expect(line.recommended?.chartType).toBe('line');
    const mixed = infer(fxChineseMetrics.columns, [
      { 日期: '2026-09-01', 活跃用户数: 1, 发布次数: 2, '发布率_%': 3 },
      { 日期: '2026-09-02', 活跃用户数: 2, 发布次数: 3, '发布率_%': 4 },
    ]);
    expect(mixed.recommended).toBeNull();
  });

  it('does not silently replace a saved auto config when recommendation version is unchanged', () => {
    const first = infer(fxDayEventCount.columns, fxDayEventCount.rows);
    expect(first.recommended?.config?.recommendation_version).toBe(CHART_RECOMMENDATION_VERSION);
    const saved = cloneConfig(first.recommended!.config!);
    const again = infer(fxDayEventCount.columns, fxDayEventCount.rows, saved);
    expect(again.recommended?.chartType).toBe('line');
  });

  // 趋势图（PRD D4）：必须出现在 candidates 中（让 ChartToolbar 下拉可手动选），
  // 但绝不作为 recommended（不能让预测线被自动呈现）。
  it('trend 在 candidates 但不参与自动推荐', () => {
    const day = infer(fxDayEventCount.columns, fxDayEventCount.rows);
    const trendCandidate = day.candidates.find((c) => c.chartType === 'trend');
    expect(trendCandidate).toBeDefined();
    expect(trendCandidate?.compatible).toBe(true);
    expect(day.recommended?.chartType).not.toBe('trend');
  });

  it('存在未识别的数值列时不再拦掉整张推荐（回归：「自动」永远停在请配置字段）', () => {
    // 线上形态：3 行结果 → 多数数值列画像器不敢定性（pending），但已有 2 个明确指标
    const columns = [
      { name: '数据日期', type: 'String' },
      { name: '资源类型', type: 'String' },
      { name: '请求数', type: 'UInt64' },
      { name: '设备数', type: 'UInt64' },
      { name: '耗时P50_ms', type: 'Float64' },
      { name: '慢_lt100KBps_%', type: 'Float64' },
      { name: '慢_lt300KBps_%', type: 'Float64' },
    ];
    const rows = ['1.tex 贴图', '2.prefab 预制体', '9.其他(大文件/未分类)'].map((kind, i) => ({
      数据日期: '2026-09-14 ~ 2026-09-20',
      资源类型: kind,
      请求数: 261464 + i * 1000,
      设备数: 16334 + i * 7,
      耗时P50_ms: 366.6 + i * 3,
      '慢_lt100KBps_%': 36.6 + i,
      '慢_lt300KBps_%': 63.7 + i,
    }));
    const profiles = profileColumns(columns as never, rows as never);
    const result = recommendChart(profiles, rows as never);
    expect(result.recommended).not.toBeNull();
    expect(result.recommended?.config?.chart_type).toBe('bar');
    expect(result.recommended?.config?.bindings.category).toBe('资源类型');
  });
});
