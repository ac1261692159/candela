import { useEffect, useState } from 'react';
import { Button, Card, Descriptions, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import { createDataPolicy, deleteDataPolicy, listDataPolicies, type IamPolicy } from '../../services/iam.service';
import { useIamStore } from '../../stores/iam.store';
import { IamLoadError } from './load-error';
import { useT, type TFunction } from '../../i18n';

const DEFAULT_DEF = {
  events: { mode: 'all', keys: [] },
  event_properties: { mode: 'all', keys: [] },
  user_properties: { mode: 'all', keys: [] },
};

interface FieldScope {
  mode?: 'all' | 'allow';
  keys?: string[];
}

interface RowFilter {
  rel?: 'and';
  children?: { prop: string; op: string; value?: unknown }[];
}

interface PolicyDef {
  events?: FieldScope;
  event_properties?: FieldScope;
  user_properties?: FieldScope;
  row_filter?: RowFilter | null;
}

function parseDef(json: string): PolicyDef | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PolicyDef) : null;
  } catch {
    return null;
  }
}

/** 范围取值：不限 / 白名单（逐键标签）/ 空白名单（全部不可见——与分析侧 `event IN ()` 的语义一致，不能显示成「不限制」） */
function scopeNode(scope: FieldScope | undefined, t: TFunction) {
  if (!scope || (scope.mode ?? 'all') === 'all') {
    return <Typography.Text type="secondary">{t('iam:dataPolicy.scopeAll')}</Typography.Text>;
  }
  const keys = scope.keys ?? [];
  if (!keys.length) return <Typography.Text type="secondary">{t('iam:dataPolicy.scopeNone')}</Typography.Text>;
  return (
    <Space wrap>
      {keys.map((key) => (
        <Tag key={key}>{key}</Tag>
      ))}
    </Space>
  );
}

/** 行过滤条件 → 「属性 运算符 值」逐条，多条以「且」连接（属性/运算符/值属数据，不翻译） */
function rowFilterText(filter: RowFilter | null | undefined, t: TFunction) {
  const children = filter?.children ?? [];
  if (!children.length) return t('iam:dataPolicy.rowFilterNone');
  return children
    .map((n) => t('iam:dataPolicy.rowFilterItem', { prop: n.prop, op: n.op, value: String(n.value ?? '') }))
    .join(` ${t('iam:dataPolicy.rowFilterAnd')} `);
}

export function IamDataPoliciesPage() {
  const { t } = useT('iam');
  const [rows, setRows] = useState<IamPolicy[]>([]);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<IamPolicy | null>(null);
  const [form] = Form.useForm();
  // rbac-v4：项目权限全员只读可见——策略明细对所有人可读，增删仍属「数据权限 · 管理」
  const canManage = useIamStore((s) => s.has('iam.data_policy.manage'));
  const [loadFailed, setLoadFailed] = useState(false);
  const load = () =>
    listDataPolicies()
      .then((rows) => {
        setRows(rows);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));

  useEffect(() => {
    void load();
  }, []);

  const detailDef = detail ? parseDef(detail.definition_json) : null;

  return (
    <Card
      title={t('iam:dataPolicy.title')}
      extra={
        canManage ? (
          <Button type="primary" onClick={() => setOpen(true)}>
            {t('iam:dataPolicy.create')}
          </Button>
        ) : null
      }
    >
      {loadFailed ? <IamLoadError onRetry={() => void load()} /> : null}
      <Table
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 640 }}
        columns={[
          { title: t('common:label.name'), dataIndex: 'name', minWidth: 240, ellipsis: { showTitle: true } },
          {
            title: t('iam:dataPolicy.reference'),
            minWidth: 200,
            render: (_, r) =>
              t('iam:dataPolicy.referenceCount', { members: r._count.members, groups: r._count.groups }),
          },
          {
            title: t('common:label.actions'),
            minWidth: canManage ? 200 : 130,
            fixed: 'right',
            render: (_, r) => (
              <Space wrap>
                <Button size="small" onClick={() => setDetail(r)}>
                  {t('common:action.view')}
                </Button>
                {canManage && (
                  <Popconfirm title={t('iam:dataPolicy.deleteConfirm')} onConfirm={() => deleteDataPolicy(r.id).then(load)}>
                    <Button size="small" danger>
                      {t('common:action.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal title={t('iam:dataPolicy.detail')} open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null}>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('common:label.name')}>{detail?.name}</Descriptions.Item>
          <Descriptions.Item label={t('iam:dataPolicy.scopeEvents')}>
            {scopeNode(detailDef?.events, t)}
          </Descriptions.Item>
          <Descriptions.Item label={t('iam:dataPolicy.scopeEventProperties')}>
            {scopeNode(detailDef?.event_properties, t)}
          </Descriptions.Item>
          <Descriptions.Item label={t('iam:dataPolicy.scopeUserProperties')}>
            {scopeNode(detailDef?.user_properties, t)}
          </Descriptions.Item>
          <Descriptions.Item label={t('iam:dataPolicy.scopeRowFilter')}>
            {rowFilterText(detailDef?.row_filter, t)}
          </Descriptions.Item>
          {!detailDef && detail ? (
            <Descriptions.Item label={t('iam:dataPolicy.definition')}>
              <Typography.Text code style={{ fontSize: 12 }}>
                {detail.definition_json}
              </Typography.Text>
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      </Modal>
      <Modal
        title={t('iam:dataPolicy.create')}
        open={canManage && open}
        onCancel={() => setOpen(false)}
        onOk={async () => {
          const v = await form.validateFields();
          let definition = DEFAULT_DEF;
          if (v.definition_json) {
            definition = JSON.parse(v.definition_json);
          }
          await createDataPolicy({ name: v.name, definition });
          message.success(t('iam:message.created'));
          setOpen(false);
          form.resetFields();
          await load();
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('common:label.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="definition_json" label={t('iam:dataPolicy.definition')}>
            <Input.TextArea rows={8} placeholder='{"events":{"mode":"allow","keys":["AppLaunch"]}}' />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
