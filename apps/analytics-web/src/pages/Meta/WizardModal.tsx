import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { createDatatable, parseDatatable } from '../../services/datatable.service';
import type { DatatableColumn, DatatableDataType, ParseResult } from '../../services/datatable.service';
import { useT } from '../../i18n';
import { dataTypeOptions, FIELD_KEY_PATTERN, toColumnPayload } from './datatable-shared';
import { readTabularFile, uploadErrorMessage } from './datatable-upload';
import { DataTableExample } from './DataTableExample';

export function WizardModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useT('datatable', 'common', 'meta');
  const [step, setStep] = useState(0);
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [tableKey, setTableKey] = useState('');
  const [remark, setRemark] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [columnsDraft, setColumnsDraft] = useState<DatatableColumn[]>([]);
  const [metaNames, setMetaNames] = useState<string[] | null>(null);
  const [metaTypes, setMetaTypes] = useState<(DatatableDataType | null)[] | null>(null);
  const [adoptNames, setAdoptNames] = useState(true);
  const [adoptTypes, setAdoptTypes] = useState(false);
  const [declaredFirst, setDeclaredFirst] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 勾选变化时按元数据行重建字段草稿（显示名继承 ##name、类型可按 ##type 覆盖） */
  useEffect(() => {
    if (!parsed) return;
    setColumnsDraft(
      parsed.columns.map((column, index) => {
        const name = adoptNames ? metaNames?.[index]?.trim() : '';
        const declared = adoptTypes && declaredFirst ? metaTypes?.[index] : null;
        return {
          ...column,
          data_type: declared ?? column.data_type,
          display_name: name || column.display_name || column.field_key,
        };
      }),
    );
  }, [parsed, metaNames, metaTypes, adoptNames, adoptTypes, declaredFirst]);

  const reset = () => {
    setStep(0);
    setCsvText('');
    setFileName('');
    setTableKey('');
    setRemark('');
    setParsed(null);
    setColumnsDraft([]);
  };

  const listSep = t('datatable:wizard.listSep');

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const { text, renames, labels, droppedColumns, declaredTypes, marker } = await readTabularFile(file, t);
      const result = await parseDatatable({ csv_text: text });
      setCsvText(text);
      setFileName(file.name);
      setParsed(result);
      setMetaNames(labels);
      setMetaTypes(declaredTypes);
      setAdoptNames(!!labels);
      setAdoptTypes(!!declaredTypes);
      setDeclaredFirst(false);
      setColumnsDraft(
        result.columns.map((column, index) => {
          const label = labels?.[index]?.trim();
          if (label) return { ...column, display_name: label.slice(0, 100) };
          const rename = renames.find((item) => item.to === column.field_key);
          return rename ? { ...column, display_name: rename.from } : column;
        }),
      );
      if (droppedColumns.length > 0) {
        message.warning(
          t('datatable:wizard.droppedColumns', {
            count: droppedColumns.length,
            columns: droppedColumns.join(listSep),
          }),
          8,
        );
      }
      if (marker) {
        message.info(
          t('datatable:wizard.markerDetected', {
            items: [
              t('datatable:wizard.metaVarItem'),
              labels ? t('datatable:wizard.metaNameItem') : '',
              declaredTypes ? t('datatable:wizard.metaTypeItem') : '',
            ]
              .filter(Boolean)
              .join(listSep),
          }),
          8,
        );
      } else if (labels) {
        message.warning(t('datatable:wizard.labelRow'), 8);
      } else if (renames.length > 0) {
        message.warning(
          t('datatable:wizard.renamedHeader', {
            from: renames.map((item) => item.from).join(listSep),
            to: renames.map((item) => item.to).join(listSep),
          }),
          6,
        );
      }
      if (!tableKey) setTableKey(file.name.replace(/\.(csv|xlsx?)$/i, '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 50));
      message.success(t('datatable:wizard.parseSuccess'));
      return false;
    } catch (err) {
      message.error(uploadErrorMessage(err, t('datatable:wizard.parseFailed'), t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const gotoPreview = async () => {
    const invalid = columnsDraft.find((column) => !FIELD_KEY_PATTERN.test(column.field_key));
    if (invalid) {
      message.error(
        t('datatable:wizard.invalidField', {
          name: invalid.field_key || t('datatable:upload.emptyHeaderName'),
        }),
      );
      return;
    }
    const keys = columnsDraft.map((column) => column.field_key);
    if (new Set(keys).size !== keys.length) {
      message.error(t('datatable:wizard.duplicateField'));
      return;
    }
    setBusy(true);
    try {
      const result = await parseDatatable({ csv_text: csvText, columns: toColumnPayload(columnsDraft) });
      setParsed(result);
      setStep(2);
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('datatable:message.validateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      await createDatatable({
        table_key: tableKey,
        remark,
        csv_text: csvText,
        columns: toColumnPayload(columnsDraft),
      });
      message.success(t('datatable:wizard.created'));
      reset();
      onCreated();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('common:message.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      width={820}
      title={t('datatable:action.create')}
      onCancel={() => {
        reset();
        onClose();
      }}
      footer={
        <Space wrap>
          <Button onClick={() => { reset(); onClose(); }}>{t('common:action.cancel')}</Button>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>{t('datatable:wizard.prev')}</Button>}
          {step === 0 && (
            <Button type="primary" disabled={!parsed} onClick={() => setStep(1)}>
              {t('datatable:wizard.next')}
            </Button>
          )}
          {step === 1 && (
            <Button type="primary" loading={busy} onClick={gotoPreview}>
              {t('datatable:wizard.next')}
            </Button>
          )}
          {step === 2 && (
            <Button type="primary" loading={busy} onClick={save}>
              {t('common:action.save')}
            </Button>
          )}
        </Space>
      }
    >
      <Steps
        current={step}
        size="small"
        items={[
          { title: t('datatable:wizard.stepUpload') },
          { title: t('datatable:wizard.stepSchema') },
          { title: t('datatable:wizard.stepPreview') },
        ]}
        style={{ marginBottom: 20 }}
      />

      {step === 0 && (
        <>
          <Upload.Dragger
            accept=".csv,.xlsx,.xls"
            showUploadList={false}
            beforeUpload={(file) => onUpload(file as unknown as File)}
          >
            <p className="ant-upload-drag-icon">
              <UploadOutlined />
            </p>
            <p className="ant-upload-text">
              {parsed
                ? t('datatable:wizard.uploadDone', { fileName })
                : t('datatable:upload.dragText')}
            </p>
            <p className="ant-upload-hint">{t('datatable:wizard.uploadHint')}</p>
          </Upload.Dragger>
          {parsed && (metaNames || metaTypes) && (
            <Space direction="vertical" size={2} style={{ marginTop: 12 }}>
              <Typography.Text type="secondary">
                {t('datatable:wizard.metaRow', {
                  items: [
                    metaNames ? t('datatable:wizard.metaNameItem') : '',
                    metaTypes ? t('datatable:wizard.metaTypeItem') : '',
                  ]
                    .filter(Boolean)
                    .join(listSep),
                })}
              </Typography.Text>
              {metaNames && (
                <Checkbox checked={adoptNames} onChange={(event) => setAdoptNames(event.target.checked)}>
                  {t('datatable:wizard.adoptNames')}
                </Checkbox>
              )}
              {metaTypes && (
                <Checkbox checked={adoptTypes} onChange={(event) => setAdoptTypes(event.target.checked)}>
                  {t('datatable:wizard.adoptTypes')}
                </Checkbox>
              )}
              {metaTypes && adoptTypes && (
                <Checkbox checked={declaredFirst} onChange={(event) => setDeclaredFirst(event.target.checked)}>
                  {t('datatable:wizard.declaredFirst')}
                </Checkbox>
              )}
            </Space>
          )}
          {parsed && (
            <Alert
              style={{ marginTop: 12 }}
              type="success"
              showIcon
              message={t('datatable:wizard.parseSummary', {
                success: parsed.success_rows,
                dropped: parsed.dropped_rows,
              })}
              description={
                <>
                  {t('datatable:wizard.fieldsPrefix')}
                  {parsed.columns.map((column) => column.field_key).join(listSep)}
                  {parsed.duplicated_keys > 0 &&
                    t('datatable:wizard.dupKeys', { count: parsed.duplicated_keys })}
                </>
              }
            />
          )}
          <DataTableExample />
        </>
      )}

      {step === 1 && (
        <>
          <Space style={{ marginBottom: 12 }} size="large" wrap>
            <span>
              {t('datatable:wizard.tableNameLabel')}
              <Input
                style={{ minWidth: 240 }}
                value={tableKey}
                onChange={(event) => setTableKey(event.target.value)}
                placeholder={t('datatable:wizard.tableNamePlaceholder')}
              />
            </span>
            <span>
              {t('datatable:wizard.remarkLabel')}
              <Input
                style={{ minWidth: 280 }}
                maxLength={120}
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                placeholder={t('datatable:wizard.remarkPlaceholder')}
              />
            </span>
          </Space>
          <Table
            rowKey="field_key"
            size="small"
            pagination={false}
            scroll={{ x: 820 }}
            dataSource={columnsDraft}
            columns={[
              {
                title: t('datatable:column.field'),
                dataIndex: 'field_key',
                minWidth: 300,
                render: (value: string, record: DatatableColumn) => (
                  <Space wrap>
                    <Input
                      size="small"
                      value={value}
                      style={{ width: 150 }}
                      status={FIELD_KEY_PATTERN.test(value) ? undefined : 'error'}
                      onChange={(event) =>
                        setColumnsDraft((prev) =>
                          prev.map((item) =>
                            item.field_key === record.field_key
                              ? { ...item, field_key: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    {record.is_primary && <Tag color="blue">{t('datatable:column.primaryKey')}</Tag>}
                  </Space>
                ),
              },
              {
                title: t('meta:label.dataType'),
                dataIndex: 'data_type',
                minWidth: 170,
                render: (value: DatatableDataType, record: DatatableColumn) => (
                  <Select
                    size="small"
                    style={{ minWidth: 150 }}
                    value={value}
                    options={dataTypeOptions(t)}
                    disabled={record.is_primary}
                    onChange={(next) =>
                      setColumnsDraft((prev) =>
                        prev.map((item) => (item.field_key === record.field_key ? { ...item, data_type: next } : item)),
                      )
                    }
                  />
                ),
              },
              {
                title: t('meta:label.displayName'),
                dataIndex: 'display_name',
                render: (value: string | undefined, record: DatatableColumn) => (
                  <Input
                    size="small"
                    value={value}
                    placeholder={t('datatable:wizard.displayNamePlaceholder')}
                    onChange={(event) =>
                      setColumnsDraft((prev) =>
                        prev.map((item) =>
                          item.field_key === record.field_key ? { ...item, display_name: event.target.value } : item,
                        ),
                      )
                    }
                  />
                ),
              },
            ]}
          />
        </>
      )}

      {step === 2 && parsed && (
        <>
          <Alert
            type={parsed.dropped_rows > 0 ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 12 }}
            message={t('datatable:wizard.parseSummary', {
              success: parsed.success_rows,
              dropped: parsed.dropped_rows,
            })}
            description={
              parsed.dropped_detail.length > 0 ? (
                <div style={{ maxHeight: 90, overflow: 'auto' }}>
                  {parsed.dropped_detail.slice(0, 10).map((item) => (
                    <div key={item.line}>
                      {t('datatable:wizard.droppedRow', {
                        line: item.line,
                        reason: item.reason_key ? t(item.reason_key, item.reason_params) : item.reason,
                      })}
                    </div>
                  ))}
                </div>
              ) : undefined
            }
          />
          <Table
            rowKey={(record) => String(record[parsed.columns[0].field_key])}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            dataSource={parsed.preview_rows}
            columns={parsed.columns.map((column) => ({
              title: column.display_name || column.field_key,
              dataIndex: column.field_key,
              minWidth: 160,
              ellipsis: { showTitle: true },
            }))}
          />
        </>
      )}
    </Modal>
  );
}
