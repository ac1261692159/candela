import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import { useT } from '../../i18n';
import {
  getRetentionOverview,
  saveRetentionPolicy,
  type RetentionOverviewView,
  type RetentionRowView,
} from '../../services/ops.service';

/** 状态标签：ok / unset（未设置 = 风险）/ deviates（偏离策略）/ disabled（策略停用） */
const STATUS_COLOR: Record<RetentionRowView['status'], string> = {
  ok: 'green',
  unset: 'red',
  deviates: 'orange',
  disabled: 'default',
};

const STATUS_KEY: Record<RetentionRowView['status'], string> = {
  ok: 'ok',
  unset: 'unset',
  deviates: 'deviates',
  disabled: 'disabled',
};

/**
 * 保留策略总览（phase: clklog-data-quality-ops-v1，R2-1 / AC-6）。
 *
 * 预期保留（登记策略，缺省用建议值） × 实际保留（表上 TTL） × 状态 × 对拍可信区间。
 * 社区版表未设置 TTL 会被标红——这是当前最大的存储风险（raw 侧无保留期）。
 */
export function RetentionCard() {
  const { t } = useT('ops');
  const [view, setView] = useState<RetentionOverviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RetentionRowView | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(await getRetentionOverview());
    } catch {
      // 错误提示由 api 拦截器统一处理
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (editing) {
      form.setFieldsValue({
        keep_days: editing.expected_days,
        enabled: editing.enabled,
        remark: editing.remark ?? '',
      });
    }
  }, [editing, form]);

  const submit = async () => {
    const values = await form.validateFields();
    if (!editing) return;
    const [db, table] = editing.table.split('.');
    setSaving(true);
    try {
      await saveRetentionPolicy(db, table, {
        keep_days: Number(values.keep_days),
        mode: editing.mode,
        enabled: Boolean(values.enabled),
        remark: values.remark ? String(values.remark) : null,
      });
      setEditing(null);
      await load();
    } catch {
      // 错误提示由 api 拦截器统一处理
    } finally {
      setSaving(false);
    }
  };

  const trusted = view?.trusted_range;

  return (
    <Card title={t('ops:retention.title')} size="small" loading={loading}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('ops:retention.hint')}
        </Typography.Text>

        {trusted ? (
          <Alert
            type={trusted.retention_days === null ? 'warning' : 'info'}
            showIcon
            message={
              trusted.retention_days === null
                ? t('ops:retention.trustedUnbounded')
                : t('ops:retention.trusted', {
                    from: trusted.from ?? '-',
                    to: trusted.to,
                    days: trusted.retention_days,
                  })
            }
            description={
              trusted.bound_by
                ? t('ops:retention.trustedBoundBy', {
                    table: trusted.bound_by,
                    days: trusted.retention_days ?? 0,
                  })
                : undefined
            }
          />
        ) : null}

        {view && view.summary.suspicious_partitions.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t('ops:retention.suspicious', { count: view.summary.suspicious_partitions.length })}
            description={view.summary.suspicious_partitions
              .slice(0, 6)
              .map((p) => `${p.table} ${p.partition} ${t(`ops:retention.suspiciousKind.${p.kind}`)}`)
              .join('、')}
          />
        ) : null}

        <Table
          size="small"
          rowKey="table"
          dataSource={view?.rows ?? []}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: t('ops:retention.column.table'), dataIndex: 'table', minWidth: 220, ellipsis: { showTitle: true } },
            {
              title: t('ops:retention.column.expected'),
              dataIndex: 'expected_days',
              minWidth: 150,
              render: (v: number, record: RetentionRowView) => (
                <span>
                  {t('ops:dataMgmt.ttlDays', { days: v })}
                  {record.registered ? null : (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                      {t('ops:retention.suggested')}
                    </Typography.Text>
                  )}
                </span>
              ),
            },
            {
              title: t('ops:retention.column.actual'),
              dataIndex: 'actual_ttl_days',
              minWidth: 150,
              render: (v: number | null) =>
                v === null ? (
                  <Tag color="red">{t('ops:retention.actualUnset')}</Tag>
                ) : (
                  t('ops:dataMgmt.ttlDays', { days: v })
                ),
            },
            {
              title: t('ops:retention.column.status'),
              dataIndex: 'status',
              minWidth: 130,
              render: (v: RetentionRowView['status']) => (
                <Tag color={STATUS_COLOR[v]}>{t(`ops:retention.status.${STATUS_KEY[v]}`)}</Tag>
              ),
            },
            {
              title: t('common:label.actions'),
              key: 'action',
              minWidth: 120,
              render: (_: unknown, record: RetentionRowView) => (
                <Button size="small" onClick={() => setEditing(record)}>
                  {record.registered ? t('common:action.edit') : t('ops:retention.register')}
                </Button>
              ),
            },
          ]}
        />
      </Space>

      <Modal
        open={Boolean(editing)}
        title={t('ops:retention.dialogTitle', { table: editing?.table ?? '' })}
        onCancel={() => setEditing(null)}
        onOk={() => void submit()}
        confirmLoading={saving}
        okText={t('ops:retention.save')}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item
            name="keep_days"
            label={t('ops:retention.fieldKeepDays')}
            extra={t('ops:retention.fieldKeepDaysHint')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={3650} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="enabled" label={t('ops:retention.fieldEnabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="remark" label={t('ops:retention.fieldRemark')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
