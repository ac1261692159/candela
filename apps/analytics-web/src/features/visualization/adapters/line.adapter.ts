import type { ChartAdapterResult, ChartConfigV1, NormalizedChartData } from '../chart.types';
import { metricUnit } from '../chart-compatibility';
import type { ColumnProfile } from '../chart.types';
import { formatChartNumber } from '../chart-data';
import { axisOfMetric, axisTooltipFormatter, mixedUnitAxes, unitForSeriesName, yAxisWithUnit } from '../metric-units';
import type { MetricUnit } from '../chart.types';
import { baseChartOption, listJoin, transformsText } from './shared';
import { formatTimeAxisLabel } from '../../time-axis/format-label';
import { t as translate } from '../../../i18n';

function formatAxis(value: unknown): string {
  if (value == null) return '';
  return formatTimeAxisLabel(value) || String(value);
}

export function lineAdapter(
  config: ChartConfigV1,
  data: NormalizedChartData,
  profiles: ColumnProfile[],
): ChartAdapterResult {
  const metricKeys = config.bindings.metrics;
  const unit = metricKeys[0] ? metricUnit(profiles.find((item) => item.key === metricKeys[0]) ?? profiles[0], config.options) : 'number';
  const categories: string[] = [];
  const categoryIndex = new Map<string, number>();
  for (const point of data.points) {
    const label = formatAxis(point.x);
    if (!categoryIndex.has(label)) {
      categoryIndex.set(label, categories.length);
      categories.push(label);
    }
  }
  const seriesNames = config.bindings.series
    ? [...new Set(data.points.map((point) => point.series ?? translate('sql:chart.emptySeries')))]
    : metricKeys;
  // 双轴（phase: clklog-analytics-sql-dual-axis-v1）：轴归属只影响实际画出来的指标。
  // 绑定 series 时所有线共用第一个指标，此时只看它一个，避免「没画的指标」也逼出第二条轴。
  const axisOf = (key: string) => axisOfMetric(key, config.options);
  const activeMetricKeys = config.bindings.series ? metricKeys.slice(0, 1) : metricKeys;
  const leftKeys = activeMetricKeys.filter((key) => axisOf(key) === 'left');
  const rightKeys = activeMetricKeys.filter((key) => axisOf(key) === 'right');
  const hasRight = rightKeys.length > 0;
  const units = config.options.units ?? {};
  // 单位解析与判定侧同规则：显式 units → 该列自身推断的单位 → 主指标兜底
  const profileUnit = (key: string): MetricUnit =>
    metricUnit(profiles.find((item) => item.key === key) ?? profiles[0], config.options);
  const unitOfKey = (key: string) => unitForSeriesName(key, units, profileUnit(key));
  /**
   * 该轴刻度的单位：同轴混单位时退化为纯数字（phase: clklog-analytics-axis-unit-coherence-v1）。
   * 一根轴只能有一种量纲装饰，套错就是把计数标成百分号；各系列的真实单位由悬停提示按系列给出。
   */
  const axisUnit = (keys: string[], fallback: MetricUnit): MetricUnit => {
    if (mixedUnitAxes(keys.map((key) => ({ key, unit: unitOfKey(key) })), axisOf).length > 0) return 'number';
    return keys.length ? unitOfKey(keys[0]) : fallback;
  };
  const series = seriesNames.map((name) => {
    const metric = config.bindings.series ? metricKeys[0] : name;
    const values = categories.map(() => null as number | null);
    for (const point of data.points) {
      const label = formatAxis(point.x);
      const idx = categoryIndex.get(label);
      if (idx === undefined) continue;
      if (config.bindings.series && (point.series ?? translate('sql:chart.emptySeries')) !== name) continue;
      values[idx] = point.values[metric] ?? null;
    }
    return {
      name,
      type: 'line',
      connectNulls: false,
      showSymbol: seriesNames.length > 2,
      symbol: 'circle',
      lineStyle: { type: 'solid', width: 2 },
      data: values,
      ...(hasRight ? { yAxisIndex: axisOf(metric) === 'right' ? 1 : 0 } : {}),
    };
  });
  // min/max 只在左轴上给：它们原本是「全部指标」的极值，直接套到右轴会把右轴压扁——
  // 那正是双轴要解决的问题。双轴时只按左轴自己的指标算。
  const rangeKeys = hasRight ? leftKeys : metricKeys;
  const numeric = data.points.flatMap((point) => rangeKeys.map((key) => point.values[key])).filter((value): value is number => value !== null);
  const min = numeric.length ? Math.min(...numeric) : 0;
  const max = numeric.length ? Math.max(...numeric) : 0;
  const description = translate('sql:chart.lineDescription', {
    x: config.bindings.x ?? '',
    metrics: listJoin(metricKeys),
  });
  const base = baseChartOption(description);
  const yAxis = hasRight
    ? [
        yAxisWithUnit(axisUnit(leftKeys, unit), leftKeys.length ? { scale: true, min, max } : { scale: true }),
        yAxisWithUnit(axisUnit(rightKeys, unit), { scale: true }),
      ]
    // 单轴分支：轴单位唯一的表达式与改造前逐字节一致（AC1）；只有该轴确实混单位时才退化为纯数字
    : yAxisWithUnit(axisUnit(activeMetricKeys, unit), { scale: true, min, max });
  return {
    option: {
      ...base,
      // 多一条右轴要把右边距让出来，否则右轴刻度被容器裁掉
      ...(hasRight ? { grid: { ...(base.grid as Record<string, unknown>), right: 48 } } : {}),
      tooltip: {
        trigger: 'axis',
        formatter: axisTooltipFormatter((name) => unitForSeriesName(name, units, unit)),
      },
      xAxis: { type: 'category', data: categories, boundaryGap: false },
      yAxis,
      series,
    },
    summary: translate('sql:chart.lineSummary', {
      description,
      points: data.displayedCount,
      series: series.length,
      min: formatChartNumber(min, unit),
      max: formatChartNumber(max, unit),
      transforms: transformsText(data.transforms),
    }),
    audit: {
      inputRows: data.originalRowCount,
      outputPoints: data.displayedCount * series.length,
      transforms: data.transforms,
    },
  };
}
