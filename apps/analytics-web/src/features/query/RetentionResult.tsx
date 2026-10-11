import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { AnalysisCardSave } from './AnalysisCardSave';
import { EmptyState } from '../../components/EmptyState';
import { AnalysisResultSettings } from './AnalysisResultSettings';
import { RetentionViewSettings } from './RetentionViewSettings';
import { DeleteCardButton } from '../report/DeleteCardButton';
import { CreateMetricModal } from '../metrics/CreateMetricModal';
import { ResultCohortModal } from '../cohort/ResultCohortModal';
import { useRetentionStore } from '../../stores/retention.store';
import type { QueryColumn, QueryResult } from '../../types/dsl.types';
import type { RetentionFormState } from '../../utils/dsl-builder';
import { ExploreChart } from '../explore-charts/ExploreChart';
import { modelFromRetentionNth } from '../explore-charts/explore-chart-option';
import { formatRetentionCell, splitRetentionColumns } from './retention-tables';
import { localizedColumnTitle, localizedColumns } from './column-titles';
import { downloadResultCsv, mappedText } from './result-csv';
import { BRAND_PRIMARY } from '../../styles/tokens';
import {
  parseRetentionResultLayout,
  retentionCardChartType,
  retentionViewPayload,
  type RetentionResultLayout,
} from './retention-view';

interface RetentionResultProps {
  result: QueryResult | null;
  loading: boolean;
  form?: RetentionFormState | null;
  cardId?: string | null;
  cardName?: string | null;
  initialLayout?: RetentionResultLayout | 'trend';
  initialChartType?: string;
}

export function RetentionResult({
  result,
  loading,
  form,
  cardId,
  cardName,
  initialLayout = 'both',
  initialChartType = 'nth_trend',
}: RetentionResultProps) {
  const { t } = useT('analysis');
  const navigate = useNavigate();
  const [view, setView] = useState<RetentionResultLayout>(() => parseRetentionResultLayout(initialLayout));
  const [createOpen, setCreateOpen] = useState(false);
  const [cohortOpen, setCohortOpen] = useState(false);
  const [cohortCell, setCohortCell] = useState<Record<string, unknown>>({});
  const dsl = useRetentionStore((s) => s.dsl);
  const error = useRetentionStore((s) => s.error);

  useEffect(() => {
    setView(parseRetentionResultLayout(initialLayout));
  }, [cardId, initialLayout, initialChartType]);

  const nthModel = useMemo(
    () =>
      result
        ? modelFromRetentionNth(localizedColumns(result.columns, t), result.rows)
        : { categories: [], series: [] },
    [result, t],
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
        <EmptyState variant="analysis" title={null} description={t('analysis:retention.emptyHint')} />
      </Card>
    );
  }

  const { columns, rows, elapsed_ms, from_cache, sql } = result;
  const showChart = view === 'chart' || view === 'both';
  const showTable = view === 'table' || view === 'both';
  const split = splitRetentionColumns(columns);
  const dslWithView = dsl
    ? {
        ...(dsl as unknown as Record<string, unknown>),
        _view: retentionViewPayload({ layout: view, chart: 'nth_trend', statCalcs: [] }),
      }
    : null;

  const renderColumns = (cols: QueryColumn[], rates: boolean) =>
    cols.map((col) => ({
      // 表头按查看者语言渲染；服务端固定文案列名带 title_key（人数 / D7 / D7 留存率…）
      title: localizedColumnTitle(col, t),
      dataIndex: col.key,
      key: col.key,
      render: (value: unknown, row: Record<string, unknown>) => {
        if (col.key === 'group_col') {
          const mapped = mappedText(col, value);
          if (mapped && mapped !== String(value ?? '')) {
            return (
              <Tooltip title={t('analysis:result.rawValue', { value: String(value) })}>
                <span style={{ color: BRAND_PRIMARY }}>{mapped}</span>
              </Tooltip>
            );
          }
        }
        const text = formatRetentionCell(col.key, value);
        const isCount = !rates && (col.key === 'cohort_size' || /^n_\d+$/.test(col.key));
        if (isCount && typeof value === 'number') {
          return (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => {
                setCohortCell({
                  cohort_date: row.cohort_date,
                  n: col.key === 'cohort_size' ? undefined : Number(col.key.slice(2)),
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
    }));

  return (
    <Card
      className="analysis-result-card"
      title={
        <Space wrap>
          <span>{t('analysis:result.title')}</span>
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
            <RetentionViewSettings layout={view} onLayoutChange={setView} />
          </AnalysisResultSettings>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => downloadResultCsv(t('analysis:retention.title'), columns, rows)}
          >
            {t('analysis:action.exportCsv')}
          </Button>
          {dslWithView ? (
            <AnalysisCardSave
              type="retention"
              dsl={dslWithView}
              formSnapshot={form}
              chartType={retentionCardChartType(view, 'nth_trend')}
              cardId={cardId}
              cardName={cardName}
            />
          ) : null}
          <Button size="small" onClick={() => setCreateOpen(true)}>
            {t('analysis:action.createMetric')}
          </Button>
          <CreateMetricModal
            open={createOpen}
            kind="retention"
            retentionForm={form}
            onClose={() => setCreateOpen(false)}
          />
          {cardId ? (
            <DeleteCardButton
              cardId={cardId}
              cardName={cardName ?? undefined}
              onDeleted={() => navigate('/analysis/retention')}
            />
          ) : null}
        </Space>
      }
    >
      {showChart ? (
        <div style={{ marginBottom: 24 }}>
          <ExploreChart kind="nth_trend" model={nthModel} statCalcs={[]} />
        </div>
      ) : null}
      {showTable ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>{t('analysis:retention.people')}</Typography.Text>
            <Table
              size="small"
              rowKey={(row) => `${row.cohort_date}-${row.group_col ?? ''}`}
              columns={renderColumns(split.people, false)}
              dataSource={rows}
              pagination={false}
              scroll={{ x: true }}
              style={{ marginTop: 8 }}
            />
          </div>
          <div>
            <Typography.Text strong>{t('analysis:retention.rate')}</Typography.Text>
            <Table
              size="small"
              rowKey={(row) => `${row.cohort_date}-${row.group_col ?? ''}-rate`}
              columns={renderColumns(split.rates, true)}
              dataSource={rows}
              pagination={false}
              scroll={{ x: true }}
              style={{ marginTop: 8 }}
            />
          </div>
        </Space>
      ) : null}
      <ResultCohortModal
        open={cohortOpen}
        source="retention"
        dsl={dsl ? (dsl as unknown as Record<string, unknown>) : null}
        cell={cohortCell}
        onClose={() => setCohortOpen(false)}
      />
      {sql && (
        <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }}>
          <pre style={{ fontSize: 12, background: '#f6f6f6', padding: 12, borderRadius: 4 }}>{sql}</pre>
        </Typography.Paragraph>
      )}
    </Card>
  );
}
