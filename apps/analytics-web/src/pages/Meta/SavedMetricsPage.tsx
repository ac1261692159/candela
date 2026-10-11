import { useEffect, useState } from 'react';
import { Button, Card, Space, Table, Tag, Typography } from 'antd';
import { EntityIcon } from '../../components/EntityIcon';
import { getSavedMetrics } from '../../services/meta.service';
import type { SavedMetric } from '../../types/meta.types';
import { MetricDetailDrawer } from '../../features/metrics/MetricDetailDrawer';
import { CreateEventMetricModal } from '../../features/metrics/CreateEventMetricModal';
import { shortSummary, windowPickSummary } from '../../features/metrics/metric-definition';
import { useT } from '../../i18n';

export function SavedMetricsPage() {
  const { t } = useT('metrics');
  const [items, setItems] = useState<SavedMetric[]>([]);
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState<SavedMetric | null>(null);
  const [creating, setCreating] = useState(false);

  const kindLabel = (kind: string): string =>
    kind === 'event'
      ? t('metrics:list.kindEvent')
      : kind === 'retention'
        ? t('metrics:list.kindRetention')
        : kind;

  const load = async () => {
    setLoading(true);
    try {
      const res = await getSavedMetrics();
      setItems(res.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <Card
      title={t('metrics:list.title')}
      extra={
        <Button type="primary" onClick={() => setCreating(true)}>
          {t('metrics:list.create')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">{t('metrics:list.intro')}</Typography.Paragraph>
      <Table
        rowKey="metric_id"
        loading={loading}
        dataSource={items}
        pagination={false}
        scroll={{ x: 900 }}
        columns={[
          {
            title: t('metrics:list.column.displayName'),
            dataIndex: 'display_name',
            minWidth: 240,
            render: (v: string, row: SavedMetric) => (
              <Space direction="vertical" size={0}>
                <Space size={6}>
                  <EntityIcon type="metric" />
                  <Typography.Link onClick={() => setOpened(row)}>{v}</Typography.Link>
                </Space>
                {windowPickSummary(row.kind, row.definition_json, t) ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {windowPickSummary(row.kind, row.definition_json, t)}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
          {
            title: t('metrics:list.column.name'),
            dataIndex: 'name',
            minWidth: 200,
            render: (v: string) => <Typography.Text ellipsis={{ tooltip: v }}>{v}</Typography.Text>,
          },
          {
            title: t('metrics:list.column.kind'),
            dataIndex: 'kind',
            minWidth: 130,
            render: (kind: string) => <Tag>{kindLabel(kind)}</Tag>,
          },
          {
            title: t('metrics:list.column.definition'),
            key: 'definition',
            minWidth: 300,
            render: (_: unknown, row: SavedMetric) => (
              <Typography.Text
                type="secondary"
                ellipsis={{ tooltip: shortSummary(row.kind, row.definition_json, t) }}
              >
                {shortSummary(row.kind, row.definition_json, t)}
              </Typography.Text>
            ),
          },
          { title: t('metrics:list.column.remark'), dataIndex: 'remark', minWidth: 200, ellipsis: { showTitle: true } },
        ]}
      />
      <CreateEventMetricModal open={creating} onClose={() => setCreating(false)} onCreated={load} />
      <MetricDetailDrawer
        metric={opened}
        onClose={() => setOpened(null)}
        onSaved={() => void load()}
        onDeleted={() => {
          setOpened(null);
          void load();
        }}
      />
    </Card>
  );
}
