import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useT } from '../../i18n';
import { useProjectStore } from '../../stores/project.store';
import {
  deleteExecute,
  deletePreview,
  getUnregisteredEvents,
  type DeleteKind,
  type DeletePreviewView,
  type UnregisteredEventsView,
} from '../../services/ops.service';

/** 定点删除白名单（与后端 cleanup-plan.ts 一致；社区版 clklog.* 不在其中，后端会硬拒） */
const DELETE_TABLES: Array<{ value: string; kinds: DeleteKind[] }> = [
  { value: 'clklog_sa.sa_events', kinds: ['event', 'project', 'before', 'future'] },
  { value: 'clklog_sa.sa_user_profiles', kinds: ['project'] },
  { value: 'clklog_sa.sa_datatable_rows', kinds: ['project'] },
  { value: 'clklog_sa.sa_cohort_members', kinds: ['project'] },
  { value: 'clklog_sa.sa_tag_members', kinds: ['project'] },
];

/** 前置对拍原因 → i18n 键（后端枚举 snake_case → 键名 lowerCamelCase） */
const PREFLIGHT_KEY: Record<DeletePreviewView['preflight']['reason'], string> = {
  ok: 'ok',
  no_snapshot: 'noSnapshot',
  not_covered: 'notCovered',
  snapshot_failed: 'snapshotFailed',
  snapshot_stale: 'snapshotStale',
};

type UnregisteredRow = UnregisteredEventsView['unregistered'][number];

/**
 * 数据清理 v1.2（phase: clklog-data-management-v1.2）。
 *
 * 上：数据 ↔ 元数据对账（「以前上报的测试事件在 ClickHouse、平台看不到」→ 一键预填按事件清理）；
 * 下：定点删除（条件白名单 → 预演 → 输入表名确认 → 执行；后端强制备份 + 审计 + 清理登记）。
 */
export function DataCleanupPanel() {
  const { t } = useT('ops');
  const project = useProjectStore((s) => s.currentProject) || 'clklogapp';

  const [unreg, setUnreg] = useState<UnregisteredEventsView | null>(null);
  const [loadingUnreg, setLoadingUnreg] = useState(true);
  const [unregError, setUnregError] = useState<string | null>(null);
  /** 对账窗口（天）：14 天实测稳定；30 天会随 CH 负载波动被估算拒绝，故默认 14、上限 30 */
  const [windowDays, setWindowDays] = useState(14);

  const [kind, setKind] = useState<DeleteKind>('event');
  const [table, setTable] = useState('clklog_sa.sa_events');
  const [event, setEvent] = useState('');
  const [before, setBefore] = useState('');
  const [confirmTable, setConfirmTable] = useState('');
  const [preview, setPreview] = useState<DeletePreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ backup_table: string | null; rows_planned: number; mutation_id: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUnreg = useCallback(async () => {
    setLoadingUnreg(true);
    setUnregError(null);
    try {
      setUnreg(await getUnregisteredEvents(project, windowDays));
    } catch (e) {
      // 失败**必须显式提示**：窗口过大时后端会拒绝，静默空列表会被误读成「没有未登记事件」
      setUnreg(null);
      setUnregError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingUnreg(false);
    }
  }, [project, windowDays]);

  useEffect(() => {
    void loadUnreg();
  }, [loadUnreg]);

  const allowedKinds = DELETE_TABLES.find((x) => x.value === table)?.kinds ?? (['project'] as DeleteKind[]);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(
        await deletePreview({
          kind,
          table,
          project,
          ...(kind === 'event' ? { event } : {}),
          ...(kind === 'before' ? { before } : {}),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runExecute = async () => {
    if (!preview?.confirm_token) return;
    setBusy(true);
    setError(null);
    try {
      const out = await deleteExecute({
        kind,
        table,
        project,
        ...(kind === 'event' ? { event } : {}),
        ...(kind === 'before' ? { before } : {}),
        confirm_table: confirmTable,
        confirm_token: preview.confirm_token,
      });
      setResult(out);
      setPreview(null);
      setConfirmTable('');
      await loadUnreg();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card
        size="small"
        title={t('ops:dataCleanup.unregisteredTitle')}
        loading={loadingUnreg}
        extra={
          <Space size={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('ops:dataCleanup.window')}
            </Typography.Text>
            <Select
              size="small"
              style={{ width: 96 }}
              value={windowDays}
              onChange={(v) => setWindowDays(v)}
              options={[7, 14, 30].map((d) => ({ value: d, label: t('ops:dataCleanup.windowDays', { days: d }) }))}
            />
            <Button size="small" onClick={() => void loadUnreg()}>
              {t('ops:dataCleanup.refresh')}
            </Button>
          </Space>
        }
      >
        {unregError ? (
          <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={t('ops:dataCleanup.unregisteredFailed', { message: unregError })} />
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('ops:dataCleanup.unregisteredHint', {
            from: unreg?.window_from ?? '-',
            data: unreg?.data_events ?? 0,
            meta: unreg?.registered_events ?? 0,
          })}
        </Typography.Text>
        <Table
          size="small"
          rowKey="event"
          style={{ marginTop: 8 }}
          dataSource={unreg?.unregistered ?? []}
          pagination={{ pageSize: 5 }}
          scroll={{ x: 760 }}
          columns={
            [
              { title: t('ops:dataCleanup.colEvent'), dataIndex: 'event', minWidth: 260, ellipsis: { showTitle: true } },
              { title: t('ops:dataCleanup.colRows'), dataIndex: 'rows', minWidth: 120, align: 'right' as const },
              {
                title: t('ops:dataCleanup.colRange'),
                key: 'range',
                minWidth: 210,
                render: (_: unknown, r: UnregisteredRow) => `${r.min_date} ~ ${r.max_date}`,
              },
              {
                title: t('ops:dataCleanup.colFuture'),
                dataIndex: 'has_future',
                key: 'has_future',
                minWidth: 120,
                render: (v: boolean) => (v ? <Tag color="orange">{t('ops:dataCleanup.futureYes')}</Tag> : '-'),
              },
              {
                title: t('ops:dataCleanup.colAction'),
                key: 'action',
                minWidth: 170,
                render: (_: unknown, r: UnregisteredRow) => (
                  <Button
                    size="small"
                    onClick={() => {
                      setKind(r.has_future ? 'future' : 'event');
                      setTable('clklog_sa.sa_events');
                      setEvent(r.event);
                      setPreview(null);
                      setResult(null);
                    }}
                  >
                    {r.has_future ? t('ops:dataCleanup.useFuture') : t('ops:dataCleanup.useEvent')}
                  </Button>
                ),
              },
            ] as ColumnsType<UnregisteredRow>
          }
        />
        {(unreg?.ghost_registered.length ?? 0) > 0 ? (
          <Alert
            style={{ marginTop: 8 }}
            type="info"
            showIcon
            message={t('ops:dataCleanup.ghostTitle', { count: unreg?.ghost_registered.length ?? 0 })}
            description={unreg?.ghost_registered.join('、')}
          />
        ) : null}
      </Card>

      <Card size="small" title={t('ops:dataCleanup.deleteTitle')}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('ops:dataCleanup.deleteHint')}
        </Typography.Text>
        <Space wrap style={{ marginTop: 8 }}>
          <Select
            style={{ minWidth: 150 }}
            value={kind}
            onChange={(v) => {
              setKind(v);
              setPreview(null);
            }}
            options={allowedKinds.map((k) => ({ value: k, label: t(`ops:dataCleanup.kind.${k}`) }))}
          />
          <Select
            style={{ minWidth: 250 }}
            value={table}
            onChange={(v) => {
              setTable(v);
              setKind('project');
              setPreview(null);
            }}
            options={DELETE_TABLES.map((x) => ({ value: x.value, label: x.value }))}
          />
          {kind === 'event' ? (
            <Input
              style={{ width: 240 }}
              placeholder={t('ops:dataCleanup.eventPlaceholder')}
              value={event}
              onChange={(e) => setEvent(e.target.value)}
            />
          ) : null}
          {kind === 'before' ? (
            <Input
              style={{ width: 190 }}
              placeholder={t('ops:dataCleanup.beforePlaceholder')}
              value={before}
              onChange={(e) => setBefore(e.target.value)}
            />
          ) : null}
          <Button type="primary" loading={busy} disabled={kind === 'event' && !event} onClick={() => void runPreview()}>
            {t('ops:dataCleanup.preview')}
          </Button>
        </Space>

        {error ? <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} /> : null}

        {preview ? (
          <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size="small">
            <Alert
              type={!preview.preflight.ok ? 'error' : preview.rows > 0 ? 'warning' : 'info'}
              showIcon
              message={t('ops:dataCleanup.previewResult', {
                rows: preview.rows,
                from: preview.min_date ?? '-',
                to: preview.max_date ?? '-',
              })}
              description={
                preview.preflight.ok
                  ? t('ops:dataCleanup.backupHint', { backup: preview.backup_table })
                  : t('ops:dataCleanup.preflightBlocked', {
                      reason: t(`ops:dataMgmt.preflight.reason.${PREFLIGHT_KEY[preview.preflight.reason]}`),
                    })
              }
            />
            {!preview.cleanup_enabled ? <Alert type="error" showIcon message={t('ops:dataCleanup.cleanupMissing')} /> : null}
            {preview.max_rows_exceeded ? (
              <Alert type="warning" showIcon message={t('ops:dataCleanup.rowsExceeded', { max: preview.max_rows })} />
            ) : null}
            <Space wrap>
              <Input
                style={{ width: 320 }}
                placeholder={t('ops:dataCleanup.confirmPlaceholder', { table })}
                value={confirmTable}
                onChange={(e) => setConfirmTable(e.target.value)}
              />
              <Button
                danger
                type="primary"
                loading={busy}
                disabled={
                  !preview.cleanup_enabled ||
                  !preview.confirm_token ||
                  preview.rows === 0 ||
                  preview.max_rows_exceeded ||
                  confirmTable !== table
                }
                onClick={() => void runExecute()}
              >
                {t('ops:dataCleanup.execute', { rows: preview.rows })}
              </Button>
            </Space>
          </Space>
        ) : null}

        {result ? (
          <Alert
            style={{ marginTop: 12 }}
            type="success"
            showIcon
            message={t('ops:dataCleanup.done', { rows: result.rows_planned })}
            description={t('ops:dataCleanup.doneDetail', {
              backup: result.backup_table ?? '-',
              mutation: result.mutation_id ?? '-',
            })}
          />
        ) : null}
      </Card>
    </Space>
  );
}
