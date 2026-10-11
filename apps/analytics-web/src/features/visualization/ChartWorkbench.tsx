import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactECharts from 'echarts-for-react';
import { Alert, Card, Col, Empty, Row, Select, Statistic, Table } from 'antd';
import { AccessibleChartSummary } from './AccessibleChartSummary';
import { ChartToolbar } from './ChartToolbar';
import { FieldBindingPanel } from './FieldBindingPanel';
import { bindingColumnsFromProfiles } from './chart-compatibility';
import { formatIssue } from './chart-issues';
import { resolveVisualization, switchChartType } from './chart-pipeline';
import { recommendationReasonText } from './chart-recommender';
import { SeriesStatsTable } from '../explore-charts/SeriesStatsTable';
import { EXPLORE_COLORS } from '../explore-charts/explore-chart-option';
import { applyLegendIsolate } from '../explore-charts/legend-isolate';
import { defaultStatCalcs, seriesStats, type StatCalc } from '../explore-charts/series-stats';
import '../explore-charts/explore-chart.css';
import type {
  BuilderDslLike,
  ChartConfigV1,
  ChartIssue,
  ChartTypeV1,
} from './chart.types';
import type { SqlExecuteResult } from '../../types/report.types';
import { useT } from '../../i18n';

type SqlMode = 'sql' | 'builder';

function withOverlayLegend(option: Record<string, unknown>, seriesCount: number): Record<string, unknown> {
  const bottom = 28 + Math.max(seriesCount, 1) * 22;
  const grid = option.grid;
  const nextGrid = Array.isArray(grid)
    ? grid.map((item) => (item && typeof item === 'object' ? { ...item, bottom } : item))
    : {
        ...(grid && typeof grid === 'object' ? grid : {}),
        left: 12,
        right: 16,
        top: 28,
        bottom,
        containLabel: true,
      };
  return { ...option, color: option.color ?? EXPLORE_COLORS, legend: { show: false }, grid: nextGrid };
}

interface ChartWorkbenchProps {
  result: SqlExecuteResult;
  config: ChartConfigV1 | null;
  queryContext?: { mode: SqlMode; builderDsl?: unknown; sql?: unknown };
  displayMode: 'analysis' | 'dashboard';
  onConfigChange?: (config: ChartConfigV1) => void;
  onIssue?: (issues: ChartIssue[]) => void;
  height?: number;
  /** 看板格子内铺满剩余高度，避免图表/表格下方大块留白 */
  fill?: boolean;
  /** SQL 页把展示/图形/字段放进顶部齿轮，工作台只画图 */
  hideEmbeddedChrome?: boolean;
  /**
   * 图表不可用时的回退形态：
   * - `table`（默认）：占位 + 内建表格，供「工作台是唯一结果渲染方」的场景（看板卡片 / 仅图表视图）；
   * - `none`：什么都不画，交给调用方（分析页在图表+表格并排时自带结果表，避免出现两张表）。
   */
  tableFallback?: 'table' | 'none';
}

class ChartErrorBoundary extends Component<{ children: ReactNode; onError: () => void; errorMessage: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    if (this.state.failed) {
      return <Alert type="error" showIcon message={this.props.errorMessage} />;
    }
    return this.props.children;
  }
}

export function ChartWorkbench({
  result,
  config,
  queryContext,
  displayMode,
  onConfigChange,
  onIssue,
  height = 320,
  fill,
  hideEmbeddedChrome,
  tableFallback = 'table',
}: ChartWorkbenchProps) {
  const { t } = useT('sql');
  const [renderError, setRenderError] = useState(false);
  const chartRef = useRef<ReactECharts>(null);
  const frameRef = useRef<number>();
  const isolatedRef = useRef<string | null>(null);
  const legendLockRef = useRef(false);

  const resolved = useMemo(
    () =>
      resolveVisualization({
        columns: result.columns,
        rows: result.rows,
        savedConfig: config,
        queryContext: { builderDsl: queryContext?.builderDsl as BuilderDslLike | undefined, sql: queryContext?.sql as string | undefined },
        truncated: result.truncated,
      }),
    [config, queryContext?.builderDsl, queryContext?.sql, result, t],
  );

  useEffect(() => {
    onIssue?.(resolved.issues);
  }, [onIssue, resolved.issues]);

  useEffect(() => {
    if (!config && resolved.config) onConfigChange?.(resolved.config);
  }, [config, onConfigChange, resolved.config]);

  useEffect(() => {
    isolatedRef.current = null;
  }, [resolved.adapter]);

  useEffect(() => {
    const node = chartRef.current?.getEchartsInstance?.().getDom()?.parentElement;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        chartRef.current?.getEchartsInstance?.().resize();
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [resolved.adapter]);

  const emit = (next: ChartConfigV1 | null) => {
    if (next) onConfigChange?.(next);
  };

  const errors = resolved.issues.filter((issue) => issue.severity === 'error');
  const warnings = resolved.issues.filter((issue) => issue.severity !== 'error');
  const funnelSelect = resolved.issues.find((issue) => issue.code === 'MULTI_ROW_FUNNEL_REQUIRES_SELECTION');
  const dimColumn = String(funnelSelect?.params?.dimension ?? resolved.config?.bindings.row_selector?.column ?? '');
  const dimValues = dimColumn
    ? [...new Set(result.rows.map((row) => row[dimColumn]).filter((value) => value !== null && value !== undefined).map(String))]
    : [];

  const cards = resolved.adapter?.option.clklogNumberCards as Array<{ name: string; display: string; value: number | null }> | undefined;
  const readOnly = displayMode === 'dashboard';
  const statCalcs =
    (resolved.config?.options.stat_calcs as StatCalc[] | undefined) ??
    defaultStatCalcs(resolved.config?.chart_type ?? 'line');
  const statSeries = resolved.data
    ? (resolved.config?.bindings.metrics.length
        ? resolved.config.bindings.metrics
        : Object.keys(resolved.data.points[0]?.values ?? {})
      ).map((name) => ({
        name,
        values: resolved.data!.points.map((point) => point.values[name] ?? null),
      }))
    : [];
  const statRows = seriesStats(statSeries, statCalcs);
  const statPercent = Object.values(resolved.config?.options.units ?? {}).some(
    (unit) => unit.includes('ratio') || unit.includes('percent'),
  );
  const overlayStats = resolved.config?.chart_type === 'bar' || resolved.config?.chart_type === 'pie';

  const analysis = displayMode === 'analysis';
  const showChrome = analysis && !hideEmbeddedChrome;
  // 图表不可用时是否「什么都不画」：此时容器不能再按 height 撑高，否则留下一大块空白
  const chartUnavailable = renderError || (errors.length > 0 && resolved.view !== 'chart');
  const blankFallback = chartUnavailable && tableFallback === 'none';
  const shellStyle = fill
    ? { position: 'relative' as const, height: blankFallback ? undefined : '100%', minHeight: 0, display: 'flex', flexDirection: showChrome ? 'row' as const : 'column' as const }
    : { position: 'relative' as const, minHeight: blankFallback ? 0 : height, display: 'flex', flexDirection: showChrome ? 'row' as const : 'column' as const };

  return (
    <div style={shellStyle}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {showChrome && (
        <ChartToolbar
          config={resolved.config}
          inference={resolved.inference}
          reason={recommendationReasonText(resolved.inference, t)}
          issues={resolved.issues}
          hideFieldsButton
          onChartTypeChange={(type: ChartTypeV1, extra) => {
            const next = switchChartType(resolved.config, type, resolved);
            if (!next) return;
            emit({
              ...next,
              options: {
                ...next.options,
                orientation: extra?.orientation ?? next.options.orientation,
                donut: extra?.donut ?? next.options.donut,
              },
            });
          }}
          onRestoreAuto={() => {
            const auto = resolveVisualization({
              columns: result.columns,
              rows: result.rows,
              queryContext: { builderDsl: queryContext?.builderDsl as BuilderDslLike | undefined, sql: queryContext?.sql as string | undefined },
              truncated: result.truncated,
            });
            if (auto.config) emit({ ...auto.config, mode: 'auto' });
          }}
          onOpenFields={() => undefined}
        />
      )}
      {warnings.map((issue, index) => (
        <Alert
          key={`${issue.code}-${issue.columns?.join(',') ?? ''}-${index}`}
          type="warning"
          showIcon
          closable
          message={formatIssue(issue, t)}
          style={{ margin: '0 12px 8px' }}
        />
      ))}
      {errors.map((issue, index) => (
        <Alert key={`${issue.code}-${issue.columns?.join(',') ?? ''}-err-${index}`} type="error" showIcon message={formatIssue(issue, t)} style={{ margin: '0 12px 8px' }} />
      ))}
      {funnelSelect && dimColumn && analysis && (
        <div style={{ padding: '0 12px 8px' }}>
          <Select
            aria-label={t('sql:chart.selectAria', { column: dimColumn })}
            placeholder={t('sql:chart.selectPlaceholder', { column: dimColumn })}
            style={{ minWidth: 240 }}
            options={dimValues.map((value) => ({ value, label: value }))}
            value={resolved.config?.bindings.row_selector ? String(resolved.config.bindings.row_selector.value) : undefined}
            onChange={(value) => {
              if (!resolved.config) return;
              emit({
                ...resolved.config,
                mode: 'manual',
                bindings: { ...resolved.config.bindings, row_selector: { column: dimColumn, value } },
              });
            }}
          />
        </div>
      )}
      {resolved.adapter && (
        <AccessibleChartSummary
          summary={resolved.adapter.summary}
          issues={resolved.issues}
          reveal={!readOnly}
        />
      )}
      {blankFallback ? null : renderError || (errors.length && resolved.view !== 'chart') ? (
        <div style={{ padding: '0 12px 12px' }}>
          <Empty description={t('sql:chart.tableFallback')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          <Table
            size="small"
            pagination={false}
            scroll={{ x: 'max-content', y: fill ? '100%' : height }}
            columns={result.columns.map((column) => ({ title: column.name, dataIndex: column.name, key: column.name, ellipsis: true }))}
            dataSource={result.rows.map((row, index) => ({ key: index, ...row }))}
          />
        </div>
      ) : cards ? (
        <Row gutter={16} style={{ padding: readOnly ? 0 : 12, flex: fill ? 1 : undefined, alignItems: fill ? 'center' : undefined }}>
          {cards.map((item) => (
            <Col key={item.name} xs={24} sm={12} md={8}>
              {readOnly ? (
                <Statistic title={item.name} value={item.display} formatter={() => item.display} />
              ) : (
                <Card>
                  <Statistic title={item.name} value={item.display} formatter={() => item.display} />
                </Card>
              )}
            </Col>
          ))}
        </Row>
      ) : resolved.adapter && resolved.view === 'chart' && !funnelSelect ? (
        <div className={`explore-chart${fill ? ' explore-chart--fill' : ''}`} style={fill ? { flex: 1 } : { height }}>
          <ChartErrorBoundary onError={() => setRenderError(true)} errorMessage={t('sql:chart.renderFailed')}>
            <ReactECharts
              ref={chartRef}
              className="explore-chart__canvas"
              option={
                overlayStats
                  ? withOverlayLegend(resolved.adapter.option as Record<string, unknown>, statRows.length)
                  : {
                      ...(resolved.adapter.option as Record<string, unknown>),
                      color: (resolved.adapter.option as Record<string, unknown>).color ?? EXPLORE_COLORS,
                    }
              }
              style={fill ? { height: '100%', flex: 1, minHeight: 0 } : { height: '100%' }}
              notMerge
              lazyUpdate
              onEvents={{
                legendselectchanged: (params: { name?: string }) => {
                  applyLegendIsolate(
                    chartRef.current?.getEchartsInstance?.(),
                    isolatedRef,
                    legendLockRef,
                    String(params?.name ?? ''),
                  );
                },
              }}
            />
          </ChartErrorBoundary>
          {overlayStats && resolved.data && resolved.config ? (
            <SeriesStatsTable rows={statRows} calcs={statCalcs} percent={statPercent} overlay />
          ) : null}
        </div>
      ) : (
        <Empty description={funnelSelect ? formatIssue(funnelSelect, t) : t('sql:chart.emptyConfig')} />
      )}
      </div>
      {!readOnly && showChrome && (
        <FieldBindingPanel
          layout="panel"
          open
          config={resolved.config}
          columns={bindingColumnsFromProfiles(resolved.profiles)}
          chartType={resolved.config?.chart_type ?? 'bar'}
          onClose={() => undefined}
          onApply={(next) => emit(next)}
          onRestoreAuto={() => {
            const auto = resolveVisualization({
              columns: result.columns,
              rows: result.rows,
              queryContext: { builderDsl: queryContext?.builderDsl as BuilderDslLike | undefined, sql: queryContext?.sql as string | undefined },
              truncated: result.truncated,
            });
            if (auto.config) emit({ ...auto.config, mode: 'auto' });
          }}
        />
      )}
    </div>
  );
}

