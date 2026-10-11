/**
 * Debug 页共用列定义与渲染（phase: clklog-analytics-debug-query-v1）。
 *
 * 查询结果表与留档详情表必须同口径——尤其是时间列：`log_time` 是「平台时区墙钟」串，
 * 必须按墙钟还原成真实时刻（补 'Z' 会当 UTC，生产实测偏 8 小时）。
 */
import { Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TFunction } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { parseWallClock } from '../time-range/resolve';
import type { DebugJobStatus, DebugRecord, DebugWindow } from '../../types/meta.types';

/** 后台任务的错误码 → 文案（字面量键写在 switch 里，i18n 键存在性检查才扫得到） */
export function errorCodeMessage(t: TFunction, code?: string | null): string {
  switch (code) {
    case 'timeout':
      return t('meta:debug.errorTimeout');
    default:
      return t('meta:debug.errorQueryFailed');
  }
}

/** 留档/任务状态标签：运行中 / 完成 / 失败（失败原因在 title 里，按语言渲染） */
export function statusTag(t: TFunction, status: DebugJobStatus, errorCode?: string | null) {
  switch (status) {
    case 'pending':
    case 'running':
      return <Tag color="processing">{t('meta:debug.statusRunning')}</Tag>;
    case 'failed':
      return (
        <Tag color="error" title={errorCodeMessage(t, errorCode)}>
          {t('meta:debug.statusFailed')}
        </Tag>
      );
    default:
      return <Tag color="success">{t('meta:debug.statusDone')}</Tag>;
  }
}

/** 窗口名文案：字面量键写在 switch 里，i18n 键存在性检查才扫得到 */
export function windowLabel(t: TFunction, window: DebugWindow): string {
  switch (window) {
    case '1h':
      return t('meta:debug.window1h');
    case '24h':
      return t('meta:debug.window24h');
    case '7d':
      return t('meta:debug.window7d');
  }
}

/** 平台时区墙钟串 → 真实时刻 → 按查看者显示时区渲染；解析不了就原样显示，不吞数据 */
export function renderLogTime(value: string): string {
  if (!value) return '-';
  const at = parseWallClock(value);
  return at ? formatDateTime(at) : value;
}

/** properties 预览：截断给个印象，完整内容在展开行里看 */
function propertiesPreview(value: string) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {value ? `${value.slice(0, 120)}…` : '-'}
    </Typography.Text>
  );
}

/** 展开行：properties 格式化为缩进 JSON（非 JSON 原样展示） */
export function expandedProperties(row: DebugRecord) {
  let pretty = row.properties;
  try {
    pretty = JSON.stringify(JSON.parse(row.properties), null, 2);
  } catch {
    // 非 JSON 原样展示
  }
  return (
    <pre style={{ fontSize: 12, background: '#f6f6f6', padding: 12, maxHeight: 400, overflow: 'auto' }}>{pretty}</pre>
  );
}

/** 原始事件行列定义（时间 / 事件 / distinct_id / user_key / properties） */
export function buildDebugColumns(t: TFunction): ColumnsType<DebugRecord> {
  return [
    {
      title: t('meta:debug.column.time'),
      dataIndex: 'log_time',
      minWidth: 180,
      render: (v: string) => renderLogTime(v),
    },
    { title: t('meta:label.event'), dataIndex: 'event', minWidth: 240, ellipsis: { showTitle: true } },
    { title: 'distinct_id', dataIndex: 'distinct_id', minWidth: 200, ellipsis: { showTitle: true } },
    { title: 'user_key', dataIndex: 'user_key', minWidth: 160, ellipsis: { showTitle: true }, render: (v: string) => v || '-' },
    {
      title: 'properties',
      dataIndex: 'properties',
      minWidth: 280,
      ellipsis: { showTitle: true },
      render: (v: string) => propertiesPreview(v),
    },
  ];
}
