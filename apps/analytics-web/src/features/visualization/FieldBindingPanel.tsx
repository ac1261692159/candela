import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Drawer, Form, Input, InputNumber, Select, Space, Switch, Typography, message } from 'antd';
import type {
  BindingColumn,
  ChartAxis,
  ChartConfigV1,
  ChartTypeV1,
  ColumnRole,
  MetricUnit,
  TrendOptions,
} from './chart.types';
import { defaultOptions } from './chart-compatibility';
import { BAR_MAX_METRICS, LINE_MAX_METRICS, NUMBER_MAX_METRICS } from './chart.constants';
import { parseChartConfigV1 } from './chart-config';
import { CHART_CONFIG_SCHEMA_VERSION, CHART_RECOMMENDATION_VERSION } from './chart.constants';
import { cleanStepLabel } from './funnel-shape';
import { StatCalcsPicker } from '../explore-charts/StatCalcsPicker';
import { defaultStatCalcs, parseStatCalcs, type StatCalc } from '../explore-charts/series-stats';
import { axisOfMetric, chartHasYAxis, metricUnitOptions, mixedUnitAxes, splitMetricsByUnit, unitSelectValue } from './metric-units';
import { useT, type TFunction } from '../../i18n';

/** 趋势图配置默认值（与 trend.adapter 的 DEFAULT_TREND 保持一致） */
const DEFAULT_TREND_OPTIONS: TrendOptions = {
  forecast_points: 7,
  threshold: null,
  show_trend_line: false,
  show_threshold: true,
};

/** 事件侧把图型映射到 `ChartOptions.metric_axis` 的合法值 */
const AXIS_VALUES: ChartAxis[] = ['left', 'right'];

/** 事件侧有数值 Y 轴的图型（SQL 侧的 `chartHasYAxis` 不含堆积 / 累计 / 分布） */
const EVENT_Y_AXIS_TYPES: string[] = [
  'line',
  'trend',
  'bar',
  'stack',
  'cumulative',
  'distribution',
  'number',
];

/** 事件侧需要 X 轴的图型（饼图把 X 当类别用） */
const EVENT_AXIS_TYPES: string[] = [
  'line',
  'trend',
  'bar',
  'stack',
  'cumulative',
  'distribution',
  'pie',
];

interface FieldBindingPanelProps {
  open: boolean;
  config: ChartConfigV1 | null;
  /** 绑定候选列；SQL 侧由 `bindingColumnsFromProfiles` 映射，事件侧由结果列直接映射 */
  columns: BindingColumn[];
  chartType: ChartTypeV1;
  onClose: () => void;
  onApply: (config: ChartConfigV1) => void;
  onRestoreAuto: () => void;
  /** 分析页常驻侧栏；设置齿轮内嵌；默认抽屉（单测与临时打开） */
  layout?: 'drawer' | 'panel' | 'settings';
  /**
   * 域：决定区块显隐与个别文案。
   * 缺省 `sql`，既有调用点行为不变；`event` 增加轴归属、隐藏 SQL 专属区块。
   */
  scope?: 'sql' | 'event';
}

/** 列角色下拉项：文案随语言，取文案要由调用方把 `t` 传进来 */
function roleOptions(t: TFunction): { value: Exclude<ColumnRole, 'pending'>; label: string }[] {
  return [
    { value: 'time', label: t('sql:field.role.time') },
    { value: 'dimension', label: t('sql:field.role.dimension') },
    { value: 'metric', label: t('sql:field.role.metric') },
    { value: 'ignored', label: t('sql:field.role.ignored') },
  ];
}

/**
 * 下拉与列角色区显示的列名。
 * SQL 侧保留「列名 · ClickHouse 类型 · 角色/置信度」，事件侧只有结果表的列名。
 */
function columnLabel(column: BindingColumn): string {
  return column.typeLabel ? `${column.label} · ${column.typeLabel}` : column.label;
}

function rolesFromColumns(columns: BindingColumn[]): ChartConfigV1['roles'] {
  const roles: ChartConfigV1['roles'] = {};
  for (const column of columns) roles[column.key] = column.role;
  return roles;
}

export function FieldBindingPanel({
  open,
  config,
  columns,
  chartType,
  onClose,
  onApply,
  onRestoreAuto,
  layout = 'drawer',
  scope = 'sql',
}: FieldBindingPanelProps) {
  const { t } = useT('sql', 'common');
  // 两个域共用一个面板：只有少数标签需要按域换措辞（事件侧 X 轴可以是维度，叫「时间轴」会误导）
  const { t: ta } = useT('analysis');
  const isEvent = scope === 'event';
  const label = {
    xAxis: isEvent ? ta('analysis:field.xAxis') : t('sql:field.timeAxis'),
    categoryAxis: t('sql:field.categoryAxis'),
    series: t('sql:field.series'),
    metrics: t('sql:field.metrics'),
    unit: (name: string) => t('sql:field.unit', { name }),
    axis: ta('analysis:field.axis'),
    axisLeft: ta('analysis:field.axisLeft'),
    axisRight: ta('analysis:field.axisRight'),
    hint: isEvent ? ta('analysis:field.hintLive') : null,
  };
  const showsYAxis = isEvent ? EVENT_Y_AXIS_TYPES.includes(chartType) : chartHasYAxis(chartType);
  /**
   * 轴归属本期只做折线族：事件侧沿用既有的数值轴图型集合，SQL 侧只给折线/趋势。
   * SQL 的柱状/条形/饼图 adapter 还不读 metric_axis，暴露控件会变成「能设但不生效」。
   */
  const showsAxisControl = isEvent
    ? EVENT_Y_AXIS_TYPES.includes(chartType)
    : chartType === 'line' || chartType === 'trend';
  const axisOptions = AXIS_VALUES.map((value) => ({
    value,
    label: value === 'right' ? label.axisRight : label.axisLeft,
  }));
  // 没有可用基线配置时（旧配置引用了已消失的列被丢弃、或推荐器给不出方案），按当前列自建一份空壳：
  // 否则面板每个下拉都是空的、「应用配置」静默返回——用户看到的就是「点了完全没反应」。
  const fallbackConfig = useMemo(() => {
    if (config || !columns.length) return null;
    try {
      return parseChartConfigV1(
        {
          schema_version: CHART_CONFIG_SCHEMA_VERSION,
          recommendation_version: CHART_RECOMMENDATION_VERSION,
          mode: 'manual',
          preferred_view: chartType === 'table' ? 'table' : 'chart',
          chart_type: chartType,
          roles: rolesFromColumns(columns),
          bindings: { metrics: [], ignored: [] },
          options: defaultOptions(),
        },
        columns.map((column) => column.key),
        scope,
      );
    } catch {
      return null;
    }
  }, [config, columns, chartType, scope]);
  const base = config ?? fallbackConfig;

  const [draft, setDraft] = useState<ChartConfigV1 | null>(base);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (layout === 'panel' || layout === 'settings' || open) {
      setDraft(base);
      setErrors([]);
    }
  }, [open, base, layout]);

  const effective = draft ?? base;
  const options = columns.map((column) => ({ value: column.key, label: columnLabel(column) }));
  const metrics = columns.filter((column) => column.role === 'metric' || column.numeric);

  const funnelSteps = effective?.bindings.funnel?.steps ?? [];

  /** 更新趋势图专属配置（写入 options.trend） */
  const setTrend = (patch: Partial<TrendOptions>) => {
    if (!effective) return;
    const current = effective.options.trend ?? DEFAULT_TREND_OPTIONS;
    setDraft({
      ...effective,
      options: defaultOptions({ ...effective.options, trend: { ...current, ...patch } }),
    });
  };

  const apply = () => {
    if (!effective) {
      setErrors([t('sql:proposal.noColumns')]);
      message.error(t('sql:proposal.noColumns'));
      return;
    }
    const nextErrors: string[] = [];
    if ((chartType === 'line' || chartType === 'trend') && !effective.bindings.x) nextErrors.push(t('sql:field.errorTimeAxis'));
    if ((chartType === 'bar' || chartType === 'pie') && !effective.bindings.category) nextErrors.push(t('sql:field.errorCategoryAxis'));
    if (chartType !== 'funnel' && chartType !== 'table' && !effective.bindings.metrics.length) nextErrors.push(t('sql:field.errorMetric'));
    const metricCap =
      chartType === 'bar' ? BAR_MAX_METRICS : chartType === 'line' || chartType === 'trend' ? LINE_MAX_METRICS : chartType === 'pie' ? 1 : NUMBER_MAX_METRICS;
    if (effective.bindings.metrics.length > metricCap) {
      nextErrors.push(t('sql:proposal.metricLimit', { chartType, limit: metricCap }));
    }
    if (chartType === 'funnel' && (funnelSteps.length < 3 || funnelSteps.length > 8)) nextErrors.push(t('sql:field.errorFunnelSteps'));
    setErrors(nextErrors);
    if (nextErrors.length) {
      // 只写在面板里容易被忽略（尤其面板滚动时），点按钮"没反应"的观感就是这么来的
      message.error(nextErrors.join('；'));
      return;
    }
    onApply({
      ...effective,
      mode: 'manual',
      chart_type: chartType,
      preferred_view: chartType === 'table' ? 'table' : 'chart',
    });
    message.success(t('sql:field.applied'));
  };

  /** 单位与轴归属改完立刻生效（事件侧每指标一个单位 / 一条轴） */
  const liveOptions = layout === 'panel' || layout === 'settings';
  const patchOptions = (patch: Partial<ChartConfigV1['options']>, live: boolean) => {
    if (!effective) return;
    const next: ChartConfigV1 = {
      ...effective,
      mode: 'manual',
      options: defaultOptions({ ...effective.options, ...patch }),
    };
    setDraft(next);
    if (live) onApply(next);
  };
  const setUnit = (column: string, unit: MetricUnit, live: boolean) => {
    if (!effective) return;
    patchOptions({ units: { ...effective.options.units, [column]: unit } }, live);
  };
  const setAxis = (column: string, axis: ChartAxis) => {
    if (!effective) return;
    patchOptions(
      { metric_axis: { ...(effective.options.metric_axis ?? {}), [column]: axis } },
      liveOptions,
    );
  };

  /**
   * 轴内单位一致（phase: clklog-analytics-axis-unit-coherence-v1）：
   * 同一根轴混两种单位时，那根轴的刻度只能有一种量纲，必须给用户一条出路。
   */
  const unitEntries = (effective?.bindings.metrics ?? []).map((key) => ({
    key,
    unit: unitSelectValue(effective?.options.units[key]),
  }));
  const mixedAxes = showsAxisControl
    ? mixedUnitAxes(unitEntries, (key) => axisOfMetric(key, effective?.options))
    : [];
  const splitByUnit = () => {
    if (!effective) return;
    const assignment = splitMetricsByUnit(unitEntries, (key) => axisOfMetric(key, effective.options));
    if (!Object.keys(assignment).length) return;
    patchOptions({ metric_axis: assignment }, liveOptions);
  };

  const setBindings = (patch: Partial<ChartConfigV1['bindings']>) => {
    if (!effective) return;
    setDraft({ ...effective, bindings: { ...effective.bindings, ...patch } });
  };

  const moveStep = (index: number, delta: number) => {
    const next = [...funnelSteps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setBindings({
      funnel: {
        shape: effective?.bindings.funnel?.shape ?? 'wide',
        metric_family: effective?.bindings.funnel?.metric_family ?? 'custom',
        steps: next.map((step, order) => ({ ...step, order: order + 1 })),
      },
      metrics: next.map((step) => step.column),
    });
  };

  const roleEditor = useMemo(
    () =>
      columns.map((column) => (
        <Form.Item key={column.key} label={column.label} style={{ marginBottom: 8 }}>
          <Select
            aria-label={t('sql:field.roleAria', { name: column.label })}
            size="small"
            value={effective?.roles[column.key]}
            options={roleOptions(t)}
            onChange={(role) => {
              if (!effective) return;
              setDraft({ ...effective, roles: { ...effective.roles, [column.key]: role } });
            }}
          />
          {column.typeLabel ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {column.typeLabel}
            </Typography.Text>
          ) : null}
        </Form.Item>
      )),
    [effective, columns, t],
  );

  /** X 轴：SQL 侧按图型限定在时间列，事件侧的 X 轴可以是任意维度 */
  const xAxisLabel = isEvent && (chartType === 'bar' || chartType === 'pie') ? label.categoryAxis : label.xAxis;
  const showsSeries = isEvent
    ? chartType === 'line' || chartType === 'trend' || chartType === 'bar' || chartType === 'stack' || chartType === 'cumulative' || chartType === 'distribution'
    : chartType === 'bar' || chartType === 'pie' || chartType === 'line' || chartType === 'trend';

  const fields = (
    <>
      {errors.map((error) => (
        <Alert key={error} type="error" showIcon message={error} style={{ marginBottom: 8 }} />
      ))}
      <Typography.Paragraph type="secondary" className={layout === 'settings' ? 'funnel-view-settings__hint' : undefined}>
        {label.hint ?? (layout === 'drawer' ? t('sql:field.hintDrawer') : t('sql:field.hintLive'))}
      </Typography.Paragraph>
      {(isEvent ? EVENT_AXIS_TYPES.includes(chartType) : chartType === 'line' || chartType === 'trend') && (
        <Form.Item label={xAxisLabel}>
          <Select
            aria-label={xAxisLabel}
            allowClear
            options={options}
            value={effective?.bindings.x}
            onChange={(value) => setBindings({ x: value })}
          />
        </Form.Item>
      )}
      {showsSeries && (
        <Form.Item label={chartType === 'bar' || chartType === 'pie' ? label.categoryAxis : label.series}>
          <Select
            aria-label={chartType === 'bar' || chartType === 'pie' ? label.categoryAxis : label.series}
            allowClear
            options={options}
            value={chartType === 'bar' || chartType === 'pie' ? effective?.bindings.category : effective?.bindings.series}
            onChange={(value) => setBindings(chartType === 'bar' || chartType === 'pie' ? { category: value } : { series: value })}
          />
        </Form.Item>
      )}
      {chartType !== 'funnel' && chartType !== 'table' && (
        <Form.Item label={label.metrics}>
          <Select
            aria-label={label.metrics}
            mode="multiple"
            options={metrics.map((column) => ({ value: column.key, label: columnLabel(column) }))}
            value={effective?.bindings.metrics}
            onChange={(value) => setBindings({ metrics: value })}
          />
        </Form.Item>
      )}
      {mixedAxes.length > 0 ? (
        <Form.Item label={t('sql:field.splitByUnit')}>
          <Space wrap>
            <Button size="small" onClick={splitByUnit}>{t('sql:field.splitByUnitAction')}</Button>
            <Typography.Text type="secondary">
              {t('sql:field.splitByUnitHint', {
                axis: (mixedAxes[0].axis === 'right' ? label.axisRight : label.axisLeft),
              })}
            </Typography.Text>
          </Space>
        </Form.Item>
      ) : null}
      {showsYAxis && (effective?.bindings.metrics ?? []).map((metric) => {
        const item = columns.find((column) => column.key === metric);
        const name = item?.label ?? metric;
        return (
          <Form.Item key={`unit-${metric}`} label={label.unit(name)}>
            <Select
              aria-label={label.unit(name)}
              options={metricUnitOptions(t)}
              value={unitSelectValue(effective?.options.units[metric])}
              onChange={(unit: MetricUnit) => setUnit(metric, unit, liveOptions)}
            />
            {showsAxisControl ? (
              <Select
                aria-label={`${label.axis} · ${name}`}
                options={axisOptions}
                value={effective?.options.metric_axis?.[metric] ?? 'left'}
                onChange={(axis: ChartAxis) => setAxis(metric, axis)}
                style={{ marginTop: 8 }}
              />
            ) : null}
          </Form.Item>
        );
      })}
      {!isEvent && (chartType === 'number' || chartType === 'funnel') && (
        <Form.Item label={t('sql:field.rowGroup')}>
          <Select
            aria-label={t('sql:field.rowGroupColumn')}
            allowClear
            options={options}
            value={effective?.bindings.row_selector?.column}
            onChange={(column) =>
              setBindings({
                row_selector: column ? { column, value: effective?.bindings.row_selector?.value ?? null } : undefined,
              })
            }
          />
          <Input
            aria-label={t('sql:field.rowSelectorValue')}
            placeholder={t('sql:field.rowSelectorValue')}
            value={effective?.bindings.row_selector ? String(effective.bindings.row_selector.value ?? '') : ''}
            onChange={(event) => {
              const column = effective?.bindings.row_selector?.column;
              if (!column) return;
              setBindings({ row_selector: { column, value: event.target.value } });
            }}
            style={{ marginTop: 8 }}
          />
        </Form.Item>
      )}
      {!isEvent && chartType === 'funnel' && (
        <>
          <Form.Item label={t('sql:field.metricFamily')}>
            <Select
              aria-label={t('sql:field.metricFamily')}
              value={effective?.bindings.funnel?.metric_family ?? 'uv'}
              options={[
                { value: 'uv', label: 'UV' },
                { value: 'pv', label: 'PV' },
                { value: 'custom', label: t('common:state.custom') },
              ]}
              onChange={(metric_family) =>
                setBindings({
                  funnel: {
                    shape: effective?.bindings.funnel?.shape ?? 'wide',
                    metric_family,
                    steps: funnelSteps,
                  },
                })
              }
            />
          </Form.Item>
          <Form.Item label={t('sql:field.steps')}>
            <Select
              aria-label={t('sql:field.stepsAria')}
              mode="multiple"
              options={metrics.map((item) => ({ value: item.key, label: columnLabel(item) }))}
              value={funnelSteps.map((step) => step.column)}
              onChange={(value) =>
                setBindings({
                  funnel: {
                    shape: 'wide',
                    metric_family: effective?.bindings.funnel?.metric_family ?? 'custom',
                    steps: value.map((column, index) => ({
                      order: index + 1,
                      column,
                      label: funnelSteps.find((step) => step.column === column)?.label ?? cleanStepLabel(column),
                    })),
                  },
                  metrics: value,
                })
              }
            />
            {funnelSteps.map((step, index) => (
              <Space key={step.column} style={{ display: 'flex', marginTop: 8 }} align="start">
                <Input
                  aria-label={t('sql:field.stepLabelAria', { name: step.column })}
                  value={step.label}
                  onChange={(event) => {
                    const next = funnelSteps.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, label: event.target.value.slice(0, 100) } : item,
                    );
                    setBindings({
                      funnel: {
                        shape: effective?.bindings.funnel?.shape ?? 'wide',
                        metric_family: effective?.bindings.funnel?.metric_family ?? 'custom',
                        steps: next,
                      },
                    });
                  }}
                />
                <Button size="small" aria-label={t('sql:field.moveUpAria', { label: step.label })} disabled={index === 0} onClick={() => moveStep(index, -1)}>
                  {t('sql:field.moveUp')}
                </Button>
                <Button
                  size="small"
                  aria-label={t('sql:field.moveDownAria', { label: step.label })}
                  disabled={index === funnelSteps.length - 1}
                  onClick={() => moveStep(index, 1)}
                >
                  {t('sql:field.moveDown')}
                </Button>
              </Space>
            ))}
          </Form.Item>
        </>
      )}
      {!isEvent && chartType === 'bar' && (
        <>
          <Form.Item label={t('sql:field.sortMetric')}>
            <Select
              aria-label={t('sql:field.sortMetric')}
              options={effective?.bindings.metrics.map((item) => ({ value: item, label: item }))}
              value={effective?.options.sort?.column}
              onChange={(column) =>
                effective &&
                setDraft({
                  ...effective,
                  options: defaultOptions({ ...effective.options, sort: { column, direction: 'desc' } }),
                })
              }
            />
          </Form.Item>
          <Form.Item label={t('sql:field.topN')}>
            <InputNumber
              aria-label={t('sql:field.topN')}
              min={1}
              max={20}
              value={effective?.options.top_n}
              onChange={(top_n) =>
                effective && setDraft({ ...effective, options: defaultOptions({ ...effective.options, top_n: top_n ?? undefined }) })
              }
            />
          </Form.Item>
        </>
      )}
      {!isEvent && chartType === 'pie' && (
        <Form.Item label={t('sql:chart.type.pieDonut')}>
          <Switch
            checked={effective?.options.donut}
            onChange={(donut) => effective && setDraft({ ...effective, options: defaultOptions({ ...effective.options, donut }) })}
          />
        </Form.Item>
      )}
      {!isEvent && chartType === 'trend' && (
        <>
          <Form.Item label={t('sql:field.forecastPoints')} tooltip={t('sql:field.forecastPointsTooltip')}>
            <InputNumber
              aria-label={t('sql:field.forecastPoints')}
              min={0}
              max={90}
              value={effective?.options.trend?.forecast_points ?? DEFAULT_TREND_OPTIONS.forecast_points}
              onChange={(value) => setTrend({ forecast_points: Number(value ?? 0) })}
            />
          </Form.Item>
          <Form.Item label={t('sql:field.threshold')} tooltip={t('sql:field.thresholdTooltip')}>
            <InputNumber
              aria-label={t('sql:field.threshold')}
              style={{ width: '100%' }}
              value={effective?.options.trend?.threshold ?? null}
              onChange={(value) => setTrend({ threshold: typeof value === 'number' ? value : null })}
            />
          </Form.Item>
          <Form.Item label={t('sql:field.trendLine')} tooltip={t('sql:field.trendLineTooltip')}>
            <Switch
              aria-label={t('sql:field.trendLine')}
              checked={effective?.options.trend?.show_trend_line ?? DEFAULT_TREND_OPTIONS.show_trend_line}
              onChange={(show_trend_line) => setTrend({ show_trend_line })}
            />
          </Form.Item>
          <Form.Item label={t('sql:field.showThreshold')}>
            <Switch
              aria-label={t('sql:field.showThreshold')}
              checked={effective?.options.trend?.show_threshold ?? DEFAULT_TREND_OPTIONS.show_threshold}
              onChange={(show_threshold) => setTrend({ show_threshold })}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t('sql:field.forecastHint')}
          </Typography.Paragraph>
        </>
      )}
      {!isEvent && (chartType === 'bar' || chartType === 'pie' || chartType === 'number') ? (
        <Form.Item label={t('sql:field.showValue')}>
          <StatCalcsPicker
            kind={chartType}
            hideLabel
            value={(effective?.options.stat_calcs as StatCalc[] | undefined) ?? defaultStatCalcs(chartType)}
            onChange={(stat_calcs) =>
              effective &&
              setDraft({
                ...effective,
                options: defaultOptions({ ...effective.options, stat_calcs: parseStatCalcs(stat_calcs, chartType) }),
              })
            }
          />
        </Form.Item>
      ) : null}
      <Typography.Title level={5}>{t('sql:field.roleSection')}</Typography.Title>
      {roleEditor}
    </>
  );

  if (layout === 'panel' || layout === 'settings') {
    const actions = (
      <Space style={{ marginTop: 12 }} wrap>
        <Button onClick={onRestoreAuto}>{t('sql:chart.restoreAuto')}</Button>
        <Button type="primary" onClick={apply}>
          {t('sql:field.apply')}
        </Button>
      </Space>
    );
    if (layout === 'settings') {
      return (
        <div aria-label={t('sql:field.title')}>
          <Typography.Text strong className="funnel-view-settings__label">
            {t('sql:field.sectionLabel')}
          </Typography.Text>
          {fields}
          {actions}
        </div>
      );
    }
    return (
      <aside className="chart-field-panel" aria-label={t('sql:field.title')}>
        <Typography.Title level={5} style={{ marginTop: 4 }}>
          {t('sql:field.title')}
        </Typography.Title>
        {fields}
        {actions}
      </aside>
    );
  }

  return (
    <Drawer
      title={t('sql:field.title')}
      open={open}
      onClose={onClose}
      width={420}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onRestoreAuto}>{t('sql:chart.restoreAuto')}</Button>
          <Button onClick={onClose}>{t('common:action.cancel')}</Button>
          <Button type="primary" onClick={apply}>
            {t('sql:field.apply')}
          </Button>
        </Space>
      }
    >
      {fields}
    </Drawer>
  );
}
