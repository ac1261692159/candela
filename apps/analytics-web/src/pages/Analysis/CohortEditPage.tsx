import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Space,
  Switch,
  Typography,
  Upload,
  message,
} from 'antd';
import { PlusOutlined, ThunderboltOutlined, UploadOutlined } from '@ant-design/icons';
import { ConditionSentenceEditor } from '../../features/cohort/ConditionSentenceEditor';
import {
  defaultDidEvent,
  defaultSequence,
  defaultUserProp,
  stampNames,
  type CohortCondition,
} from '../../features/cohort/cohort-condition';
import { validateConditions } from '../../features/cohort/condition-validation';
import {
  DEFAULT_SQL_TEXT,
  DEFAULT_SQL_TIME_PARAMS,
  SqlCohortForm,
  type SqlTimeParam,
} from '../../features/cohort/SqlCohortForm';
import {
  createCohort,
  getCohort,
  getCohortTemplate,
  previewConditionCohort,
  previewSqlCohort,
  replaceCohortMembers,
  updateCohort,
} from '../../services/cohort.service';
import { getUserProperties } from '../../services/meta.service';
import { useProjectStore } from '../../stores/project.store';
import type { MetaUserProperty } from '../../types/meta.types';
import { SubjectSelect } from '../../features/subject/SubjectSelect';
import { subjectForbidsDidNot, useSubjects } from '../../features/subject/use-subjects';
import { useT, type TFunction } from '../../i18n';

type Kind = 'condition' | 'id_upload' | 'sql';

function titleFor(kind: Kind, isEdit: boolean, readonlyResult: boolean, t: TFunction) {
  if (readonlyResult) return t('cohort:kind.result');
  if (isEdit) return t('cohort:cohortEdit.titleEdit');
  if (kind === 'id_upload') return t('cohort:cohortEdit.titleCreateIdUpload');
  if (kind === 'sql') return t('cohort:cohortEdit.titleCreateSql');
  return t('cohort:cohortEdit.titleCreateCondition');
}

export function CohortEditPage() {
  const { t } = useT('cohort');
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const project = useProjectStore((state) => state.currentProject);
  const [form] = Form.useForm();
  const [kind, setKind] = useState<Kind>((searchParams.get('kind') as Kind) || 'condition');
  const [conditions, setConditions] = useState<CohortCondition[]>([defaultDidEvent()]);
  const [sqlText, setSqlText] = useState(DEFAULT_SQL_TEXT);
  const [timeParams, setTimeParams] = useState<SqlTimeParam[]>(DEFAULT_SQL_TIME_PARAMS);
  const [previewRows, setPreviewRows] = useState<{ uid: string }[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [saving, setSaving] = useState(false);
  const [userProperties, setUserProperties] = useState<MetaUserProperty[]>([]);
  const [readonlyResult, setReadonlyResult] = useState(false);
  const [subjectId, setSubjectId] = useState<string | undefined>();
  const [issues, setIssues] = useState<{ index: number; message: string }[]>([]);
  const [preview, setPreview] = useState<{
    count: number;
    items: { uid: string }[];
    truncated: boolean;
    limit: number;
  } | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [reuploadText, setReuploadText] = useState('');
  const [reuploading, setReuploading] = useState(false);
  const { subjects } = useSubjects();
  const selectedSubject = subjects.find((item) => item.subject_id === subjectId);
  const allowDidNot = !subjectForbidsDidNot(selectedSubject);
  const isEdit = Boolean(id);

  useEffect(() => {
    getUserProperties()
      .then((res) => setUserProperties(res.items))
      .catch(() => setUserProperties([]));
  }, [project]);

  useEffect(() => {
    if (!id) {
      const names = stampNames(t);
      form.setFieldsValue({ ...names, remark: '', schedule: false });
      const nextKind = (searchParams.get('kind') as Kind) || 'condition';
      setKind(nextKind);
      setConditions([defaultDidEvent()]);
      setSqlText(DEFAULT_SQL_TEXT);
      setTimeParams(DEFAULT_SQL_TIME_PARAMS);
      setPreviewRows(null);
      return;
    }
    getCohort(id)
      .then((row) => {
        form.setFieldsValue({
          display_name: row.display_name,
          name: row.name,
          remark: row.remark ?? '',
          schedule: row.schedule === 'daily',
        });
        setSavedCount(row.member_count);
        if (row.subject_id) setSubjectId(row.subject_id);
        if (row.kind === 'result') {
          setReadonlyResult(true);
          setKind('condition');
          return;
        }
        setKind(row.kind);
        const def = row.definition_json as {
          conditions?: CohortCondition[];
          sql_text?: string;
          time_params?: SqlTimeParam[];
        };
        if (row.kind === 'condition' && Array.isArray(def.conditions) && def.conditions.length > 0) {
          setConditions(def.conditions);
        }
        if (row.kind === 'sql') {
          setSqlText(typeof def.sql_text === 'string' ? def.sql_text : DEFAULT_SQL_TEXT);
          setTimeParams(
            Array.isArray(def.time_params) && def.time_params.length > 0
              ? def.time_params
              : DEFAULT_SQL_TIME_PARAMS,
          );
        }
      })
      .catch(() => {
        message.error(t('cohort:cohortEdit.notFound'));
        navigate('/analysis/cohorts');
      });
  }, [form, id, navigate, searchParams, t]);

  const downloadTemplate = async () => {
    const file = await getCohortTemplate();
    const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const sqlDefinition = () => ({ sql_text: sqlText, time_params: timeParams });

  /** 试跑：按当前草稿实时算一次人数与样例，不保存、不落成员表 */
  const handleConditionPreview = async () => {
    const found = validateConditions(conditions, t);
    setIssues(found);
    if (found.length > 0) {
      message.warning(t('cohort:cohortEdit.fixConditions'));
      return;
    }
    setPreviewing(true);
    try {
      const res = await previewConditionCohort({
        definition_json: { conditions },
        subject_id: subjectId,
        limit: 20,
      });
      setPreview({ count: res.count, items: res.items, truncated: res.truncated, limit: res.limit });
    } finally {
      setPreviewing(false);
    }
  };

  const handleReupload = async () => {
    if (!id) return;
    if (!reuploadText.trim()) {
      message.warning(t('cohort:cohortEdit.uploadCsvRequired'));
      return;
    }
    setReuploading(true);
    try {
      await replaceCohortMembers(id, reuploadText);
      message.success(t('cohort:cohortEdit.reuploadDone'));
      navigate('/analysis/cohorts');
    } finally {
      setReuploading(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const res = await previewSqlCohort({ definition_json: sqlDefinition() });
      setPreviewRows(res.items);
      if (res.truncated) message.info(t('cohort:cohortEdit.previewTruncated'));
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setPreviewing(false);
    }
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (kind === 'condition' && !readonlyResult) {
      const found = validateConditions(conditions, t);
      setIssues(found);
      if (found.length > 0) {
        message.warning(t('cohort:cohortEdit.fixConditions'));
        return;
      }
    }
    setSaving(true);
    try {
      if (isEdit && id) {
        await updateCohort(id, {
          display_name: values.display_name,
          remark: values.remark,
          schedule:
            kind === 'condition' || kind === 'sql' ? (values.schedule ? 'daily' : 'manual') : 'manual',
          definition_json:
            kind === 'condition' ? { conditions } : kind === 'sql' ? sqlDefinition() : undefined,
        });
        message.success(t('cohort:message.saved'));
      } else if (kind === 'id_upload') {
        if (!csvText.trim()) {
          message.warning(t('cohort:cohortEdit.uploadCsvRequired'));
          return;
        }
        await createCohort({
          name: values.name,
          display_name: values.display_name,
          remark: values.remark,
          kind: 'id_upload',
          definition_json: { match: 'uid' },
          csv_text: csvText,
          subject_id: subjectId,
        });
        message.success(t('cohort:cohortEdit.createdMatchingUsers'));
      } else if (kind === 'sql') {
        await createCohort({
          name: values.name,
          display_name: values.display_name,
          remark: values.remark,
          kind: 'sql',
          schedule: values.schedule ? 'daily' : 'manual',
          definition_json: sqlDefinition(),
          subject_id: subjectId,
        });
        message.success(t('cohort:message.createdComputing'));
      } else {
        await createCohort({
          name: values.name,
          display_name: values.display_name,
          remark: values.remark,
          kind: 'condition',
          schedule: values.schedule ? 'daily' : 'manual',
          definition_json: { conditions },
          subject_id: subjectId,
        });
        message.success(t('cohort:message.createdComputing'));
      }
      navigate('/analysis/cohorts');
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={titleFor(kind, isEdit, readonlyResult, t)}
      extra={<Button onClick={() => navigate('/analysis/cohorts')}>{t('cohort:action.backToList')}</Button>}
    >
      <Form form={form} layout="vertical" style={{ maxWidth: 720 }}>
        <Form.Item name="display_name" label={t('cohort:label.displayName')} rules={[{ required: true, message: t('cohort:rule.requiredDisplayName') }]}>
          <Input maxLength={80} disabled={readonlyResult} />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('cohort:label.cohortName')}
          rules={[
            { required: true, message: t('cohort:rule.requiredCohortName') },
            { pattern: /^[a-z][a-z0-9_]{0,79}$/, message: t('cohort:rule.cohortNamePattern') },
          ]}
        >
          <Input maxLength={80} disabled={isEdit} />
        </Form.Item>
        <Form.Item name="remark" label={t('common:label.remark')}>
          <Input.TextArea maxLength={200} rows={2} disabled={readonlyResult} />
        </Form.Item>
        <Form.Item label={t('cohort:label.subject')}>
          <SubjectSelect value={subjectId} onChange={setSubjectId} disabled={isEdit || readonlyResult} />
        </Form.Item>
        {(kind === 'condition' || kind === 'sql') && !readonlyResult ? (
          <Form.Item name="schedule" label={t('cohort:label.scheduleSwitch')} valuePropName="checked">
            <Switch checkedChildren={t('cohort:option.daily')} unCheckedChildren={t('cohort:option.manual')} />
          </Form.Item>
        ) : null}
      </Form>
      {readonlyResult ? (
        <Typography.Paragraph type="secondary">{t('cohort:cohortEdit.resultReadonly')}</Typography.Paragraph>
      ) : null}
      {kind === 'condition' && !readonlyResult ? (
        <div>
          <Typography.Paragraph strong>{t('cohort:cohortEdit.conditionSection')}</Typography.Paragraph>
          {conditions.map((condition, index) => {
            const issue = issues.find((item) => item.index === index);
            return (
              <div
                key={index}
                style={{
                  marginBottom: 12,
                  padding: issue ? '6px 8px' : 0,
                  border: issue ? '1px solid #ff4d4f' : 'none',
                  borderRadius: 6,
                }}
              >
                <ConditionSentenceEditor
                  value={condition}
                  onChange={(next) => setConditions((prev) => prev.map((item, i) => (i === index ? next : item)))}
                  allowDidNot={allowDidNot}
                  onRemove={
                    conditions.length > 1
                      ? () => setConditions((prev) => prev.filter((_, i) => i !== index))
                      : undefined
                  }
                  userProperties={userProperties}
                />
                {issue ? (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {issue.message}
                  </Typography.Text>
                ) : null}
              </div>
            );
          })}
          <Space wrap>
            <Dropdown
              menu={{
                items: [
                  { key: 'did_event', label: t('cohort:cohortEdit.conditionKindDidEvent') },
                  { key: 'sequence', label: t('cohort:cohortEdit.conditionKindSequence') },
                  { key: 'user_prop', label: t('cohort:cohortEdit.conditionKindUserProp') },
                ],
                onClick: ({ key }) => {
                  const next =
                    key === 'sequence' ? defaultSequence() : key === 'user_prop' ? defaultUserProp() : defaultDidEvent();
                  setConditions((prev) => [...prev, next]);
                },
              }}
            >
              <Button icon={<PlusOutlined />}>{t('cohort:cohortEdit.addCondition')}</Button>
            </Dropdown>
            <Button icon={<ThunderboltOutlined />} loading={previewing} onClick={() => void handleConditionPreview()}>
              {t('cohort:cohortEdit.previewRun')}
            </Button>
          </Space>
          {preview ? (
            <Alert
              style={{ marginTop: 12 }}
              type={preview.count === 0 ? 'warning' : 'info'}
              showIcon
              message={
                preview.count === 0
                  ? t('cohort:cohortEdit.previewEmpty')
                  : t('cohort:cohortEdit.previewCount', { count: preview.count })
              }
              description={
                <Space direction="vertical" size={4}>
                  {savedCount !== null ? (
                    <Typography.Text type="secondary">
                      {t('cohort:cohortEdit.previewSaved', { count: savedCount })} ·{' '}
                      {preview.count === savedCount
                        ? t('cohort:cohortEdit.previewSame')
                        : preview.count > savedCount
                          ? t('cohort:cohortEdit.previewDiffUp', { delta: preview.count - savedCount })
                          : t('cohort:cohortEdit.previewDiffDown', { delta: savedCount - preview.count })}
                    </Typography.Text>
                  ) : null}
                  {preview.items.length > 0 ? (
                    /* UID 预览是用户数据（无空格长串），需要可折行，但不用 break-all：
                       break-all 会把任意文本逐字符切断（AGENTS_front 红线）；
                       overflow-wrap: break-word 只在整词放不下时才断，对 UID 效果一致。 */
                    <Typography.Text type="secondary" style={{ overflowWrap: 'break-word' }}>
                      {preview.items.map((item) => item.uid).join(', ')}
                      {preview.truncated
                        ? ` … ${t('cohort:cohortEdit.previewSampleMore', { limit: preview.limit })}`
                        : ''}
                    </Typography.Text>
                  ) : null}
                  <Typography.Text type="secondary">{t('cohort:cohortEdit.previewHint')}</Typography.Text>
                </Space>
              }
            />
          ) : null}
        </div>
      ) : null}
      {kind === 'sql' && !readonlyResult ? (
        <SqlCohortForm
          sqlText={sqlText}
          timeParams={timeParams}
          onSqlChange={setSqlText}
          onTimeParamsChange={setTimeParams}
          previewing={previewing}
          previewRows={previewRows ?? undefined}
          onPreview={() => void handlePreview()}
        />
      ) : null}
      {kind === 'id_upload' ? (
        <div>
          <Typography.Paragraph type="secondary">
            {isEdit ? t('cohort:cohortEdit.reuploadHint') : t('cohort:cohortEdit.uploadHint')}
          </Typography.Paragraph>
          {isEdit ? (
            <Typography.Paragraph strong>{t('cohort:cohortEdit.reuploadTitle')}</Typography.Paragraph>
          ) : null}
          <Button style={{ marginRight: 8 }} onClick={() => void downloadTemplate()}>
            {t('cohort:cohortEdit.downloadTemplate')}
          </Button>
          <Upload
            accept=".csv,text/csv"
            maxCount={1}
            beforeUpload={(file) => {
              const reader = new FileReader();
              const apply = isEdit ? setReuploadText : setCsvText;
              reader.onload = () => apply(String(reader.result ?? ''));
              reader.readAsText(file, 'UTF-8');
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>{t('cohort:cohortEdit.uploadCsv')}</Button>
          </Upload>
          {(() => {
            const text = isEdit ? reuploadText : csvText;
            if (!text) return null;
            const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
            return (
              <>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>
                  {t('cohort:cohortEdit.rowsRead', { count })}
                </Typography.Paragraph>
                {isEdit ? (
                  <Button type="primary" loading={reuploading} onClick={() => void handleReupload()}>
                    {t('cohort:cohortEdit.reuploadSubmit')}
                  </Button>
                ) : null}
              </>
            );
          })()}
        </div>
      ) : null}
      {!readonlyResult ? (
        <Button type="primary" loading={saving} onClick={() => void handleSave()} style={{ marginTop: 24 }}>
          {t('common:action.save')}
        </Button>
      ) : null}
    </Card>
  );
}
