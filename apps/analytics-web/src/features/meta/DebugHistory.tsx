import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, message, Modal, Popconfirm, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  debugArchiveSetting,
  debugRecordDelete,
  debugRecordDetail,
  debugRecords,
  setDebugArchiveSetting,
} from '../../services/meta.service';
import { formatDateTime } from '../../i18n/format';
import { useT } from '../../i18n';
import { useIamStore } from '../../stores/iam.store';
import { buildDebugColumns, errorCodeMessage, expandedProperties, statusTag, windowLabel } from './debug-columns';
import type { DebugJobStatus, DebugRecordDetail, DebugRecordSummary } from '../../types/meta.types';

/** 项目级留档开关的权限与项目时区设置一致（运维/超管） */
const SWITCH_PERMISSION = 'ops.owner.assign';
/** 有未完成任务时的列表轮询间隔（全部完成后停止轮询） */
const ACTIVE_POLL_MS = 5000;

/**
 * Debug 留档历史（phase: clklog-analytics-debug-query-v1 的 F1/F2）。
 * 每次查询成功留一条快照，永久保存、可按条删除（删除写审计）；
 * 「回看」看到的是当时的快照——sa_events 只有窗口内的数据，过了就查不回来了。
 */
/** 未完成任务时的列表轮询间隔可注入：生产用默认值，测试注入小间隔 */
export function DebugHistory({
  refreshToken,
  activePollMs = ACTIVE_POLL_MS,
}: { refreshToken?: number; activePollMs?: number } = {}) {
  const { t } = useT('meta');
  const canManageSwitch = useIamStore((s) => s.has(SWITCH_PERMISSION));
  const [items, setItems] = useState<DebugRecordSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<DebugRecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const pageSize = 10;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await debugRecords({ page, pageSize });
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch {
      // api 层已统一提示；这里保留旧数据，避免列表闪空
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // 有未完成任务（pending/running）时轻量轮询列表；全部完成即停（不做无谓轮询）
  const hasActiveJob = items.some((row) => row.status === 'pending' || row.status === 'running');
  useEffect(() => {
    if (!hasActiveJob) return;
    const id = window.setInterval(() => void load(), activePollMs);
    return () => window.clearInterval(id);
  }, [hasActiveJob, load, activePollMs]);

  useEffect(() => {
    debugArchiveSetting()
      .then((res) => setEnabled(res.enabled))
      .catch(() => setEnabled(null));
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await debugRecordDetail(id));
    } catch {
      // 提示已由 api 层给出
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await debugRecordDelete(id);
      message.success(t('meta:debug.deleteOk'));
      void load();
    },
    [load, t],
  );

  const toggle = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      try {
        const res = await setDebugArchiveSetting(next);
        setEnabled(res.enabled);
        message.success(next ? t('meta:debug.archiveSwitchOn') : t('meta:debug.archiveSwitchOff'));
      } catch {
        setEnabled(previous); // 失败回滚开关显示，避免「看着是关的、其实没关」
      }
    },
    [enabled, t],
  );

  const conditionText = useCallback(
    (row: DebugRecordSummary) => {
      const parts: string[] = [];
      if (row.cond_distinct_id) parts.push(`distinct_id=${row.cond_distinct_id}`);
      if (row.cond_user_key) parts.push(`user_key=${row.cond_user_key}`);
      if (row.cond_event) parts.push(`${t('meta:label.eventName')}=${row.cond_event}`);
      parts.push(windowLabel(t, row.window));
      return parts.join(' · ');
    },
    [t],
  );

  const columns: ColumnsType<DebugRecordSummary> = useMemo(
    () => [
      {
        title: t('meta:debug.column.archivedAt'),
        dataIndex: 'created_at',
        minWidth: 180,
        render: (v: string) => formatDateTime(v),
      },
      {
        title: t('meta:debug.column.condition'),
        key: 'condition',
        minWidth: 200,
        ellipsis: { showTitle: true },
        render: (_, row) => conditionText(row),
      },
      {
        title: t('meta:debug.column.status'),
        dataIndex: 'status',
        minWidth: 130,
        render: (v: DebugJobStatus | undefined, row) => statusTag(t, v ?? 'done', row.error_code),
      },
      {
        title: t('meta:debug.column.hitReturn'),
        key: 'count',
        minWidth: 190,
        render: (_, row) =>
          row.status === 'pending' || row.status === 'running' ? (
            <Typography.Text type="secondary">—</Typography.Text>
          ) : (
            <Space size={4}>
              <span>{t('meta:debug.hitTotal', { total: row.matched_total })}</span>
              {row.truncated ? <Tag color="warning">{t('meta:debug.column.truncatedTag')}</Tag> : null}
            </Space>
          ),
      },
      {
        title: t('meta:debug.column.operator'),
        dataIndex: 'created_by_name',
        minWidth: 150,
        ellipsis: { showTitle: true },
        render: (v: string | null, row) => v || row.created_by,
      },
      {
        title: t('meta:debug.column.actions'),
        key: 'actions',
        minWidth: 190,
        render: (_, row) => (
          <Space size={4} wrap>
            <Button type="link" size="small" onClick={() => void openDetail(row.id)}>
              {t('common:action.view')}
            </Button>
            <Popconfirm
              title={t('meta:debug.deleteConfirm')}
              okText={t('common:action.delete')}
              cancelText={t('common:action.cancel')}
              onConfirm={() => void remove(row.id)}
            >
              <Button type="link" size="small" danger>
                {t('common:action.delete')}
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [conditionText, openDetail, remove, t],
  );

  return (
    <Card
      title={t('meta:debug.historyTitle')}
      extra={
        canManageSwitch ? (
          <Space size={8} wrap>
            <Tooltip title={t('meta:debug.archiveSwitchHint')}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('meta:debug.archiveSwitch')}
              </Typography.Text>
            </Tooltip>
            <Switch checked={enabled ?? true} loading={enabled === null} onChange={(next) => void toggle(next)} />
          </Space>
        ) : null
      }
    >
      {enabled === false && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('meta:debug.archiveDisabled')} />
      )}
      <Table<DebugRecordSummary>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={items}
        columns={columns}
        scroll={{ x: 1060 }}
        locale={{ emptyText: t('meta:debug.historyEmpty') }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />
      <Modal
        open={detail !== null}
        title={t('meta:debug.detailTitle')}
        width={1100}
        footer={null}
        onCancel={() => setDetail(null)}
      >
        {detail && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {formatDateTime(detail.created_at)} · {detail.created_by_name || detail.created_by} ·{' '}
              {conditionText(detail)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t('meta:debug.hitTotal', { total: detail.matched_total })} ·{' '}
              {t('meta:debug.shownRecent', { shown: detail.row_count })}
            </Typography.Text>
            {detail.truncated && (
              <Alert type="warning" showIcon message={t('meta:debug.archiveTruncated')} />
            )}
            {(detail.status === 'failed' || detail.error_code) && (
              <Alert type="error" showIcon message={errorCodeMessage(t, detail.error_code)} />
            )}
            <Table
              size="small"
              rowKey="id"
              loading={detailLoading}
              dataSource={detail.rows}
              pagination={{ pageSize: 20 }}
              expandable={{ expandedRowRender: expandedProperties }}
              columns={buildDebugColumns(t)}
              scroll={{ x: 1080 }}
            />
          </Space>
        )}
      </Modal>
    </Card>
  );
}
