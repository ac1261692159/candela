import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { EntityIcon } from '../../components/EntityIcon';
import {
  createSubject,
  deleteSubject,
  getSubjects,
  type AnalysisSubject,
} from '../../services/subject.service';
import { getAllEventAttributes, getUserProperties } from '../../services/meta.service';
import { useProjectStore } from '../../stores/project.store';
import { useT } from '../../i18n';
import { SELECT_POPUP } from '../../components/select-popup';

export function AnalysisSubjectsPage() {
  const { t } = useT('cohort');
  const project = useProjectStore((state) => state.currentProject);
  const [items, setItems] = useState<AnalysisSubject[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [eventProps, setEventProps] = useState<{ prop_key: string; display_name?: string }[]>([]);
  const [userProps, setUserProps] = useState<{ prop_key: string; display_name?: string }[]>([]);
  const scope = Form.useWatch('scope', form);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getSubjects();
      setItems(res.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    getAllEventAttributes()
      .then(setEventProps)
      .catch(() => setEventProps([]));
    getUserProperties()
      .then((res) => setUserProps(res.items))
      .catch(() => setUserProps([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const propOptions = useMemo(() => {
    const rows = scope === 'user' ? userProps : eventProps;
    return rows.map((item) => ({
      label: item.display_name ? `${item.display_name} (${item.prop_key})` : item.prop_key,
      value: item.prop_key,
    }));
  }, [scope, eventProps, userProps]);

  const handleCreate = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await createSubject({
        name: values.name,
        display_name: values.display_name,
        source: { scope: values.scope, prop: values.prop },
      });
      message.success(t('cohort:subjectPage.created'));
      setOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (row: AnalysisSubject) => {
    Modal.confirm({
      title: t('cohort:subjectPage.deleteTitle'),
      content: t('cohort:subjectPage.deleteContent', { name: row.display_name }),
      okText: t('common:action.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteSubject(row.subject_id);
          message.success(t('cohort:message.deleted'));
          await load();
        } catch (err) {
          if (err instanceof Error && err.message) message.error(err.message);
        }
      },
    });
  };

  return (
    <Card
      title={t('cohort:subjectPage.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t('cohort:subjectPage.create')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        {t('cohort:subjectPage.hint')}
      </Typography.Paragraph>
      <Table
        rowKey="subject_id"
        loading={loading}
        dataSource={items}
        pagination={false}
        scroll={{ x: 910 }}
        columns={[
          {
            title: t('cohort:label.displayName'),
            dataIndex: 'display_name',
            width: 200,
            ellipsis: true,
            render: (v: string) => (
              <Space size={6}>
                <EntityIcon type="subject" />
                <span>{v}</span>
              </Space>
            ),
          },
          { title: t('cohort:label.identifier'), dataIndex: 'name', width: 180, ellipsis: true },
          {
            title: t('common:label.type'),
            dataIndex: 'kind',
            /* 单元格是 nowrap 的 Tag：俄 «Предустановленный» 17 字符 ≈ 111px + Tag 内边距 + 单元格 32px。
               100px 只够中文，长语言下 Tag 会横溢出格；按最长语言估宽。 */
            width: 150,
            render: (kind: string, row) =>
              row.is_preset ? <Tag color="blue">{t('cohort:label.preset')}</Tag> : kind === 'property' ? t('cohort:label.prop') : kind,
          },
          {
            title: t('cohort:label.source'),
            width: 280,
            ellipsis: true,
            render: (_: unknown, row: AnalysisSubject) =>
              row.source
                ? `${row.source.scope === 'user' ? t('cohort:label.userProp') : t('cohort:label.eventProp')} · ${row.source.prop}`
                : 'user_key / distinct_id',
          },
          {
            title: t('common:label.actions'),
            width: 100,
            fixed: 'right',
            render: (_: unknown, row: AnalysisSubject) =>
              row.is_preset ? null : (
                <Button type="link" danger icon={<DeleteOutlined />} onClick={() => handleDelete(row)}>
                  {t('common:action.delete')}
                </Button>
              ),
          },
        ]}
      />
      <Modal
        title={t('cohort:subjectPage.modalTitle')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleCreate()}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ scope: 'event' }}>
          <Form.Item name="display_name" label={t('cohort:label.displayName')} rules={[{ required: true, message: t('cohort:rule.requiredDisplayName') }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('cohort:label.subjectName')}
            rules={[
              { required: true, message: t('cohort:rule.requiredSubjectName') },
              { pattern: /^[a-z][a-z0-9_]{0,79}$/, message: t('cohort:rule.subjectNamePattern') },
            ]}
          >
            <Input maxLength={80} placeholder="account" />
          </Form.Item>
          <Form.Item name="scope" label={t('cohort:label.source')} rules={[{ required: true }]}>
            <Select
              {...SELECT_POPUP}
              options={[
                { label: t('cohort:label.eventProp'), value: 'event' },
                { label: t('cohort:label.userProp'), value: 'user' },
              ]}
            />
          </Form.Item>
          <Form.Item name="prop" label={t('cohort:label.prop')} rules={[{ required: true, message: t('cohort:rule.requiredProp') }]}>
            <Select {...SELECT_POPUP} showSearch options={propOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
