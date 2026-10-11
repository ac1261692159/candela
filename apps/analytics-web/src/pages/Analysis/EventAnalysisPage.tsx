import { useAnalysisProposal } from '../../features/ai-analysis/useAnalysisProposal';
import { eventForm } from '../../features/ai-analysis/dsl-form';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { AnalysisWorkbench } from '../../features/query/AnalysisWorkbench';
import { AnalysisToolbar } from '../../features/query/AnalysisToolbar';
import { EventAnalysisForm } from '../../features/query/EventAnalysisForm';
import { EventAnalysisResult } from '../../features/query/EventAnalysisResult';
import { useAnalysisStore } from '../../stores/analysis.store';
import { buildEventQuery, type EventAnalysisFormState } from '../../utils/dsl-builder';
import type { TimeRange } from '../../types/dsl.types';
import { lastNDaysRange } from '../../features/query/example-query';
import { materializeTimeRange } from '../../features/time-range/resolve';
import { useProjectStore } from '../../stores/project.store';
import { getCard } from '../../services/report.service';
import { queryResultFromCache } from '../../features/query/analysis-cache-result';
import { useAiContextStore } from '../../stores/ai-context.store';
import {
  durationPlainFromDsl,
  eventChartFromDsl,
  eventLayoutFromDsl,
  eventStatCalcsFromDsl,
  eventYUnitFromDsl,
  type EventChartType,
  type EventResultLayout,
} from '../../features/query/event-view';
import type { StatCalc } from '../../features/explore-charts/series-stats';
import type { MetricUnit } from '../../features/visualization/chart.types';
import { chartConfigFromProposal, useEventChartConfig } from '../../features/event-chart';
import { useChartProposal } from '../../features/ai-analysis/useChartProposal';
import { localizedColumns } from '../../features/query/column-titles';
import { useT } from '../../i18n';

export function EventAnalysisPage() {
  const project = useProjectStore((state) => state.currentProject);
  const { dsl, result, loading, runQuery, hydrateCached } = useAnalysisStore();
  const publishAiContext = useAiContextStore((state) => state.publishContext);
  const clearAiContext = useAiContextStore((state) => state.clearContext);
  const { t } = useT('analysis');
  const [searchParams] = useSearchParams();
  const cardId = searchParams.get('card');

  const [restoredForm, setRestoredForm] = useState<EventAnalysisFormState | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [lastForm, setLastForm] = useState<EventAnalysisFormState | null>(null);
  const [draftForm, setDraftForm] = useState<EventAnalysisFormState | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [cardName, setCardName] = useState<string | null>(null);
  const [eventLayout, setEventLayout] = useState<EventResultLayout>('both');
  const [eventChart, setEventChart] = useState<EventChartType>('line');
  const [durationPlain, setDurationPlain] = useState(false);
  const [eventStatCalcs, setEventStatCalcs] = useState<StatCalc[] | undefined>(undefined);
  const [eventYUnit, setEventYUnit] = useState<MetricUnit>('number');
  // 卡片的字段绑定配置：store 里的 dsl 是重建后的查询，不带 chart_config，必须单独带下来
  const [cardChartConfigRaw, setCardChartConfigRaw] = useState<unknown>(null);
  const restoredRef = useRef<string | null>(null);
  // 时间范围提升到 Page：工具条（结果上方）与编辑器共享
  const [timeRange, setTimeRange] = useState<TimeRange>(() => lastNDaysRange(7));

  // 图表配置由页面层持有：AI 快照要从这里发布 analysis.chart_config（phase: clklog-ai-event-chart-v1）
  const chartColumns = useMemo(
    () => localizedColumns(result?.columns ?? [], t),
    [result, t],
  );
  const {
    chartConfig,
    issues: chartConfigIssues,
    setOverride: setChartConfig,
  } = useEventChartConfig({
    raw: cardChartConfigRaw,
    columns: chartColumns,
    chartType: eventChart,
    legacyUnit: eventYUnit,
    resetKey: cardId,
  });
  /** 发给 AI 的结果列元数据：列 key（绑定引用的就是它）+ 角色 + 单位 */
  const chartResultColumns = useMemo(
    () =>
      (result?.columns ?? []).map((column) => ({
        name: column.key,
        role: column.role,
        unit: column.unit,
      })),
    [result],
  );

  // AI 图表提案：只落成待确认条，用户点「应用」才改本地配置（phase: clklog-ai-event-chart-v1）
  const applyChartProposal = useCallback(
    (raw: Record<string, unknown>) => {
      setChartConfig(chartConfigFromProposal(raw, chartColumns));
    },
    [chartColumns, setChartConfig],
  );
  const chartProposal = useChartProposal('event', project, applyChartProposal, chartConfig);

  useEffect(() => {
    publishAiContext(
      {
        page: 'event',
        route: '/analysis/event',
        analysis: {
          dsl: dsl ? { ...dsl } : null,
          form: draftForm ? { ...draftForm, timeRange } : null,
          loading,
          // 图表展示参数（读）：列元数据 + 当前生效配置 + chart_config 覆盖不到的展示态
          result_columns: chartResultColumns,
          chart_config: chartConfig,
          view: {
            event_layout: eventLayout,
            event_chart: eventChart,
            duration_plain: durationPlain,
            stat_calcs: eventStatCalcs ?? [],
            y_unit: eventYUnit,
          },
        },
        result: result ? { ...result } : undefined,
      },
      project,
    );
  }, [
    dsl,
    draftForm,
    timeRange,
    loading,
    project,
    publishAiContext,
    result,
    chartResultColumns,
    chartConfig,
    eventLayout,
    eventChart,
    durationPlain,
    eventStatCalcs,
    eventYUnit,
  ]);

  useEffect(
    () => () => {
      clearAiContext('event', project);
    },
    [clearAiContext, project],
  );

  useAnalysisProposal('event', project, eventForm, (form) => {
    setRestoredForm(form);
    setDraftForm(form);
    setTimeRange(materializeTimeRange(form.timeRange));
    setFormEpoch((value) => value + 1);
  });

  const handleAnalyze = (form: EventAnalysisFormState) => {
    const next = buildEventQuery({ ...form, timeRange }, project);
    setLastForm(form);
    runQuery(next);
  };

  useEffect(() => {
    if (!cardId || restoredRef.current === cardId) return;
    restoredRef.current = cardId;
    let cancelled = false;
    setRestoring(true);
    getCard(cardId)
      .then((card) => {
        if (cancelled) return;
        setCardName(card.name);
        setEventLayout(eventLayoutFromDsl(card.dsl));
        setEventChart(eventChartFromDsl(card.dsl, card.chart_type));
        setDurationPlain(durationPlainFromDsl(card.dsl));
        setEventStatCalcs(eventStatCalcsFromDsl(card.dsl, eventChartFromDsl(card.dsl, card.chart_type)));
        setEventYUnit(eventYUnitFromDsl(card.dsl));
        setCardChartConfigRaw((card.dsl as { chart_config?: unknown })?.chart_config ?? null);
        const snapshot = (card.dsl as { _form?: EventAnalysisFormState })?._form;
        if (snapshot?.metrics?.length) {
          setRestoredForm({
            ...snapshot,
            approx: snapshot.approx ?? (card.dsl as { approx?: boolean }).approx,
          });
          setTimeRange(materializeTimeRange(snapshot.timeRange));
          const next = buildEventQuery(snapshot, project);
          setLastForm(snapshot);
          const cached = queryResultFromCache(card.cache?.result);
          if (cached) hydrateCached(next, cached);
          else runQuery(next);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; restoredRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, project]);

  if (restoring) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <AnalysisWorkbench
      rail={
        <EventAnalysisForm
          key={`${project}:${cardId ?? 'default'}:${formEpoch}`}
          initialForm={restoredForm ?? undefined}
          onAnalyze={handleAnalyze}
          onFormChange={setDraftForm}
          loading={loading}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
        />
      }
      result={
        <>
          <AnalysisToolbar timeRange={timeRange} onTimeRangeChange={setTimeRange} />
          <EventAnalysisResult
            result={result}
            loading={loading}
            form={lastForm}
            cardId={cardId}
            cardName={cardName}
            initialLayout={eventLayout}
            initialChartType={eventChart}
            initialDurationPlain={durationPlain}
            initialStatCalcs={eventStatCalcs}
            initialYUnit={eventYUnit}
            chartConfig={chartConfig}
            chartConfigIssues={chartConfigIssues}
            onChartConfigChange={setChartConfig}
            chartProposal={chartProposal.proposal}
            onChartProposalAccept={chartProposal.accept}
            onChartProposalDismiss={chartProposal.dismiss}
          />
        </>
      }
    />
  );
}
