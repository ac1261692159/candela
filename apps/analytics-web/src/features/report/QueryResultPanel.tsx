import { useMemo } from 'react';
import { Alert, Skeleton, Spin, Table, Typography } from 'antd';
import { EmptyState } from '../../components/EmptyState';
import { useT } from '../../i18n';
import { ChartWorkbench } from '../visualization/ChartWorkbench';
import { buildPivotTable } from '../visualization/chart-data';
import { bucketRoles } from '../visualization/chart-compatibility';
import { TABLE_VIRTUALIZE_ROWS } from '../visualization/chart.constants';
import { createIssue, formatIssue } from '../visualization/chart-issues';
import { recommendChart } from '../visualization/chart-recommender';
import { resolveVisualization } from '../visualization/chart-pipeline';
import { profileColumns } from '../visualization/column-profiler';
import type { ChartConfigV1 } from '../visualization/chart.types';
import type { SqlExecuteResult, SqlMode } from '../../types/report.types';
import {
  sqlLayoutFromPreferredView,
  sqlLayoutShowsChart,
  sqlLayoutShowsTable,
  type SqlResultLayout,
} from './sql-result-layout';

interface QueryResultPanelProps {
  result: SqlExecuteResult | null;
  loading: boolean;
  error: string | null;
  config: ChartConfigV1 | null;
  queryContext?: { mode: SqlMode; builderDsl?: unknown; sql?: unknown };
  onConfigChange?: (config: ChartConfigV1) => void;
  tableHeight?: number;
  layout?: SqlResultLayout;
}

const fmt = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN');
  return String(value);
};

export function QueryResultPanel({
  result,
  loading,
  error,
  config,
  queryContext,
  onConfigChange,
  tableHeight = 280,
  layout,
}: QueryResultPanelProps) {
  const { t } = useT('report');
  const profiles = useMemo(
    () => (result ? profileColumns(result.columns, result.rows, { builderDsl: queryContext?.builderDsl as never, sql: queryContext?.sql as never }) : []),
    [queryContext?.builderDsl, result],
  );
  const buckets = useMemo(() => bucketRoles(profiles), [profiles]);
  // 图表可用性：与 ChartWorkbench 同源判定（失效时它不画回退表，表格应占满高度）。
  // 必须在下方早返回之前调用 —— 否则卸载/加载切换时会「Rendered more hooks than during the previous render」。
  const chartResolution = useMemo(
    () =>
      result
        ? resolveVisualization({
            columns: result.columns,
            rows: result.rows,
            savedConfig: config,
            queryContext: {
              builderDsl: queryContext?.builderDsl as never,
              sql: queryContext?.sql as never,
            },
            truncated: result.truncated,
          })
        : null,
    [config, result, queryContext?.builderDsl, queryContext?.sql],
  );
  const chartUnavailable = Boolean(
    chartResolution &&
      chartResolution.issues.some((issue) => issue.severity === 'error') &&
      chartResolution.view !== 'chart',
  );
  const pivot = useMemo(() => {
    if (!result) return null;
    if (buckets.time.length === 1 && buckets.dimension.length === 1 && buckets.metric.length === 1) {
      return buildPivotTable(result.rows, buckets.time[0].key, buckets.dimension[0].key, buckets.metric[0].key);
    }
    return null;
  }, [buckets, result]);

  const effective: SqlResultLayout =
    layout ?? sqlLayoutFromPreferredView(config?.preferred_view ?? (pivot ? 'pivot' : undefined));

  if (loading && !result) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (error && !result) {
    return (
      <div style={{ padding: 24 }}>
        <Typography.Text type="danger">{error}</Typography.Text>
      </div>
    );
  }

  if (!result) {
    return (
      <EmptyState
        variant="sql"
        title={t('report:result.emptyTitle')}
        description={t('report:result.emptyDescription')}
      />
    );
  }

  if (!result.columns.length) {
    return <EmptyState variant="sql" />;
  }

  const virtual = result.rows.length > TABLE_VIRTUALIZE_ROWS;
  // 用户 SQL 别名是用户数据（不翻译）：按别名自身字符数估列宽**下限**（最短 112、最长 240），
  // 表格宽度下限 = 各列下限之和——结果区窄时整表横向滚动，而不是把每列压成一字一列（G.29）
  const plainColumns = result.columns.map((column) => ({
    title: column.name,
    dataIndex: column.name,
    key: column.name,
    minWidth: Math.min(240, Math.max(112, column.name.length * 9 + 24)),
    ellipsis: { showTitle: true },
    sorter: (a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a[column.name] ?? '').localeCompare(String(b[column.name] ?? ''), undefined, { numeric: true }),
  }));
  const plainTableMinWidth = plainColumns.reduce((total, column) => total + column.minWidth, 0);

  const additive = buckets.metric[0]?.metric?.aggregation === 'additive';
  const tableIssues = recommendChart(profiles, result.rows).issues.filter(
    (issue) => issue.code === 'AMBIGUOUS_COLUMN_ROLE' || issue.code === 'TOO_MANY_ROWS',
  );
  const showChart = sqlLayoutShowsChart(effective);
  const showTable = sqlLayoutShowsTable(effective);
  const showPivot = effective === 'pivot' && Boolean(pivot);
  const split = showChart && showTable;
  const splitWithChart = split && !chartUnavailable;
  const chartHeight = splitWithChart ? Math.max(200, Math.round(tableHeight * 0.48)) : Math.max(240, tableHeight - 48);
  const gridHeight = splitWithChart ? Math.max(160, tableHeight - chartHeight) : tableHeight;

  return (
    <div style={{ position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.55)', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Spin />
          <Typography.Text type="secondary">{t('report:result.loadingKeep')}</Typography.Text>
        </div>
      )}
      {error && (
        <Alert type="error" showIcon message={error} style={{ margin: '8px 12px' }} />
      )}
      {result.truncated && (
        <Alert
          type="warning"
          showIcon
          message={formatIssue(createIssue('TRUNCATED_RESULT', 'warning', { params: { rows: result.rows.length } }))}
          style={{ margin: '8px 12px 0' }}
        />
      )}
      {tableIssues.map((issue) => (
        <Alert
          key={issue.code}
          type={issue.severity === 'error' ? 'error' : 'warning'}
          showIcon
          message={formatIssue(issue)}
          style={{ margin: '8px 12px 0' }}
        />
      ))}
      <div style={{ padding: '8px 16px', minWidth: 0 }}>
        <Typography.Text type="secondary" style={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}>
          {t('report:result.summary', {
            rows: result.row_count,
            elapsed: result.elapsed_ms,
            readRows: result.read_rows,
            readBytes: result.read_bytes,
          })}
          {result.truncated ? t('report:result.truncatedSuffix') : ''}
          {result.from_cache ? t('report:result.fromCacheSuffix') : ''}
          {result.applied_time_range
            ? t('report:result.timeRangeSuffix', {
                start: result.applied_time_range.start,
                end: result.applied_time_range.end,
              })
            : ''}
        </Typography.Text>
      </div>
      {result.rows.length === 0 && result.query_id !== 'card-placeholder' && (
        // 「缓存为空」与「条件没有数据」的下一步动作不同，不能合成一句文案
        <EmptyState
          variant="sql"
          title={result.from_cache ? t('report:result.emptyCacheTitle') : undefined}
          description={result.from_cache ? t('report:result.emptyCacheDescription') : undefined}
        />
      )}
      {result.rows.length === 0 && result.query_id === 'card-placeholder' && !showChart && (
        <EmptyState
          variant="sql"
          title={t('report:result.placeholderTitle')}
          description={t('report:result.placeholderDescription')}
        />
      )}
      {result.rows.length > 0 && showPivot && pivot && (
        <Table
          size="small"
          bordered
          columns={[
            {
              // 透视首列是被冻结的维度值（用户数据）：宽度参与吸附对齐，保留定宽；
              // 补 ellipsis + showTitle，列名/取值被夹住时悬停仍可看全称（G.29）
              title: `${pivot.propDim} \\ ${pivot.timeDim}`,
              dataIndex: pivot.timeDim,
              key: pivot.timeDim,
              fixed: 'left',
              width: 160,
              ellipsis: { showTitle: true },
              render: (value: unknown) => fmt(value),
            },
            ...pivot.propValues.map((value) => ({
              title: value,
              key: value,
              dataIndex: value,
              align: 'right' as const,
              ellipsis: { showTitle: true },
              render: fmt,
            })),
          ]}
          dataSource={pivot.rows.map((row, index) => ({ key: index, ...row }))}
          pagination={false}
          sticky
          scroll={{ x: 'max-content', y: tableHeight }}
          virtual={virtual}
          summary={(data) => {
            if (!data.length || !additive) return null;
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}>
                  <Typography.Text strong>{t('common:label.total')}</Typography.Text>
                </Table.Summary.Cell>
                {pivot.propValues.map((value, index) => {
                  const sum = data.reduce((acc, row) => {
                    const cell = (row as Record<string, unknown>)[value];
                    return typeof cell === 'number' ? acc + cell : acc;
                  }, 0);
                  return (
                    <Table.Summary.Cell key={value} index={index + 1} align="right">
                      <Typography.Text strong>{fmt(sum)}</Typography.Text>
                    </Table.Summary.Cell>
                  );
                })}
              </Table.Summary.Row>
            );
          }}
        />
      )}
      {(result.rows.length > 0 || Boolean(config)) && showChart && (
        <ChartWorkbench
          result={result}
          config={config}
          queryContext={queryContext}
          displayMode="analysis"
          hideEmbeddedChrome
          tableFallback={showTable ? 'none' : 'table'}
          onConfigChange={onConfigChange}
          height={chartHeight}
        />
      )}
      {result.rows.length > 0 && showTable && (
        <Table
          size="small"
          columns={plainColumns}
          dataSource={result.rows.map((row, index) => ({ key: index, ...row }))}
          pagination={false}
          sticky
          virtual={virtual}
          scroll={{ x: plainTableMinWidth, y: gridHeight }}
        />
      )}
    </div>
  );
}
