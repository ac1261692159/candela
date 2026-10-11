import { useEffect, useState } from 'react';
import { formatDateTimeFixed } from '../../i18n/format';
import { Button, Card, InputNumber, Space, Table, Tag, Typography, message } from 'antd';
import { useT } from '../../i18n';
import {
  getAlertRetention,
  saveAlertRetention,
  type RetentionItem,
  type RetentionScope,
} from './alerting-api';

/**
 * 数据保留策略（phase: clklog-analytics-alert-channels-v1）。
 *
 * 三个范围可**分别**设置：告警历史、通知记录默认 1 年，变更记录默认永久。
 * 留空 = 永久保留；清理由服务端按策略定期执行（每 6 小时检查一次，批删并写审计）。
 */
export function RetentionPanel() {
  const { t } = useT('alerting');
  const [items, setItems] = useState<RetentionItem[]>([]);
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    const res = await getAlertRetention();
    setItems(res.items ?? []);
    setDraft(Object.fromEntries((res.items ?? []).map((item) => [item.scope, item.retain_days])));
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (scope: RetentionScope) => {
    setSaving(scope);
    try {
      await saveAlertRetention(scope, draft[scope] ?? null);
      message.success(t('alerting:retention.saved'));
      await load();
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card size="small" title={t('alerting:retention.title')} style={{ marginBottom: 12 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('alerting:retention.hint')}
      </Typography.Paragraph>
      <Table
        rowKey="scope"
        size="small"
        pagination={false}
        dataSource={items}
        columns={[
          {
            title: t('alerting:retention.scope'),
            key: 'label',
            minWidth: 170,
            // 服务端优先下发 label_key；无 key（旧接口）回退中文 label
            render: (_: unknown, row: RetentionItem) => (row.label_key ? t(row.label_key) : row.label),
          },
          {
            title: t('alerting:retention.days'),
            key: 'days',
            minWidth: 240,
            render: (_: unknown, row: RetentionItem) => (
              <InputNumber
                min={1}
                max={3650}
                style={{ width: 160 }}
                placeholder={t('alerting:retention.keepForever')}
                value={draft[row.scope] ?? null}
                onChange={(value) => setDraft((prev) => ({ ...prev, [row.scope]: value ?? null }))}
              />
            ),
          },
          {
            title: t('alerting:retention.current'),
            key: 'current',
            minWidth: 170,
            render: (_: unknown, row: RetentionItem) =>
              row.retain_days === null ? (
                <Tag color="purple">{t('alerting:retention.forever')}</Tag>
              ) : (
                <Tag>{t('alerting:retention.daysValue', { days: row.retain_days })}</Tag>
              ),
          },
          {
            title: t('common:label.actions'),
            key: 'ops',
            render: (_: unknown, row: RetentionItem) => (
              <Space wrap>
                <Button size="small" type="primary" loading={saving === row.scope} onClick={() => void save(row.scope)}>
                  {t('common:action.save')}
                </Button>
                {row.updated_by ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.updated_by} · {formatDateTimeFixed(row.updated_at ?? undefined)}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
