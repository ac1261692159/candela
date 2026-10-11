import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Radio, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { FunnelResult as FunnelResultData } from '../../types/dsl.types';
import { EmptyState } from '../../components/EmptyState';
import { AnalysisCardSave } from './AnalysisCardSave';
import { AnalysisResultSettings } from './AnalysisResultSettings';
import { DeleteCardButton } from '../report/DeleteCardButton';
import { FunnelViewSettings } from './FunnelViewSettings';
import { FunnelExploreChart } from './FunnelExploreChart';
import { ResultCohortModal } from '../cohort/ResultCohortModal';
import { useFunnelStore } from '../../stores/funnel.store';
import { ChartWorkbench } from '../visualization/ChartWorkbench';
import {
  FUNNEL_TIME_COLUMN,
  funnelTimeGranularity,
  funnelTrendResult,
  withFunnelTimeGranularity,
  type FunnelTimeGranularity,
} from './funnel-trend';
import type { ChartConfigV1 } from '../visualization/chart.types';
import {
  DEFAULT_FUNNEL_COLOR,
  DEFAULT_FUNNEL_TABLE_COL_CHARS,
  buildFunnelTableModel,
  formatFunnelCell,
  funnelSeriesFromResult,
  funnelTableCellStyle,
  funnelViewPayload,
  parseFunnelColorConfig,
  parseFunnelLayout,
  parseFunnelRateMode,
  parseFunnelTableColChars,
  resolveFunnelLayout,
  type FunnelColorConfig,
  type FunnelLayout,
  type FunnelRateMode,
  isFunnelStepCountKey,
} from './funnel-display';
import { downloadResultCsv, mappedText } from './result-csv';
import { BRAND_PRIMARY } from '../../styles/tokens';

interface FunnelResultProps {
  result: FunnelResultData | null;
  loading: boolean;
  form?: unknown;
  cardId?: string | null;
  cardName?: string | null;
  initialRateMode?: FunnelRateMode;
  initialLayout?: FunnelLayout;
  initialColor?: FunnelColorConfig;
  initialTableColChars?: number;
}

/** 有时间维度时可切到趋势图；此时漏斗图意义不明（只画第 1 个桶），故不提供 */
type ViewType = 'funnel' | 'table' | 'both' | 'trend';

/** 按小时粒度仅在时间跨度 ≤ 7 天时可用（PRD 决策 D3） */
const HOUR_GRANULARITY_MAX_DAYS = 7;

export { funnelSeriesFromResult };

export function FunnelResult({
  result,
  loading,
  form,
  cardId,
  cardName,
  initialRateMode = 'conversion',
  initialLayout,
  initialColor,
  initialTableColChars,
}: FunnelResultProps) {
  const { t } = useT('analysis');
  const navigate = useNavigate();
  const [view, setView] = useState<ViewType>('both');
  const [rateMode, setRateMode] = useState<FunnelRateMode>(initialRateMode);
  const [layoutOverride, setLayoutOverride] = useState<FunnelLayout | undefined>(initialLayout);
  const [color, setColor] = useState<FunnelColorConfig>(() =>
    parseFunnelColorConfig(initialColor ?? DEFAULT_FUNNEL_COLOR),
  );
  const [tableColChars, setTableColChars] = useState(() =>
    parseFunnelTableColChars(initialTableColChars ?? DEFAULT_FUNNEL_TABLE_COL_CHARS),
  );
  const [cohortOpen, setCohortOpen] = useState(false);
  const [cohortCell, setCohortCell] = useState<Record<string, unknown>>({});
  const dsl = useFunnelStore((s) => s.dsl);
  // 查询失败且无结果时也要看得见错误（与留存结果区一致）
  const error = useFunnelStore((s) => s.error);
  const runQuery = useFunnelStore((s) => s.runQuery);
  const [trendConfig, setTrendConfig] = useState<ChartConfigV1 | null>(null);

  // 时间维度：漏斗按时间分桶后才有趋势可言（PRD 决策 D1：整体模式不给趋势图）
  const timeGranularity = funnelTimeGranularity(dsl);
  const trendResult = useMemo(() => funnelTrendResult(result), [result]);

  const initialTrendConfig = useMemo<ChartConfigV1 | null>(() => {
    if (!trendResult) return null;
    const metrics = trendResult.columns
      .filter((column) => column.name !== FUNNEL_TIME_COLUMN)
      .map((column) => column.name);
    if (!metrics.length) return null;
    return {
      schema_version: 1,
      recommendation_version: 1,
      mode: 'manual',
      preferred_view: 'chart',
      chart_type: 'trend',
      roles: {
        [FUNNEL_TIME_COLUMN]: 'time',
        ...Object.fromEntries(metrics.map((name) => [name, 'metric' as const])),
      },
      bindings: { x: FUNNEL_TIME_COLUMN, metrics, ignored: [] },
      options: {
        orientation: 'vertical',
        donut: false,
        include_other: false,
        units: {},
        aggregation: {},
      },
    };
  }, [trendResult]);

  const hourDisabled = useMemo(() => {
    if (!dsl?.time_range?.start || !dsl?.time_range?.end) return true;
    const start = Date.parse(String(dsl.time_range.start));
    const end = Date.parse(String(dsl.time_range.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
    return (end - start) / 86_400_000 > HOUR_GRANULARITY_MAX_DAYS;
  }, [dsl]);

  // 时间粒度变化：重置视图与趋势图配置，并按新粒度重新查询
  useEffect(() => {
    setTrendConfig(null);
    setView((current) => {
      if (timeGranularity === 'none' && current === 'trend') return 'both';
      if (timeGranularity !== 'none' && current !== 'trend' && current !== 'table') return 'table';
      return current;
    });
  }, [timeGranularity]);

  const changeTimeGranularity = (next: FunnelTimeGranularity) => {
    if (!dsl) return;
    void runQuery(withFunnelTimeGranularity(dsl, next));
  };

  useEffect(() => {
    setRateMode(parseFunnelRateMode(initialRateMode));
    setLayoutOverride(parseFunnelLayout(initialLayout));
    setColor(parseFunnelColorConfig(initialColor ?? DEFAULT_FUNNEL_COLOR));
    setTableColChars(parseFunnelTableColChars(initialTableColChars ?? DEFAULT_FUNNEL_TABLE_COL_CHARS));
  }, [cardId, initialRateMode, initialLayout, initialColor, initialTableColChars]);

  const funnelData = useMemo(() => funnelSeriesFromResult(result), [result]);
  const layout = resolveFunnelLayout(layoutOverride, funnelData.length);
  const tableModel = useMemo(
    () => (result ? buildFunnelTableModel(result, rateMode, t) : { columns: [], rows: [] }),
    [result, rateMode, t],
  );

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
        <EmptyState variant="analysis" title={null} description={t('analysis:funnel.emptyHint')} />
      </Card>
    );
  }

  const { elapsed_ms, from_cache, sql } = result;
  const showChart = view === 'funnel' || view === 'both';
  const showTable = view === 'table' || view === 'both';
  const dslWithView = dsl
    ? { ...(dsl as unknown as Record<string, unknown>), _view: funnelViewPayload(rateMode, layout, color, tableColChars) }
    : null;

  return (
    <Card
      className="analysis-result-card"
      title={
        <Space wrap>
          <span>{t('analysis:result.funnelTitle')}</span>
          <Tag color={from_cache ? 'green' : 'blue'}>
            {from_cache ? t('analysis:state.cacheHit') : t('analysis:state.liveQuery')}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {elapsed_ms}ms
          </Typography.Text>
        </Space>
      }
      extra={
        <Space wrap>
          <AnalysisResultSettings>
            <FunnelViewSettings
              rateMode={rateMode}
              layout={layout}
              color={color}
              tableColChars={tableColChars}
              onRateModeChange={setRateMode}
              onLayoutChange={setLayoutOverride}
              onColorChange={setColor}
              onTableColCharsChange={setTableColChars}
            />
          </AnalysisResultSettings>
          <Select
            aria-label={t('analysis:funnel.granularityAria')}
            size="small"
            /* 110px 按中文「整体/按日/按小时」定宽：德 «Nach Stunde»、泰 «รายชั่วโมง» 会被截成「Nach Stu…」。
               改成最小宽度，按最长语言生长。 */
            style={{ minWidth: 110 }}
            value={timeGranularity}
            options={[
              { value: 'none', label: t('analysis:funnel.granularityOverall') },
              { value: 'day', label: t('analysis:funnel.granularityDay') },
              { value: 'hour', label: t('analysis:funnel.granularityHour'), disabled: hourDisabled },
            ]}
            onChange={(value) => changeTimeGranularity(value as FunnelTimeGranularity)}
          />
          <Radio.Group
            value={view}
            onChange={(e) => setView(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            {timeGranularity === 'none' ? (
              <>
                <Radio.Button value="both">{t('analysis:funnel.withTable')}</Radio.Button>
                <Radio.Button value="funnel">{t('analysis:funnel.chartOnly')}</Radio.Button>
                <Radio.Button value="table">{t('analysis:view.table')}</Radio.Button>
              </>
            ) : (
              <>
                <Radio.Button value="table">{t('analysis:view.table')}</Radio.Button>
                <Radio.Button value="trend">{t('analysis:view.trend')}</Radio.Button>
              </>
            )}
          </Radio.Group>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => downloadResultCsv(t('analysis:funnel.title'), result.columns, result.rows)}
          >
            {t('analysis:action.exportCsv')}
          </Button>
          {dslWithView ? (
            <AnalysisCardSave
              type="funnel"
              dsl={dslWithView}
              formSnapshot={form}
              chartType={view === 'table' ? 'table' : 'bar'}
              cardId={cardId}
              cardName={cardName}
            />
          ) : null}
          {cardId ? (
            <DeleteCardButton
              cardId={cardId}
              cardName={cardName ?? undefined}
              onDeleted={() => navigate('/analysis/funnel')}
            />
          ) : null}
        </Space>
      }
    >
      {view === 'trend' ? (
        trendResult && initialTrendConfig ? (
          <div style={{ marginBottom: 24 }}>
            <ChartWorkbench
              result={trendResult}
              config={trendConfig ?? initialTrendConfig}
              displayMode="analysis"
              onConfigChange={setTrendConfig}
              height={360}
            />
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
              {t('analysis:funnel.trendNote')}
            </Typography.Paragraph>
          </div>
        ) : (
          <Typography.Text type="secondary">{t('analysis:funnel.noTrendData')}</Typography.Text>
        )
      ) : null}
      {showChart && (
        <div style={{ marginBottom: 24 }}>
          {funnelData.length > 0 ? (
            <FunnelExploreChart
              series={funnelData}
              rateMode={rateMode}
              layout={layout}
              color={color}
            />
          ) : (
            <Typography.Text type="secondary">{t('common:state.empty')}</Typography.Text>
          )}
        </div>
      )}
      {showTable && (
        <Table
          className="funnel-table"
          size="small"
          rowKey={(r) => String(r._rowKey ?? r.group_col ?? 'total')}
          scroll={{ x: 'max-content' }}
          columns={tableModel.columns.map((c) => {
            const style = funnelTableCellStyle(c.title || t('analysis:funnel.conversion'), tableColChars);
            return {
              title: c.title,
              dataIndex: c.key,
              key: c.key,
              width: style.width,
              ellipsis: true,
              onHeaderCell: () => ({ style }),
              onCell: () => ({ style }),
              render: (value: unknown, row: Record<string, unknown>) => {
                if (c.key === 'group_col') {
                  const mapped = mappedText(
                    result.columns.find((column) => column.key === 'group_col'),
                    value,
                  );
                  if (mapped && mapped !== String(value ?? '')) {
                    return (
                      <Tooltip title={t('analysis:result.rawValue', { value: String(value) })}>
                        <span style={{ color: BRAND_PRIMARY }}>{mapped}</span>
                      </Tooltip>
                    );
                  }
                }
                const text = formatFunnelCell(value);
                if (
                  row._metric === t('analysis:funnel.valueRow') &&
                  isFunnelStepCountKey(c.key) &&
                  typeof value === 'number'
                ) {
                  return (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => {
                        setCohortCell({
                          step: Number(c.key.replace('step_', '')),
                          group_col: row.group_col,
                        });
                        setCohortOpen(true);
                      }}
                    >
                      {text}
                    </Button>
                  );
                }
                return text;
              },
            };
          })}
          dataSource={tableModel.rows}
          pagination={false}
        />
      )}
      <ResultCohortModal
        open={cohortOpen}
        source="funnel"
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
