import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  assignOwner,
  createProject,
  listRegistryProjects,
  listUserDirectory,
  type RegistryProject,
} from '../../services/iam.service';
import { createLoginUser } from '../../services/auth.service';
import { useIamStore } from '../../stores/iam.store';
import { useProjectStore } from '../../stores/project.store';
import { useT } from '../../i18n';

export function ProjectOwnersPage() {
  const { t } = useT('iam');
  const loadMe = useIamStore((s) => s.loadMe);
  const canUsers = useIamStore((s) => s.has('ops.user.manage'));
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const [rows, setRows] = useState<RegistryProject[]>([]);
  const [users, setUsers] = useState<{ id: string; username: string; display_name: string | null }[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [ownerPick, setOwnerPick] = useState<Record<string, string>>({});
  const [form] = Form.useForm();
  const [userForm] = Form.useForm();

  const load = async () => {
    const data = await listRegistryProjects();
    setRows(data);
    const pick: Record<string, string> = {};
    for (const row of data) {
      if (row.owner?.user_id) pick[row.name] = row.owner.user_id;
    }
    setOwnerPick(pick);
  };

  useEffect(() => {
    void load();
    listUserDirectory().then(setUsers).catch(() => setUsers([]));
  }, []);

  const userOptions = users.map((u) => ({
    value: u.id,
    label: u.display_name
      ? t('iam:projectSettings.userOption', { name: u.display_name, username: u.username })
      : u.username,
  }));

  return (
    <Card
      title={t('iam:projectSettings.title')}
      extra={
        <Space wrap>
          {canUsers ? (
            <Button onClick={() => setUserOpen(true)}>{t('iam:projectSettings.createAccount')}</Button>
          ) : null}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('iam:projectSettings.createProject')}
          </Button>
        </Space>
      }
    >
      <Alert
        style={{ marginBottom: 16 }}
        type="info"
        showIcon
        message={t('iam:projectSettings.ownerNotice')}
      />
      <Table
        rowKey="name"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1040 }}
        columns={[
          { title: t('iam:projectSettings.projectName'), dataIndex: 'name', minWidth: 180, ellipsis: { showTitle: true } },
          { title: t('iam:projectSettings.displayName'), dataIndex: 'display_name', minWidth: 220, ellipsis: { showTitle: true } },
          {
            title: t('iam:projectSettings.currentOwner'),
            minWidth: 220,
            ellipsis: { showTitle: true },
            render: (_, r) => r.owner?.display_name || r.owner?.username || t('iam:projectSettings.unassigned'),
          },
          {
            title: t('iam:projectSettings.assign'),
            minWidth: 380,
            render: (_, r) => (
              <Space wrap>
                <Select
                  style={{ minWidth: 220 }}
                  value={ownerPick[r.name]}
                  placeholder={t('iam:projectSettings.selectUser')}
                  options={userOptions}
                  showSearch
                  optionFilterProp="label"
                  onChange={(id) => setOwnerPick((prev) => ({ ...prev, [r.name]: id }))}
                />
                <Button
                  type="primary"
                  disabled={!ownerPick[r.name]}
                  onClick={async () => {
                    const userId = ownerPick[r.name];
                    if (!userId) return;
                    await assignOwner(r.name, userId);
                    message.success(t('iam:projectSettings.ownerUpdated', { name: r.name }));
                    await load();
                  }}
                >
                  {t('common:action.save')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={t('iam:projectSettings.createProject')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          const created = await createProject(v);
          message.success(t('iam:projectSettings.projectCreated'));
          setCreateOpen(false);
          form.resetFields();
          await load();
          await loadMe();
          setCurrentProject(created.name);
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('iam:projectSettings.projectName')}
            extra={t('iam:projectSettings.nameHint')}
            rules={[
              { required: true, message: t('iam:projectSettings.nameRequired') },
              { pattern: /^[a-z][a-z0-9_]{1,62}$/, message: t('iam:projectSettings.nameInvalid') },
            ]}
          >
            <Input placeholder={t('iam:projectSettings.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="display_name" label={t('iam:projectSettings.displayName')}>
            <Input placeholder={t('iam:projectSettings.displayNamePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="owner_user_id"
            label={t('iam:projectSettings.projectOwner')}
            rules={[{ required: true, message: t('iam:projectSettings.ownerRequired') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={userOptions}
              placeholder={t('iam:projectSettings.selectUser')}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('iam:projectSettings.createAccount')}
        open={userOpen}
        onCancel={() => setUserOpen(false)}
        destroyOnClose
        onOk={async () => {
          const v = await userForm.validateFields();
          await createLoginUser(v);
          message.success(t('iam:projectSettings.accountCreated'));
          setUserOpen(false);
          userForm.resetFields();
          listUserDirectory().then(setUsers).catch(() => setUsers([]));
        }}
      >
        <Typography.Paragraph type="secondary">
          {t('iam:projectSettings.accountHint')}
        </Typography.Paragraph>
        <Form form={userForm} layout="vertical">
          <Form.Item name="username" label={t('iam:projectSettings.username')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label={t('iam:projectSettings.displayName')}>
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('iam:projectSettings.password')}
            rules={[{ required: true }, { min: 6, message: t('iam:message.minLength') }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
