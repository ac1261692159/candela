import type { ChartAdapterResult, ChartConfigV1, ColumnProfile, NormalizedChartData } from '../chart.types';
import { metricUnit } from '../chart-compatibility';
import { formatChartNumber } from '../chart-data';
import { baseChartOption, transformsText } from './shared';
import { t as translate } from '../../../i18n';

export function pieAdapter(
  config: ChartConfigV1,
  data: NormalizedChartData,
  profiles: ColumnProfile[],
): ChartAdapterResult {
  const metric = config.bindings.metrics[0];
  const unit = metricUnit(profiles.find((item) => item.key === metric) ?? profiles[0], config.options);
  const pieData = data.points.map((point) => ({
    name: point.category ?? translate('sql:chart.emptySeries'),
    value: point.values[metric] ?? 0,
  }));
  const description = translate('sql:chart.pieDescription', {
    type: config.options.donut ? translate('sql:chart.type.pieDonut') : translate('sql:chart.type.pie'),
    category: config.bindings.category ?? '',
    metric,
  });
  const radius = config.options.donut ? ['46%', '70%'] : '70%';
  return {
    option: {
      ...baseChartOption(description, 'item'),
      series: [
        {
          type: 'pie',
          radius,
          label: { formatter: '{b}: {d}%' },
          data: pieData,
        },
      ],
    },
    summary: translate('sql:chart.pieSummary', {
      description,
      count: data.displayedCount,
      transforms: transformsText(data.transforms),
      max: formatChartNumber(pieData.reduce((max, item) => Math.max(max, Number(item.value) || 0), 0), unit),
    }),
    audit: {
      inputRows: data.originalRowCount,
      outputPoints: data.displayedCount,
      transforms: data.transforms,
    },
  };
}
