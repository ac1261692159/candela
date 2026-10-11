import { Radio, Select, Space, Switch, Typography } from 'antd';
import { useT } from '../../i18n';
import { StatCalcsPicker } from '../explore-charts/StatCalcsPicker';
import { parseStatCalcs, type StatCalc } from '../explore-charts/series-stats';
import { FieldBindingPanel } from '../visualization/FieldBindingPanel';
import { defaultOptions } from '../visualization/chart-compatibility';
import type { BindingColumn, ChartConfigV1, MetricUnit } from '../visualization/chart.types';
import { metricUnitOptions, unitSelectValue } from '../visualization/metric-units';
import type { EventChartType, EventResultLayout } from './event-view';
import './analysis-workbench.css';

interface EventViewSettingsProps {
  layout: EventResultLayout;
  chartType: EventChartType;
  statCalcs: StatCalc[];
  hasDuration: boolean;
  durationPlain: boolean;
  yUnit: MetricUnit;
  /** 字段绑定配置（X 轴 / 拆分系列 / 指标 / 轴归属 / 每指标单位） */
  chartConfig: ChartConfigV1;
  columns: BindingColumn[];
  onLayoutChange: (layout: EventResultLayout) => void;
  onChartTypeChange: (chart: EventChartType) => void;
  onStatCalcsChange: (calcs: StatCalc[]) => void;
  onDurationPlainChange: (plain: boolean) => void;
  onYUnitChange: (unit: MetricUnit) => void;
  onChartConfigChange: (config: ChartConfigV1) => void;
  onRestoreAuto: () => void;
}

export function EventViewSettings({
  layout,
  chartType,
  statCalcs,
  hasDuration,
  durationPlain,
  yUnit,
  chartConfig,
  columns,
  onLayoutChange,
  onChartTypeChange,
  onStatCalcsChange,
  onDurationPlainChange,
  onYUnitChange,
  onChartConfigChange,
  onRestoreAuto,
}: EventViewSettingsProps) {
  const { t } = useT('analysis');
  /**
   * 单位是「整张图的缺省」：改一次就把所有已绑定指标一起改掉。
   * 想只改某一个指标走下面的「字段 → 指标单位」。旧卡还靠 `_view.y_unit` 复现，
   * 所以两个地方都要写。
   */
  const setGlobalUnit = (unit: MetricUnit) => {
    onYUnitChange(unit);
    const units = Object.fromEntries(chartConfig.bindings.metrics.map((key) => [key, unit]));
    onChartConfigChange({
      ...chartConfig,
      mode: 'manual',
      options: defaultOptions({ ...chartConfig.options, units }),
    });
  };
  return (
    <div className="funnel-view-settings">
      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:view.display')}
      </Typography.Text>
      <Radio.Group
        value={layout}
        onChange={(e) => onLayoutChange(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        options={[
          { label: t('analysis:view.chartAndTable'), value: 'both' },
          { label: t('analysis:view.chart'), value: 'chart' },
          { label: t('analysis:view.table'), value: 'table' },
        ]}
      />

      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:view.chartType')}
      </Typography.Text>
      <Radio.Group
        value={chartType}
        onChange={(e) => {
          const next = e.target.value as EventChartType;
          onChartTypeChange(next);
          onStatCalcsChange(parseStatCalcs(statCalcs, next));
        }}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        disabled={layout === 'table'}
        options={[
          { label: t('analysis:chartKind.line'), value: 'line' },
          { label: t('analysis:chartKind.trend'), value: 'trend' },
          { label: t('analysis:chartKind.bar'), value: 'bar' },
          { label: t('analysis:chartKind.stack'), value: 'stack' },
          { label: t('analysis:chartKind.cumulative'), value: 'cumulative' },
          { label: t('analysis:chartKind.distribution'), value: 'distribution' },
          { label: t('analysis:view.pie'), value: 'pie' },
          { label: t('analysis:chartKind.number'), value: 'number' },
        ]}
      />

      {chartType === 'bar' ||
      chartType === 'stack' ||
      chartType === 'distribution' ||
      chartType === 'pie' ||
      chartType === 'number' ? (
        <StatCalcsPicker
          kind={chartType}
          value={statCalcs}
          onChange={onStatCalcsChange}
          disabled={layout === 'table'}
        />
      ) : null}

      {chartType !== 'pie' ? (
        <>
          <Typography.Text strong className="funnel-view-settings__label">
            {t('analysis:view.unit')}
          </Typography.Text>
          <Select
            aria-label={t('analysis:view.yAxisUnit')}
            size="small"
            style={{ minWidth: 160 }}
            options={metricUnitOptions(t)}
            value={unitSelectValue(yUnit)}
            onChange={setGlobalUnit}
            disabled={layout === 'table'}
          />
        </>
      ) : null}

      {hasDuration ? (
        <>
          <Typography.Text strong className="funnel-view-settings__label">
            {t('analysis:view.durationDisplay')}
          </Typography.Text>
          <Space>
            <Switch size="small" checked={durationPlain} onChange={onDurationPlainChange} />
            <Typography.Text>{t('analysis:view.durationPlain')}</Typography.Text>
          </Space>
        </>
      ) : null}

      <FieldBindingPanel
        layout="settings"
        open
        scope="event"
        config={chartConfig}
        columns={columns}
        chartType={chartType}
        onClose={() => undefined}
        onApply={onChartConfigChange}
        onRestoreAuto={onRestoreAuto}
      />
    </div>
  );
}
