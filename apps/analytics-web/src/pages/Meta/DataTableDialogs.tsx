import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import { DeleteOutlined, LinkOutlined, PlusOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import {
  createDatatableBinding,
  deleteDatatableBinding,
  previewDatatableUpdate,
  updateDatatable,
  updateDatatableBinding,
} from '../../services/datatable.service';
import type {
  DatatableDataType,
  DatatableDetail,
  DatatableSummary,
  ParseResult,
} from '../../services/datatable.service';
import { getAllEventAttributes, getUserProperties } from '../../services/meta.service';
import { useT } from '../../i18n';
import { builtinProps, granularityOptions, isCompatible, pickDefaultLabelField, propTargetType, typeLabel } from './datatable-shared';
import type { PropOption } from './datatable-shared';
import { readTabularFile, uploadErrorMessage } from './datatable-upload';




/** 关联属性弹窗里字段映射表的一行 */

export interface BindingFieldRow {
  field_key: string;
  data_type: DatatableDataType;
  isKey: boolean;
  prop_key: string;
  display_name: string;
}

/** 一个「关联属性」草稿：已存在的绑定与新建未保存的走同一结构 */

export interface BindingDraft {
  key: string;
  bindingId?: string;
  status?: string;
  targetProp: string;
  /** 多选关联：一次可选多个属性，保存时各生成一套派生属性 */
  targetProps?: string[];
  keyColumn: string;
  granularity: string;
  displayNames: Record<string, string>;
  /** 值映射用哪一列当业务名；空则服务端按默认规则 */
  labelField?: string;
  /** 服务端算出的展示列显示名（值映射按哪一列显示业务名）；null/undefined = 不映射 */
  labelTitle?: string | null;
}


export function UpdateModal({
  record,
  onClose,
  onUpdated,
}: {
  record: DatatableSummary | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { t } = useT('datatable', 'common');
  const [mode, setMode] = useState<'incr' | 'replace'>('incr');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<(ParseResult & { current_row_count: number }) | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!record) {
      setCsvText('');
      setPreview(null);
      setMode('incr');
    }
  }, [record]);

  const onUpload = async (file: File) => {
    if (!record) return false;
    setBusy(true);
    try {
      const { text, labels } = await readTabularFile(file, t);
      if (labels) {
        message.warning(t('datatable:update.labelRowSkipped'), 8);
      }
      const result = await previewDatatableUpdate(record.id, { csv_text: text, mode });
      setCsvText(text);
      setPreview(result);
      return false;
    } catch (err) {
      message.error(uploadErrorMessage(err, t('datatable:message.validateFailed'), t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!record || !csvText) return;
    setBusy(true);
    try {
      const result = await updateDatatable(record.id, { csv_text: csvText, mode });
      message.success(
        t('datatable:update.done', {
          added: result.added,
          updated: result.updated,
          dropped: result.dropped,
        }),
      );
      onUpdated();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('datatable:update.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!record}
      width={720}
      title={t('datatable:update.title', { name: record?.table_key ?? '' })}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>{t('common:action.cancel')}</Button>
          <Button type="primary" disabled={!preview} loading={busy} onClick={submit}>
            {t('datatable:update.submit')}
          </Button>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item label={t('datatable:update.modeLabel')}>
          <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}>
            <Radio value="incr">{t('datatable:update.modeIncr')}</Radio>
            <Radio value="replace">{t('datatable:update.modeReplace')}</Radio>
          </Radio.Group>
        </Form.Item>
      </Form>
      <Upload.Dragger accept=".csv,.xlsx,.xls" showUploadList={false} beforeUpload={(file) => onUpload(file as unknown as File)}>
        <p className="ant-upload-text">{t('datatable:upload.dragText')}</p>
        <p className="ant-upload-hint">{t('datatable:update.dragHint')}</p>
      </Upload.Dragger>
      {preview && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message={t('datatable:update.previewSummary', {
            success: preview.success_rows,
            dropped: preview.dropped_rows,
            current: preview.current_row_count,
          })}
          description={
            <>
              {preview.duplicated_keys > 0 &&
                t('datatable:update.dupKeys', { count: preview.duplicated_keys })}
              {t('datatable:update.atomicNote')}
            </>
          }
        />
      )}
    </Modal>
  );
}


export function BindingModal({
  detail,
  onClose,
  onChanged,
}: {
  detail: DatatableDetail | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useT('datatable', 'common', 'meta');
  const [drafts, setDrafts] = useState<BindingDraft[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [options, setOptions] = useState<PropOption[]>([]);
  const [searchText, setSearchText] = useState('');
  const [busy, setBusy] = useState(false);

  const columns = detail?.columns ?? [];
  const fallbackKeyColumn = columns[0]?.field_key ?? '';
  const active = drafts.find((item) => item.key === activeKey) ?? drafts[0];
  const keyColumn = active?.keyColumn || fallbackKeyColumn;
  const keyType = columns.find((column) => column.field_key === keyColumn)?.data_type;
  const defaultLabelField = pickDefaultLabelField(columns, keyColumn);
  const defaultLabelTitle = defaultLabelField
    ? columns.find((column) => column.field_key === defaultLabelField)?.display_name || defaultLabelField
    : undefined;

  useEffect(() => {
    if (!detail) {
      setDrafts([]);
      setActiveKey('');
      return;
    }
    const restored: BindingDraft[] = (detail.bindings ?? []).map((binding) => ({
      key: binding.id,
      bindingId: binding.id,
      status: binding.status,
      targetProp: binding.target_prop,
      keyColumn: binding.key_column || detail.columns?.[0]?.field_key || '',
      granularity: binding.granularity ?? 'day',
      displayNames: Object.fromEntries(
        (binding.field_mappings ?? []).map((item) => [item.field_key, item.display_name ?? '']),
      ),
      labelField: binding.label_field ?? undefined,
      labelTitle: binding.label_title ?? null,
    }));
    // 空表也先给一个「关联属性 1」草稿，打开即可直接选属性（对齐数数）
    if (restored.length === 0) {
      restored.push({
        key: 'new_0',
        targetProp: '',
        keyColumn: detail.columns?.[0]?.field_key ?? '',
        granularity: 'day',
        displayNames: {},
        labelField: pickDefaultLabelField(detail.columns ?? [], detail.columns?.[0]?.field_key ?? ''),
      });
    }
    setDrafts(restored);
    setActiveKey(restored[0]?.key ?? '');
  }, [detail]);

  useEffect(() => {
    if (!detail) return;
    let alive = true;
    void (async () => {
      const [attrs, users] = await Promise.all([
        // 事件属性 459 条，必须翻页取全；否则 goods_id 之类排在 100 条之后的属性搜不到
        getAllEventAttributes().catch(
          () => [] as { prop_key: string; display_name?: string; data_type: string }[],
        ),
        getUserProperties().catch(() => ({ items: [] as PropOption[] })),
      ]);
      if (!alive) return;
      const toOption = (items: { prop_key: string; display_name?: string; data_type: string }[]) =>
        items.map((item) => ({
          prop_key: item.prop_key,
          label: item.display_name || item.prop_key,
          data_type: item.data_type,
          targetType: 'event_property' as const,
        }));
      setOptions([
        ...builtinProps(t),
        ...toOption(attrs),
        ...toOption(users.items ?? []),
      ]);
    })();
    return () => {
      alive = false;
    };
  }, [detail, t]);

  const patchActive = (patch: Partial<BindingDraft>) => {
    setDrafts((prev) => prev.map((item) => (item.key === active?.key ? { ...item, ...patch } : item)));
  };

  const addDraft = () => {
    const draft: BindingDraft = {
      key: `new_${Date.now()}`,
      targetProp: '',
      keyColumn: fallbackKeyColumn,
      granularity: 'day',
      displayNames: {},
      labelField: pickDefaultLabelField(columns, fallbackKeyColumn),
    };
    setDrafts((prev) => [...prev, draft]);
    setActiveKey(draft.key);
  };

  /** 一键关联同名字段：字段名与属性标识同名（如 user_id ↔ user_id）时各建一条绑定 */
  const autoMatch = async () => {
    if (!detail) return;
    const bound = new Set(
      (detail.bindings ?? []).filter((item) => item.status === 'active').map((item) => item.target_prop),
    );
    const candidates = columns
      .filter((column) => !bound.has(column.field_key))
      .filter((column) => options.some((option) => option.prop_key === column.field_key));
    // 名称列（`*_name`）不自动关联：事件里的值本身就是可读业务名，
    // 映射只会按"展示列"把它换成维表里的另一个字段（曾经把 商品名称 换成了 商品ID）
    const isNameColumn = (key: string) => /(^|_)name$/i.test(key);
    const pairs = candidates
      .filter((column) => !isNameColumn(column.field_key))
      .map((column) => column.field_key);
    const skippedNames = candidates
      .filter((column) => isNameColumn(column.field_key))
      .map((column) => column.field_key);
    if (pairs.length === 0) {
      message.info(
        skippedNames.length
          ? t('datatable:binding.autoNoFields', { columns: skippedNames.join(t('datatable:wizard.listSep')) })
          : t('datatable:binding.autoNoMatch'),
      );
      return;
    }
    setBusy(true);
    try {
      for (const prop of pairs) {
        await createDatatableBinding(detail.id, {
          target_type: propTargetType(prop),
          target_prop: prop,
          key_column: prop,
          label_field: pickDefaultLabelField(columns, prop),
          field_mappings: [],
        });
      }
      message.success(
        t('datatable:binding.autoDone', {
          count: pairs.length,
          fields: pairs.join(t('datatable:wizard.listSep')),
        }),
      );
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('datatable:binding.autoFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** 主键列之外每列一行：派生属性名 `<属性>@<字段>`，显示名可改 */
  const fieldRows: BindingFieldRow[] = columns.map((column) => {
    const isKey = column.field_key === keyColumn;
    return {
      field_key: column.field_key,
      data_type: column.data_type,
      isKey,
      prop_key: isKey || !active?.targetProp ? '-' : `${active.targetProp}@${column.field_key}`,
      display_name: isKey
        ? ''
        : active?.displayNames[column.field_key] || column.display_name || column.field_key,
    };
  });

  const save = async () => {
    if (!detail || !active) return;
    const props = active.targetProps?.length
      ? active.targetProps
      : active.targetProp
        ? [active.targetProp]
        : [];
    if (props.length === 0) {
      message.warning(t('datatable:binding.needProp'));
      return;
    }
    setBusy(true);
    try {
      const keyColumnToSave = active.keyColumn || fallbackKeyColumn;
      const labelField = active.labelField || pickDefaultLabelField(columns, keyColumnToSave);
      const mappings = fieldRows
        .filter((row) => !row.isKey)
        .map((row) => ({ field_key: row.field_key, display_name: row.display_name }));
      if (active.bindingId && props.length === 1) {
        await updateDatatableBinding(detail.id, active.bindingId, {
          key_column: keyColumnToSave,
          label_field: labelField,
          granularity: propTargetType(props[0]) === 'event_time' ? active.granularity : undefined,
          field_mappings: mappings,
        });
      } else {
        for (const prop of props) {
          const targetType = propTargetType(prop);
          await createDatatableBinding(detail.id, {
            target_type: targetType,
            target_prop: prop,
            key_column: keyColumnToSave,
            label_field: labelField,
            granularity: targetType === 'event_time' ? active.granularity : undefined,
            field_mappings: mappings,
          });
        }
      }
      message.success(
        props.length > 1
          ? t('datatable:binding.savedMany', { count: props.length })
          : t('datatable:binding.saved'),
      );
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('common:message.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    if (!detail || !active?.bindingId) return;
    setBusy(true);
    try {
      await deleteDatatableBinding(detail.id, active.bindingId);
      message.success(t('datatable:binding.unbound'));
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('datatable:binding.unbindFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!detail}
      width={1080}
      title={t('datatable:binding.title', { name: detail?.table_key ?? '' })}
      onCancel={onClose}
      footer={
        <Space wrap>
          {active?.bindingId && active.status === 'active' && (
            <Button danger loading={busy} onClick={unbind}>
              {t('datatable:binding.unbind')}
            </Button>
          )}
          {active?.bindingId && active.status !== 'active' && (
            <Button danger loading={busy} onClick={unbind}>
              {t('datatable:binding.purge')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common:action.close')}</Button>
          <Button type="primary" loading={busy} disabled={!active} onClick={save}>
            {t('common:action.save')}
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('datatable:binding.alertText', {
          table: detail?.table_key ?? '',
          key: keyColumn || '-',
          type: typeLabel(keyType, t),
          targets:
            keyType === 'string'
              ? t('datatable:binding.targetsTextTime')
              : keyType === 'datetime'
                ? t('datatable:binding.targetsTimeText')
                : t('datatable:binding.targetsSelf', { type: typeLabel(keyType, t) }),
        })}
      />
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: '0 1 240px', minWidth: 240 }}>
          {drafts.map((draft, index) => {
            const selected = draft.key === active?.key;
            const invalid = !!draft.status && draft.status !== 'active';
            return (
              <div
                key={draft.key}
                onClick={() => setActiveKey(draft.key)}
                style={{
                  border: `1px solid ${selected ? '#1677ff' : invalid ? '#f0f0f0' : '#d9d9d9'}`,
                  background: selected ? '#e6f4ff' : invalid ? '#fafafa' : '#fff',
                  borderRadius: 6,
                  padding: '4px 6px 4px 10px',
                  marginBottom: 8,
                  cursor: 'pointer',
                }}
              >
                <Space style={{ width: '100%', justifyContent: 'space-between' }} size={2}>
                  <Space size={4} wrap>
                    <Typography.Text
                      ellipsis={{ tooltip: draft.targetProp || t('datatable:binding.draftName', { index: index + 1 }) }}
                      style={{ maxWidth: 130, color: invalid ? 'rgba(0, 0, 0, 0.35)' : undefined }}
                    >
                      {draft.targetProp || t('datatable:binding.draftName', { index: index + 1 })}
                    </Typography.Text>
                    {invalid && (
                      <Tag color="default" style={{ marginRight: 0 }}>
                        {t('datatable:binding.invalid')}
                      </Tag>
                    )}
                  </Space>
                  <span onClick={(event) => event.stopPropagation()}>
                    <Popconfirm
                      title={
                        invalid
                          ? t('datatable:binding.purgeConfirm')
                          : draft.bindingId
                            ? t('datatable:binding.unbindConfirm')
                            : t('datatable:binding.removeConfirm')
                      }
                      onConfirm={async () => {
                        if (draft.bindingId && detail) {
                          await deleteDatatableBinding(detail.id, draft.bindingId);
                          message.success(invalid ? t('datatable:binding.purged') : t('datatable:binding.unbound'));
                          onChanged();
                          return;
                        }
                        setDrafts((prev) => prev.filter((item) => item.key !== draft.key));
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        title={invalid ? t('datatable:binding.purge') : t('datatable:binding.unbind')}
                      />
                    </Popconfirm>
                  </span>
                </Space>
                {draft.bindingId && !invalid && (
                  <Tooltip
                    title={
                      draft.labelTitle
                        ? t('datatable:binding.labelTitleTip', { column: draft.labelTitle })
                        : t('datatable:binding.noLabelTip')
                    }
                  >
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block' }}
                      ellipsis
                    >
                      {draft.labelTitle
                        ? t('datatable:binding.labelColumn', { column: draft.labelTitle })
                        : t('datatable:binding.noMapping')}
                    </Typography.Text>
                  </Tooltip>
                )}
              </div>
            );
          })}
          <Button block type="dashed" icon={<PlusOutlined />} onClick={addDraft}>
            {t('datatable:binding.addProp')}
          </Button>
          <Button
            block
            style={{ marginTop: 8 }}
            icon={<LinkOutlined />}
            loading={busy}
            onClick={autoMatch}
          >
            {t('datatable:binding.autoMatch')}
          </Button>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {active ? (
            <>
              <div
                style={{
                  display: 'flex',
                  // 三栏标签在俄/德下明显变长：窄容器允许换行堆叠，避免横向溢出弹窗
                  flexWrap: 'wrap',
                  gap: 16,
                  marginBottom: 12,
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ flex: '0 1 320px', minWidth: 240 }}>
                  <Typography.Text strong>{t('datatable:binding.selectProp')}</Typography.Text>
                  <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                    <Select
                      mode="multiple"
                      allowClear
                      showSearch
                      style={{ flex: 1, minWidth: 0 }}
                      placeholder={t('datatable:binding.searchProp')}
                      optionFilterProp="label"
                      value={active.targetProps ?? (active.targetProp ? [active.targetProp] : [])}
                      onSearch={(value: string) => setSearchText(value)}
                      onChange={(values: string[]) => {
                        const list = values ?? [];
                        patchActive({ targetProps: list, targetProp: list[0] ?? '', displayNames: {} });
                      }}
                      options={[
                        ...options.map((option) => ({
                          value: option.prop_key,
                          label: `${option.label}(${option.prop_key})　${typeLabel(option.data_type, t)}`,
                          disabled: !isCompatible(keyType, option.data_type),
                        })),
                        ...(searchText.trim() && !options.some((item) => item.prop_key === searchText.trim())
                          ? [
                              {
                                value: searchText.trim(),
                                label: t('datatable:binding.useCustom', { key: searchText.trim() }),
                                disabled: false,
                              },
                            ]
                          : []),
                      ]}
                    />
                    {propTargetType(active.targetProp) === 'event_time' && (
                      <Select
                        value={active.granularity}
                        style={{ minWidth: 120 }}
                        onChange={(value: string) => patchActive({ granularity: value })}
                        options={granularityOptions(t)}
                      />
                    )}
                  </div>
                </div>
                <div style={{ flex: '0 1 240px', minWidth: 220 }}>
                  <Space size={4}>
                    <Typography.Text strong>{t('datatable:binding.keyColumn')}</Typography.Text>
                    <Tooltip title={t('datatable:binding.keyColumnTip')}>
                      <QuestionCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
                    </Tooltip>
                  </Space>
                  <div style={{ marginTop: 4 }}>
                    <Select
                      value={keyColumn}
                      style={{ width: '100%' }}
                      onChange={(value: string) =>
                        patchActive({
                          keyColumn: value,
                          displayNames: {},
                          labelField: pickDefaultLabelField(columns, value),
                        })
                      }
                      options={columns.map((column) => ({
                        value: column.field_key,
                        label: `${column.display_name || column.field_key}（${column.field_key}）`,
                      }))}
                    />
                  </div>
                </div>
                <div style={{ flex: '0 1 240px', minWidth: 220 }}>
                  <Space size={4}>
                    <Typography.Text strong>{t('datatable:binding.labelField')}</Typography.Text>
                    <Tooltip
                      title={t('datatable:binding.labelFieldTip', {
                        current: defaultLabelTitle
                          ? t('datatable:binding.labelFieldCurrent', { column: defaultLabelTitle })
                          : '',
                      })}
                    >
                      <QuestionCircleOutlined style={{ color: '#8c8c8c', cursor: 'help' }} />
                    </Tooltip>
                  </Space>
                  <div style={{ marginTop: 4 }}>
                    <Select
                      value={active.labelField || defaultLabelField}
                      style={{ width: '100%' }}
                      onChange={(value: string) => patchActive({ labelField: value })}
                      options={columns.map((column) => ({
                        value: column.field_key,
                        label: `${column.display_name || column.field_key}（${column.field_key}）`,
                      }))}
                    />
                  </div>
                </div>
              </div>
              <Table<BindingFieldRow>
                rowKey="field_key"
                size="small"
                pagination={false}
                scroll={{ x: 1060 }}
                dataSource={fieldRows}
                columns={[
                  {
                    title: t('datatable:column.field'),
                    dataIndex: 'field_key',
                    minWidth: 220,
                    ellipsis: { showTitle: true },
                    render: (value: string, record) => (
                      <Space size={4} wrap>
                        <Typography.Text>{value}</Typography.Text>
                        {record.isKey && <Tag color="blue">{t('datatable:column.primaryKey')}</Tag>}
                      </Space>
                    ),
                  },
                  {
                    title: t('meta:label.dataType'),
                    dataIndex: 'data_type',
                    minWidth: 150,
                    render: (value: string) => typeLabel(value, t),
                  },
                  {
                    title: t('datatable:binding.propName'),
                    dataIndex: 'prop_key',
                    minWidth: 240,
                    ellipsis: { showTitle: true },
                  },
                  {
                    title: t('datatable:binding.propDataType'),
                    dataIndex: 'data_type',
                    minWidth: 210,
                    render: (value: string) => typeLabel(value, t),
                  },
                  {
                    title: t('datatable:binding.propDisplayName'),
                    dataIndex: 'display_name',
                    minWidth: 260,
                    render: (value: string, record) =>
                      record.isKey ? (
                        '-'
                      ) : (
                        <Input
                          size="small"
                          value={value}
                          onChange={(event) =>
                            patchActive({
                              displayNames: { ...active.displayNames, [record.field_key]: event.target.value },
                            })
                          }
                        />
                      ),
                  },
                ]}
              />
            </>
          ) : (
            <Empty description={t('datatable:binding.emptyHint')} />
          )}
        </div>
      </div>
    </Modal>
  );
}
