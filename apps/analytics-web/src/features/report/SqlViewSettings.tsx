import { Radio, Tooltip, Typography } from 'antd';
import { FieldBindingPanel } from '../visualization/FieldBindingPanel';
import { switchChartType } from '../visualization/chart-pipeline';
import { bindingColumnsFromProfiles, fixableInPanel } from '../visualization/chart-compatibility';
import { formatIssue } from '../visualization/chart-issues';
import { type TFunction, useT } from '../../i18n';
import type { ChartConfigV1, ChartTypeV1, ResolvedVisualization } from '../visualization/chart.types';
import type { SqlExecuteResult } from '../../types/report.types';
import type { SqlResultLayout } from './sql-result-layout';
import { preferredViewFromSqlLayout } from './sql-result-layout';
import '../query/analysis-workbench.css';

const CHART_CHIPS = (t: TFunction): Array<{ value: string; label: string; chartType: ChartTypeV1; extra?: { orientation?: 'vertical' | 'horizontal'; donut?: boolean } }> => [
  { value: 'line', label: t('report:cardView.line'), chartType: 'line' },
  { value: 'trend', label: t('report:cardView.trend'), chartType: 'trend' },
  { value: 'bar', label: t('report:cardView.bar'), chartType: 'bar', extra: { orientation: 'vertical' } },
  { value: 'bar:horizontal', label: t('report:cardView.barHorizontal'), chartType: 'bar', extra: { orientation: 'horizontal' } },
  { value: 'pie', label: t('report:cardView.pie'), chartType: 'pie', extra: { donut: false } },
  { value: 'pie:donut', label: t('report:cardView.donut'), chartType: 'pie', extra: { donut: true } },
  { value: 'funnel', label: t('report:cardView.funnel'), chartType: 'funnel' },
  { value: 'number', label: t('report:cardView.number'), chartType: 'number' },
];

interface SqlViewSettingsProps {
  layout: SqlResultLayout;
  canPivot: boolean;
  result: SqlExecuteResult | null;
  resolved: ResolvedVisualization | null;
  onLayoutChange: (layout: SqlResultLayout) => void;
  onConfigChange: (config: ChartConfigV1) => void;
}

function selectedChartValue(config: ChartConfigV1 | null | undefined): string {
  if (!config || config.mode === 'auto') return 'auto';
  if (config.chart_type === 'pie' && config.options.donut) return 'pie:donut';
  if (config.chart_type === 'bar' && config.options.orientation === 'horizontal') return 'bar:horizontal';
  return config.chart_type;
}

export function SqlViewSettings({
  layout,
  canPivot,
  result,
  resolved,
  onLayoutChange,
  onConfigChange,
}: SqlViewSettingsProps) {
  const { t } = useT('report');
  const chips = CHART_CHIPS(t);
  if (!result) {
    return <Typography.Text type="secondary">{t('report:sqlView.empty')}</Typography.Text>;
  }

  const config = resolved?.config ?? null;
  const chartValue = selectedChartValue(config);
  const chartDisabled = layout === 'table' || layout === 'pivot';
  const emit = (next: ChartConfigV1 | null) => {
    if (!next) return;
    onConfigChange({ ...next, preferred_view: preferredViewFromSqlLayout(layout) });
  };

  return (
    <div className="funnel-view-settings">
      <Typography.Text strong className="funnel-view-settings__label">
        {t('report:sqlView.display')}
      </Typography.Text>
      <Radio.Group
        value={layout}
        onChange={(event) => onLayoutChange(event.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        options={[
          { label: t('report:sqlView.chartAndTable'), value: 'both' },
          { label: t('report:sqlView.chart'), value: 'chart' },
          { label: t('report:sqlView.table'), value: 'table' },
          ...(canPivot ? [{ label: t('report:sqlView.pivot'), value: 'pivot' as const }] : []),
        ]}
      />

      <Typography.Text strong className="funnel-view-settings__label">
        {t('report:sqlView.chartType')}
      </Typography.Text>
      <Radio.Group
        value={chartValue}
        disabled={chartDisabled || !resolved}
        onChange={(event) => {
          const value = String(event.target.value);
          if (value === 'auto') {
            const auto = resolved?.inference.recommended?.config;
            if (auto) emit({ ...auto, mode: 'auto' });
            return;
          }
          const chip = chips.find((item) => item.value === value);
          if (!chip || !resolved) return;
          const next = switchChartType(config, chip.chartType, resolved);
          if (!next) return;
          emit({
            ...next,
            options: {
              ...next.options,
              orientation: chip.extra?.orientation ?? next.options.orientation,
              donut: chip.extra?.donut ?? next.options.donut,
            },
          });
        }}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        options={[
          { label: t('report:sqlView.auto'), value: 'auto' },
          // 所有图型都列出来：不兼容的置灰并给出悬停原因，而不是直接消失（用户看不到就别谈理解）
          ...chips.map((item) => {
            const candidate = resolved?.inference.candidates.find(
              (entry) => entry.chartType === item.chartType,
            );
            const usable =
              !candidate || candidate.compatible || fixableInPanel(candidate.issues);
            const reason = candidate?.issues.find((issue) => issue.severity === 'error');
            return {
              label:
                usable || !candidate ? (
                  item.label
                ) : (
                  <Tooltip title={reason ? formatIssue(reason, t) : t('sql:toolbar.unavailableReason')}>
                    <span>{item.label}</span>
                  </Tooltip>
                ),
              value: item.value,
              disabled: !usable,
            };
          }),
        ]}
      />

      {!chartDisabled ? (
        <FieldBindingPanel
          layout="settings"
          open
          config={config}
          columns={bindingColumnsFromProfiles(resolved?.profiles ?? [])}
          chartType={config?.chart_type ?? 'bar'}
          onClose={() => undefined}
          onApply={(next) => emit(next)}
          onRestoreAuto={() => {
            const auto = resolved?.inference.recommended?.config;
            if (auto) emit({ ...auto, mode: 'auto' });
          }}
        />
      ) : null}
    </div>
  );
}
