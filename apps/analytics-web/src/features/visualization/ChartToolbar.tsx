import { Button, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { chartTypeLabel } from './chart.constants';
import { fixableInPanel } from './chart-compatibility';
import { formatIssue } from './chart-issues';
import { useT, type TFunction } from '../../i18n';
import type { ChartConfigV1, ChartInferenceResult, ChartIssue, ChartTypeV1 } from './chart.types';

interface ChartToolbarProps {
  config: ChartConfigV1 | null;
  inference: ChartInferenceResult;
  reason: string;
  issues: ChartIssue[];
  readOnly?: boolean;
  hideFieldsButton?: boolean;
  onChartTypeChange: (type: ChartTypeV1, extra?: { orientation?: 'vertical' | 'horizontal'; donut?: boolean }) => void;
  onRestoreAuto: () => void;
  onOpenFields: () => void;
}

function typeOptions(inference: ChartInferenceResult, t: TFunction) {
  const compatible = inference.candidates.filter(
    (item) => item.chartType !== 'table' && (item.compatible || fixableInPanel(item.issues)),
  );
  const unavailable = inference.candidates.filter(
    (item) => item.chartType !== 'table' && !item.compatible && !fixableInPanel(item.issues),
  );
  const compatibleOptions: Array<{ value: string; label: string; disabled?: boolean; title?: string }> = [];
  for (const item of compatible) {
    const hint = item.compatible
      ? undefined
      : item.issues.filter((issue) => issue.severity === 'error').map((issue) => formatIssue(issue, t)).join('；');
    compatibleOptions.push({ value: item.chartType, label: chartTypeLabel(item.chartType, t), title: hint });
    if (item.chartType === 'bar') {
      compatibleOptions.push({ value: 'bar:horizontal', label: t('sql:chart.type.barHorizontal') });
    }
    if (item.chartType === 'pie') {
      compatibleOptions.push({ value: 'pie:donut', label: t('sql:chart.type.pieDonut') });
    }
  }
  const unavailableOptions = unavailable.map((item) => {
    const reason = item.issues[0] ? formatIssue(item.issues[0], t) : t('sql:toolbar.unavailableReason');
    return {
      value: `unavailable:${item.chartType}`,
      label: t('sql:toolbar.unavailable', { type: chartTypeLabel(item.chartType, t) }),
      disabled: true,
      title: reason,
    };
  });
  return { compatibleOptions, unavailableOptions };
}

export function ChartToolbar({
  config,
  inference,
  reason,
  issues,
  readOnly,
  hideFieldsButton,
  onChartTypeChange,
  onRestoreAuto,
  onOpenFields,
}: ChartToolbarProps) {
  const { t } = useT('sql');
  const recommended = inference.recommended;
  const autoLabel = recommended
    ? t('sql:toolbar.auto', { type: chartTypeLabel(recommended.chartType, t) })
    : t('sql:toolbar.auto', { type: t('sql:chart.type.table') });
  const modeLabel = config?.mode === 'manual'
    ? t('sql:toolbar.manual', {
        type: config.options.donut
          ? t('sql:chart.type.pieDonut')
          : config.options.orientation === 'horizontal' && config.chart_type === 'bar'
            ? t('sql:chart.type.barHorizontal')
            : chartTypeLabel(config.chart_type, t),
      })
    : autoLabel;
  const { compatibleOptions, unavailableOptions } = typeOptions(inference, t);
  const selectValue = !config || config.mode === 'auto'
    ? 'auto'
    : config.options.donut && config.chart_type === 'pie'
      ? 'pie:donut'
      : config.options.orientation === 'horizontal' && config.chart_type === 'bar'
        ? 'bar:horizontal'
        : config.chart_type;
  const transformTags: string[] = [];
  if (issues.some((issue) => issue.code === 'TRUNCATED_RESULT')) transformTags.push(formatIssue(issues.find((issue) => issue.code === 'TRUNCATED_RESULT')!, t));
  if (config?.options.top_n) transformTags.push(`Top${config.options.top_n}`);
  if (config?.options.include_other) transformTags.push(t('sql:chart.other'));
  if (config?.bindings.row_selector) {
    transformTags.push(t('sql:toolbar.rowSelector', {
      column: config.bindings.row_selector.column,
      value: String(config.bindings.row_selector.value),
    }));
  }
  if (config?.options.units && Object.values(config.options.units).some((unit) => unit.includes('percent') || unit.includes('ratio'))) {
    transformTags.push(t('sql:toolbar.percentFormat'));
  }

  return (
    <Space wrap style={{ padding: '4px 12px' }} size={8}>
      <Tooltip title={reason}>
        <Typography.Text strong>{modeLabel}</Typography.Text>
      </Tooltip>
      {!readOnly && (
        <Select
          size="small"
          aria-label={t('sql:toolbar.selectChart')}
          value={selectValue}
          style={{ minWidth: 160 }}
          options={[
            { label: t('sql:toolbar.groupAuto'), options: [{ value: 'auto', label: autoLabel }] },
            { label: t('sql:toolbar.groupCompatible'), options: compatibleOptions },
            { label: t('sql:toolbar.groupUnavailable'), options: unavailableOptions },
          ]}
          onChange={(value) => {
            if (value === 'auto') {
              onRestoreAuto();
              return;
            }
            if (value === 'bar:horizontal') {
              onChartTypeChange('bar', { orientation: 'horizontal' });
              return;
            }
            if (value === 'pie:donut') {
              onChartTypeChange('pie', { donut: true });
              return;
            }
            onChartTypeChange(value as ChartTypeV1, value === 'bar' ? { orientation: 'vertical' } : value === 'pie' ? { donut: false } : undefined);
          }}
        />
      )}
      {!readOnly && !hideFieldsButton && (
        <Button size="small" onClick={onOpenFields}>
          {t('sql:field.title')}
        </Button>
      )}
      {!readOnly && config?.mode === 'manual' && (
        <Button size="small" onClick={onRestoreAuto}>
          {t('sql:chart.restoreAuto')}
        </Button>
      )}
      {transformTags.map((tag) => (
        <Tag key={tag} color="processing">
          {tag}
        </Tag>
      ))}
    </Space>
  );
}
