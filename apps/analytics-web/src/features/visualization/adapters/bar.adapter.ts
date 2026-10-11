import type { ChartAdapterResult, ChartConfigV1, ColumnProfile, NormalizedChartData } from '../chart.types';
import { metricUnit } from '../chart-compatibility';
import { formatChartNumber } from '../chart-data';
import { axisTooltipFormatter, unitForSeriesName, yAxisWithUnit } from '../metric-units';
import { baseChartOption, listJoin, transformsText } from './shared';
import { t as translate } from '../../../i18n';

export function barAdapter(
  config: ChartConfigV1,
  data: NormalizedChartData,
  profiles: ColumnProfile[],
): ChartAdapterResult {
  const horizontal = config.options.orientation === 'horizontal';
  const categories = data.points.map((point) => point.category ?? translate('sql:chart.emptySeries'));
  const series = config.bindings.metrics.map((metric) => ({
    name: metric,
    type: 'bar',
    data: data.points.map((point) => point.values[metric] ?? null),
  }));
  const unit = metricUnit(profiles.find((item) => item.key === config.bindings.metrics[0]) ?? profiles[0], config.options);
  const numeric = data.points.flatMap((point) => config.bindings.metrics.map((key) => point.values[key])).filter((value): value is number => value !== null);
  const min = numeric.length ? Math.min(0, ...numeric) : 0;
  const max = numeric.length ? Math.max(0, ...numeric) : 0;
  const units = config.options.units ?? {};
  const valueAxis = yAxisWithUnit(unit, { min, max });
  const categoryAxis = { type: 'category', data: categories, axisLabel: { overflow: 'truncate', width: 120 } };
  const description = translate('sql:chart.barDescription', {
    type: horizontal ? translate('sql:chart.type.barHorizontal') : translate('sql:chart.type.bar'),
    category: config.bindings.category ?? '',
    metrics: listJoin(config.bindings.metrics),
  });
  return {
    option: {
      ...baseChartOption(description),
      tooltip: {
        trigger: 'axis',
        formatter: axisTooltipFormatter((name) => unitForSeriesName(name, units, unit)),
      },
      xAxis: horizontal ? valueAxis : categoryAxis,
      yAxis: horizontal ? categoryAxis : valueAxis,
      series,
    },
    summary: translate('sql:chart.barSummary', {
      description,
      displayed: data.displayedCount,
      total: data.originalRowCount,
      transforms: transformsText(data.transforms),
      max: formatChartNumber(numeric.length ? Math.max(...numeric) : null, unit),
    }),
    audit: {
      inputRows: data.originalRowCount,
      outputPoints: data.displayedCount * series.length,
      transforms: data.transforms,
    },
  };
}
