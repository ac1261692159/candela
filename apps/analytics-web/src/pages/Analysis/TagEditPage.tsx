import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Dropdown, Form, Input, Space, Switch, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { ConditionSentenceEditor } from '../../features/cohort/ConditionSentenceEditor';
import {
  defaultDidEvent,
  defaultSequence,
  defaultUserProp,
  type CohortCondition,
} from '../../features/cohort/cohort-condition';
import { stampTagNames } from '../../features/tag/tag-values';
import { createTag, getTag, updateTag } from '../../services/tag.service';
import { getUserProperties } from '../../services/meta.service';
import { useProjectStore } from '../../stores/project.store';
import type { MetaUserProperty } from '../../types/meta.types';
import { SubjectSelect } from '../../features/subject/SubjectSelect';
import { subjectForbidsDidNot, useSubjects } from '../../features/subject/use-subjects';
import { useT } from '../../i18n';

type TagRule = { value: string; conditions: CohortCondition[] };

function emptyRule(): TagRule {
  return { value: '', conditions: [defaultDidEvent()] };
}

export function TagEditPage() {
  const { t } = useT('cohort');
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const project = useProjectStore((state) => state.currentProject);
  const [form] = Form.useForm();
  const [rules, setRules] = useState<TagRule[]>([emptyRule(), emptyRule()]);
  const [saving, setSaving] = useState(false);
  const [userProperties, setUserProperties] = useState<MetaUserProperty[]>([]);
  const [subjectId, setSubjectId] = useState<string | undefined>();
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
      form.setFieldsValue({ ...stampTagNames(t), remark: '', schedule: false, default_value: '' });
      setRules([emptyRule(), emptyRule()]);
      return;
    }
    getTag(id)
      .then((row) => {
        const def = row.definition_json as { rules?: TagRule[]; default_value?: string };
        form.setFieldsValue({
          display_name: row.display_name,
          name: row.name,
          remark: row.remark ?? '',
          schedule: row.schedule === 'daily',
          default_value: def.default_value ?? '',
        });
        if (row.subject_id) setSubjectId(row.subject_id);
        if (Array.isArray(def.rules) && def.rules.length >= 2) {
          setRules(
            def.rules.map((rule) => ({
              value: rule.value,
              conditions: rule.conditions?.length ? rule.conditions : [defaultDidEvent()],
            })),
          );
        }
      })
      .catch(() => {
        message.error(t('cohort:tagEdit.notFound'));
        navigate('/analysis/tags');
      });
  }, [form, id, navigate, t]);

  const patchRule = (index: number, patch: Partial<TagRule>) => {
    setRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (rules.length < 2) {
      message.warning(t('cohort:tagEdit.minRules'));
      return;
    }
    if (rules.some((rule) => !rule.value.trim())) {
      message.warning(t('cohort:tagEdit.valueRequired'));
      return;
    }
    setSaving(true);
    try {
      const definition_json = {
        rules: rules.map((rule) => ({ value: rule.value.trim(), conditions: rule.conditions })),
        ...(values.default_value?.trim() ? { default_value: values.default_value.trim() } : {}),
      };
      if (isEdit && id) {
        await updateTag(id, {
          display_name: values.display_name,
          remark: values.remark,
          schedule: values.schedule ? 'daily' : 'manual',
          definition_json,
        });
        message.success(t('cohort:message.saved'));
      } else {
        await createTag({
          name: values.name,
          display_name: values.display_name,
          remark: values.remark,
          schedule: values.schedule ? 'daily' : 'manual',
          definition_json,
          subject_id: subjectId,
        });
        message.success(t('cohort:message.createdComputing'));
      }
      navigate('/analysis/tags');
    } catch (err) {
      if (err instanceof Error && err.message) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={isEdit ? t('cohort:tagEdit.titleEdit') : t('cohort:tagEdit.titleCreate')}
      extra={<Button onClick={() => navigate('/analysis/tags')}>{t('cohort:action.backToList')}</Button>}
    >
      <Form form={form} layout="vertical" style={{ maxWidth: 720 }}>
        <Form.Item name="display_name" label={t('cohort:label.displayName')} rules={[{ required: true, message: t('cohort:rule.requiredDisplayName') }]}>
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('cohort:label.tagName')}
          rules={[
            { required: true, message: t('cohort:rule.requiredTagName') },
            { pattern: /^[a-z][a-z0-9_]{0,79}$/, message: t('cohort:rule.cohortNamePattern') },
          ]}
        >
          <Input maxLength={80} disabled={isEdit} />
        </Form.Item>
        <Form.Item name="remark" label={t('common:label.remark')}>
          <Input.TextArea maxLength={200} rows={2} />
        </Form.Item>
        <Form.Item name="default_value" label={t('cohort:label.defaultValue')}>
          <Input maxLength={40} placeholder={t('cohort:tagEdit.defaultValuePlaceholder')} />
        </Form.Item>
        <Form.Item name="schedule" label={t('cohort:label.scheduleSwitch')} valuePropName="checked">
          <Switch checkedChildren={t('cohort:option.daily')} unCheckedChildren={t('cohort:option.manual')} />
        </Form.Item>
        <Form.Item label={t('cohort:label.subject')}>
          <SubjectSelect value={subjectId} onChange={setSubjectId} disabled={isEdit} />
        </Form.Item>
      </Form>
      <Typography.Paragraph type="secondary">
        {t('cohort:tagEdit.hint')}
      </Typography.Paragraph>
      {rules.map((rule, ruleIndex) => (
        <div key={ruleIndex} style={{ marginBottom: 20, padding: 12, border: '1px solid #f0f0f0', borderRadius: 8 }}>
          <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
            <Typography.Text strong>{t('cohort:tagEdit.ruleTitle', { index: ruleIndex + 1 })}</Typography.Text>
            {rules.length > 2 ? (
              <Button
                size="small"
                danger
                type="text"
                onClick={() => setRules((prev) => prev.filter((_, i) => i !== ruleIndex))}
              >
                {t('cohort:tagEdit.removeRule')}
              </Button>
            ) : null}
          </Space>
          <Input
            value={rule.value}
            onChange={(e) => patchRule(ruleIndex, { value: e.target.value })}
            placeholder={t('cohort:tagEdit.ruleValuePlaceholder')}
            maxLength={40}
            style={{ marginBottom: 12 }}
          />
          {rule.conditions.map((condition, index) => (
            <div key={index} style={{ marginBottom: 12 }}>
              <ConditionSentenceEditor
                value={condition}
                onChange={(next) =>
                  patchRule(ruleIndex, {
                    conditions: rule.conditions.map((item, i) => (i === index ? next : item)),
                  })
                }
                allowDidNot={allowDidNot}
                onRemove={
                  rule.conditions.length > 1
                    ? () =>
                        patchRule(ruleIndex, {
                          conditions: rule.conditions.filter((_, i) => i !== index),
                        })
                    : undefined
                }
                userProperties={userProperties}
              />
            </div>
          ))}
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
                patchRule(ruleIndex, { conditions: [...rule.conditions, next] });
              },
            }}
          >
            <Button icon={<PlusOutlined />}>{t('common:action.addCondition')}</Button>
          </Dropdown>
        </div>
      ))}
      <Button
        icon={<PlusOutlined />}
        onClick={() => setRules((prev) => [...prev, emptyRule()])}
        disabled={rules.length >= 20}
      >
        {t('cohort:tagEdit.addRule')}
      </Button>
      <div>
        <Button type="primary" loading={saving} onClick={() => void handleSave()} style={{ marginTop: 24 }}>
          {t('common:action.save')}
        </Button>
      </div>
    </Card>
  );
}
