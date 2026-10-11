import type { ChartAdapterResult, ChartConfigV1, ColumnProfile, NormalizedChartData } from '../chart.types';
import { metricUnit } from '../chart-compatibility';
import { formatChartNumber } from '../chart-data';
import { defaultStatCalcs, reduceSeries, type StatCalc } from '../../explore-charts/series-stats';
import { t as translate } from '../../../i18n';

export function numberAdapter(
  config: ChartConfigV1,
  data: NormalizedChartData,
  profiles: ColumnProfile[],
): ChartAdapterResult {
  const calc = ((config.options.stat_calcs as StatCalc[] | undefined) ?? defaultStatCalcs('number'))[0] ?? 'last';
  const items = config.bindings.metrics.map((metric) => {
    const unit = metricUnit(profiles.find((item) => item.key === metric) ?? profiles[0], config.options);
    const value = reduceSeries(
      data.points.map((point) => point.values[metric] ?? null),
      calc,
    );
    return { name: metric, value, display: formatChartNumber(value, unit), unit };
  });
  const description = translate('sql:chart.numberDescription', {
    items: items
      .map((item) => `${item.name} ${item.display}`)
      .join(translate('sql:chart.itemSeparator')),
  });
  return {
    option: { clklogNumberCards: items, aria: { enabled: true, description } },
    summary: description,
    audit: {
      inputRows: data.originalRowCount,
      outputPoints: items.length,
      transforms: data.transforms,
    },
  };
}
