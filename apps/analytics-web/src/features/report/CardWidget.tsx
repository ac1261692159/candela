import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown, Empty, Modal, Skeleton, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { MoreOutlined, ReloadOutlined } from '@ant-design/icons';
import { EmptyState } from '../../components/EmptyState';
import { useNavigate } from 'react-router-dom';
import { FunnelExploreChart } from '../query/FunnelExploreChart';
import { refreshCard, updateCardDisplay } from '../../services/report.service';
import { type TFunction, useT } from '../../i18n';
import { ChartWorkbench } from '../visualization/ChartWorkbench';
import { ExploreChart } from '../explore-charts/ExploreChart';
import { modelFromRetentionNth } from '../explore-charts/explore-chart-option';
import { buildEventChartModel, readEventChartConfig } from '../event-chart';
import { eventChartFromDsl, eventStatCalcsFromDsl, eventYUnitFromDsl, parseEventChartType, type EventChartType } from '../query/event-view';
import { dashboardSqlPresentation } from './sql-chart-state';
import { CardDisplayDrawer } from './CardDisplayDrawer';
import { isEventChartView, resolveDisplayView, settingsDisplayView } from './card-display';
import { formatRetentionCell, splitRetentionColumns } from '../query/retention-tables';
import { localizedColumnTitle, localizedColumns, localizedStageCellValue } from '../query/column-titles';
import { TextCardEditorModal, TextPanelView } from './TextPanel';
import {
  formatFunnelCell,
  funnelColorFromDsl,
  buildFunnelTableModel,
  funnelLayoutFromDsl,
  funnelRateFromDsl,
  funnelSeriesFromResult,
  funnelTableCellStyle,
  funnelTableColCharsFromDsl,
  resolveFunnelLayout,
} from '../query/funnel-display';
import '../query/analysis-workbench.css';
import type { FunnelResult, QueryColumn } from '../../types/dsl.types';
import type { CardRefreshResult, DashboardCard, SqlExecuteResult, TextCardDsl } from '../../types/report.types';

interface CardWidgetProps {
  card: DashboardCard;
  dbId: string;
  editable?: boolean;
  showTypeTag?: boolean;
  refreshEpoch?: number;
  scheduleRefresh?: <T>(task: () => Promise<T>) => Promise<T>;
  onRemove?: (cardId: string) => void;
  onCardUpdated?: () => void;
}

const cardTypeLabels = (t: TFunction): Record<string, string> => ({
  event: t('report:cardType.event'),
  funnel: t('report:cardType.funnelShort'),
  retention: t('report:cardType.retentionShort'),
  sql: t('report:cardType.sql'),
  text: t('report:cardType.text'),
  metric: t('report:cardType.metric'),
});

const typeColor: Record<string, string> = {
  event: 'blue',
  funnel: 'purple',
  retention: 'cyan',
  sql: 'geekblue',
  text: 'gold',
  metric: 'green',
};

const editRoutes: Record<string, string> = {
  sql: '/report/sql',
  event: '/analysis/event',
  funnel: '/analysis/funnel',
  retention: '/analysis/retention',
  // 指标卡的口径在「数据管理 → 指标」里改（卡片的筛选能力在指标自身）
  metric: '/meta/metrics',
};

/**
 * 卡片刷新失败 → 给人看的一句话。
 *
 * 优先按**机器码**判分支（文案会随语言变，机器码不会）；老后端或非本平台错误再回退文案子串匹配。
 */
function sqlCardErrorMessage(error: unknown, t: TFunction): string {
  const raw = error instanceof Error ? error.message : '';
  const code = (error as { errorCode?: string } | null)?.errorCode ?? '';
  const m = raw.toLowerCase();
  if (
    code === 'report.sqlReport.noSqlSaved' ||
    code === 'report.sqlReport.sqlRequired' ||
    m.includes('未保存 sql') ||
    m.includes('缺少 sql') ||
    m.includes('卡片未保存') ||
    m.includes('no saved sql')
  ) {
    return t('report:card.errorNoSql');
  }
  if (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('超时') ||
    m.includes('max_execution_time')
  ) {
    return t('report:card.errorTimeout', { detail: raw });
  }
  if (m.includes('暂不支持')) return raw;
  return t('report:card.errorFailed', { detail: raw });
}

function isSqlResult(result: CardRefreshResult['result']): result is SqlExecuteResult {
  return 'row_count' in result || (Array.isArray(result.columns) && result.columns[0] !== undefined && 'name' in result.columns[0]);
}

/** 量格子剩余高度，让图表/表格铺满，而不是固定 240px 把下面留白。 */
function FillFrame({ children }: { children: (height: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => {
      const next = el.clientHeight;
      if (next > 0) setHeight(next);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="grafana-fill">
      {children(height)}
    </div>
  );
}

export function CardWidget({
  card,
  dbId,
  editable,
  showTypeTag = false,
  refreshEpoch = 0,
  scheduleRefresh,
  onRemove,
  onCardUpdated,
}: CardWidgetProps) {
  const { t } = useT('report');
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(card.cache?.error ?? null);
  const [result, setResult] = useState<CardRefreshResult['result'] | null>(card.cache?.result ?? null);
  const [textOpen, setTextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftView, setDraftView] = useState('');
  const [savingDisplay, setSavingDisplay] = useState(false);
  const [placement, setPlacement] = useState(card.display ?? null);
  const title = card.name?.trim() || t('report:card.untitled');
  const viewed = { ...card, display: placement };
  const displayView = resolveDisplayView(viewed);

  const load = async () => {
    if (card.type === 'text') return;
    setLoading(true);
    setError(null);
    try {
      const res = await refreshCard(dbId, card.card_id);
      setResult(res.result);
    } catch (e) {
      setError(sqlCardErrorMessage(e, t));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (card.type === 'text') return;
    const force = refreshEpoch > 0;
    const hasCache = Boolean(card.cache?.result);
    if (hasCache && !force) {
      setResult(card.cache!.result);
      setError(card.cache!.error);
    }
    const need = force || !hasCache || Boolean(card.cache?.stale);
    if (!need) return;
    const run = scheduleRefresh ?? ((task: () => Promise<void>) => task());
    void run(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.card_id, refreshEpoch]);

  useEffect(() => {
    setPlacement(card.display ?? null);
  }, [card.display]);

  const openEdit = () => {
    if (card.type === 'text') {
      setTextOpen(true);
      return;
    }
    const route = editRoutes[card.type];
    if (route) navigate(`${route}?card=${encodeURIComponent(card.card_id)}`);
  };

  const renderBody = () => {
    if (card.type === 'text') {
      const dsl = (card.dsl && typeof card.dsl === 'object' ? card.dsl : {}) as TextCardDsl;
      return <TextPanelView name={title} dsl={dsl} />;
    }
    if (loading && !result) {
      return <Skeleton active title={false} paragraph={{ rows: 6 }} />;
    }
    if (error && !result) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical" size={8} style={{ maxWidth: '100%' }}>
              {/* 错误原文可能很长且无空格（SQL/URL）：允许换行 + 断长词，窄卡片里不溢出裁切 */}
              <Typography.Text type="warning" style={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}>
                {error}
              </Typography.Text>
              {card.type !== 'retention' ? (
                <Button size="small" onClick={() => void load()}>
                  {t('common:action.reload')}
                </Button>
              ) : null}
            </Space>
          }
        />
      );
    }
    if (!result) return null;
    if (card.type === 'funnel') {
      const funnelResult = result as FunnelResult;
      const rateMode = funnelRateFromDsl(card.dsl);
      const tableModel = buildFunnelTableModel(funnelResult, rateMode, t);
      const tableColChars = funnelTableColCharsFromDsl(card.dsl);
      if (displayView === 'table') {
        return (
          <FillFrame>
            {(h) => (
              <Table
                className="funnel-table"
                size="small"
                pagination={false}
                scroll={{ x: 'max-content', y: Math.max(80, h - 8) }}
                columns={tableModel.columns.map((col) => {
                  const style = funnelTableCellStyle(col.title || t('report:card.conversionRate'), tableColChars);
                  return {
                    title: col.title,
                    dataIndex: col.key,
                    key: col.key,
                    // 宽度来自漏斗 DSL 的字数设置（已按译后标题字数取 max），此处不再按中文另设定宽
                    width: style.width,
                    ellipsis: { showTitle: true },
                    onHeaderCell: () => ({ style }),
                    onCell: () => ({ style }),
                    render: (value: unknown) => formatFunnelCell(value),
                  };
                })}
                dataSource={tableModel.rows}
                rowKey="_rowKey"
              />
            )}
          </FillFrame>
        );
      }
      const series = funnelSeriesFromResult(funnelResult);
      const layout = resolveFunnelLayout(funnelLayoutFromDsl(card.dsl), series.length);
      const color = funnelColorFromDsl(card.dsl);
      return (
        <FillFrame>
          {(h) =>
            series.length > 0 ? (
              <div style={{ height: Math.max(120, h), overflow: 'auto' }}>
                <FunnelExploreChart
                  series={series}
                  rateMode={rateMode}
                  layout={layout}
                  color={color}
                  frameHeight={Math.max(120, h)}
                />
              </div>
            ) : (
              // 卡片高度往往只有 2–3 行（ROW_HEIGHT 40）：用 compact，别让插画和留白把文案挤出可视区
              <EmptyState variant="analysis" compact />
            )
          }
        </FillFrame>
      );
    }
    if (card.type === 'sql' && isSqlResult(result)) {
      const dsl = card.dsl && typeof card.dsl === 'object' ? (card.dsl as Record<string, unknown>) : {};
      const sqlResult: SqlExecuteResult = {
        query_id: result.query_id ?? '',
        columns: result.columns.map((col) => ({
          name: String(col.name ?? ''),
          type: String(col.type ?? 'String'),
        })),
        rows: result.rows,
        row_count: result.row_count ?? result.rows.length,
        truncated: Boolean(result.truncated) || (result as { reason?: string }).reason === 'cache_too_large',
        elapsed_ms: result.elapsed_ms ?? 0,
        read_rows: result.read_rows ?? 0,
        read_bytes: result.read_bytes ?? 0,
      };
      const presentation = dashboardSqlPresentation({
        columns: sqlResult.columns,
        rows: sqlResult.rows,
        truncated: sqlResult.truncated,
        savedConfig: dsl.chart_config,
        overlayView: displayView,
      });
      const rowCountLabel = sqlResult.truncated
        ? t('report:card.rowCountTruncated', { count: sqlResult.row_count })
        : t('report:card.rowCount', { count: sqlResult.row_count });
      if (presentation.mode === 'chart') {
        return (
          <FillFrame>
            {(h) => (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                  {rowCountLabel}
                </Typography.Text>
                <div className="grafana-fill">
                  <ChartWorkbench
                    result={sqlResult}
                    config={presentation.config}
                    displayMode="dashboard"
                    height={Math.max(120, h - 22)}
                    fill
                  />
                </div>
              </>
            )}
          </FillFrame>
        );
      }
      // 用户 SQL 别名是用户数据（不翻译）：按别名自身字符数估列宽下限；
      // 表格宽度下限 = 各列下限之和——卡片窄时整表横向滚动，而不是把每列压成一字一列（G.29）
      const columns = sqlResult.columns.map((col) => ({
        title: col.name,
        dataIndex: col.name,
        key: col.name,
        minWidth: Math.min(240, Math.max(112, col.name.length * 9 + 24)),
        ellipsis: { showTitle: true },
      }));
      const tableMinWidth = columns.reduce((total, col) => total + col.minWidth, 0);
      const rows = sqlResult.rows.map((row, index) => ({ ...row, _rowKey: index }));
      return (
        <FillFrame>
          {(h) => (
            <>
              <Typography.Text
                type={presentation.reason ? 'warning' : 'secondary'}
                style={{ fontSize: 12, flexShrink: 0, whiteSpace: 'normal', overflowWrap: 'break-word' }}
              >
                {presentation.reason ? `${presentation.reason} · ${rowCountLabel}` : rowCountLabel}
              </Typography.Text>
              <Table
                size="small"
                pagination={false}
                scroll={{ x: tableMinWidth, y: Math.max(80, h - 28) }}
                columns={columns}
                dataSource={rows}
                rowKey="_rowKey"
              />
            </>
          )}
        </FillFrame>
      );
    }
    const eventResult = result;
    // 卡片结果带缓存：服务端只下发 title_key，本地化在渲染边界按查看者语言做（i18n-v1）。
    // 字段集合保持原有白名单（key / title / unit），只追加文案键两个字段。
    const mappedColumns: QueryColumn[] = (eventResult.columns ?? []).map((col) => {
      const source = col as QueryColumn;
      const titleKey = typeof source.title_key === 'string' ? source.title_key : undefined;
      return {
        key: String(col.key ?? col.name ?? ''),
        title: String(col.title ?? col.name ?? ''),
        unit: source.unit,
        ...(titleKey ? { title_key: titleKey } : {}),
        ...(titleKey && source.title_params ? { title_params: source.title_params } : {}),
      };
    });
    const rows = (eventResult.rows ?? []).map((row, index) => ({ ...row, _rowKey: index }));
    if (card.type === 'retention') {
      if (displayView === 'people_table' || displayView === 'rate_table') {
        const split = splitRetentionColumns(mappedColumns);
        const cols = displayView === 'people_table' ? split.people : split.rates;
        // 首列是「队列日期 / 人数」（译后更长），其余是 Dn / Dn 留存率（窄）；下限按最长语言估
        const retentionColumns = cols.map((col, index) => ({
          title: localizedColumnTitle(col, t),
          dataIndex: col.key,
          key: col.key,
          minWidth: index === 0 ? 132 : 96,
          ellipsis: { showTitle: true },
          render: (value: unknown) => formatRetentionCell(col.key, value),
        }));
        const retentionMinWidth = retentionColumns.reduce((total, col) => total + col.minWidth, 0);
        return (
          <FillFrame>
            {(h) => (
              <Table
                size="small"
                pagination={false}
                scroll={{ x: retentionMinWidth, y: Math.max(80, h - 8) }}
                columns={retentionColumns}
                dataSource={rows}
                rowKey="_rowKey"
              />
            )}
          </FillFrame>
        );
      }
      return (
        <FillFrame>
          {(h) => (
          <ExploreChart
            kind="nth_trend"
            model={modelFromRetentionNth(localizedColumns(mappedColumns, t), eventResult.rows ?? [])}
            statCalcs={[]}
            height={Math.max(120, h)}
          />
          )}
        </FillFrame>
      );
    }
    if (displayView === 'table') {
      // 首列是分组维度（用户数据 + 译后的时间粒度），下限给足；其余是译后列名/数值列
      const eventTableColumns = mappedColumns.map((col, index) => ({
        title: localizedColumnTitle(col, t),
        dataIndex: col.key,
        key: col.key,
        minWidth: index === 0 ? 144 : 120,
        ellipsis: { showTitle: true },
        // 阶段汇总行：分组单元格按查看者语言渲染（服务端原值是中文，卡片结果又是缓存）
        render: (value: unknown, row: Record<string, unknown>) =>
          (localizedStageCellValue(col.key, value, row, t) ?? value) as ReactNode,
      }));
      const eventMinWidth = eventTableColumns.reduce((total, col) => total + col.minWidth, 0);
      return (
        <FillFrame>
          {(h) => (
            <Table
              size="small"
              pagination={false}
              scroll={{ x: eventMinWidth, y: Math.max(80, h - 8) }}
              columns={eventTableColumns}
              dataSource={rows}
              rowKey="_rowKey"
            />
          )}
        </FillFrame>
      );
    }
    const chart: EventChartType = isEventChartView(displayView ?? '')
      ? (displayView as EventChartType)
      : eventChartFromDsl(card.dsl, parseEventChartType(card.chart_type));
    const calcs = eventStatCalcsFromDsl(card.dsl, chart);
    // 看板不复现字段面板，但轴归属 / 单位 / 拆分系列 / 标签策略要跟着卡片走
    const localized = localizedColumns(mappedColumns, t);
    const yUnit = eventYUnitFromDsl(card.dsl);
    const stored = readEventChartConfig({
      raw: (card.dsl as { chart_config?: unknown } | null)?.chart_config ?? null,
      columns: localized,
      chartType: chart,
      legacyUnit: yUnit,
    });
    const { model } = buildEventChartModel(localized, eventResult.rows ?? [], {
      ...stored.config,
      chart_type: chart,
    });
    return (
      <FillFrame>
        {(h) => (
          <ExploreChart
            kind={chart}
            model={model}
            statCalcs={calcs}
            yUnit={yUnit}
            height={Math.max(120, h)}
          />
        )}
      </FillFrame>
    );
  };

  const openSettings = () => {
    if (card.type === 'text') {
      setTextOpen(true);
      return;
    }
    setDraftView(settingsDisplayView(viewed));
    setSettingsOpen(true);
  };

  const saveDisplay = async () => {
    if (!draftView) return;
    setSavingDisplay(true);
    try {
      const res = await updateCardDisplay(dbId, card.card_id, { view: draftView });
      setPlacement(res.display);
      setSettingsOpen(false);
      onCardUpdated?.();
    } catch (e) {
      message.warning(e instanceof Error ? e.message : t('common:message.saveFailed'));
    } finally {
      setSavingDisplay(false);
    }
  };

  const menuItems = [
    { key: 'settings', label: t('report:action.settings'), onClick: openSettings },
    editable && onRemove
      ? {
          key: 'remove',
          label: t('report:card.removeFromDashboard'),
          danger: true,
          onClick: () => {
            Modal.confirm({
              title: t('report:card.removeConfirmTitle', { name: title }),
              content: t('report:card.removeConfirmBody'),
              okText: t('report:card.remove'),
              cancelText: t('common:action.cancel'),
              onOk: () => onRemove(card.card_id),
            });
          },
        }
      : null,
  ].filter(Boolean) as { key: string; label: string; danger?: boolean; onClick?: () => void }[];

  const metricMeta = (result as { metric_meta?: { cohort_applied?: boolean } } | null)?.metric_meta;
  const metricCohortIgnored = metricMeta?.cohort_applied === false;

  return (
    <div className="grafana-panel">
      <div className="grafana-panel-header">
        <span className="grafana-panel-drag" aria-label={t('report:card.drag')} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          {showTypeTag ? (
            // 类型标签是译后文案（俄/德可到中文 2 倍）：窄卡片里截断时用 tooltip 兜底可读
            <Tooltip title={cardTypeLabels(t)[card.type] || card.type}>
              <Tag color={typeColor[card.type]} style={{ maxWidth: '100%' }}>
                {cardTypeLabels(t)[card.type] || card.type}
              </Tag>
            </Tooltip>
          ) : null}
          {metricCohortIgnored ? (
            <Tooltip title={t('report:card.metricCohortTooltip')}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                {t('report:card.metricCohortIgnored')}
              </Tag>
            </Tooltip>
          ) : null}
          <Tooltip title={title}>
            <Typography.Text
              className="grafana-panel-title"
              onClick={openEdit}
              ellipsis
              style={{ flex: 1, minWidth: 0, fontSize: 13 }}
            >
              {title}
            </Typography.Text>
          </Tooltip>
        </div>
        <Space size={0} className="grafana-panel-actions">
          {card.type !== 'text' ? (
            <Tooltip title={t('report:card.refreshData')}>
              <Button
                type="text"
                size="small"
                aria-label={t('report:card.refreshAria', { name: title })}
                icon={<ReloadOutlined />}
                onClick={() => void load()}
                loading={loading}
              />
            </Tooltip>
          ) : null}
          <Dropdown menu={{ items: menuItems }} trigger={['click']}>
            <Button type="text" size="small" aria-label={t('report:card.menuAria', { name: title })} icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      </div>
      <div className={card.type === 'text' ? 'grafana-panel-body grafana-panel-body-flush' : 'grafana-panel-body'}>
        {renderBody()}
      </div>
      {card.type === 'text' ? (
        <TextCardEditorModal
          open={textOpen}
          card={{ card_id: card.card_id, name: title, dsl: card.dsl }}
          onClose={() => setTextOpen(false)}
          onSaved={() => onCardUpdated?.()}
          onDeleted={() => onCardUpdated?.()}
        />
      ) : (
        <CardDisplayDrawer
          open={settingsOpen}
          type={card.type}
          view={draftView}
          saving={savingDisplay}
          onClose={() => setSettingsOpen(false)}
          onChange={setDraftView}
          onSave={() => void saveDisplay()}
        />
      )}
    </div>
  );
}
