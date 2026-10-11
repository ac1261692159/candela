import { describe, expect, it } from 'vitest';
import { defaultOptions, evaluateCompatibility } from './chart-compatibility';
import { resolveVisualization } from './chart-pipeline';
import { profileColumns } from './column-profiler';
import { fxCountryCount, fxDayEventCount, fxDuplicateSeries, fxOsUniq, fxPartyFunnel } from './chart.fixtures';
import { manyRows } from './chart.fixtures';

describe('chart-compatibility', () => {
  it('rejects duplicate line keys without summing', () => {
    const profiles = profileColumns(fxDuplicateSeries.columns, fxDuplicateSeries.rows);
    const result = evaluateCompatibility('line', profiles, fxDuplicateSeries.rows);
    expect(result.compatible).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'DUPLICATE_KEY')).toBe(true);
  });

  it('rejects pie for non-additive uniq metrics', () => {
    const profiles = profileColumns(fxOsUniq.columns, fxOsUniq.rows);
    expect(evaluateCompatibility('pie', profiles, fxOsUniq.rows).compatible).toBe(false);
  });

  it('rejects too many input rows without sampling', () => {
    const data = manyRows(10001);
    const profiles = profileColumns(data.columns, data.rows);
    expect(evaluateCompatibility('bar', profiles, data.rows).issues.some((issue) => issue.code === 'TOO_MANY_ROWS')).toBe(true);
  });

  it('keeps multi-row funnel from auto-selecting the first row', () => {
    const profiles = profileColumns(fxPartyFunnel.columns, fxPartyFunnel.rows);
    const result = evaluateCompatibility('funnel', profiles, fxPartyFunnel.rows);
    expect(result.issues.some((issue) => issue.code === 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION')).toBe(true);
    expect(result.config?.bindings.row_selector).toBeUndefined();
  });

  it('accepts ranked bars and applies top n only after 20 categories', () => {
    const profiles = profileColumns(fxCountryCount.columns, fxCountryCount.rows);
    const result = evaluateCompatibility('bar', profiles, fxCountryCount.rows);
    expect(result.compatible).toBe(true);
    expect(result.config?.options.top_n).toBe(20);
    expect(result.config?.options.orientation).toBe('horizontal');
  });

  it('有绑定配置时按绑定判定：多余的 metric / 未绑定的维度都不干扰（回归：线上「图表配置已失效」）', () => {
    // 线上真实形态：13 列里 11 个数值列被标成 metric、日期列被标成 dimension，但实际只绑定了
    // category=资源类型 + 3 个指标。按旧逻辑会判 TOO_MANY_METRICS / DUPLICATE_KEY → 图表被回退成表格。
    const resolved = resolveVisualization({
      columns: [
        { name: '数据日期', type: 'String' },
        { name: '资源类型', type: 'String' },
        ...['请求数','设备数','文件大小P50_KB','流量GB','整体带宽MBps','单请求速度P50_MBps','单请求速度P95_MBps','耗时P50_ms','耗时P95_ms','慢_lt100KBps_%','慢_lt300KBps_%'].map((name) => ({ name, type: 'Float64' })),
      ] as never,
      rows: [1, 2, 3].map((i) => ({
        数据日期: '2026-09-14 ~ 2026-09-20', 资源类型: 'r' + i, 请求数: 100 + i, 设备数: 10 + i,
        文件大小P50_KB: 40 + i, 流量GB: 100 + i, 整体带宽MBps: 0.5 + i, 单请求速度P50_MBps: 0.1 + i,
        单请求速度P95_MBps: 2 + i, 耗时P50_ms: 360 + i, 耗时P95_ms: 3400 + i, '慢_lt100KBps_%': 30 + i, '慢_lt300KBps_%': 60 + i,
      })) as never,
      savedConfig: {"bindings":{"category":"资源类型","ignored":[],"metrics":["整体带宽MBps","慢_lt100KBps_%","慢_lt300KBps_%"]},"chart_type":"bar","mode":"manual","options":{"aggregation":{},"donut":false,"include_other":false,"orientation":"vertical","units":{}},"preferred_view":"chart","recommendation_version":1,"roles":{"单请求速度P50_MBps":"metric","单请求速度P95_MBps":"metric","慢_lt100KBps_%":"metric","慢_lt300KBps_%":"metric","数据日期":"dimension","整体带宽MBps":"metric","文件大小P50_KB":"metric","流量GB":"metric","耗时P50_ms":"metric","耗时P95_ms":"metric","设备数":"metric","请求数":"metric","资源类型":"dimension"},"schema_version":1} as never,
    });
    expect(resolved.view).toBe('chart');
    expect(resolved.config?.bindings.metrics).toHaveLength(3);
  });

  it('mode=auto 的配置失效时按当前列重算并出图（回归：「自动」不再等于失效）', () => {
    // 卡片里存的旧自动配置：绑定的是英文别名列（plat/raw_cnt），当前结果里已不存在
    const staleAuto = {
      schema_version: 1, recommendation_version: 1, mode: 'auto', preferred_view: 'chart', chart_type: 'bar',
      roles: { plat: 'dimension', raw_cnt: 'metric' },
      bindings: { category: 'plat', metrics: ['raw_cnt'], ignored: [] },
      options: { orientation: 'vertical', donut: false, include_other: false, units: {}, aggregation: {} },
    };
    const resolved = resolveVisualization({
      columns: fxDayEventCount.columns as never,
      rows: fxDayEventCount.rows as never,
      savedConfig: staleAuto as never,
    });
    expect(resolved.view).toBe('chart');
    expect(resolved.config?.bindings.x).toBe('day');
    expect(resolved.issues.some((issue) => issue.code === 'STALE_CONFIG' && issue.severity === 'error')).toBe(false);
  });


  it('分类轴跳过常数维度：第一维全行同值时仍能推荐柱状图（回归：「自动」出不了图）', () => {
    // 线上形态：结果第一列是「数据日期」（3 行同值），真正的维度是「资源类型」
    const columns = [
      { name: '数据日期', type: 'String' },
      { name: '资源类型', type: 'String' },
      { name: '慢_lt100KBps_%', type: 'Float64' },
      { name: '慢_lt300KBps_%', type: 'Float64' },
    ];
    const rows = ['1.tex 贴图', '2.prefab 预制体', '9.其他(大文件/未分类)'].map((kind, i) => ({
      数据日期: '2026-09-14 ~ 2026-09-20',
      资源类型: kind,
      '慢_lt100KBps_%': 30 + i,
      '慢_lt300KBps_%': 60 + i,
    }));
    const profiles = profileColumns(columns as never, rows as never);
    const bar = evaluateCompatibility('bar', profiles, rows as never);
    expect(bar.compatible).toBe(true);
    expect(bar.config?.bindings.category).toBe('资源类型');
  });
});

/**
 * 轴内单位一致（phase: clklog-analytics-axis-unit-coherence-v1）。
 * 双轴之后「单位一致」的主语是同一根轴：左轴人民币 + 右轴百分比是正确用法。
 */
describe('混单位判定按轴', () => {
  const columns = [
    { name: 'day', type: 'Date' },
    { name: 'revenue', type: 'Float64' },
    { name: 'rate', type: 'Float64' },
  ];
  const rows = [
    { day: '2026-09-01', revenue: 120, rate: 0.5 },
    { day: '2026-09-02', revenue: 90, rate: 0.4 },
  ];
  const profiles = profileColumns(columns, rows);
  const twoUnits = { units: { revenue: 'currency_cny', rate: 'percent_0_100' } } as const;

  it('跨轴不同单位不报混用（改动前会误报，自动模式下还可能直接不出图）', () => {
    const result = evaluateCompatibility('line', profiles, rows, defaultOptions({
      ...twoUnits,
      metric_axis: { rate: 'right' },
    } as never));
    expect(result.issues.some((issue) => issue.code === 'MIXED_UNITS')).toBe(false);
  });

  it('同一根轴混两种单位照报，并指出是哪根轴、涉及哪些指标', () => {
    const result = evaluateCompatibility('line', profiles, rows, defaultOptions(twoUnits as never));
    const issue = result.issues.find((item) => item.code === 'MIXED_UNITS');
    expect(issue).toBeTruthy();
    expect(issue?.params?.axis).toBe('left');
    expect(issue?.columns).toEqual(['revenue', 'rate']);
  });

  it('trend 与 line 同语义', () => {
    const mixed = evaluateCompatibility('trend', profiles, rows, defaultOptions(twoUnits as never));
    expect(mixed.issues.some((issue) => issue.code === 'MIXED_UNITS')).toBe(true);
    const split = evaluateCompatibility('trend', profiles, rows, defaultOptions({
      ...twoUnits,
      metric_axis: { rate: 'right' },
    } as never));
    expect(split.issues.some((issue) => issue.code === 'MIXED_UNITS')).toBe(false);
  });

  it('柱状没有双轴，混单位仍按整图判定（保持既有行为）', () => {
    const result = evaluateCompatibility('bar', profiles, rows, defaultOptions(twoUnits as never));
    expect(result.issues.some((issue) => issue.code === 'MIXED_UNITS')).toBe(true);
  });
});
