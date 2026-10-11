import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Space, Spin, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { AnalysisCardSave } from './AnalysisCardSave';
import { AnalysisResultSettings } from './AnalysisResultSettings';
import { EventViewSettings } from './EventViewSettings';
import { DeleteCardButton } from '../report/DeleteCardButton';
import { CreateMetricModal } from '../metrics/CreateMetricModal';
import { ResultCohortModal } from '../cohort/ResultCohortModal';
import { useAnalysisStore } from '../../stores/analysis.store';
import { ExploreChart } from '../explore-charts/ExploreChart';
import { defaultStatCalcs, type StatCalc } from '../explore-charts/series-stats';
import type { QueryResult } from '../../types/dsl.types';
import type { EventAnalysisFormState } from '../../utils/dsl-builder';
import {
  eventCardChartType,
  eventViewPayload,
  parseDurationPlain,
  parseEventChartType,
  parseEventResultLayout,
  type EventChartType,
  type EventResultLayout,
} from './event-view';
import type { ChartConfigV1, ChartIssue, MetricUnit } from '../visualization/chart.types';
import { defaultOptions } from '../visualization/chart-compatibility';
import { formatIssue } from '../visualization/chart-issues';
import {
  bindingColumns,
  buildEventChartModel,
  suggestAxisSplit,
} from '../event-chart';
import { localizedColumns } from './column-titles';
import { downloadResultCsv } from './result-csv';
import './analysis-workbench.css';

interface EventAnalysisResultProps {
  result: QueryResult | null;
  loading: boolean;
  /** 最近一次查询的表单快照（保存卡片时存储，供点击卡片还原） */
  form?: EventAnalysisFormState | null;
  cardId?: string | null;
  cardName?: string | null;
  initialLayout?: EventResultLayout;
  initialChartType?: EventChartType;
  initialDurationPlain?: boolean;
  initialStatCalcs?: StatCalc[];
  initialYUnit?: MetricUnit;
  /**
   * 当前生效的图表配置与它的改动入口。由页面层持有（AI 快照要从页面发布它），
   * 本组件只渲染与编辑，不自己存一份。
   */
  chartConfig: ChartConfigV1;
  /** 读卡片配置时发现的问题（绑定过期等），与图表下方的问题行一起展示 */
  chartConfigIssues?: ChartIssue[];
  onChartConfigChange: (config: ChartConfigV1 | null) => void;
  /**
   * AI 图表提案（phase: clklog-ai-event-chart-v1）：只展示，**不自动应用**——
   * 用户点「应用」才生效，点「忽略」把回绝回给 AI。AI 侧在 5 分钟 TTL 内等这个决定。
   */
  chartProposal?: { reason: string } | null;
  onChartProposalAccept?: () => void;
  onChartProposalDismiss?: () => void;
}

export function EventAnalysisResult({
  result,
  loading,
  form,
  cardId,
  cardName,
  initialLayout = 'both',
  initialChartType = 'line',
  initialDurationPlain = false,
  initialStatCalcs,
  initialYUnit = 'number',
  chartConfig,
  chartConfigIssues = [],
  onChartConfigChange,
  chartProposal = null,
  onChartProposalAccept,
  onChartProposalDismiss,
}: EventAnalysisResultProps) {
  const { t } = useT('analysis');
  const navigate = useNavigate();
  const [view, setView] = useState<EventResultLayout>(() => parseEventResultLayout(initialLayout));
  const [chartType, setChartType] = useState<EventChartType>(() => parseEventChartType(initialChartType));
  const [durationPlain, setDurationPlain] = useState(() => parseDurationPlain(initialDurationPlain));
  const [statCalcs, setStatCalcs] = useState<StatCalc[]>(
    () => initialStatCalcs ?? defaultStatCalcs(parseEventChartType(initialChartType)),
  );
  const [yUnit, setYUnit] = useState<MetricUnit>(() => initialYUnit);
  const [createOpen, setCreateOpen] = useState(false);
  const [cohortOpen, setCohortOpen] = useState(false);
  const [cohortCell, setCohortCell] = useState<Record<string, unknown>>({});
  const [axisHintDismissed, setAxisHintDismissed] = useState(false);
  const dsl = useAnalysisStore((s) => s.dsl);
  // 查询失败且无结果时也要看得见错误（与留存结果区一致）
  const error = useAnalysisStore((s) => s.error);
  // 图表系列名/图例用本地化列名；表格走 DataTable（表头本地化，时间列启发式读服务端中文原文）
  const displayColumns = useMemo(
    () => (result ? localizedColumns(result.columns, t) : []),
    [result, t],
  );

  // 字段绑定由页面层持有（chartConfig prop）；这里只负责渲染与把改动回抛
  const bindingColumnList = useMemo(
    () => bindingColumns(displayColumns, chartConfig.roles),
    [displayColumns, chartConfig.roles],
  );
  const chartModel = useMemo(
    () => (result ? buildEventChartModel(displayColumns, result.rows, chartConfig) : null),
    [result, displayColumns, chartConfig],
  );

  // 双轴建议：只在没有拆分系列（系列与指标一一对应）时才给得出
  const axisSuggestion = useMemo(() => {
    if (!chartModel || chartConfig.bindings.series) return null;
    const byKey = new Map(displayColumns.map((column) => [column.key, column]));
    const byName = new Map(chartModel.model.series.map((item) => [item.name, item]));
    const candidates = chartConfig.bindings.metrics.flatMap((key) => {
      const column = byKey.get(key);
      const series = column ? byName.get(column.title) : undefined;
      return column && series ? [{ key, name: column.title, values: series.values }] : [];
    });
    return suggestAxisSplit(candidates, chartConfig.options.metric_axis);
  }, [chartModel, chartConfig, displayColumns]);

  // 提案条在结果区顶部，用户可能在页面下方——出现时滚到可见位置
  const proposalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chartProposal) return;
    proposalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [chartProposal]);

  useEffect(() => {
    setView(parseEventResultLayout(initialLayout));
    const chart = parseEventChartType(initialChartType);
    setChartType(chart);
    setDurationPlain(parseDurationPlain(initialDurationPlain));
    setStatCalcs(initialStatCalcs ?? defaultStatCalcs(chart));
    setYUnit(initialYUnit);
    setAxisHintDismissed(false);
  }, [cardId, initialLayout, initialChartType, initialDurationPlain, initialStatCalcs, initialYUnit]);

  if (loading) {
    return (
      <Card>
        <Spin tip={t('analysis:state.querying')} style={{ width: '100%', padding: 40 }} />
      </Card>
    );
  }

  if (!result) {
    if (error) {
      return (
        <Card>
          <Typography.Text type="danger">{error}</Typography.Text>
        </Card>
      );
    }
    return (
      <Card>
        <EmptyState variant="analysis" title={null} description={t('analysis:event.emptyHint')} />
      </Card>
    );
  }

  const { columns, rows, elapsed_ms, from_cache, sql } = result;
  const showChart = view === 'chart' || view === 'both';
  const showTable = view === 'table' || view === 'both';
  const hasDuration = columns.some((col) => col.unit === 'duration_sec');
  const dslWithView = dsl
    ? {
        ...(dsl as unknown as Record<string, unknown>),
        _view: eventViewPayload({ layout: view, chart: chartType, durationPlain, statCalcs, yUnit }),
        // 字段绑定与 SQL 卡同名字段、同一份契约（phase: clklog-analytics-event-chart-binding-v1）
        chart_config: chartConfig,
      }
    : null;
  const userCountKeys = (form?.metrics ?? []).flatMap((metric, index) =>
    metric.kind !== 'formula' && (metric.analysis === 'trig_user_num' || metric.type === 'uniq_user')
      ? [`m_${index}`]
      : [],
  );

  return (
    <Card
      className="analysis-result-card"
      title={
        <Space wrap>
          <span>{t('analysis:result.title')}</span>
          <Tag color={from_cache ? 'green' : 'blue'}>
            {from_cache ? t('analysis:state.cacheHit') : t('analysis:state.liveQuery')}
          </Tag>
          {dsl && (dsl as { approx?: boolean }).approx ? (
            <Tag color="gold" title={t('analysis:event.approxTagTip')}>
              {t('analysis:event.approxTag')}
            </Tag>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {elapsed_ms}ms
          </Typography.Text>
        </Space>
      }
      extra={
        <Space wrap>
          <AnalysisResultSettings>
            <EventViewSettings
              layout={view}
              chartType={chartType}
              statCalcs={statCalcs}
              hasDuration={hasDuration}
              durationPlain={durationPlain}
              yUnit={yUnit}
              chartConfig={chartConfig}
              columns={bindingColumnList}
              onLayoutChange={setView}
              onChartTypeChange={setChartType}
              onStatCalcsChange={setStatCalcs}
              onDurationPlainChange={setDurationPlain}
              onYUnitChange={setYUnit}
              onChartConfigChange={onChartConfigChange}
              onRestoreAuto={() => onChartConfigChange(null)}
            />
          </AnalysisResultSettings>
          {dslWithView ? (
            <AnalysisCardSave
              type="event"
              dsl={dslWithView}
              formSnapshot={form}
              chartType={eventCardChartType(view, chartType)}
              cardId={cardId}
              cardName={cardName}
            />
          ) : null}
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => downloadResultCsv(t('analysis:event.title'), columns, rows)}
          >
            {t('analysis:action.exportCsv')}
          </Button>
          <Button size="small" onClick={() => setCreateOpen(true)}>
            {t('analysis:action.createMetric')}
          </Button>
          <CreateMetricModal
            open={createOpen}
            kind="event"
            eventMetrics={form?.metrics}
            onClose={() => setCreateOpen(false)}
          />
          {cardId ? (
            <DeleteCardButton
              cardId={cardId}
              cardName={cardName ?? undefined}
              onDeleted={() => navigate('/analysis/event')}
            />
          ) : null}
        </Space>
      }
    >
      {showChart && chartModel && (
        <div style={{ marginBottom: 24 }}>
          {chartProposal ? (
            <div ref={proposalRef}>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                message={
                  <Space wrap>
                    <span>{t('analysis:aiChart.title', { reason: chartProposal.reason })}</span>
                    <Button size="small" type="primary" onClick={onChartProposalAccept}>
                      {t('analysis:aiChart.apply')}
                    </Button>
                    <Button size="small" onClick={onChartProposalDismiss}>
                      {t('analysis:aiChart.ignore')}
                    </Button>
                  </Space>
                }
              />
            </div>
          ) : null}
          {!chartProposal && axisSuggestion && !axisHintDismissed ? (
            <Alert
              type="info"
              showIcon
              closable
              onClose={() => setAxisHintDismissed(true)}
              style={{ marginBottom: 8 }}
              message={
                <Space wrap>
                  <span>
                    {formatIssue(
                      {
                        code: 'AXIS_SPLIT_SUGGESTED',
                        severity: 'info',
                        params: { ratio: axisSuggestion.ratio, metrics: axisSuggestion.names.join(t('sql:chart.listSeparator')) },
                      },
                      t,
                    )}
                  </span>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() =>
                      onChartConfigChange({
                        ...chartConfig,
                        mode: 'manual',
                        options: defaultOptions({ ...chartConfig.options, metric_axis: axisSuggestion.axes }),
                      })
                    }
                  >
                    {t('analysis:issue.applySuggestion')}
                  </Button>
                </Space>
              }
            />
          ) : null}
          <ExploreChart
            kind={chartType}
            model={chartModel.model}
            statCalcs={statCalcs}
            yUnit={yUnit}
          />
          {[...chartConfigIssues, ...chartModel.issues]
            .filter((issue) => issue.code !== 'AXIS_SPLIT_SUGGESTED')
            .map((issue, index) => (
              <Typography.Text
                key={`${issue.code}-${index}`}
                type={issue.severity === 'error' ? 'danger' : 'secondary'}
                style={{ display: 'block', fontSize: 12, marginTop: 4 }}
              >
                {formatIssue(issue, t)}
              </Typography.Text>
            ))}
        </div>
      )}
      {showTable && (
        <DataTable
          columns={columns}
          rows={rows}
          durationPlain={durationPlain}
          userCountKeys={userCountKeys}
          onUserCountClick={(key, row) => {
            const index = Number(key.slice(2));
            const groups: Record<string, unknown> = {};
            for (const [groupKey, value] of Object.entries(row)) {
              if (groupKey.startsWith('g_')) groups[groupKey] = value;
            }
            setCohortCell({
              metric_id: form?.metrics[index]?.id,
              groups,
            });
            setCohortOpen(true);
          }}
        />
      )}
      <ResultCohortModal
        open={cohortOpen}
        source="event"
        dsl={dsl ? (dsl as unknown as Record<string, unknown>) : null}
        cell={cohortCell}
        onClose={() => setCohortOpen(false)}
      />
      {sql && (
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          <pre style={{ fontSize: 12, background: '#f6f6f6', padding: 12, borderRadius: 4 }}>
            {sql}
          </pre>
        </Typography.Paragraph>
      )}
    </Card>
  );
}
