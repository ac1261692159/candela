import { useAnalysisProposal } from '../../features/ai-analysis/useAnalysisProposal';
import { funnelForm } from '../../features/ai-analysis/dsl-form';
import { useEffect, useRef, useState } from 'react';
import { Spin } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { AnalysisWorkbench } from '../../features/query/AnalysisWorkbench';
import { AnalysisToolbar } from '../../features/query/AnalysisToolbar';
import { FunnelEditor } from '../../features/query/FunnelEditor';
import { FunnelResult } from '../../features/query/FunnelResult';
import { useFunnelStore } from '../../stores/funnel.store';
import { useProjectStore } from '../../stores/project.store';
import { buildFunnelQuery } from '../../utils/dsl-builder';
import type { FunnelFormState } from '../../utils/dsl-builder';
import type { TimeRange } from '../../types/dsl.types';
import { lastNDaysRange } from '../../features/query/example-query';
import { materializeTimeRange } from '../../features/time-range/resolve';
import { getCard } from '../../services/report.service';
import { funnelResultFromCache } from '../../features/query/analysis-cache-result';
import { useAiContextStore } from '../../stores/ai-context.store';
import {
  DEFAULT_FUNNEL_COLOR,
  DEFAULT_FUNNEL_TABLE_COL_CHARS,
  funnelColorFromDsl,
  funnelLayoutFromDsl,
  funnelRateFromDsl,
  funnelTableColCharsFromDsl,
  type FunnelColorConfig,
  type FunnelLayout,
  type FunnelRateMode,
} from '../../features/query/funnel-display';

export function FunnelAnalysisPage() {
  const project = useProjectStore((state) => state.currentProject);
  const { dsl, result, loading, runQuery, hydrateCached } = useFunnelStore();
  const publishAiContext = useAiContextStore((state) => state.publishContext);
  const clearAiContext = useAiContextStore((state) => state.clearContext);
  const [searchParams] = useSearchParams();
  const cardId = searchParams.get('card');

  const [restoredForm, setRestoredForm] = useState<FunnelFormState | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [lastForm, setLastForm] = useState<FunnelFormState | null>(null);
  const [draftForm, setDraftForm] = useState<FunnelFormState | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [cardName, setCardName] = useState<string | null>(null);
  const [rateMode, setRateMode] = useState<FunnelRateMode>('conversion');
  const [layout, setLayout] = useState<FunnelLayout | undefined>();
  const [color, setColor] = useState<FunnelColorConfig>(DEFAULT_FUNNEL_COLOR);
  const [tableColChars, setTableColChars] = useState(DEFAULT_FUNNEL_TABLE_COL_CHARS);
  // 时间范围提升到 Page：工具条（结果上方）与编辑器共享
  const [timeRange, setTimeRange] = useState<TimeRange>(() => lastNDaysRange(7));
  const restoredRef = useRef<string | null>(null);

  useEffect(() => {
    publishAiContext(
      {
        page: 'funnel',
        route: '/analysis/funnel',
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
      clearAiContext('funnel', project);
    },
    [clearAiContext, project],
  );

  useAnalysisProposal('funnel', project, funnelForm, (form) => {
    setRestoredForm(form);
    setDraftForm(form);
    setTimeRange(materializeTimeRange(form.timeRange));
    setFormEpoch((value) => value + 1);
  });

  const handleAnalyze = (form: FunnelFormState) => {
    const next = buildFunnelQuery({ ...form, timeRange }, project);
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
        setRateMode(funnelRateFromDsl(card.dsl));
        setLayout(funnelLayoutFromDsl(card.dsl));
        setColor(funnelColorFromDsl(card.dsl));
        setTableColChars(funnelTableColCharsFromDsl(card.dsl));
        const snapshot = (card.dsl as { _form?: FunnelFormState })?._form;
        if (snapshot?.steps?.length) {
          setRestoredForm(snapshot);
          setTimeRange(materializeTimeRange(snapshot.timeRange));
          const next = buildFunnelQuery(snapshot, project);
          setLastForm(snapshot);
          const cached = funnelResultFromCache(card.cache?.result);
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
        <FunnelEditor
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
          <FunnelResult
            result={result}
            loading={loading}
            form={lastForm}
            cardId={cardId}
            cardName={cardName}
            initialRateMode={rateMode}
            initialLayout={layout}
            initialColor={color}
            initialTableColChars={tableColChars}
          />
        </>
      }
    />
  );
}
