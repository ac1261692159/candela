import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Input,
  Modal,
  Segmented,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CaretRightOutlined,
  EditOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { DataDictionaryPanel } from '../../features/report/DataDictionaryPanel';
import { DeleteCardButton } from '../../features/report/DeleteCardButton';
import { CardSaveActions } from '../../features/report/CardSaveActions';
import { SqlReportEditor } from '../../features/report/SqlReportEditor';
import { QueryResultPanel } from '../../features/report/QueryResultPanel';
import { ResultResizePane } from '../../features/report/ResultResizePane';
import { SqlViewSettings } from '../../features/report/SqlViewSettings';
import {
  preferredViewFromSqlLayout,
  sqlLayoutFromPreferredView,
  type SqlResultLayout,
} from '../../features/report/sql-result-layout';
import { AnalysisResultSettings } from '../../features/query/AnalysisResultSettings';
import { GroupByPanel, BuilderDsl } from '../../features/report/GroupByPanel';
import { useAiContextStore } from '../../stores/ai-context.store';
import { useProjectStore } from '../../stores/project.store';
import { useAiChatStore } from '../../stores/ai-chat.store';
import { PAGE_BRIDGE_EVENT } from '../../features/ai/usePageBridge';
import { decidePageBridgeProposal } from '../../services/ai.service';
import {
  executeSql,
  getCard,
  getSqlSchema,
  saveSqlReport,
  updateCard,
  updateSqlReport,
} from '../../services/report.service';
import type { ApiErrorMeta } from '../../services/api';
import type {
  SqlExecuteResult,
  SqlMode,
  SqlSchema,
  SqlTimeRange,
} from '../../types/report.types';
import type { ChartConfigV1 } from '../../features/visualization/chart.types';
import { bucketRoles } from '../../features/visualization/chart-compatibility';
import { profileColumns } from '../../features/visualization/column-profiler';
import { resolveVisualization } from '../../features/visualization/chart-pipeline';
import { configAfterExecute, isV1ChartConfig } from '../../features/report/sql-chart-state';
import { placeholderSqlResult, sqlResultFromCache } from '../../features/report/sql-cache-result';
import {
  materializeSqlChartProposal,
  sameSqlChartConfig,
  SqlChartProposalError,
} from '../../features/visualization/sql-chart-proposal';
import { pruneStaleOptionRefs } from '../../features/visualization/chart-config';
import type { PageBridgeEvent } from '../../types/ai.types';
import type { TimeRange } from '../../types/dsl.types';
import { TimeRangeControl } from '../../features/time-range/TimeRangeControl';
import { defaultPastNDays, materializeTimeRange } from '../../features/time-range/resolve';
import { useT } from '../../i18n';

const SQL_MAX_RANGE_DAYS = 90;

export function SqlReportPage() {
  const { t } = useT('sql');
  const [searchParams, setSearchParams] = useSearchParams();
  const [schema, setSchema] = useState<SqlSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [mode, setMode] = useState<SqlMode>('sql');
  const [builderDsl, setBuilderDsl] = useState<BuilderDsl | null>(null);
  const [sql, setSql] = useState('SELECT count() AS 事件量\nFROM clklog_sa.sa_events\nLIMIT 1000');
  const [sqlRevision, setSqlRevision] = useState(0);
  const [range, setRange] = useState<TimeRange>(() => defaultPastNDays(7));
  const [result, setResult] = useState<SqlExecuteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartConfig, setChartConfig] = useState<ChartConfigV1 | null>(null);
  const [layout, setLayout] = useState<SqlResultLayout>('both');
  const [chartDirty, setChartDirty] = useState(false);
  const [resultFullscreen, setResultFullscreen] = useState(false);
  const [resultHeight, setResultHeight] = useState(360);
  const [legacyCardWithoutChart, setLegacyCardWithoutChart] = useState(false);
  const [openedWithSavedChart, setOpenedWithSavedChart] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [currentCard, setCurrentCard] = useState<{
    id: string;
    name: string;
    description?: string | null;
  } | null>(null);
  const publishAiContext = useAiContextStore((state) => state.publishContext);
  const clearAiContext = useAiContextStore((state) => state.clearContext);
  const project = useProjectStore((state) => state.currentProject);
  const aiExpanded = useAiChatStore((state) => state.expanded);
  const sqlRef = useRef(sql);
  const resultRef = useRef(result);
  const chartConfigRef = useRef(chartConfig);
  resultRef.current = result;
  chartConfigRef.current = chartConfig;
  const currentRevision = () => useAiContextStore.getState().context?.revision ?? 0;

  const updateSql = useCallback((nextSql: string) => {
    if (nextSql === sqlRef.current) return;
    sqlRef.current = nextSql;
    const nextRevision = currentRevision() + 1;
    setSql(nextSql);
    setSqlRevision(nextRevision);
  }, []);

  const loadSchema = useCallback(async () => {
    setSchemaLoading(true);
    try {
      setSchema(await getSqlSchema());
    } catch {
      // 拦截器提示
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  const applyCard = useCallback(
    (
      id: string,
      name: string,
      dsl: Record<string, unknown>,
      cacheResult?: unknown,
      description?: string | null,
    ) => {
      setCurrentCard({ id, name, description: description ?? null });
      const nextMode = dsl.mode === 'builder' ? 'builder' : 'sql';
      setMode(nextMode);
      const sqlText = String(dsl.sql_text ?? dsl.sql ?? '');
      if (sqlText) updateSql(sqlText);
      const tr = dsl.time_range as TimeRange | undefined;
      if (tr?.relative || (tr?.start && tr?.end)) {
        try {
          setRange(materializeTimeRange(tr));
        } catch {
          if (tr.start && tr.end) setRange({ start: tr.start, end: tr.end });
        }
      }
      const saved = dsl.chart_config;
      if (isV1ChartConfig(saved)) {
        setChartConfig(saved);
        setOpenedWithSavedChart(true);
        setLegacyCardWithoutChart(false);
      } else {
        setChartConfig(null);
        setOpenedWithSavedChart(false);
        setLegacyCardWithoutChart(true);
      }
      setChartDirty(false);
      const cached = sqlResultFromCache(cacheResult);
      if (cached) {
        setResult(cached);
        setError(null);
      } else if (isV1ChartConfig(saved)) {
        setResult(placeholderSqlResult(saved));
        setError(null);
      } else {
        setResult(null);
      }
    },
    [updateSql],
  );

  const cardId = searchParams.get('card');
  const openedCardRef = useRef<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  useEffect(() => {
    if (!cardId || openedCardRef.current === cardId) return;
    openedCardRef.current = cardId;
    void (async () => {
      try {
        const card = await getCard(cardId);
        if (card.type !== 'sql') {
          message.error(t('sql:page.notSqlCard'));
          return;
        }
        const dsl = (card.dsl ?? {}) as Record<string, unknown>;
        applyCard(card.card_id, card.name, dsl, card.cache?.result, card.description);
        const cached = sqlResultFromCache(card.cache?.result);
        if (cached) {
          message.success(t('sql:card.openedCached', { name: card.name }));
        } else if (isV1ChartConfig(dsl.chart_config)) {
          message.success(t('sql:card.openedWithChart', { name: card.name }));
        } else {
          message.success(t('sql:card.openedPlain', { name: card.name }));
        }
      } catch {
        // 拦截器提示
      }
    })();
  }, [applyCard, cardId, t]);

  const timeRange = (): SqlTimeRange => materializeTimeRange(range);

  const resolved = useMemo(
    () =>
      result
        ? resolveVisualization({
            columns: result.columns,
            rows: result.rows,
            savedConfig: chartConfig,
            queryContext: { builderDsl: builderDsl as never, sql },
            truncated: result.truncated,
          })
        : null,
    [builderDsl, chartConfig, result, sql],
  );
  const canPivot = useMemo(() => {
    if (!result) return false;
    const buckets = bucketRoles(
      profileColumns(result.columns, result.rows, { builderDsl: builderDsl as never, sql }),
    );
    return buckets.time.length === 1 && buckets.dimension.length === 1 && buckets.metric.length === 1;
  }, [builderDsl, result, sql]);

  useEffect(() => {
    setLayout(sqlLayoutFromPreferredView(chartConfigRef.current?.preferred_view));
  }, [result?.query_id]);

  const changeLayout = (next: SqlResultLayout) => {
    setLayout(next);
    const preferred = preferredViewFromSqlLayout(next);
    const current = chartConfig ?? resolved?.config ?? null;
    if (!current || current.preferred_view === preferred) return;
    setChartConfig({ ...current, preferred_view: preferred });
    setChartDirty(true);
  };

  const applyChartConfig = (next: ChartConfigV1) => {
    // 改了 SQL / 换了列别名后，上一版配置的 options 里可能留着已消失的列（sort/units/aggregation）。
    // 不清掉的话：状态里是「已应用」，但渲染解析判无效 → 回退表格 + 「配置已失效」，用户看到的却是「点了没反应」。
    const columnNames = (result?.columns ?? []).map((column) => column.name);
    const safe = columnNames.length
      ? { ...next, options: pruneStaleOptionRefs(next.options, columnNames) }
      : next;
    setChartConfig(safe);
    setChartDirty(true);
    if (safe.preferred_view === 'chart' && (layout === 'table' || layout === 'pivot')) {
      setLayout('both');
    }
    if (safe.preferred_view === 'table') setLayout('table');
    if (safe.preferred_view === 'pivot') setLayout('pivot');
  };

  useEffect(() => {
    publishAiContext({
      page: 'sql',
      route: '/report/sql',
      revision: sqlRevision,
      analysis: {
        mode,
        sql: mode === 'sql' ? sql : null,
        dsl: mode === 'builder' && builderDsl ? { ...builderDsl } : null,
        time_range: timeRange(),
        loading,
        error,
        card_id: currentCard?.id ?? null,
        card_name: currentCard?.name ?? null,
        result_columns: result?.columns.map((column) => ({ name: column.name, type: column.type })) ?? [],
        chart_config: chartConfig,
      },
      result: result ? { ...result } : undefined,
    }, project);
  }, [builderDsl, chartConfig, currentCard, error, loading, mode, project, publishAiContext, range, result, sql, sqlRevision]);

  useEffect(
    () => () => {
      clearAiContext('sql', project);
    },
    [clearAiContext, project],
  );

  const applyExecuteResult = useCallback((res: SqlExecuteResult) => {
    setResult(res);
    setChartConfig((current) =>
      configAfterExecute({
        result: res,
        current,
        legacyCardWithoutChart,
        openedWithSavedChart,
        builderDsl: builderDsl ?? undefined,
        sql: sqlRef.current,
      }),
    );
  }, [builderDsl, legacyCardWithoutChart, openedWithSavedChart]);

  const run = async () => {
    if (mode === 'builder') {
      if (!builderDsl) {
        message.warning(t('sql:page.builderRequired'));
        return;
      }
    } else if (!sql.trim()) {
      message.warning(t('sql:page.sqlRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await executeSql({
        mode,
        sql: mode === 'sql' ? sql : undefined,
        dsl: mode === 'builder' ? builderDsl : undefined,
        time_range: timeRange(),
      });
      applyExecuteResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('sql:page.executeFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const rejectProposal = (proposal: PageBridgeEvent, reason: string) => {
      void decidePageBridgeProposal(proposal.proposal_id, {
        accepted: false,
        current_revision: currentRevision(),
        reason,
      }).catch(() => undefined);
    };

    const onProposal = (raw: Event) => {
      const proposal = (raw as CustomEvent<PageBridgeEvent>).detail;
      if (proposal?.action === 'analysis_edit') return;
      const expired = () => Boolean(proposal?.expires_at && Date.parse(proposal.expires_at) <= Date.now());
      if (expired()) { rejectProposal(proposal, t('sql:page.proposalExpired')); return; }
      if (!proposal || proposal.expected_revision !== currentRevision()) {
        if (proposal) rejectProposal(proposal, t('sql:page.proposalStale'));
        message.warning(t('sql:page.proposalOld'));
        return;
      }

      if (proposal.action === 'sql_load_card') {
        if (!proposal.card_id) {
          rejectProposal(proposal, t('sql:page.missingCardId'));
          return;
        }
        const before = useAiContextStore.getState().context?.analysis;
        const appliedRevision = proposal.expected_revision + (sqlRef.current !== proposal.sql || before?.mode !== 'sql' || before?.card_id !== proposal.card_id ? 1 : 0);
        updateSql(proposal.sql);
        setMode('sql');
        setCurrentCard({
          id: proposal.card_id,
          name: proposal.card_name?.trim() || proposal.card_id,
        });
        openedCardRef.current = proposal.card_id;
        setSearchParams({ card: proposal.card_id });
        void decidePageBridgeProposal(proposal.proposal_id, {
          accepted: true,
          current_revision: appliedRevision,
          applied_revision: appliedRevision,
        }).catch(() => message.warning(t('sql:page.cardAckFailed')));
        message.success(t('sql:page.switchedCard', { name: proposal.card_name || proposal.card_id }));
        return;
      }

      if (proposal.action === 'sql_edit') {
        // 自动应用模式（2026-09-09 产品决策）：提案直接写入编辑器并回执，不弹人工确认框。
        const changed = sqlRef.current !== proposal.sql || useAiContextStore.getState().context?.analysis?.mode !== 'sql';
        const appliedRevision = proposal.expected_revision + (changed ? 1 : 0);
        updateSql(proposal.sql);
        setMode('sql');
        void decidePageBridgeProposal(proposal.proposal_id, {
          accepted: true,
          current_revision: appliedRevision,
          applied_revision: appliedRevision,
        }).then(() => message.success(t('sql:page.editApplied')))
          .catch(() => message.warning(t('sql:page.editAckFailed')));
        return;
      }

      // 图表提案：`analysis_chart_edit` 才是正式名（SQL 与事件两域共用，服务端按页面选域），
      // `sql_chart_edit` 是旧名，只为「server 先更新、host 插件还是旧的」这种部署顺序容错。
      // 只认旧名会导致线上提案掉进下面的执行分支、被回一句「执行请求不是编辑器中的当前 SQL」
      // （2026-09-24 验收实测到的回归）。
      if (proposal.action === 'analysis_chart_edit' || proposal.action === 'sql_chart_edit') {
        const live = resultRef.current;
        if (!live?.columns.length) {
          rejectProposal(proposal, t('sql:page.noResult'));
          message.warning(t('sql:page.chartNoResult'));
          return;
        }
        if (!proposal.chart_config) {
          rejectProposal(proposal, t('sql:page.missingChartConfig'));
          return;
        }
        try {
          const next = materializeSqlChartProposal(
            proposal.chart_config,
            live.columns.map((column) => column.name),
            chartConfigRef.current?.options,
          );
          const changed = !sameSqlChartConfig(chartConfigRef.current, next);
          const appliedRevision = proposal.expected_revision + (changed ? 1 : 0);
          setChartConfig(next);
          setChartDirty(true);
          setLayout(sqlLayoutFromPreferredView(next.preferred_view));
          void decidePageBridgeProposal(proposal.proposal_id, {
            accepted: true,
            current_revision: appliedRevision,
            applied_revision: appliedRevision,
          }).then(() => message.success(t('sql:page.chartApplied')))
            .catch(() => message.warning(t('sql:page.chartAckFailed')));
        } catch (chartError) {
          const detail = chartError instanceof SqlChartProposalError ? chartError.message : t('sql:proposal.bindingsInvalid');
          rejectProposal(proposal, detail);
          message.warning(detail);
        }
        return;
      }

      // 走到这里的只能是 sql_execute。显式挡一道：本页不认识的动作按「不归我管」忽略，
      // 不要掉进执行分支 —— 那会带着空 sql 去比对（回一句驴唇不对马嘴的拒绝），
      // 或者更糟：真的把 SQL 跑起来。
      if (proposal.action !== 'sql_execute') return;

      if (proposal.sql.trim() !== sqlRef.current.trim()) {
        rejectProposal(proposal, t('sql:page.executeMismatch'));
        message.warning(t('sql:page.executeMismatchWarning'));
        return;
      }
      // 自动执行模式（2026-09-09 产品决策）：执行请求直接运行，不弹人工确认框；
      // 仍经过项目、时间范围、LIMIT、超时和只读账号守卫，资源限额不变。
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const executed = await executeSql({
            mode: 'sql',
            sql: proposal.sql,
            time_range: timeRange(),
          });
          applyExecuteResult(executed);
          await decidePageBridgeProposal(proposal.proposal_id, {
            accepted: true,
            current_revision: proposal.expected_revision,
            result: {
              query_id: executed.query_id,
              columns: executed.columns,
              rows: executed.rows.slice(0, 50),
              row_count: executed.row_count,
              truncated: executed.truncated || executed.rows.length > 50,
              elapsed_ms: executed.elapsed_ms,
            },
          }).catch(() => {
            message.warning(t('sql:page.executeAckFailed'));
          });
        } catch (executionError) {
          const detail = executionError instanceof Error ? executionError.message : t('sql:page.executeFailed');
          // 回执带上机器码：AI 据此区分「查询超预算」与「服务不可达」，不靠文案猜
          const meta = executionError as Partial<ApiErrorMeta>;
          setError(detail);
          await decidePageBridgeProposal(proposal.proposal_id, {
            accepted: true,
            current_revision: proposal.expected_revision,
            result: {
              ok: false,
              error: detail,
              errorCode: meta?.errorCode ?? 'web.sql.executeFailed',
              ...(meta?.messageKey ? { messageKey: meta.messageKey } : {}),
            },
          }).catch(() => undefined);
          message.error(detail);
        } finally {
          setLoading(false);
        }
      })();
    };

    window.addEventListener(PAGE_BRIDGE_EVENT, onProposal);
    return () => window.removeEventListener(PAGE_BRIDGE_EVENT, onProposal);
  }, [applyExecuteResult, range, setSearchParams, updateSql, t]);

  const handleGenerate = (dsl: BuilderDsl, sqlText: string) => {
    setBuilderDsl(dsl);
    updateSql(sqlText);
    setMode('sql');
    message.success(t('sql:page.sqlGenerated'));
  };

  const overwriteCard = async () => {
    if (!currentCard) return;
    try {
      await updateSqlReport(currentCard.id, {
        name: currentCard.name,
        mode,
        sql_text: sql,
        dsl: builderDsl,
        chart_config: chartConfig,
        time_range: timeRange(),
      });
      setChartDirty(false);
      setOpenedWithSavedChart(Boolean(chartConfig));
      setLegacyCardWithoutChart(!chartConfig);
      message.success(t('sql:card.overwritten', { name: currentCard.name }));
    } catch {
      // 拦截器提示
    }
  };

  const handleCreate = async () => {
    if (!saveName.trim()) {
      message.warning(t('sql:card.nameRequired'));
      return;
    }
    try {
      const created = await saveSqlReport({
        name: saveName.trim(),
        mode,
        sql_text: sql,
        dsl: builderDsl,
        chart_config: chartConfig,
        time_range: timeRange(),
      });
      setSaveOpen(false);
      setSaveName('');
      setCurrentCard({ id: created.id, name: created.name, description: created.description ?? null });
      openedCardRef.current = created.id;
      setSearchParams({ card: created.id });
      setChartDirty(false);
      setOpenedWithSavedChart(Boolean(chartConfig));
      setLegacyCardWithoutChart(!chartConfig);
      message.success(t('sql:card.saved'));
    } catch {
      // 拦截器提示
    }
  };

  const insertToEditor = (fragment: string) => {
    const base = sqlRef.current.trimEnd();
    updateSql(
      /where/i.test(fragment)
        ? `${base}\n${fragment}`
        : `${base}${base.endsWith('\n') ? '' : '\n'}${fragment}`,
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: 1 }}>
      <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Button type="primary" icon={<CaretRightOutlined />} loading={loading} onClick={() => void run()}>
          {t('sql:page.run')}
        </Button>
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as SqlMode)}
          options={[
            {
              value: 'sql',
              label: (
                <span>
                  {t('sql:builder.sqlMode')}
                  <Tooltip
                    title={
                      <span>
                        {t('sql:builder.sqlTooltipLine1')}
                        <br />
                        {t('sql:builder.sqlTooltipLine2')}
                      </span>
                    }
                  >
                    <QuestionCircleOutlined
                      style={{ marginLeft: 4, color: '#8c8c8c' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                      }}
                    />
                  </Tooltip>
                </span>
              ),
            },
            {
              value: 'builder',
              label: (
                <span>
                  {t('sql:builder.builderMode')}
                  <Tooltip
                    title={
                      <span>
                        {t('sql:builder.tooltipLine1')}
                        <br />
                        {t('sql:builder.tooltipLine2')}
                      </span>
                    }
                  >
                    <QuestionCircleOutlined
                      style={{ marginLeft: 4, color: '#8c8c8c' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                      }}
                    />
                  </Tooltip>
                </span>
              ),
            },
          ]}
        />
        <AnalysisResultSettings>
          <SqlViewSettings
            layout={layout}
            canPivot={canPivot}
            result={result}
            resolved={resolved}
            onLayoutChange={changeLayout}
            onConfigChange={applyChartConfig}
          />
        </AnalysisResultSettings>
        <CardSaveActions
          bound={Boolean(currentCard)}
          disabled={loading}
          size="middle"
          onOverwrite={() => void overwriteCard()}
          onSaveAs={() => {
            setSaveName(currentCard ? t('sql:card.copyName', { name: currentCard.name }) : '');
            setSaveOpen(true);
          }}
        />
        {currentCard ? (
          <DeleteCardButton
            cardId={currentCard.id}
            cardName={currentCard.name}
            onDeleted={() => {
              setCurrentCard(null);
              setSearchParams({}, { replace: true });
            }}
          />
        ) : null}
        {chartDirty && <Tag color="gold">{t('sql:page.chartUnsaved')}</Tag>}
        <TimeRangeControl value={range} onChange={setRange} size="middle" maxDays={SQL_MAX_RANGE_DAYS} />
        {currentCard ? (
          <Typography.Text>
            {t('sql:page.currentCard')}
            <Typography.Text strong>{currentCard.name}</Typography.Text>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              title={t('sql:card.settings')}
              aria-label={t('sql:card.settings')}
              onClick={() => {
                setRenameDraft(currentCard?.name ?? '');
                setDescDraft(currentCard?.description ?? '');
                setRenameOpen(true);
              }}
            />
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">{t('sql:page.noCard')}</Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ marginLeft: 'auto' }}>
          {t('sql:page.timeRangeHint')}
        </Typography.Text>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: aiExpanded ? 220 : 300, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            <DataDictionaryPanel schema={schema} loading={schemaLoading} onInsert={insertToEditor} />
          </div>
          {mode === 'builder' && (
            <div style={{ borderTop: '1px solid #f0f0f0' }}>
              <GroupByPanel schema={schema} onGenerate={handleGenerate} />
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, padding: 8, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <SqlReportEditor value={sql} onChange={updateSql} readOnly={false} onRun={() => void run()} />
          </div>
        </div>
      </div>

      <ResultResizePane
        compact={!result && !error && !loading}
        loading={loading}
        fullscreen={resultFullscreen}
        onFullscreen={() => setResultFullscreen((value) => !value)}
        onHeightChange={setResultHeight}
      >
        <QueryResultPanel
          result={result}
          loading={loading}
          error={error}
          config={chartConfig}
          layout={layout}
          queryContext={{ mode, builderDsl: builderDsl ?? undefined, sql: sqlRef.current }}
          tableHeight={resultFullscreen ? Math.round(window.innerHeight * 0.75) : Math.max(180, resultHeight - 48)}
          onConfigChange={(next) => {
            applyChartConfig(next);
          }}
        />
      </ResultResizePane>

      <Modal
        title={currentCard ? t('sql:card.saveAs') : t('sql:card.save')}
        open={saveOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setSaveOpen(false)}
        okText={t('common:action.save')}
      >
        <Typography.Paragraph type="secondary">
          {t('sql:card.saveHint')}
        </Typography.Paragraph>
        <input
          placeholder={t('sql:card.name')}
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          style={{ width: '100%', padding: 8, border: '1px solid #d9d9d9', borderRadius: 4 }}
        />
      </Modal>
      <Modal
        title={t('sql:card.settings')}
        open={renameOpen}
        okText={t('common:action.save')}
        width={480}
        onCancel={() => setRenameOpen(false)}
        onOk={() => {
          const name = renameDraft.trim();
          if (!name || !currentCard) return;
          const description = descDraft.trim() || null;
          void (async () => {
            try {
              await updateCard(currentCard.id, { name, description });
              setCurrentCard({ ...currentCard, name, description });
              setRenameOpen(false);
              message.success(t('sql:card.updated'));
            } catch {
              // 拦截器已提示（重名返回 409）
            }
          })();
        }}
      >
        <Typography.Text>{t('sql:card.name')}</Typography.Text>
        <Input
          autoFocus
          maxLength={80}
          value={renameDraft}
          placeholder={t('sql:card.name')}
          onChange={(event) => setRenameDraft(event.target.value)}
          style={{ marginTop: 8 }}
        />
        <Typography.Text style={{ display: 'block', marginTop: 16 }}>{t('sql:card.descriptionLabel')}</Typography.Text>
        <Input.TextArea
          maxLength={200}
          showCount
          autoSize={{ minRows: 2, maxRows: 4 }}
          value={descDraft}
          placeholder={t('sql:card.descriptionPlaceholder')}
          onChange={(event) => setDescDraft(event.target.value)}
          style={{ marginTop: 8 }}
        />
      </Modal>
    </div>
  );
}
