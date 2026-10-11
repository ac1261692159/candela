import { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Table, Typography, message } from 'antd';
import { createResultCohort, previewResultUsers } from '../../services/cohort.service';
import { useT } from '../../i18n';
import { stampNames } from './cohort-condition';

export type ResultCohortSource = 'event' | 'funnel' | 'retention';

interface Props {
  open: boolean;
  source: ResultCohortSource;
  dsl: Record<string, unknown> | null;
  cell: Record<string, unknown>;
  onClose: () => void;
}

export function ResultCohortModal({ open, source, dsl, cell, onClose }: Props) {
  const { t } = useT('cohort');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<{ uid: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    if (!open || !dsl) return;
    setLoading(true);
    previewResultUsers({ source, dsl, cell, limit: 1000 })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => {
        setItems([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [open, source, dsl, cell]);

  useEffect(() => {
    if (!saveOpen) return;
    const names = stampNames(t);
    form.setFieldsValue({ ...names, remark: '' });
  }, [form, saveOpen, t]);

  const handleSave = async () => {
    if (!dsl) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      await createResultCohort({
        name: values.name,
        display_name: values.display_name,
        remark: values.remark,
        source,
        dsl,
        cell,
      });
      message.success(t('cohort:resultModal.saved'));
      setSaveOpen(false);
      onClose();
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        title={t('cohort:resultModal.usersTitle')}
        open={open}
        onCancel={onClose}
        footer={[
          <Button key="save" type="primary" disabled={!dsl || items.length === 0} onClick={() => setSaveOpen(true)}>
            {t('cohort:resultModal.saveAsCohort')}
          </Button>,
          <Button key="close" onClick={onClose}>
            {t('common:action.close')}
          </Button>,
        ]}
        width={560}
      >
        <Typography.Paragraph type="secondary">
          {t('cohort:resultModal.hint')}
        </Typography.Paragraph>
        <Table
          size="small"
          rowKey="uid"
          loading={loading}
          dataSource={items}
          pagination={{ pageSize: 20, showTotal: () => t('cohort:resultModal.pageTotal', { shown: items.length, total }) }}
          columns={[{ title: t('cohort:label.userId'), dataIndex: 'uid', width: 280, ellipsis: true }]}
          scroll={{ x: 320 }}
        />
      </Modal>
      <Modal
        title={t('cohort:resultModal.saveTitle')}
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText={t('common:action.save')}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="display_name" label={t('cohort:label.displayName')} rules={[{ required: true, message: t('cohort:rule.requiredDisplayName') }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('cohort:label.cohortName')}
            rules={[
              { required: true, message: t('cohort:rule.requiredCohortName') },
              { pattern: /^[a-z][a-z0-9_]{0,79}$/, message: t('cohort:rule.cohortNamePattern') },
            ]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="remark" label={t('common:label.remark')}>
            <Input.TextArea maxLength={200} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
