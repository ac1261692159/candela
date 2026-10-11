import { useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Typography, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { EventMetricEditor, createEventMetric, createFormulaMetric } from './event-metric-editor/EventMetricEditor';
import { FilterEditor, emptyFilterItem } from '../../components/FilterEditor';
import { getDatatableLabels } from '../../services/datatable.service';
import { GroupEditor, createGroupItem, groupAddMenuItems } from '../../components/GroupEditor';
import { QueryStep } from './QueryStep';
import { lastNDaysRange, pickExampleEvents } from './example-query';
import { ApplySavedMetricButton } from '../metrics/ApplySavedMetricButton';
import { appendEventMetric, metricFromSavedEvent } from '../metrics/apply-saved-metric';
import { useProjectStore } from '../../stores/project.store';
import {
  getEvents,
  getEventProperties,
  getUserProperties,
  getVirtualProperties,
} from '../../services/meta.service';
import { buildEventQuery, hydrateEventForm, newMetricId, type EventAnalysisFormState } from '../../utils/dsl-builder';
import type { TFunction } from '../../i18n';
import type { MetaEvent, MetaEventProperty, MetaUserProperty, MetaVirtualProperty } from '../../types/meta.types';
import type { MetricItem, FilterGroup, GroupItem, TimeRange, FilterItem } from '../../types/dsl.types';
import { ANY_EVENT, MAX_EVENT_METRICS } from '../../types/dsl.types';
import { labeledEventProperties } from '../../components/event-property-options';
import { useDatatableDimensions } from '../../components/use-datatable-dimensions';
import { useReadyCohorts } from '../cohort/use-ready-cohorts';
import { useReadyTags } from '../tag/use-ready-tags';
import { SubjectSelect } from '../subject/SubjectSelect';

interface EventAnalysisFormProps {
  onAnalyze: (dsl: EventAnalysisFormState) => void;
  loading?: boolean;
  initialForm?: EventAnalysisFormState;
  /** 时间范围受控值（提升到 Page 层，供结果区工具条显示） */
  timeRange?: TimeRange;
  onTimeRangeChange?: (timeRange: TimeRange) => void;
  /** 当前表单变化上报（Page 层「计算」按钮用最新表单发起计算） */
  onFormChange?: (form: EventAnalysisFormState) => void;
}

/** 默认表单（默认指标别名按当前语言取，故为工厂函数） */
const createDefaultForm = (t: TFunction): EventAnalysisFormState => ({
  metrics: [
    {
      id: 'm_0',
      kind: 'event',
      analysis: 'total_times',
      alias: t('analysis:analysisMethod.totalTimes'),
    },
  ],
  filters: { logic: 'and', items: [] },
  groups: [{ scope: 'time', granularity: 'day' }],
  timeRange: lastNDaysRange(7),
});

export function EventAnalysisForm({
  onAnalyze,
  loading,
  initialForm,
  timeRange: controlledTimeRange,
  onTimeRangeChange,
  onFormChange,
}: EventAnalysisFormProps) {
  const { t } = useT('analysis');
  const [form, setForm] = useState<EventAnalysisFormState>(() =>
    hydrateEventForm(initialForm ?? createDefaultForm(t)),
  );
  // 时间范围受控提升：外部传入则以外部为准（工具条在结果区上方）
  const effectiveTimeRange = controlledTimeRange ?? form.timeRange;
  const effectiveForm = useMemo(
    () => ({ ...form, timeRange: effectiveTimeRange }),
    [form, effectiveTimeRange],
  );
  const [events, setEvents] = useState<MetaEvent[]>([]);
  const [userProperties, setUserProperties] = useState<MetaUserProperty[]>([]);
  const [propMap, setPropMap] = useState<
    Record<string, { event: MetaEventProperty[]; virtual: MetaVirtualProperty[] }>
  >({});
  const project = useProjectStore((state) => state.currentProject);
  const cohorts = useReadyCohorts(form.subjectId);
  const tags = useReadyTags(form.subjectId);
  const dimensionProperties = useDatatableDimensions();

  useEffect(() => {
    getEvents({ pageSize: 100, exclude_hidden: true })
      .then((res) => setEvents(res.items))
      .catch(() => setEvents([]));
  }, [project]);

  useEffect(() => {
    getUserProperties()
      .then((res) => setUserProperties(res.items))
      .catch(() => setUserProperties([]));
  }, [project]);

  useEffect(() => {
    form.metrics.forEach((metric) => {
      if (metric.event && metric.event !== ANY_EVENT && metric.kind !== 'formula') void loadProperties(metric.event);
    });
  }, [form.metrics, project]);

  const loadProperties = async (eventKey: string) => {
    if (propMap[eventKey]) return;
    try {
      const [eventProps, virtualProps] = await Promise.all([
        getEventProperties(eventKey),
        getVirtualProperties(eventKey),
      ]);
      setPropMap((prev) => ({
        ...prev,
        [eventKey]: { event: eventProps, virtual: virtualProps },
      }));
    } catch {
      setPropMap((prev) => ({ ...prev, [eventKey]: { event: [], virtual: [] } }));
    }
  };

  const patchForm = (patch: Partial<EventAnalysisFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const groupAttrCount = form.groups.filter((g) => g.scope !== 'time').length;
  const [applyOpen, setApplyOpen] = useState(false);

  const combinedEventProperties = useMemo(() => {
    const seen = new Set<string>();
    const rows: { prop_key: string; display_name?: string; data_type?: string }[] = [];
    for (const metric of form.metrics) {
      const pack = metric.event ? propMap[metric.event] : undefined;
      const listed = labeledEventProperties(pack);
      for (const prop of listed) {
        if (seen.has(prop.prop_key)) continue;
        seen.add(prop.prop_key);
        rows.push(prop);
      }
    }
    const withDims = [...rows];
    for (const prop of labeledEventProperties(undefined, dimensionProperties)) {
      if (seen.has(prop.prop_key)) continue;
      seen.add(prop.prop_key);
      withDims.push(prop);
    }
    return { event: rows, all: withDims };
  }, [form.metrics, propMap, dimensionProperties]);

  // 表单变化上报（Page 层「计算」按钮取最新表单）
  useEffect(() => {
    onFormChange?.(effectiveForm);
  }, [effectiveForm, onFormChange]);

  const handleSubmit = () => {
    try {
      buildEventQuery(effectiveForm, project);
      onAnalyze(effectiveForm);
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('analysis:message.formInvalid'));
    }
  };

  const handleExample = () => {
    const { first, second } = pickExampleEvents(events);
    if (!first) {
      message.warning(t('analysis:message.noVisibleEvents'));
      return;
    }
    const metrics: MetricItem[] = [
      {
        id: newMetricId(),
        kind: 'event',
        analysis: 'total_times',
        alias: t('analysis:analysisMethod.totalTimes'),
        event: first,
      },
    ];
    if (second && second !== first) {
      metrics.push({
        id: newMetricId(),
        kind: 'event',
        analysis: 'trig_user_num',
        alias: t('analysis:analysisMethod.trigUserNum'),
        event: second,
      });
    }
    const next: EventAnalysisFormState = {
      metrics,
      filters: { logic: 'and', items: [] },
      groups: [{ scope: 'time', granularity: 'day' }],
      timeRange: lastNDaysRange(7),
    };
    setForm(next);
    onTimeRangeChange?.(next.timeRange);
    onAnalyze(next);
  };

  return (
    <div className="analysis-editor">
      <div className="analysis-editor__body">
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {t('analysis:event.title')}
      </Typography.Title>
      <QueryStep title={t('analysis:subject.section')}>
        <SubjectSelect value={form.subjectId} onChange={(subjectId) => patchForm({ subjectId })} />
      </QueryStep>
      <QueryStep
        title={t('analysis:metric.section')}
        extra={
          <Dropdown
            trigger={['click']}
            // 弹出层挂到 body 并朝左下展开：否则窄配置轨里菜单会被裁切（AGENTS_front §8）
            getPopupContainer={() => document.body}
            placement="bottomRight"
            overlayStyle={{ minWidth: 150 }}
            menu={{
              items: [
                { key: 'metric', label: t('analysis:metric.add') },
                { key: 'formula', label: t('analysis:metric.addFormula') },
                { key: 'apply', label: t('analysis:metric.applySaved') },
              ],
              onClick: ({ key }) => {
                if (key === 'metric') {
                  patchForm({ metrics: [...form.metrics, createEventMetric()] });
                } else if (key === 'formula') {
                  if (!form.metrics.some((m) => m.kind !== 'formula')) {
                    message.warning(t('analysis:message.addEventMetricFirst'));
                    return;
                  }
                  patchForm({ metrics: [...form.metrics, createFormulaMetric(form.metrics)] });
                } else {
                  setApplyOpen(true);
                }
              },
            }}
          >
            <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('analysis:metric.add')} />
          </Dropdown>
        }
      >
        <EventMetricEditor
          value={form.metrics}
          onChange={(metrics: MetricItem[]) => patchForm({ metrics })}
          userProperties={userProperties}
          propMap={propMap}
          onNeedProperties={(eventKey) => void loadProperties(eventKey)}
          tags={tags}
          hideAddActions
          loadValueLabels={getDatatableLabels}
          dimensionProperties={dimensionProperties}
        />
      </QueryStep>
      <QueryStep
        title={t('analysis:filter.global')}
        dimmed={form.filters.items.length === 0}
        extra={
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'condition', label: t('analysis:filter.addCondition') },
                { key: 'group', label: t('analysis:filter.addGroup') },
              ],
              onClick: ({ key }) => {
                const item: FilterItem | FilterGroup =
                  key === 'group'
                    ? { logic: 'and', items: [emptyFilterItem()] }
                    : emptyFilterItem();
                patchForm({ filters: { ...form.filters, items: [...form.filters.items, item] } });
              },
            }}
          >
            <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('analysis:filter.addAria')} />
          </Dropdown>
        }
      >
        <FilterEditor
          value={form.filters}
          onChange={(filters: FilterGroup) => patchForm({ filters })}
          eventProperties={combinedEventProperties.all}
          userProperties={userProperties}
          cohorts={cohorts}
          tags={tags}
          hideAddActions
          loadValueLabels={getDatatableLabels}
        />
      </QueryStep>
      <QueryStep
        title={t('analysis:group.items')}
        dimmed={form.groups.length === 0}
        extra={
          <Dropdown
            trigger={['click']}
            menu={{
              items: groupAddMenuItems({
                attrCount: groupAttrCount,
                hasCohorts: cohorts.length > 0,
                hasTags: tags.length > 0,
              }),
              onClick: ({ key }) => {
                patchForm({ groups: [...form.groups, createGroupItem(key as GroupItem['scope'])] });
              },
            }}
          >
            <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('analysis:group.addAria')} />
          </Dropdown>
        }
      >
        <GroupEditor
          value={form.groups}
          onChange={(groups: GroupItem[]) => patchForm({ groups })}
          eventProperties={combinedEventProperties.event}
          dimensionProperties={dimensionProperties}
          userProperties={userProperties}
          cohorts={cohorts}
          tags={tags}
          hideAddActions
        />
      </QueryStep>
      {/* 时间范围已移至结果区上方（AnalysisToolbar） */}
      <Button type="link" size="small" style={{ paddingLeft: 0 }} onClick={handleExample}>
        {t('analysis:action.fillExample')}
      </Button>
      <ApplySavedMetricButton
        kind="event"
        hideTrigger
        open={applyOpen}
        onOpenChange={setApplyOpen}
        onPick={(saved) => {
          const incoming = metricFromSavedEvent(saved, `m_${Date.now()}`);
          if (!incoming) {
            message.warning(t('analysis:message.metricNotApplicableEvent'));
            return;
          }
          const next = appendEventMetric(form.metrics, incoming);
          if (next.length > MAX_EVENT_METRICS) {
            message.warning(t('analysis:message.maxMetrics', { max: MAX_EVENT_METRICS }));
            return;
          }
          patchForm({ metrics: next });
          if (incoming.event && incoming.event !== ANY_EVENT) void loadProperties(incoming.event);
        }}
      />
      {/* 「近似计算 + 计算」作为 body 内最末一组控件（不再 sticky 于侧栏底部） */}
      <div className="analysis-editor__bottom-actions">
        <span
          className="approx-hint approx-hint--enabled"
          title={t('analysis:approx.hintEvent')}
        >
          <input
            type="checkbox"
            checked={Boolean(form.approx)}
            onChange={(e) => patchForm({ approx: e.target.checked })}
          />{' '}
          {t('analysis:approx.label')} <span className="approx-i">i</span>
        </span>
        <Button type="primary" loading={loading} onClick={handleSubmit}>
          {t('analysis:action.calculate')}
        </Button>
      </div>
    </div>
    </div>
  );
}
