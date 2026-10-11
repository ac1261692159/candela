import { useEffect, useState } from 'react';
import { Button, Drawer, Form, Input, Popconfirm, Select, Switch, Typography, message } from 'antd';
import { deleteDashboard } from '../../services/report.service';
import { getFolders, type FolderNode } from '../../services/iam.service';
import { type TFunction, useT } from '../../i18n';
import type { DashboardDetail } from '../../types/report.types';

const UNCATEGORIZED = '__uncategorized__';

const refreshOptions = (t: TFunction) => [
  { value: 0, label: t('report:dashboard.refreshOff') },
  { value: 30, label: t('report:dashboard.intervalSeconds', { count: 30 }) },
  { value: 60, label: t('report:dashboard.intervalMinutes', { count: 1 }) },
  { value: 300, label: t('report:dashboard.intervalMinutes', { count: 5 }) },
  { value: 900, label: t('report:dashboard.intervalMinutes', { count: 15 }) },
];

const ttlOptions = (t: TFunction) => [
  { value: 30, label: t('report:dashboard.intervalSeconds', { count: 30 }) },
  { value: 60, label: t('report:dashboard.intervalMinutes', { count: 1 }) },
  { value: 300, label: t('report:dashboard.intervalMinutes', { count: 5 }) },
  { value: 900, label: t('report:dashboard.intervalMinutes', { count: 15 }) },
  { value: 3600, label: t('report:dashboard.intervalHours', { count: 1 }) },
];

const colOptions = (t: TFunction) => [
  { value: 12, label: t('report:dashboard.gridColumnOption', { count: 12 }) },
  { value: 16, label: t('report:dashboard.gridColumnOption', { count: 16 }) },
  { value: 24, label: t('report:dashboard.gridColumnDefault') },
];

interface DashboardSettingsDrawerProps {
  dashboard: DashboardDetail;
  open: boolean;
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    description: string | null;
    refresh_interval_sec: number;
    cache_ttl_sec: number;
    grid_columns: number;
    folder_id: string | null;
    show_card_type: boolean;
  }) => Promise<void>;
  onDeleted: () => void;
}

export function DashboardSettingsDrawer({
  dashboard,
  open,
  onClose,
  onSubmit,
  onDeleted,
}: DashboardSettingsDrawerProps) {
  const { t } = useT('report');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [folders, setFolders] = useState<FolderNode[]>([]);

  useEffect(() => {
    if (!open) return;
    getFolders()
      .then((tree) => {
        const flat = (tree.folders ?? []).flatMap((n) => [n, ...(n.children ?? [])]);
        setFolders(flat);
      })
      .catch(() => setFolders([]));
  }, [open]);

  return (
    <Drawer
      title={t('report:dashboard.settings')}
      open={open}
      onClose={onClose}
      width={400}
      destroyOnClose
      extra={
        <Button type="primary" loading={saving} onClick={() => void form.submit()}>
          {t('common:action.save')}
        </Button>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: dashboard.name,
          description: dashboard.description ?? '',
          refresh_interval_sec: dashboard.refresh_interval_sec ?? 0,
          cache_ttl_sec: dashboard.cache_ttl_sec ?? 300,
          grid_columns: dashboard.grid_columns ?? 24,
          folder_id: dashboard.folder_id || UNCATEGORIZED,
          show_card_type: dashboard.show_card_type ?? false,
        }}
        onFinish={async (values) => {
          setSaving(true);
          try {
            await onSubmit({
              ...values,
              description: values.description?.trim() || null,
              folder_id: values.folder_id === UNCATEGORIZED ? null : values.folder_id,
            });
            onClose();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Form.Item name="name" label={t('common:label.name')} rules={[{ required: true, message: t('report:dashboard.enterName') }]}>
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item
          name="description"
          label={t('report:label.descriptionOptional')}
          tooltip={t('report:dashboard.descriptionTooltip')}
        >
          <Input.TextArea
            placeholder={t('report:dashboard.descriptionPlaceholder')}
            maxLength={500}
            showCount
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
        </Form.Item>
        <Form.Item
          name="refresh_interval_sec"
          label={t('report:dashboard.autoRefresh')}
          extra={t('report:dashboard.autoRefreshHint')}
        >
          <Select options={refreshOptions(t)} />
        </Form.Item>
        <Form.Item
          name="cache_ttl_sec"
          label={t('report:dashboard.cacheTtl')}
          extra={t('report:dashboard.cacheTtlHint')}
        >
          <Select options={ttlOptions(t)} />
        </Form.Item>
        <Form.Item
          name="grid_columns"
          label={t('report:dashboard.gridColumns')}
          extra={t('report:dashboard.gridColumnsHint')}
        >
          <Select options={colOptions(t)} />
        </Form.Item>
        <Form.Item
          name="show_card_type"
          label={t('report:dashboard.showCardType')}
          extra={t('report:dashboard.showCardTypeHint')}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item name="folder_id" label={t('report:folder.field')}>
          <Select
            options={[
              { value: UNCATEGORIZED, label: t('report:folder.uncategorized') },
              ...folders.map((f) => ({
                value: f.folder_id,
                label: f.parent_id ? `${folders.find((p) => p.folder_id === f.parent_id)?.name ?? ''} / ${f.name}`.replace(/^ \/ /, '') : f.name,
              })),
            ]}
          />
        </Form.Item>
      </Form>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t('report:dashboard.dangerZone')}
      </Typography.Title>
      <Popconfirm
        title={t('report:dashboard.deleteConfirm', { name: dashboard.name })}
        description={t('report:dashboard.deleteConfirmBody')}
        okText={t('report:dashboard.delete')}
        cancelText={t('common:action.cancel')}
        okButtonProps={{ danger: true }}
        onConfirm={async () => {
          await deleteDashboard(dashboard.db_id);
          message.success(t('report:dashboard.deleted'));
          onDeleted();
        }}
      >
        <Button danger>{t('report:dashboard.deleteThis')}</Button>
      </Popconfirm>
    </Drawer>
  );
}
