import { createIssue } from '../chart-issues';
import type { ChartAdapterResult, ChartConfigV1, ChartIssue, ColumnProfile, NormalizedChartData } from '../chart.types';
import { conversionRate, formatChartNumber } from '../chart-data';
import { parseStrictNumber } from '../column-profiler';
import { baseChartOption } from './shared';
import { t as translate } from '../../../i18n';

export function funnelAdapter(
  config: ChartConfigV1,
  data: NormalizedChartData,
  _profiles: ColumnProfile[],
  extraIssues: ChartIssue[] = [],
): ChartAdapterResult & { issues: ChartIssue[] } {
  const issues: ChartIssue[] = [...extraIssues];
  const steps = config.bindings.funnel?.steps ?? [];
  const row = data.selectedRow;
  const values = steps.map((step) => {
    const parsed = row ? parseStrictNumber(row[step.column]) : null;
    if (parsed === 'unsafe') {
      issues.push(createIssue('UNSAFE_INTEGER', 'error', { columns: [step.column] }));
      return { ...step, value: null as number | null };
    }
    if (parsed === null) {
      issues.push(createIssue('NEGATIVE_VALUE', 'error', { columns: [step.column] }));
      return { ...step, value: null as number | null };
    }
    if (parsed < 0) {
      issues.push(createIssue('NEGATIVE_VALUE', 'error', { columns: [step.column] }));
    }
    return { ...step, value: parsed };
  });
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1].value;
    const current = values[i].value;
    if (prev !== null && current !== null && current > prev) {
      issues.push(createIssue('NON_MONOTONIC_FUNNEL', 'warning'));
      break;
    }
  }
  const hasError = issues.some((issue) => issue.severity === 'error' && issue.code !== 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION');
  const seriesData = hasError || !row
    ? []
    : values.map((step, index) => {
        const stepRate = conversionRate(step.value, index === 0 ? step.value : values[index - 1].value);
        const totalRate = conversionRate(step.value, values[0].value);
        return {
          name: step.label,
          value: step.value,
          stepRate,
          totalRate,
        };
      });
  const first = seriesData[0]?.value ?? null;
  const last = seriesData[seriesData.length - 1]?.value ?? null;
  const total = conversionRate(last, first);
  const description = translate('sql:chart.funnelDescription', {
    steps: steps.length,
    family: config.bindings.funnel?.metric_family ?? 'custom',
  });
  return {
    option: {
      ...baseChartOption(description, 'item'),
      series: [
        {
          type: 'funnel',
          sort: 'none',
          gap: 4,
          label: {
            show: true,
            formatter: (params: { name: string; value: number; data: { stepRate: number | null } }) =>
              `${params.name}\n${formatChartNumber(params.value)}\n${params.data.stepRate == null ? '--' : formatChartNumber(params.data.stepRate, 'ratio_0_1')}`,
          },
          data: seriesData,
        },
      ],
    },
    summary: translate('sql:chart.funnelSummary', {
      description,
      first: formatChartNumber(first),
      last: formatChartNumber(last),
      total: total == null ? '--' : formatChartNumber(total, 'ratio_0_1'),
    }),
    audit: {
      inputRows: data.originalRowCount,
      outputPoints: seriesData.length,
      transforms: ['funnel_order_preserved'],
    },
    issues,
  };
}
