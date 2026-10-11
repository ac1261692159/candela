import { Alert, Card, Descriptions, Empty, Space, Statistic, Table, Tag } from 'antd';
import { formatDateTime } from '../../i18n/format';
import { CheckCircleOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type {
  DiscoveryLog,
  ReconcileDailyItem,
  ReconcileEventItem,
  ReconcileReport,
  ReconcileSkippedRange,
} from '../../types/meta.types';

interface QualityReportProps {
  report: ReconcileReport | null;
  loading: boolean;
}

const eventSourceColor = (source: string) => (source === 'sa_events' ? 'blue' : 'green');

const changeTypeColor: Record<string, string> = {
  event_created: 'geekblue',
  property_created: 'blue',
  property_type_changed: 'orange',
  user_property_created: 'cyan',
  user_property_type_changed: 'gold',
  user_property_hidden: 'default',
  user_property_active: 'green',
};

/**
 * 变化类型 → i18n 键名白名单。
 *
 * 服务端下发的是稳定标识（`change_type`，7 种取值）；**未知取值显示原始标识**，
 * 不能直接拼键名——拼错时 i18next 会把整条键路径当文案渲染（生产踩过：
 * `quality.changeType.user_property_type_changed`）。
 */
const CHANGE_TYPE_KEY: Record<string, string> = {
  event_created: 'eventCreated',
  property_created: 'propertyCreated',
  property_type_changed: 'propertyTypeChanged',
  user_property_created: 'userPropertyCreated',
  user_property_type_changed: 'userPropertyTypeChanged',
  user_property_hidden: 'userPropertyHidden',
  user_property_active: 'userPropertyActive',
};

/** 变化内容（用户属性与事件属性分开表述，类型变更统一写成 A → B） */
function changeContent(record: DiscoveryLog, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (record.change_type.endsWith('_type_changed')) {
    return `${record.from_value ?? '-'} → ${record.to_value ?? '-'}`;
  }
  switch (record.change_type) {
    case 'event_created':
      return t('ops:quality.change.eventCreated');
    case 'property_created':
      return t('ops:quality.change.propertyCreated', { value: record.to_value });
    case 'user_property_created':
      return t('ops:quality.change.userPropertyCreated', { value: record.to_value });
    case 'user_property_hidden':
      return t('ops:quality.change.userPropertyHidden');
    case 'user_property_active':
      return t('ops:quality.change.userPropertyActive');
    default:
      return record.change_type;
  }
}

export function QualityReport({ report, loading }: QualityReportProps) {
  const { t } = useT('ops');
  if (loading && !report) {
    return <Card loading />;
  }
  if (!report) {
    return (
      <Card>
        <Empty description={t('ops:quality.reportEmpty')} />
      </Card>
    );
  }

  const { summary, daily, crc, events, range, threshold_pct, discovery_logs, skipped } = report;
  const hasAlert = summary.has_alert;
  const skippedDays = summary.skipped_days ?? daily.items.filter((i) => i.status === 'skipped').length;
  const outOfRetentionDays = daily.items.filter((i) => i.status === 'out_of_retention').length;
  // 全部日期都没参与比对（超保留期/已清理）时不能显示绿色「一致性正常」——那会让人误读成「比对通过」
  // 复用既有文案键（不做新键）：标题用「超保留期不比对」，描述用「超保留期天数」统计
  const comparedDays = daily.items.length - skippedDays - outOfRetentionDays;
  const nothingCompared = !hasAlert && daily.items.length > 0 && comparedDays === 0;

  const dailyColumns = [
    {
      title: t('ops:quality.column.date'),
      dataIndex: 'date',
      key: 'date',
      minWidth: 130,
    },
    {
      title: t('ops:quality.column.saRows'),
      dataIndex: 'sa_cnt',
      key: 'sa_cnt',
      minWidth: 150,
      align: 'right' as const,
    },
    {
      title: t('ops:quality.column.crcUniq'),
      dataIndex: 'sa_uniq',
      key: 'sa_uniq',
      minWidth: 140,
      align: 'right' as const,
    },
    {
      title: t('ops:quality.column.rawRows'),
      dataIndex: 'raw_cnt',
      key: 'raw_cnt',
      minWidth: 170,
      align: 'right' as const,
    },
    {
      title: t('ops:quality.column.deviation'),
      dataIndex: 'deviation_pct',
      key: 'deviation_pct',
      minWidth: 110,
      align: 'right' as const,
      render: (v: number, record: ReconcileDailyItem) =>
        record.status === 'skipped' ? (
          <Tag>{t('ops:quality.skippedReason.cleaned')}</Tag>
        ) : record.status === 'out_of_retention' ? (
          <Tag color="default">{t('ops:quality.outOfRetentionShort')}</Tag>
        ) : (
          <Tag color={record.status === 'ALERT' ? 'red' : 'green'}>{v}%</Tag>
        ),
    },
    {
      title: t('common:label.status'),
      dataIndex: 'status',
      key: 'status',
      minWidth: 110,
      render: (v: string) =>
        v === 'ALERT' ? (
          <Tag color="red">{t('ops:quality.abnormal')}</Tag>
        ) : v === 'skipped' ? (
          <Tag color="orange">{t('ops:quality.skipped')}</Tag>
        ) : v === 'out_of_retention' ? (
          <Tag color="default">{t('ops:quality.outOfRetention')}</Tag>
        ) : (
          <Tag color="green">{t('ops:quality.normal')}</Tag>
        ),
    },
  ];

  const diffColumns = [
    {
      title: t('meta:label.event'),
      dataIndex: 'event',
      key: 'event',
      minWidth: 240,
      ellipsis: { showTitle: true },
    },
    {
      title: t('ops:quality.column.saRows'),
      dataIndex: 'sa_cnt',
      key: 'sa_cnt',
      minWidth: 150,
      align: 'right' as const,
    },
    {
      title: t('ops:quality.column.rawRows'),
      dataIndex: 'raw_cnt',
      key: 'raw_cnt',
      minWidth: 170,
      align: 'right' as const,
    },
    {
      title: t('ops:quality.column.diff'),
      dataIndex: 'diff',
      key: 'diff',
      minWidth: 130,
      align: 'right' as const,
      render: (v: number) => <span style={{ color: v > 0 ? '#cf1322' : undefined }}>{v > 0 ? `+${v}` : v}</span>,
    },
    {
      title: t('ops:quality.column.deviation'),
      dataIndex: 'deviation_pct',
      key: 'deviation_pct',
      minWidth: 110,
      align: 'right' as const,
      render: (v: number) => `${v}%`,
    },
  ];

  const onlyInOneColumns = [
    {
      title: t('meta:label.event'),
      dataIndex: 'event',
      key: 'event',
      minWidth: 240,
      ellipsis: { showTitle: true },
    },
    {
      title: t('ops:quality.column.source'),
      dataIndex: 'side',
      key: 'side',
      minWidth: 140,
      render: (v: string) => <Tag color={eventSourceColor(v)}>{v}</Tag>,
    },
    {
      title: t('ops:quality.column.rows'),
      dataIndex: 'cnt',
      key: 'cnt',
      minWidth: 130,
      align: 'right' as const,
    },
  ];

  const eventColumns = [
    {
      title: t('ops:quality.column.source'),
      key: 'source',
      minWidth: 140,
      render: (_: unknown, record: ReconcileEventItem & { source: string }) => (
        <Tag color={eventSourceColor(record.source)}>{record.source}</Tag>
      ),
    },
    {
      title: t('meta:label.event'),
      dataIndex: 'event',
      key: 'event',
      minWidth: 240,
      ellipsis: { showTitle: true },
    },
    {
      title: t('ops:quality.column.rows'),
      dataIndex: 'cnt',
      key: 'cnt',
      minWidth: 130,
      align: 'right' as const,
    },
  ];

  const logColumns = [
    {
      title: t('ops:quality.column.changeType'),
      dataIndex: 'change_type',
      key: 'change_type',
      minWidth: 150,
      render: (_: unknown, record: DiscoveryLog) => {
        const key = CHANGE_TYPE_KEY[record.change_type];
        return (
          <Tag color={changeTypeColor[record.change_type] || 'default'}>
            {key ? t(`ops:quality.changeType.${key}`) : record.change_type}
          </Tag>
        );
      },
    },
    {
      title: t('meta:label.event'),
      dataIndex: 'event',
      key: 'event',
      minWidth: 180,
      ellipsis: { showTitle: true },
    },
    {
      title: t('ops:quality.column.prop'),
      dataIndex: 'prop',
      key: 'prop',
      minWidth: 180,
      ellipsis: { showTitle: true },
      render: (v: string | null) => v ?? '-',
    },
    {
      title: t('ops:quality.column.change'),
      key: 'change',
      minWidth: 260,
      ellipsis: { showTitle: true },
      render: (_: unknown, record: DiscoveryLog) => changeContent(record, t),
    },
    {
      title: t('ops:quality.column.discoveredAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      minWidth: 180,
      render: (v: string) => formatDateTime(v),
    },
  ];

  const sideRows = [
    ...(events.sa_events ?? []).map((e) => ({ ...e, source: 'sa_events' })),
    ...(events.log_analysis ?? []).map((e) => ({ ...e, source: 'log_analysis' })),
  ];

  const skippedColumns = [
    {
      title: t('ops:quality.column.skippedRange'),
      key: 'range',
      minWidth: 240,
      render: (_: unknown, record: ReconcileSkippedRange) => `${record.from} ~ ${record.to}`,
    },
    {
      title: t('ops:quality.column.skippedWhy'),
      key: 'reason',
      minWidth: 200,
      render: (_: unknown, record: ReconcileSkippedRange) => t(`ops:quality.skippedReason.${record.reason}`),
    },
    {
      title: t('ops:quality.column.skippedSource'),
      dataIndex: 'source',
      key: 'source',
      minWidth: 260,
      ellipsis: { showTitle: true },
    },
  ];

  return (
    <Card>
      {nothingCompared ? (
        <Alert
          type="info"
          showIcon
          message={t('ops:quality.outOfRetention')}
          description={`${t('ops:quality.stat.outOfRetention')}: ${outOfRetentionDays}${skippedDays ? ` / ${t('ops:quality.stat.skippedDays')}: ${skippedDays}` : ''}`}
        />
      ) : hasAlert ? (
        <Alert
          type="warning"
          showIcon
          message={t('ops:quality.alert.title')}
          description={t('ops:quality.alert.desc', {
            days: summary.alert_days,
            total: summary.total_days,
            threshold: threshold_pct,
            dup: summary.dup_crc_rows,
          })}
        />
      ) : (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message={t('ops:quality.ok.title')}
          description={t('ops:quality.ok.desc', {
            from: range.from,
            to: range.to,
            threshold: threshold_pct,
          })}
        />
      )}

      <Space size="large" wrap style={{ margin: '16px 0' }}>
        <Statistic
          title={t('ops:quality.stat.days')}
          value={summary.total_days}
          suffix={t('ops:quality.stat.daysSuffix', { count: summary.alert_days })}
          valueStyle={{ color: summary.alert_days > 0 ? '#cf1322' : undefined }}
        />
        {skippedDays > 0 ? (
          <Statistic title={t('ops:quality.stat.skippedDays')} value={skippedDays} />
        ) : null}
        {outOfRetentionDays > 0 ? (
          <Statistic title={t('ops:quality.stat.outOfRetention')} value={outOfRetentionDays} />
        ) : null}
        <Statistic
          title={t('ops:quality.stat.dupCrc')}
          value={summary.dup_crc_rows}
          suffix={t('ops:quality.stat.rowsSuffix')}
          valueStyle={{ color: summary.dup_crc_rows > 0 ? '#cf1322' : undefined }}
        />
        <Statistic
          title={t('ops:quality.stat.crcUnique')}
          value={
            crc.skipped
              ? t('ops:quality.skipped')
              : crc.pass
                ? t('ops:quality.pass')
                : t('ops:quality.abnormal')
          }
          valueStyle={{ color: crc.skipped ? undefined : crc.pass ? '#3f8600' : '#cf1322' }}
        />
      </Space>

      <Descriptions column={3} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('ops:quality.scope.range')}>{`${range.from} ~ ${range.to}`}</Descriptions.Item>
        <Descriptions.Item label={t('ops:quality.scope.threshold')}>{`${threshold_pct}%`}</Descriptions.Item>
        <Descriptions.Item label={t('ops:quality.scope.total')}>
          {daily.items.reduce((s, i) => s + i.sa_cnt, 0).toLocaleString()}
        </Descriptions.Item>
        {report.trigger ? (
          <Descriptions.Item label={t('ops:quality.scope.trigger')}>
            {t(`ops:quality.trigger.${report.trigger}`)}
          </Descriptions.Item>
        ) : null}
        {summary.ignored_events ? (
          <Descriptions.Item label={t('ops:quality.scope.ignored')}>{summary.ignored_events}</Descriptions.Item>
        ) : null}
      </Descriptions>

      <Space direction="vertical" style={{ width: '100%' }}>
        <Table
          rowKey="date"
          size="small"
          title={() => <b>{t('ops:quality.table.daily')}</b>}
          loading={loading}
          dataSource={daily.items}
          columns={dailyColumns}
          pagination={false}
          scroll={{ x: 820 }}
        />
        <Table
          rowKey="event"
          size="small"
          title={() => (
            <span>
              <b>{t('ops:quality.table.diffs')}</b>
              <span style={{ fontWeight: 'normal', marginLeft: 8, color: '#888' }}>
                {t('ops:quality.table.diffsHint', { count: events.diff_total })}
              </span>
            </span>
          )}
          loading={loading}
          dataSource={events.diffs}
          columns={diffColumns}
          pagination={false}
          scroll={{ x: 720 }}
        />
        {events.only_in_one.length > 0 ? (
          <Table
            rowKey="event"
            size="small"
            title={() => <b>{t('ops:quality.table.onlyInOne')}</b>}
            loading={loading}
            dataSource={events.only_in_one}
            columns={onlyInOneColumns}
            pagination={false}
            scroll={{ x: 620 }}
          />
        ) : null}
        {events.ignored_events.length > 0 ? (
          <Alert
            type="info"
            showIcon
            message={t('ops:quality.ignored.title', { count: events.ignored_events.length })}
            description={events.ignored_events.join('、')}
          />
        ) : null}
        {skipped.length > 0 ? (
          <Table
            rowKey={(r: ReconcileSkippedRange) => r.from}
            size="small"
            title={() => <b>{t('ops:quality.table.skipped')}</b>}
            loading={loading}
            dataSource={skipped}
            columns={skippedColumns}
            pagination={false}
            scroll={{ x: 700 }}
          />
        ) : null}
        {sideRows.length > 0 ? (
          <Table
            rowKey="event"
            size="small"
            title={() => <b>{t('ops:quality.table.events')}</b>}
            loading={loading}
            dataSource={sideRows}
            columns={eventColumns}
            pagination={false}
            scroll={{ x: 520 }}
          />
        ) : null}
        <Table
          rowKey="id"
          size="small"
          title={() => (
            <span>
              <b>{t('ops:quality.table.discovery')}</b>
              <span style={{ fontWeight: 'normal', marginLeft: 8, color: '#888' }}>
                {t('ops:quality.table.discoveryHint', { count: discovery_logs.length })}
              </span>
            </span>
          )}
          loading={loading}
          dataSource={discovery_logs}
          columns={logColumns}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 960 }}
        />
      </Space>
    </Card>
  );
}
