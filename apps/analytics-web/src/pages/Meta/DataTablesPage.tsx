import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../../i18n/format';
import {
  Button,
  Card,
  Dropdown,
  Popover,
  Empty,
  Input,
  Modal,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LinkOutlined,
  MoreOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  clearDatatable,
  deleteDatatable,
  downloadDatatable,
  getDatatable,
  listDatatables,
  updateDatatableMeta,
  type DatatableDetail,
  type DatatableSummary,
} from '../../services/datatable.service';
import { useT, type TFunction } from '../../i18n';
import { WizardModal } from './WizardModal';
import { BindingModal, UpdateModal } from './DataTableDialogs';

/** 数据表说明（Popover 内容）：<code> 里的标识不翻译 */
function tableHelp(t: TFunction) {
  return (
    <div style={{ maxWidth: 460, fontSize: 13, lineHeight: 1.7 }}>
      <p style={{ margin: '0 0 8px' }}>
        <b>{t('datatable:help.whatIsTerm')}</b>
        {t('datatable:help.whatIsLead')}{' '}
        <Typography.Text code>10001</Typography.Text>{' '}
        {t('datatable:help.whatIsTail')}
      </p>
      <p style={{ margin: '0 0 4px' }}>
        <b>{t('datatable:help.problemTitle')}</b>
      </p>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
        <li>{t('datatable:help.problemOnlyId')}</li>
        <li>
          {t('datatable:help.problemGroupLead')}
          <b>{t('datatable:help.problemGroupTerm')}</b>
          {t('datatable:help.problemGroupMid')}{' '}
          <b>{t('datatable:help.problemGroupTerm2')}</b>
        </li>
        <li>{t('datatable:help.problemSharedRule')}</li>
      </ul>
      <p style={{ margin: '0 0 4px' }}>
        <b>{t('datatable:help.usageTitle')}</b>
      </p>
      <ol style={{ margin: '0 0 8px', paddingLeft: 18 }}>
        <li>
          {t('datatable:help.usageUploadLead')}{' '}
          <Typography.Text code>##var</Typography.Text>
          {t('datatable:help.usageVarSuffix')}{' '}
          <Typography.Text code>##name</Typography.Text>
          {t('datatable:help.usageNameSuffix')}{' '}
          <Typography.Text code>##type</Typography.Text>
          {t('datatable:help.usageTypeSuffix')}
        </li>
        <li>{t('datatable:help.usageBind')}</li>
        <li>
          {t('datatable:help.usageShowLead')}
          <b>{t('datatable:help.usageShowTerm')}</b>
          {t('datatable:help.usageShowTail')}
        </li>
      </ol>
      <p style={{ margin: '0 0 4px' }}>
        <b>{t('datatable:help.rulesTitle')}</b>
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>{t('datatable:help.ruleLimits')}</li>
        <li>
          <b>{t('datatable:help.ruleKeyTerm')}</b>
          {t('datatable:help.ruleKeyDesc')}
        </li>
        <li>{t('datatable:help.ruleUpdate')}</li>
        <li>{t('datatable:help.ruleDelete')}</li>
        <li>{t('datatable:help.ruleCache')}</li>
        <li>{t('datatable:help.ruleScope')}</li>
      </ul>
    </div>
  );
}


export default function DataTablesPage() {
  const { t } = useT('datatable', 'common');
  const [rows, setRows] = useState<DatatableSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<DatatableSummary | null>(null);
  const [bindingTarget, setBindingTarget] = useState<DatatableDetail | null>(null);
  const [remarkTarget, setRemarkTarget] = useState<DatatableSummary | null>(null);
  const [remarkDraft, setRemarkDraft] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listDatatables());
    } catch {
      message.error(t('datatable:message.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openBindings = async (id: string) => {
    try {
      setBindingTarget(await getDatatable(id));
    } catch {
      message.error(t('datatable:message.openBindingsFailed'));
    }
  };

  const onDownload = async (record: DatatableSummary) => {
    try {
      const { content } = await downloadDatatable(record.id);
      const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${record.table_key}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      message.error(t('datatable:message.downloadFailed'));
    }
  };

  const columns = [
    {
      title: t('datatable:column.tableName'),
      dataIndex: 'table_key',
      minWidth: 200,
      ellipsis: { showTitle: true },
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: t('common:label.remark'),
      dataIndex: 'remark',
      minWidth: 160,
      ellipsis: { showTitle: true },
      render: (value: string | null) => value || '-',
    },
    { title: t('datatable:column.rowCount'), dataIndex: 'row_count', minWidth: 100, align: 'right' as const },
    { title: t('datatable:column.columnCount'), dataIndex: 'column_count', minWidth: 100, align: 'right' as const },
    {
      title: t('datatable:column.bindings'),
      dataIndex: 'binding_summary',
      minWidth: 190,
      ellipsis: { showTitle: true },
      render: (value: string) => value || '-',
    },
    {
      title: t('datatable:column.updatedAt'),
      dataIndex: 'updated_at',
      minWidth: 170,
      render: (value: string, record: DatatableSummary) =>
        value ? (
          <Typography.Text title={record.updated_by ?? ''}>
            {formatDateTime(value)}
          </Typography.Text>
        ) : (
          '-'
        ),
    },
    {
      title: t('common:label.actions'),
      minWidth: 210,
      render: (_: unknown, record: DatatableSummary) => (
        <Space size={0} wrap>
          <Button size="small" type="link" icon={<LinkOutlined />} onClick={() => openBindings(record.id)}>
            {t('datatable:action.configureBindings')}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'update', icon: <UploadOutlined />, label: t('datatable:action.updateData') },
                { key: 'download', icon: <DownloadOutlined />, label: t('common:action.download') },
                { key: 'remark', icon: <EditOutlined />, label: t('datatable:action.editRemark') },
                { key: 'clear', danger: true, label: t('common:action.clear') },
                { key: 'delete', danger: true, icon: <DeleteOutlined />, label: t('common:action.delete') },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'update') setUpdateTarget(record);
                if (key === 'download') void onDownload(record);
                if (key === 'remark') {
                  setRemarkTarget(record);
                  setRemarkDraft(record.remark ?? '');
                }
                if (key === 'clear') {
                  Modal.confirm({
                    title: t('datatable:confirm.clearTitle', { name: record.table_key }),
                    content: t('datatable:confirm.clearContent'),
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      await clearDatatable(record.id);
                      message.success(t('datatable:message.cleared'));
                      await load();
                    },
                  });
                }
                if (key === 'delete') {
                  Modal.confirm({
                    title: t('datatable:confirm.deleteTitle', { name: record.table_key }),
                    content: t('datatable:confirm.deleteContent'),
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      await deleteDatatable(record.id);
                      message.success(t('datatable:message.deleted'));
                      await load();
                    },
                  });
                }
              },
            }}
          >
            <Button size="small" type="link" icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space size={6}>
          {t('datatable:title')}
          <Popover
            content={tableHelp(t)}
            placement="rightTop"
            trigger="hover"
            title={t('datatable:help.popoverTitle')}
          >
            <QuestionCircleOutlined style={{ color: 'rgba(0, 0, 0, 0.45)', cursor: 'help' }} />
          </Popover>
        </Space>
      }
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setWizardOpen(true)}>
          {t('datatable:action.create')}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('datatable:hint')}
      </Typography.Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        columns={columns}
        scroll={{ x: 1160 }}
        locale={{ emptyText: <Empty description={t('datatable:empty')} /> }}
        pagination={false}
      />

      <WizardModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={async () => {
          setWizardOpen(false);
          await load();
        }}
      />
      <UpdateModal
        record={updateTarget}
        onClose={() => setUpdateTarget(null)}
        onUpdated={async () => {
          setUpdateTarget(null);
          await load();
        }}
      />
      <BindingModal
        detail={bindingTarget}
        onClose={() => setBindingTarget(null)}
        onChanged={async () => {
          if (bindingTarget) setBindingTarget(await getDatatable(bindingTarget.id));
          await load();
        }}
      />
      <Modal
        open={!!remarkTarget}
        title={t('datatable:remark.title', { name: remarkTarget?.table_key ?? '' })}
        onCancel={() => setRemarkTarget(null)}
        onOk={async () => {
          if (!remarkTarget) return;
          try {
            await updateDatatableMeta(remarkTarget.id, { remark: remarkDraft });
            message.success(t('datatable:remark.saved'));
            setRemarkTarget(null);
            await load();
          } catch (err) {
            message.error(err instanceof Error ? err.message : t('common:message.saveFailed'));
          }
        }}
      >
        <Input
          value={remarkDraft}
          maxLength={120}
          placeholder={t('datatable:remark.placeholder')}
          onChange={(event) => setRemarkDraft(event.target.value)}
        />
      </Modal>
    </Card>
  );
}
