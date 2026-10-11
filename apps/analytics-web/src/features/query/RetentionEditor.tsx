import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dropdown, InputNumber, Radio, Select, Tag, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { labeledEventProperties } from '../../components/event-property-options';
import { useDatatableDimensions } from '../../components/use-datatable-dimensions';
import { useReadyCohorts } from '../cohort/use-ready-cohorts';
import { useReadyTags } from '../tag/use-ready-tags';
import { SubjectSelect } from '../subject/SubjectSelect';
import { FilterEditor, emptyFilterItem } from '../../components/FilterEditor';
import { getDatatableLabels } from '../../services/datatable.service';
import { SELECT_POPUP } from '../../components/select-popup';
import { EventSelect } from '../../components/EventSelect';
import { QueryStep } from './QueryStep';
import { lastNDaysRange, pickExampleEvents } from './example-query';
import { useProjectStore } from '../../stores/project.store';
import {
  getEvents,
  getEventProperties,
  getUserProperties,
  getVirtualProperties,
} from '../../services/meta.service';
import { buildRetentionQuery, type RetentionFormState } from '../../utils/dsl-builder';
import type { FilterGroup, FilterItem, TimeRange } from '../../types/dsl.types';
import { isAnyEvent } from '../../types/dsl.types';
import type {
  MetaEvent,
  MetaEventProperty,
  MetaUserProperty,
  MetaVirtualProperty,
} from '../../types/meta.types';
import { ApplySavedMetricButton } from '../metrics/ApplySavedMetricButton';
import { applyRetentionDefinition } from '../metrics/apply-saved-metric';

interface RetentionEditorProps {
  onAnalyze: (form: RetentionFormState) => void;
  loading?: boolean;
  initialForm?: RetentionFormState;
  /** 时间范围受控值（提升到 Page 层，供结果区工具条显示） */
  timeRange?: TimeRange;
  onTimeRangeChange?: (timeRange: TimeRange) => void;
  /** 当前表单变化上报（Page 层「计算」按钮用最新表单发起计算） */
  onFormChange?: (form: RetentionFormState) => void;
}

const emptyFilters: FilterGroup = { logic: 'and', items: [] };

const defaultForm: RetentionFormState = {
  startEvent: '',
  returnEvent: '',
  startFilters: { ...emptyFilters },
  returnFilters: { ...emptyFilters },
  filters: { ...emptyFilters },
  groupCohortId: undefined,
  groupTagId: undefined,
  cohort: 'all',
  granularity: 'day',
  nList: [1, 2, 3, 7],
  timeRange: lastNDaysRange(7),
};

const N_PRESETS = [1, 2, 3, 7, 15];

export function RetentionEditor({
  onAnalyze,
  loading,
  initialForm,
  timeRange: controlledTimeRange,
  onTimeRangeChange,
  onFormChange,
}: RetentionEditorProps) {
  const { t } = useT('analysis');
  const [form, setForm] = useState<RetentionFormState>(initialForm ?? defaultForm);
  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [userProperties, setUserProperties] = useState<MetaUserProperty[]>([]);
  const [propMap, setPropMap] = useState<
    Record<string, { event: MetaEventProperty[]; virtual: MetaVirtualProperty[] }>
  >({});
  const [customN, setCustomN] = useState<number | null>(null);
  const project = useProjectStore((state) => state.currentProject);
  const cohorts = useReadyCohorts(form.subjectId);
  const tags = useReadyTags(form.subjectId);
  const dimensionProperties = useDatatableDimensions();

  useEffect(() => {
    getEvents({ pageSize: 100, exclude_hidden: true })
      .then((res) => setEvents(res.items))
      .catch(() => setEvents([]));
    getUserProperties()
      .then((res) => setUserProperties(res.items))
      .catch(() => setUserProperties([]));
  }, [project]);

  useEffect(() => {
    [form.startEvent, form.returnEvent].forEach((eventKey) => {
      if (eventKey && !isAnyEvent(eventKey)) void loadProperties(eventKey);
    });
  }, [form.startEvent, form.returnEvent]);

  const loadProperties = async (eventKey: string) => {
    if (propMap[eventKey]) return;
    try {
      const [eventProps, virtualProps] = await Promise.all([
        getEventProperties(eventKey),
        getVirtualProperties(eventKey),
      ]);
      setPropMap((prev) => ({ ...prev, [eventKey]: { event: eventProps, virtual: virtualProps } }));
    } catch {
      setPropMap((prev) => ({ ...prev, [eventKey]: { event: [], virtual: [] } }));
    }
  };

  const patchForm = (patch: Partial<RetentionFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const combinedProps = (eventKey: string) =>
    labeledEventProperties(propMap[eventKey], dimensionProperties);

  const effectiveTimeRange = controlledTimeRange ?? form.timeRange;
  const effectiveForm = useMemo(
    () => ({ ...form, timeRange: effectiveTimeRange }),
    [form, effectiveTimeRange],
  );

  // 表单变化上报（Page 层「计算」按钮取最新表单）
  useEffect(() => {
    onFormChange?.(effectiveForm);
  }, [effectiveForm, onFormChange]);

  const handleExample = () => {
    const { first } = pickExampleEvents(events);
    if (!first) {
      message.warning(t('analysis:message.noVisibleEvents'));
      return;
    }
    const next: RetentionFormState = {
      ...defaultForm,
      startEvent: first,
      returnEvent: first,
      nList: [1, 2, 3, 7],
      timeRange: lastNDaysRange(7),
    };
    try {
      buildRetentionQuery(next, project);
      setForm(next);
      onTimeRangeChange?.(next.timeRange);
      onAnalyze(next);
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('analysis:message.exampleFailed'));
    }
  };

  const toggleN = (n: number, checked: boolean) => {
    const next = checked ? [...new Set([...form.nList, n])] : form.nList.filter((item) => item !== n);
    patchForm({ nList: next.sort((a, b) => a - b) });
  };

  return (
    <div className="analysis-editor">
      <div className="analysis-editor__body">
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {t('analysis:retention.title')}
      </Typography.Title>
      <QueryStep title={t('analysis:subject.section')}>
        <SubjectSelect value={form.subjectId} onChange={(subjectId) => patchForm({ subjectId })} />
      </QueryStep>
      <QueryStep
        title={t('analysis:retention.startEvent')}
        extra={
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'condition', label: t('analysis:filter.addCondition') },
                { key: 'group', label: t('analysis:filter.addGroup') },
              ],
              onClick: ({ key }) => {
                const filters = form.startFilters ?? { logic: 'and', items: [] };
                const item: FilterGroup | FilterItem =
                  key === 'group'
                    ? { logic: 'and', items: [emptyFilterItem()] }
                    : emptyFilterItem();
                patchForm({ startFilters: { ...filters, items: [...filters.items, item] } });
              },
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              aria-label={t('analysis:retention.addStartFilterAria')}
            />
          </Dropdown>
        }
      >
        <EventSelect
          value={form.startEvent || undefined}
          onChange={(startEvent) => patchForm({ startEvent })}
          showAnyEvent
          placeholder={t('analysis:retention.startEventPlaceholder')}
          style={{ width: '100%', marginBottom: 8 }}
        />
        {isAnyEvent(form.startEvent) ? (
          <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('analysis:message.anyEventSlow')}
          </Typography.Text>
        ) : null}
        <FilterEditor
          value={form.startFilters}
          onChange={(startFilters) => patchForm({ startFilters })}
          eventProperties={combinedProps(form.startEvent)}
          userProperties={userProperties}
          hideAddActions
          loadValueLabels={getDatatableLabels}
        />
      </QueryStep>
      <QueryStep
        title={t('analysis:retention.returnEvent')}
        extra={
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'condition', label: t('analysis:filter.addCondition') },
                { key: 'group', label: t('analysis:filter.addGroup') },
              ],
              onClick: ({ key }) => {
                const filters = form.returnFilters ?? { logic: 'and', items: [] };
                const item: FilterGroup | FilterItem =
                  key === 'group'
                    ? { logic: 'and', items: [emptyFilterItem()] }
                    : emptyFilterItem();
                patchForm({ returnFilters: { ...filters, items: [...filters.items, item] } });
              },
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              aria-label={t('analysis:retention.addReturnFilterAria')}
            />
          </Dropdown>
        }
      >
        <EventSelect
          value={form.returnEvent || undefined}
          onChange={(returnEvent) => patchForm({ returnEvent })}
          showAnyEvent
          placeholder={t('analysis:retention.returnEventPlaceholder')}
          style={{ width: '100%', marginBottom: 8 }}
        />
        {isAnyEvent(form.returnEvent) ? (
          <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('analysis:message.anyEventSlow')}
          </Typography.Text>
        ) : null}
        <FilterEditor
          value={form.returnFilters}
          onChange={(returnFilters) => patchForm({ returnFilters })}
          eventProperties={combinedProps(form.returnEvent)}
          userProperties={userProperties}
          hideAddActions
          loadValueLabels={getDatatableLabels}
        />
      </QueryStep>
      <QueryStep title={t('analysis:retention.criteriaSection')}>
        <Radio.Group
          value={form.cohort}
          onChange={(e) => patchForm({ cohort: e.target.value })}
          className="chrome-chip-group"
          optionType="button"
          buttonStyle="solid"
          size="small"
          style={{ marginBottom: 8 }}
          options={[
            { label: t('analysis:retention.allUsers'), value: 'all' },
            { label: t('analysis:retention.firstDayNewUsers'), value: 'first_day' },
          ]}
        />
        <Select
          {...SELECT_POPUP}
          value={form.granularity}
          onChange={(granularity) => patchForm({ granularity })}
          options={[
            { label: t('analysis:retention.byDay'), value: 'day' },
            { label: t('analysis:retention.byWeek'), value: 'week' },
            { label: t('analysis:retention.byMonth'), value: 'month' },
          ]}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {N_PRESETS.map((n) => (
            <Checkbox
              key={n}
              checked={form.nList.includes(n)}
              onChange={(e) => toggleN(n, e.target.checked)}
            >
              {form.granularity === 'week' ? `W${n}` : form.granularity === 'month' ? `M${n}` : `D${n}`}
            </Checkbox>
          ))}
          {form.nList
            .filter((n) => !N_PRESETS.includes(n))
            .map((n) => (
              <Tag key={n} closable onClose={() => toggleN(n, false)}>
                {form.granularity === 'week' ? `W${n}` : form.granularity === 'month' ? `M${n}` : `D${n}`}
              </Tag>
            ))}
        </div>
        <InputNumber
          min={1}
          max={90}
          value={customN ?? undefined}
          onChange={(value) => setCustomN(value)}
          addonBefore={t('analysis:retention.customN')}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <Button
          size="small"
          disabled={!customN}
          onClick={() => {
            if (customN) toggleN(customN, true);
          }}
        >
          {t('analysis:retention.addPeriod')}
        </Button>
      </QueryStep>
      <QueryStep
        title={t('analysis:filter.global')}
        dimmed={(form.filters?.items ?? []).length === 0}
        extra={
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'condition', label: t('analysis:filter.addCondition') },
                { key: 'group', label: t('analysis:filter.addGroup') },
              ],
              onClick: ({ key }) => {
                const filters = form.filters ?? { logic: 'and', items: [] };
                const item: FilterGroup | FilterItem =
                  key === 'group'
                    ? { logic: 'and', items: [emptyFilterItem()] }
                    : emptyFilterItem();
                patchForm({ filters: { ...filters, items: [...filters.items, item] } });
              },
            }}
          >
            <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('analysis:filter.addAria')} />
          </Dropdown>
        }
      >
        <FilterEditor
          value={form.filters ?? { logic: 'and', items: [] }}
          onChange={(filters) => patchForm({ filters })}
          eventProperties={combinedProps(form.startEvent)}
          userProperties={userProperties}
          cohorts={cohorts}
          tags={tags}
          hideAddActions
          loadValueLabels={getDatatableLabels}
        />
      </QueryStep>
      {cohorts.length > 0 || tags.length > 0 ? (
        <QueryStep title={t('analysis:group.items')}>
          {tags.length > 0 ? (
            <Select
              {...SELECT_POPUP}
              allowClear
              placeholder={t('analysis:retention.groupByTagPlaceholder')}
              value={form.groupTagId}
              onChange={(groupTagId) => patchForm({ groupTagId, groupCohortId: undefined })}
              options={tags.map((tag) => ({
                label: `${tag.display_name} (${tag.name})`,
                value: tag.tag_id,
              }))}
              showSearch
              optionFilterProp="label"
              style={{ width: '100%', marginBottom: cohorts.length > 0 ? 8 : 0 }}
            />
          ) : null}
          {cohorts.length > 0 ? (
            <Select
              {...SELECT_POPUP}
              allowClear
              placeholder={t('analysis:retention.groupByCohortPlaceholder')}
              value={form.groupCohortId}
              onChange={(groupCohortId) => patchForm({ groupCohortId, groupTagId: undefined })}
              options={cohorts.map((cohort) => ({
                label: `${cohort.display_name} (${cohort.name})`,
                value: cohort.cohort_id,
              }))}
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
            />
          ) : null}
        </QueryStep>
      ) : null}
      {/* 时间范围与「计算」按钮已移至底部常驻条 / 结果上方工具条 */}
      <QueryStep title={t('analysis:retention.applyMetric')}>
        <ApplySavedMetricButton
          kind="retention"
          label={t('analysis:retention.applyMetric')}
          onPick={(saved) => {
            const next = applyRetentionDefinition(form, saved);
            if (!next) {
              message.warning(t('analysis:message.metricNotApplicableRetention'));
              return;
            }
            setForm(next);
            if (next.startEvent && !isAnyEvent(next.startEvent)) void loadProperties(next.startEvent);
            if (next.returnEvent && !isAnyEvent(next.returnEvent)) void loadProperties(next.returnEvent);
            message.success(t('analysis:message.metricApplied', { name: saved.display_name }));
          }}
        />
        <Button type="link" size="small" style={{ paddingLeft: 0 }} onClick={handleExample}>
          {t('analysis:action.fillExample')}
        </Button>
      </QueryStep>
      {/* 「近似计算 + 计算」作为 body 内最末一组控件（不再 sticky 于侧栏底部） */}
      <div className="analysis-editor__bottom-actions">
        <span className="approx-hint" title={t('analysis:approx.hintRetention')}>
          <input type="checkbox" disabled /> {t('analysis:approx.label')} <span className="approx-i">i</span>
        </span>
        <Button
          type="primary"
          loading={loading}
          onClick={() => {
            try {
              buildRetentionQuery(effectiveForm, project);
              onAnalyze(effectiveForm);
            } catch (err) {
              message.error(err instanceof Error ? err.message : t('analysis:message.formInvalid'));
            }
          }}
        >
          {t('analysis:action.calculate')}
        </Button>
      </div>
    </div>
    </div>
  );
}
