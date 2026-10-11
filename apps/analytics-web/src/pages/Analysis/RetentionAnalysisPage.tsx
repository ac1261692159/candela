import { useAnalysisProposal } from '../../features/ai-analysis/useAnalysisProposal';
import { retentionForm } from '../../features/ai-analysis/dsl-form';
import { useEffect, useRef, useState } from 'react';
import { Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { AnalysisWorkbench } from '../../features/query/AnalysisWorkbench';
import { AnalysisToolbar } from '../../features/query/AnalysisToolbar';
import { RetentionEditor } from '../../features/query/RetentionEditor';
import { RetentionResult } from '../../features/query/RetentionResult';
import { useRetentionStore } from '../../stores/retention.store';
import { useProjectStore } from '../../stores/project.store';
import { buildRetentionQuery, type RetentionFormState } from '../../utils/dsl-builder';
import type { TimeRange } from '../../types/dsl.types';
import { lastNDaysRange } from '../../features/query/example-query';
import { materializeTimeRange } from '../../features/time-range/resolve';
import { getCard } from '../../services/report.service';
import { queryResultFromCache } from '../../features/query/analysis-cache-result';
import { useAiContextStore } from '../../stores/ai-context.store';
import { retentionChartFromDsl, retentionLayoutFromDsl, type RetentionChartType, type RetentionResultLayout } from '../../features/query/retention-view';

export function RetentionAnalysisPage() {
  const project = useProjectStore((state) => state.currentProject);
  const { dsl, result, loading, runQuery, hydrateCached } = useRetentionStore();
  const publishAiContext = useAiContextStore((state) => state.publishContext);
  const clearAiContext = useAiContextStore((state) => state.clearContext);
  const [searchParams] = useSearchParams();
  const cardId = searchParams.get('card');

  const [restoredForm, setRestoredForm] = useState<RetentionFormState | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [lastForm, setLastForm] = useState<RetentionFormState | null>(null);
  const [draftForm, setDraftForm] = useState<RetentionFormState | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [cardName, setCardName] = useState<string | null>(null);
  const [retentionLayout, setRetentionLayout] = useState<RetentionResultLayout>('both');
  const [retentionChart, setRetentionChart] = useState<RetentionChartType>('nth_trend');
  const restoredRef = useRef<string | null>(null);
  // 时间范围提升到 Page：工具条（结果上方）与编辑器共享
  const [timeRange, setTimeRange] = useState<TimeRange>(() => lastNDaysRange(7));

  useEffect(() => {
    publishAiContext(
      {
        page: 'retention',
        route: '/analysis/retention',
        analysis: {
          dsl: dsl ? { ...dsl } : null,
          form: draftForm ? { ...draftForm, timeRange } : null,
          loading,
        },
        result: result ? { ...result } : undefined,
      },
      project,
    );
  }, [dsl, draftForm, timeRange, loading, project, publishAiContext, result]);

  useEffect(
    () => () => {
      clearAiContext('retention', project);
    },
    [clearAiContext, project],
  );

  useAnalysisProposal('retention', project, retentionForm, (form) => {
    setRestoredForm(form);
    setDraftForm(form);
    setTimeRange(materializeTimeRange(form.timeRange));
    setFormEpoch((value) => value + 1);
  });

  const handleAnalyze = (form: RetentionFormState) => {
    const next = buildRetentionQuery({ ...form, timeRange }, project);
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
        setRetentionLayout(retentionLayoutFromDsl(card.dsl));
        setRetentionChart(retentionChartFromDsl(card.dsl, card.chart_type));
        const snapshot = (card.dsl as { _form?: RetentionFormState })?._form;
        if (snapshot?.startEvent) {
          setRestoredForm(snapshot);
          setTimeRange(materializeTimeRange(snapshot.timeRange));
          const next = buildRetentionQuery(snapshot, project);
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
        <RetentionEditor
          key={`${project}:${cardId ?? 'default'}:${formEpoch}`}
          initialForm={restoredForm ?? undefined}
          onAnalyze={handleAnalyze}
          onFormChange={setDraftForm}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
        />
      }
      result={
        <>
          <AnalysisToolbar timeRange={timeRange} onTimeRangeChange={setTimeRange} />
          <RetentionResult
            result={result}
            loading={loading}
            form={lastForm}
            cardId={cardId}
            cardName={cardName}
            initialLayout={retentionLayout}
            initialChartType={retentionChart}
          />
        </>
      }
    />
  );
}
