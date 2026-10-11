import { useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Col, Input, InputNumber, message, Modal, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import {
  getDataOverview,
  getDataTrend,
  getDataHealth,
  previewCleanup,
  executeDropPartitions,
  setTableTtl,
  getDataMgmtActions,
  type TableInventory,
  type CleanupPreviewResult,
  type ReconcileSnapshotView,
  type ActionLogItem,
} from '../../services/ops.service';
import { useT, type TFunction } from '../../i18n';
import { RetentionCard } from '../../features/ops/RetentionCard';
import { DataCleanupPanel } from '../../features/ops/DataCleanupPanel';
import { ProjectRetireCard } from '../../features/ops/ProjectRetireCard';
import type { PreflightView } from '../../services/ops.service';

/** 前置对拍原因 → i18n 键名（后端枚举是 snake_case，前端键名按规范用 lowerCamelCase） */
const PREFLIGHT_REASON_KEY: Record<PreflightView['reason'], string> = {
  ok: 'ok',
  no_snapshot: 'noSnapshot',
  not_covered: 'notCovered',
  snapshot_failed: 'snapshotFailed',
  snapshot_stale: 'snapshotStale',
};

function fmtBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/** 行数缩写：中文用「万 / 亿」（与原实现逐字一致）；其他语言按同一量级写作 ×10K / ×100M（i18n 设计文档 §5.5） */
function fmtRows(n: number, t: TFunction): string {
  if (n >= 1e8) return t('ops:dataMgmt.rowsHundredMillion', { value: (n / 1e8).toFixed(2) });
  if (n >= 1e4) return t('ops:dataMgmt.rowsTenThousand', { value: (n / 1e4).toFixed(1) });
  return String(n);
}

/**
 * 数据运维（phase: clklog-analytics-data-management-v1；V1.1 执行流、quality-ops-v1 保留策略已并入）。
 *
 * 现状：存储概览 + 按表趋势 + 数据健康 + 清理预演与执行（二次确认 + 前置对拍 + 审计 + 清理登记）
 * + TTL 设置 + 保留策略总览（预期 × 实际 × 对拍可信区间）+ 可疑分区提示。
 * 顶部提示是**能力清单**，不再写「V1.1 待上线」——那批能力已陆续上线（2026-09 起）。
 */
export function DataManagementPage() {
  const { t } = useT('ops');
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [tables, setTables] = useState<TableInventory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [trend, setTrend] = useState<{ series: Record<string, { bytes: [string, number][] }>; points: number } | null>(null);
  const [trendRange, setTrendRange] = useState(24 * 30);

  const [health, setHealth] = useState<ReconcileSnapshotView | null>(null);

  const [previewTable, setPreviewTable] = useState<string | undefined>();
  const [previewDays, setPreviewDays] = useState(180);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<CleanupPreviewResult | null>(null);
  // 预演失败标记：单独置位（不信赖文案前缀，切换语言后仍可判定）
  const [previewFailed, setPreviewFailed] = useState(false);

  // V1.1 清理执行
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [executing, setExecuting] = useState(false);
  const [executeResult, setExecuteResult] = useState<{ done: string[]; failed: { partition: string; error: string }[] } | null>(null);

  // V1.1 TTL 设置
  const [ttlOpen, setTtlOpen] = useState(false);
  const [ttlTable, setTtlTable] = useState<string | undefined>();
  const [ttlDays, setTtlDays] = useState(180);
  const [ttlConfirm, setTtlConfirm] = useState('');
  const [ttlSaving, setTtlSaving] = useState(false);

  const [actions, setActions] = useState<ActionLogItem[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const [ov, tr, h] = await Promise.all([
          getDataOverview(),
          getDataTrend(24 * 30).catch(() => null),
          getDataHealth().catch(() => null),
        ]);
        setTables(ov.tables);
        if (tr) setTrend({ series: tr.series, points: tr.sampled_points });
        setHealth(h);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('common:message.loadFailed'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshActions = async () => {
    const a = await getDataMgmtActions({ limit: 10 }).catch(() => []);
    setActions(a);
  };

  useEffect(() => {
    if (!loading) void refreshActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const openConfirm = async () => {
    setConfirmText('');
    setExecuteResult(null);
    setConfirmOpen(true);
  };

  const runExecute = async () => {
    if (!preview || !previewTable) return;
    setExecuting(true);
    try {
      const r = await executeDropPartitions({
        table: preview.table,
        partitions: preview.partitions.map((p) => p.partition),
        confirmed_table: confirmText.trim(),
        dry_run_snapshot: preview,
      });
      setExecuteResult({ done: r.done, failed: r.failed });
      setConfirmOpen(false);
      message.success(t('ops:dataMgmt.deletedPartitions', { count: r.done.length }));
      void refreshActions();
      // 刷新概览与预演（分区已删，重新盘点）
      const ov = await getDataOverview().catch(() => null);
      if (ov) setTables(ov.tables);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('ops:message.executeFailed'));
    } finally {
      setExecuting(false);
    }
  };

  const runSetTtl = async () => {
    if (!ttlTable) return;
    setTtlSaving(true);
    try {
      const r = await setTableTtl({ table: ttlTable, days: ttlDays, confirmed_table: ttlConfirm.trim() });
      setTtlOpen(false);
      message.success(t('ops:dataMgmt.ttlSetDone', { days: r.ttl_days }));
      void refreshActions();
      const ov = await getDataOverview().catch(() => null);
      if (ov) setTables(ov.tables);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('ops:message.setFailed'));
    } finally {
      setTtlSaving(false);
    }
  };

  const refreshTrend = async (hours: number) => {
    setTrendRange(hours);
    const tr = await getDataTrend(hours).catch(() => null);
    if (tr) setTrend({ series: tr.series, points: tr.sampled_points });
  };

  const totals = useMemo(() => {
    const rows = tables.reduce((s, tbl) => s + tbl.rows, 0);
    const bytes = tables.reduce((s, tbl) => s + tbl.compressed_bytes, 0);
    return { rows, bytes, count: tables.length };
  }, [tables]);

  const trendOption = useMemo(() => {
    if (!trend) return null;
    const names = Object.keys(trend.series);
    if (!names.length) return null;
    const legend = names.map((n) => t('ops:dataMgmt.compressedBytes', { name: n }));
    const series = names.map((n) => ({
      name: t('ops:dataMgmt.compressedBytes', { name: n }),
      type: 'line' as const,
      showSymbol: false,
      data: trend.series[n].bytes.map(([pointAt, bytes]) => [pointAt, bytes]),
    }));
    return {
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, data: legend },
      grid: { left: '3%', right: '4%', bottom: '18%', containLabel: true },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtBytes(v) } },
      series,
    };
  }, [trend, t]);

  const runPreview = async () => {
    if (!previewTable) return;
    setPreviewing(true);
    setPreview(null);
    setPreviewFailed(false);
    try {
      setPreview(await previewCleanup(previewTable, previewDays));
    } catch (e) {
      setPreviewFailed(true);
      setPreview({
        table: previewTable,
        older_than_days: previewDays,
        cutoff: '',
        partitions: [],
        total_rows: 0,
        total_compressed_bytes: 0,
        action: t('ops:dataMgmt.previewFailed', { error: e instanceof Error ? e.message : String(e) }),
      });
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <Spin tip={t('ops:dataMgmt.loadingOverview')} style={{ width: '100%', padding: 40 }} />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={t('ops:dataMgmt.readonlyNotice')} />
      {error && <Alert type="error" showIcon message={error} />}

      <Row gutter={16}>
        <Col span={8}><Card><Statistic title={t('ops:dataMgmt.statTables')} value={totals.count} /></Card></Col>
        <Col span={8}><Card><Statistic title={t('ops:dataMgmt.statRows')} value={fmtRows(totals.rows, t)} /></Card></Col>
        <Col span={8}><Card><Statistic title={t('ops:dataMgmt.statCompressed')} value={fmtBytes(totals.bytes)} /></Card></Col>
      </Row>

      <Card title={t('ops:dataMgmt.overview')} size="small">
        <Table<TableInventory>
          size="small"
          rowKey="table"
          dataSource={tables}
          pagination={false}
          scroll={{ x: 1060 }}
          columns={[
            { title: t('ops:dataMgmt.column.table'), dataIndex: 'table', minWidth: 320, ellipsis: { showTitle: true } },
            { title: t('ops:dataMgmt.column.rows'), dataIndex: 'rows', minWidth: 130, render: (v: number) => fmtRows(v, t) },
            { title: t('ops:dataMgmt.column.compressed'), dataIndex: 'compressed_bytes', minWidth: 140, render: (v: number) => fmtBytes(v) },
            { title: t('ops:dataMgmt.column.raw'), dataIndex: 'total_bytes', minWidth: 120, render: (v: number) => fmtBytes(v) },
            { title: t('ops:dataMgmt.column.partitions'), dataIndex: 'partitions', minWidth: 110 },
            {
              title: t('ops:dataMgmt.column.lastWrite'),
              dataIndex: 'last_write_at',
              minWidth: 170,
              render: (v: string | null) => (v ? formatDateTime(v) : '-'),
            },
            {
              title: 'TTL',
              dataIndex: 'ttl_days',
              minWidth: 170,
              render: (v: number | null) =>
                v ? <Tag color="green">{t('ops:dataMgmt.ttlDays', { days: v })}</Tag> : <Tag>{t('common:state.notSet')}</Tag>,
            },
          ]}
        />
      </Card>

      <Card
        title={t('ops:dataMgmt.trend')}
        size="small"
        extra={
          <Select
            size="small"
            value={trendRange}
            onChange={(v) => void refreshTrend(v)}
            options={[
              { value: 24 * 7, label: t('common:time.last7Days') },
              { value: 24 * 30, label: t('common:time.last30Days') },
              { value: 24 * 90, label: t('ops:range.last90Days') },
            ]}
            style={{ minWidth: 150 }}
          />
        }
      >
        {trendOption ? (
          <ReactECharts option={trendOption} style={{ height: 300 }} />
        ) : (
          <Typography.Text type="secondary">
            {t('ops:dataMgmt.trendAccumulating', { count: trend?.points ?? 0 })}
          </Typography.Text>
        )}
      </Card>

      <Card
        title={t('ops:dataMgmt.health')}
        size="small"
        extra={
          <Button size="small" onClick={() => navigate('/ops/quality')}>
            {t('ops:dataMgmt.gotoQuality')}
          </Button>
        }
      >
        {health ? (
          <Space size={32} wrap>
            <Statistic
              title={t('ops:dataMgmt.lastReconcile')}
              value={formatDateTime(health.ran_at)}
              suffix={
                health.stale_level === 'fresh' ? null : (
                  <Tag color={health.stale_level === 'error' ? 'red' : 'orange'}>
                    {t(
                      health.stale_level === 'error'
                        ? 'ops:dataMgmt.snapshotStaleError'
                        : 'ops:dataMgmt.snapshotStaleWarn',
                      { hours: health.age_hours },
                    )}
                  </Tag>
                )
              }
            />
            <Statistic title={t('ops:dataMgmt.reconcileRange')} value={`${health.range.from} ~ ${health.range.to}`} />
            <Statistic
              title={t('ops:dataMgmt.reconcileStatus')}
              valueStyle={{ color: health.summary?.has_alert ? '#cf1322' : '#3f8600' }}
              value={health.summary?.has_alert ? t('ops:dataMgmt.hasAlert') : t('ops:dataMgmt.normal')}
            />
            <Statistic title={t('ops:dataMgmt.alertDays')} value={health.summary?.alert_days ?? 0} />
            <Statistic title={t('ops:dataMgmt.dupCrcRows')} value={health.summary?.dup_crc_rows ?? 0} />
          </Space>
        ) : (
          <Typography.Text type="secondary">{t('ops:dataMgmt.noSnapshot')}</Typography.Text>
        )}
      </Card>

      <RetentionCard />

      <DataCleanupPanel />

      <ProjectRetireCard />

      <Card title={t('ops:dataMgmt.preview')} size="small">
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            placeholder={t('ops:dataMgmt.selectTable')}
            style={{ minWidth: 300 }}
            value={previewTable}
            onChange={setPreviewTable}
            options={tables.map((row) => ({ value: row.table, label: row.table }))}
          />
          <span>{t('ops:dataMgmt.previewPrefix')}</span>
          <InputNumber min={1} max={3650} value={previewDays} onChange={(v) => setPreviewDays(v ?? 180)} />
          <span>{t('ops:dataMgmt.previewSuffix')}</span>
          <Button type="primary" loading={previewing} disabled={!previewTable} onClick={() => void runPreview()}>
            {t('ops:dataMgmt.previewRun')}
          </Button>
        </Space>
        {preview && (
          <>
            {previewFailed ? (
              <Alert type="error" showIcon message={preview.action} />
            ) : (
              <Alert
                type={preview.partitions.length ? 'warning' : 'success'}
                showIcon
                message={
                  preview.partitions.length
                    ? t('ops:dataMgmt.previewImpact', {
                        count: preview.partitions.length,
                        rows: fmtRows(preview.total_rows, t),
                        size: fmtBytes(preview.total_compressed_bytes),
                        cutoff: preview.cutoff,
                      })
                    : t('ops:dataMgmt.previewNone', { cutoff: preview.cutoff })
                }
                description={preview.partitions.length ? t('ops:dataMgmt.previewWarning') : undefined}
              />
            )}
            {preview.preflight && !preview.preflight.ok ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message={t('ops:dataMgmt.preflight.blocked', {
                  reason: t(`ops:dataMgmt.preflight.reason.${PREFLIGHT_REASON_KEY[preview.preflight.reason]}`),
                })}
                description={t('ops:dataMgmt.preflight.hint', {
                  date: preview.preflight.required_to,
                  max: preview.preflight.max_age_hours,
                })}
              />
            ) : preview.preflight ? (
              <Alert
                type="success"
                showIcon
                style={{ marginTop: 12 }}
                message={t('ops:dataMgmt.preflight.ok', { date: preview.preflight.required_to })}
              />
            ) : null}
            {preview.partitions.length > 0 && (
              <>
                <Button
                  danger
                  type="primary"
                  style={{ marginTop: 12 }}
                  disabled={Boolean(preview.preflight && !preview.preflight.ok)}
                  onClick={() => void openConfirm()}
                >
                  {t('ops:dataMgmt.executeCleanup', { count: preview.partitions.length })}
                </Button>
                <Table
                  size="small"
                  style={{ marginTop: 12 }}
                  rowKey="partition"
                  dataSource={preview.partitions}
                  pagination={false}
                  scroll={{ x: 540 }}
                  columns={[
                    { title: t('ops:dataMgmt.column.partitions'), dataIndex: 'partition', minWidth: 240, ellipsis: { showTitle: true } },
                    { title: t('ops:dataMgmt.column.rows'), dataIndex: 'rows', minWidth: 130, render: (v: number) => fmtRows(v, t) },
                    {
                      title: t('ops:dataMgmt.column.compressed'),
                      dataIndex: 'compressed_bytes',
                      minWidth: 150,
                      render: (v: number) => fmtBytes(v),
                    },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Card>

      <Card
        title={t('ops:dataMgmt.ttl')}
        size="small"
        extra={
          <Button
            size="small"
            onClick={() => {
              setTtlTable(previewTable ?? tables[0]?.table);
              setTtlConfirm('');
              setTtlOpen(true);
            }}
          >
            {t('ops:dataMgmt.ttlSet')}
          </Button>
        }
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('ops:dataMgmt.ttlHint')}
        </Typography.Text>
      </Card>

      <Card title={t('ops:dataMgmt.audit')} size="small">
        <Table<ActionLogItem>
          size="small"
          rowKey="id"
          dataSource={actions}
          pagination={false}
          locale={{ emptyText: t('ops:dataMgmt.noActions') }}
          scroll={{ x: 1080 }}
          columns={[
            {
              title: t('ops:dataMgmt.column.time'),
              dataIndex: 'created_at',
              minWidth: 170,
              render: (v: string) => formatDateTime(v),
            },
            {
              title: t('ops:dataMgmt.column.action'),
              dataIndex: 'action',
              minWidth: 200,
              render: (v: string) =>
                v === 'drop_partition'
                  ? t('ops:dataMgmt.actionDropPartition')
                  : v === 'set_ttl'
                    ? t('ops:dataMgmt.actionSetTtl')
                    : v,
            },
            { title: t('ops:dataMgmt.column.targetTable'), dataIndex: 'target_table', minWidth: 240, ellipsis: { showTitle: true } },
            {
              title: t('ops:dataMgmt.column.detail'),
              dataIndex: 'detail',
              minWidth: 320,
              ellipsis: { showTitle: true },
              render: (v: Record<string, unknown>) => (
                <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: JSON.stringify(v) }}>
                  {JSON.stringify(v).slice(0, 160)}
                </Typography.Text>
              ),
            },
            {
              title: t('common:label.status'),
              dataIndex: 'status',
              minWidth: 120,
              render: (v: string) => (
                <Tag color={v === 'done' ? 'green' : v === 'partial' ? 'orange' : 'red'}>
                  {v === 'done'
                    ? t('ops:dataMgmt.statusDone')
                    : v === 'partial'
                      ? t('ops:dataMgmt.statusPartial')
                      : t('common:state.failed')}
                </Tag>
              ),
            },
            { title: t('ops:dataMgmt.column.operator'), dataIndex: 'operator', minWidth: 150, ellipsis: { showTitle: true } },
          ]}
        />
      </Card>

      <Modal
        title={t('ops:dataMgmt.confirmDropTitle')}
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={() => void runExecute()}
        confirmLoading={executing}
        okText={t('ops:dataMgmt.confirmDropOk')}
        okButtonProps={{ danger: true, disabled: confirmText.trim() !== previewTable }}
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('ops:dataMgmt.dropWarning', {
            table: previewTable,
            count: preview?.partitions.length ?? 0,
            rows: fmtRows(preview?.total_rows ?? 0, t),
          })}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('ops:dataMgmt.confirmTypeHint')}<Typography.Text code>{previewTable}</Typography.Text>
        </Typography.Paragraph>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={previewTable}
        />
        {executeResult && (
          <Alert
            style={{ marginTop: 12 }}
            type={executeResult.failed.length ? 'warning' : 'success'}
            message={
              executeResult.failed.length
                ? t('ops:dataMgmt.executeDonePartial', {
                    count: executeResult.done.length,
                    failed: executeResult.failed.length,
                  })
                : t('ops:dataMgmt.executeDone', { count: executeResult.done.length })
            }
          />
        )}
      </Modal>

      <Modal
        title={t('ops:dataMgmt.ttlTitle')}
        open={ttlOpen}
        onCancel={() => setTtlOpen(false)}
        onOk={() => void runSetTtl()}
        confirmLoading={ttlSaving}
        okText={t('ops:dataMgmt.ttlSet')}
        okButtonProps={{ disabled: ttlConfirm.trim() !== ttlTable }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Typography.Text>
            {t('ops:dataMgmt.ttlTarget')}<Typography.Text code>{ttlTable}</Typography.Text>
            {t('ops:dataMgmt.ttlRetain')}
            <InputNumber min={1} max={3650} value={ttlDays} onChange={(v) => setTtlDays(v ?? 180)} style={{ margin: '0 8px' }} />
            {t('ops:dataMgmt.ttlRetainSuffix')}
          </Typography.Text>
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {t('ops:dataMgmt.ttlNoteBefore')}<b>{t('ops:dataMgmt.ttlNoteBold')}</b>{t('ops:dataMgmt.ttlNoteAfter')}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('ops:dataMgmt.confirmTypeHint')}
          </Typography.Text>
          <Input value={ttlConfirm} onChange={(e) => setTtlConfirm(e.target.value)} placeholder={ttlTable} />
        </Space>
      </Modal>
    </Space>
  );
}
