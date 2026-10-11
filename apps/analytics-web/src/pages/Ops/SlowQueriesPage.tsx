import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import {
  Alert,
  Button,
  Card,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { getSlowQueries, type SlowQueryItem } from '../../services/ops.service';
import { useT, type TFunction } from '../../i18n';

/**
 * 运维 · 慢 SQL（phase: clklog-analytics-ops-console-v1）。
 *
 * 只读页面：不提供终止查询、清理等任何写操作（PRD AC11）。
 * 时间范围上限 72 小时——查询日志本身只保留约 3 天。
 */

/** 时间范围选项（文案随语言变化，故由组件内的 t 构造） */
const hourOptionsOf = (t: TFunction) => [
  { value: 1, label: t('ops:range.last1Hour') },
  { value: 6, label: t('ops:range.last6Hours') },
  { value: 24, label: t('ops:range.last24Hours') },
  { value: 72, label: t('ops:range.last3Days') },
];

/** 查询超时上限（与后端 maxExecutionTime 一致），超过说明查询是被杀掉的 */
const TIMEOUT_MS = 30_000;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString('zh-CN');
}

export function SlowQueriesPage() {
  const { t } = useT('ops');
  const [hours, setHours] = useState(24);
  const [minDurationMs, setMinDurationMs] = useState(5000);
  const [status, setStatus] = useState<'all' | 'success' | 'failed'>('all');
  const [items, setItems] = useState<SlowQueryItem[]>([]);
  const [note, setNote] = useState('');
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSlowQueries({ hours, min_duration_ms: minDurationMs, status, limit: 100 });
      setItems(res.items ?? []);
      setNote(
        res.retention_note_key
          ? t(res.retention_note_key, res.retention_note_params)
          : (res.retention_note ?? ''),
      );
      setGeneratedAt(res.generated_at ?? null);
      setFromCache(Boolean(res.from_cache));
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : t('common:message.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [hours, minDurationMs, status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo(
    () => [
      {
        title: t('ops:slowQuery.column.time'),
        dataIndex: 'event_time',
        key: 'event_time',
        minWidth: 170,
        render: (value: string) => <Typography.Text style={{ fontSize: 12 }}>{value}</Typography.Text>,
      },
      {
        title: t('ops:slowQuery.column.duration'),
        dataIndex: 'duration_ms',
        key: 'duration_ms',
        minWidth: 120,
        sorter: (a: SlowQueryItem, b: SlowQueryItem) => a.duration_ms - b.duration_ms,
        defaultSortOrder: 'descend' as const,
        render: (value: number) => (
          <Typography.Text type={value >= TIMEOUT_MS ? 'danger' : undefined} strong={value >= TIMEOUT_MS}>
            {value.toLocaleString('zh-CN')} ms
          </Typography.Text>
        ),
      },
      {
        title: t('common:label.status'),
        dataIndex: 'status',
        key: 'status',
        minWidth: 110,
        render: (value: SlowQueryItem['status']) =>
          value === 'failed' ? (
            <Tag color="red">{t('common:state.failed')}</Tag>
          ) : (
            <Tag color="green">{t('common:state.success')}</Tag>
          ),
      },
      {
        title: t('ops:slowQuery.column.readRows'),
        dataIndex: 'read_rows',
        key: 'read_rows',
        minWidth: 130,
        render: (value: number) => formatCount(value),
      },
      {
        title: t('ops:slowQuery.column.readBytes'),
        dataIndex: 'read_bytes',
        key: 'read_bytes',
        minWidth: 130,
        render: (value: number) => formatBytes(value),
      },
      {
        title: t('ops:slowQuery.column.memory'),
        dataIndex: 'memory_usage',
        key: 'memory_usage',
        minWidth: 130,
        render: (value: number) => formatBytes(value),
      },
      {
        title: t('ops:slowQuery.column.user'),
        dataIndex: 'user',
        key: 'user',
        minWidth: 140,
        ellipsis: { showTitle: true },
      },
      {
        title: 'SQL',
        dataIndex: 'query',
        key: 'query',
        minWidth: 480,
        render: (value: string, row: SlowQueryItem) => {
          const key = `${row.event_time}_${row.duration_ms}`;
          const isOpen = expanded === key;
          return (
            <div style={{ maxWidth: 620 }}>
              <Typography.Text
                style={{ fontSize: 12, whiteSpace: isOpen ? 'pre-wrap' : 'nowrap' }}
                ellipsis={isOpen ? false : { tooltip: value }}
              >
                {value}
              </Typography.Text>
              {value.length > 80 ? (
                <Button
                  type="link"
                  size="small"
                  style={{ padding: '0 4px' }}
                  aria-label={
                    isOpen ? t('ops:slowQuery.collapseSql') : t('ops:slowQuery.expandSql')
                  }
                  onClick={() => setExpanded(isOpen ? null : key)}
                >
                  {isOpen ? t('common:action.collapse') : t('common:action.expand')}
                </Button>
              ) : null}
              {row.exception ? (
                <div>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {row.exception}
                  </Typography.Text>
                </div>
              ) : null}
            </div>
          );
        },
      },
    ],
    [expanded, t],
  );

  return (
    <Card
      title={t('ops:slowQuery.title')}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          {t('common:action.refresh')}
        </Button>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          aria-label={t('common:label.timeRange')}
          value={hours}
          style={{ minWidth: 190 }}
          options={hourOptionsOf(t)}
          onChange={setHours}
        />
        <Space size={4}>
          <Typography.Text type="secondary">{t('ops:slowQuery.minDuration')}</Typography.Text>
          <InputNumber
            aria-label={t('ops:slowQuery.minDuration')}
            min={0}
            max={600000}
            step={1000}
            value={minDurationMs}
            style={{ width: 120 }}
            addonAfter="ms"
            onChange={(value) => setMinDurationMs(Number(value ?? 0))}
          />
        </Space>
        <Select
          aria-label={t('ops:slowQuery.status')}
          value={status}
          style={{ minWidth: 130 }}
          options={[
            { value: 'all', label: t('common:state.all') },
            { value: 'success', label: t('common:state.success') },
            { value: 'failed', label: t('common:state.failed') },
          ]}
          onChange={setStatus}
        />
      </Space>

      {note ? (
        <Alert
          type="info"
          showIcon
          message={note}
          description={
            generatedAt ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('ops:slowQuery.generatedAt', {
                  time: formatDateTime(generatedAt),
                })}
                {fromCache ? t('ops:slowQuery.fromCache') : ''}
              </Typography.Text>
            ) : undefined
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
      ) : null}

      <Table
        rowKey={(row) => `${row.event_time}_${row.duration_ms}_${row.user}`}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('ops:slowQuery.empty', { ms: minDurationMs }) }}
      />
    </Card>
  );
}
