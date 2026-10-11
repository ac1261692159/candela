import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, InputNumber, Typography, message } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useT, type TFunction } from '../../i18n';
import { FilterEditor, emptyFilterItem } from '../../components/FilterEditor';
import { getDatatableLabels } from '../../services/datatable.service';
import { GroupEditor, createGroupItem, groupAddMenuItems } from '../../components/GroupEditor';
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
import { asEditorGroups, buildFunnelQuery, type FunnelFormState } from '../../utils/dsl-builder';
import type { FilterGroup, FilterItem, GroupItem, TimeRange } from '../../types/dsl.types';
import { MAX_FUNNEL_STEPS, MIN_FUNNEL_STEPS, isAnyEvent } from '../../types/dsl.types';
import { labeledEventProperties } from '../../components/event-property-options';
import { useDatatableDimensions } from '../../components/use-datatable-dimensions';
import { useReadyCohorts } from '../cohort/use-ready-cohorts';
import { useReadyTags } from '../tag/use-ready-tags';
import { SubjectSelect } from '../subject/SubjectSelect';
import {
  insertFunnelStepAfter,
  insertFunnelStepBefore,
  moveFunnelStep,
} from './funnel-editor-steps';
import type {
  MetaEvent,
  MetaEventProperty,
  MetaUserProperty,
  MetaVirtualProperty,
} from '../../types/meta.types';

interface FunnelEditorProps {
  onAnalyze: (form: FunnelFormState) => void;
  loading?: boolean;
  initialForm?: FunnelFormState;
  /** 时间范围受控值（提升到 Page 层，供结果区工具条显示） */
  timeRange?: TimeRange;
  onTimeRangeChange?: (timeRange: TimeRange) => void;
  /** 当前表单变化上报（Page 层「计算」按钮用最新表单发起计算） */
  onFormChange?: (form: FunnelFormState) => void;
}

const defaultFilters: FilterGroup = { logic: 'and', items: [] };

/** 默认表单（步骤别名按当前语言取，故为工厂函数） */
const createDefaultForm = (t: TFunction): FunnelFormState => ({
  steps: [
    { event: '', alias: t('analysis:funnel.stepIndex', { index: 1 }) },
    { event: '', alias: t('analysis:funnel.stepIndex', { index: 2 }) },
  ],
  timeRange: lastNDaysRange(7),
  windowDays: 7,
  filters: { ...defaultFilters },
});

export function FunnelEditor({
  onAnalyze,
  loading,
  initialForm,
  timeRange: controlledTimeRange,
  onTimeRangeChange,
  onFormChange,
}: FunnelEditorProps) {
  const { t } = useT('analysis');
  const [form, setForm] = useState<FunnelFormState>(() => {
    const base = initialForm ?? createDefaultForm(t);
    return { ...base, group: base.group ? asEditorGroups([base.group])[0] : undefined };
  });
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
    getUserProperties()
      .then((res) => setUserProperties(res.items))
      .catch(() => setUserProperties([]));
  }, [project]);

  useEffect(() => {
    form.steps.forEach((s) => {
      if (s.event && !isAnyEvent(s.event)) void loadProperties(s.event);
    });
  }, [form.steps]);

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

  const patchForm = (patch: Partial<FunnelFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const handleStepChange = (index: number, patch: Partial<FunnelFormState['steps'][number]>) => {
    const next = form.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    patchForm({ steps: next });
  };

  const stepKeySeq = useRef(form.steps.length);
  const [stepKeys, setStepKeys] = useState(() => form.steps.map((_, i) => `fs_${i}`));

  const warnIfFull = () => {
    if (form.steps.length >= MAX_FUNNEL_STEPS) {
      message.warning(t('analysis:message.maxFunnelSteps', { max: MAX_FUNNEL_STEPS }));
      return true;
    }
    return false;
  };

  const nextStepKey = () => {
    stepKeySeq.current += 1;
    return `fs_${stepKeySeq.current}`;
  };

  const handleInsertBefore = (index: number) => {
    if (warnIfFull()) return;
    const key = nextStepKey();
    patchForm({ steps: insertFunnelStepBefore(form.steps, index) });
    setStepKeys((keys) => {
      const next = [...keys];
      next.splice(index, 0, key);
      return next;
    });
  };

  const handleAddAfter = (index: number) => {
    if (warnIfFull()) return;
    const key = nextStepKey();
    patchForm({ steps: insertFunnelStepAfter(form.steps, index) });
    setStepKeys((keys) => {
      const next = [...keys];
      next.splice(index + 1, 0, key);
      return next;
    });
  };

  const handleMoveStep = (index: number, delta: -1 | 1) => {
    const next = moveFunnelStep(form.steps, index, delta);
    if (next === form.steps) return;
    patchForm({ steps: next });
    setStepKeys((keys) => {
      const moved = [...keys];
      const [item] = moved.splice(index, 1);
      moved.splice(index + delta, 0, item);
      return moved;
    });
  };

  const handleRemoveStep = (index: number) => {
    if (form.steps.length <= MIN_FUNNEL_STEPS) {
      message.warning(t('analysis:message.minFunnelSteps', { min: MIN_FUNNEL_STEPS }));
      return;
    }
    patchForm({ steps: form.steps.filter((_, i) => i !== index) });
    setStepKeys((keys) => keys.filter((_, i) => i !== index));
  };

  const handleGroupChange = (groups: GroupItem[]) => {
    patchForm({ group: groups[0] });
  };

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
    const { first, second } = pickExampleEvents(events);
    if (!first) {
      message.warning(t('analysis:message.noVisibleEvents'));
      return;
    }
    const next: FunnelFormState = {
      steps: [
        { event: first, alias: t('analysis:funnel.stepIndex', { index: 1 }) },
        { event: second, alias: t('analysis:funnel.stepIndex', { index: 2 }) },
      ],
      timeRange: lastNDaysRange(7),
      windowDays: 7,
      filters: { logic: 'and', items: [] },
    };
    setForm(next);
    setStepKeys(next.steps.map((_, i) => `fs_ex_${i}`));
    onTimeRangeChange?.(next.timeRange);
    onAnalyze(next);
  };

  const handleSubmit = () => {
    try {
      buildFunnelQuery(effectiveForm, project);
      onAnalyze(effectiveForm);
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('analysis:message.formInvalid'));
    }
  };

  const groupValue = form.group ? [form.group] : [];

  // 长按标题 1 秒进入拖动排序（替代 ↑↓ 按钮）。
  // 按下后允许 ≤8px 的手部抖动；超过阈值或 1 秒内松手则取消。
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const dragFromRef = useRef<number | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartY = useRef(0);

  const startPress = (index: number, y: number) => {
    pressStartY.current = y;
    pressTimer.current = setTimeout(() => {
      setDragFrom(index);
      dragFromRef.current = index;
    }, 1000);
  };
  const movePress = (y: number) => {
    if (pressTimer.current && Math.abs(y - pressStartY.current) > 8) cancelPress();
  };
  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  useEffect(() => {
    if (dragFrom == null) return;
    const onMove = (e: PointerEvent) => {
      const from = dragFromRef.current;
      if (from == null) return;
      const els = Array.from(document.querySelectorAll<HTMLElement>('[data-step-index]'));
      const hit = els.find((el) => {
        const r = el.getBoundingClientRect();
        return e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (!hit) return;
      const to = Number(hit.dataset.stepIndex);
      if (Number.isInteger(to) && to !== from) {
        handleMoveStep(from, to > from ? 1 : -1);
        dragFromRef.current = to;
        setDragFrom(to);
      }
    };
    const onUp = () => {
      setDragFrom(null);
      dragFromRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragFrom]);

  return (
    <div className="analysis-editor">
      <div className="analysis-editor__body">
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {t('analysis:funnel.title')}
      </Typography.Title>
      <QueryStep title={t('analysis:subject.section')}>
        <SubjectSelect value={form.subjectId} onChange={(subjectId) => patchForm({ subjectId })} />
      </QueryStep>
      {form.steps.map((step, index) => (
        <QueryStep
          key={stepKeys[index] ?? `fs_${index}`}
          index={index + 1}
          title={step.alias || t('analysis:funnel.stepIndex', { index: index + 1 })}
          collapsible
          titleEditable
          onTitleChange={(alias) => handleStepChange(index, { alias })}
          stepIndex={index}
          dragging={dragFrom === index}
          onHeadPointerDown={(e) => {
            e.preventDefault(); // 防止长按选中文本
            startPress(index, e.clientY);
          }}
          onHeadPointerMove={(e) => movePress(e.clientY)}
          onHeadPointerUp={cancelPress}
          onHeadPointerLeave={cancelPress}
          extra={
            <span className="funnel-step-order">
              {form.steps.length > MIN_FUNNEL_STEPS ? (
                <Button
                  icon={<DeleteOutlined />}
                  danger
                  size="small"
                  type="text"
                  aria-label={t('analysis:funnel.removeStepAria', { index: index + 1 })}
                  onClick={() => handleRemoveStep(index)}
                />
              ) : null}
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'condition', label: t('analysis:filter.addCondition') },
                    {
                      key: 'before',
                      label: t('analysis:funnel.insertBefore'),
                      disabled: form.steps.length >= MAX_FUNNEL_STEPS,
                    },
                    {
                      key: 'after',
                      label: t('analysis:funnel.insertAfter'),
                      disabled: form.steps.length >= MAX_FUNNEL_STEPS,
                    },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'before') handleInsertBefore(index);
                    if (key === 'after') handleAddAfter(index);
                    if (key === 'condition') {
                      const step = form.steps[index];
                      const stepFilters = step.filters ?? { logic: 'and', items: [] as never[] };
                      handleStepChange(index, {
                        filters: {
                          ...stepFilters,
                          items: [...stepFilters.items, emptyFilterItem()],
                        },
                      });
                    }
                  },
                }}
              >
                <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                aria-label={t('analysis:funnel.addStepAria', { index: index + 1 })}
              />
              </Dropdown>
            </span>
          }
        >
          <EventSelect
            value={step.event || undefined}
            onChange={(event) => handleStepChange(index, { event })}
            showAnyEvent
            style={{ width: '100%', marginBottom: 8 }}
          />
          {isAnyEvent(step.event) ? (
            <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
              {t('analysis:message.anyEventSlow')}
            </Typography.Text>
          ) : null}
          <FilterEditor
            value={step.filters ?? { logic: 'and', items: [] }}
            onChange={(filters) => handleStepChange(index, { filters })}
            eventProperties={labeledEventProperties(propMap[step.event], dimensionProperties)}
            userProperties={userProperties}
            hideAddActions
            loadValueLabels={getDatatableLabels}
          />
        </QueryStep>
      ))}
      <QueryStep title={t('analysis:funnel.windowSection')}>
        <InputNumber
          value={form.windowDays}
          onChange={(v) => patchForm({ windowDays: v ?? 7 })}
          min={1}
          max={3650}
          addonBefore={t('analysis:funnel.windowDays')}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <Checkbox
          checked={form.limitWindowInRange}
          onChange={(e) => patchForm({ limitWindowInRange: e.target.checked })}
        >
          {t('analysis:funnel.limitWindowInRange')}
        </Checkbox>
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
                const item: FilterGroup | FilterItem =
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
          onChange={(filters) => patchForm({ filters })}
          eventProperties={labeledEventProperties(
            form.steps[0]?.event ? propMap[form.steps[0].event] : undefined,
            dimensionProperties,
          )}
          userProperties={userProperties}
          cohorts={cohorts}
          tags={tags}
          hideAddActions
          loadValueLabels={getDatatableLabels}
        />
      </QueryStep>
      <QueryStep
        title={t('analysis:group.title')}
        dimmed={groupValue.length === 0}
        extra={
          <Dropdown
            trigger={['click']}
            menu={{
              items: groupAddMenuItems({
                attrCount: groupValue.filter((g) => g.scope !== 'time').length,
                limitAttr: false,
                hasCohorts: cohorts.length > 0,
                hasTags: tags.length > 0,
              }),
              onClick: ({ key }) => {
                handleGroupChange([...groupValue, createGroupItem(key as GroupItem['scope'])]);
              },
            }}
          >
            <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('analysis:group.addAria')} />
          </Dropdown>
        }
      >
        <GroupEditor
          value={groupValue}
          onChange={handleGroupChange}
          eventProperties={labeledEventProperties(
            form.steps[0]?.event ? propMap[form.steps[0].event] : undefined,
          )}
          dimensionProperties={dimensionProperties}
          userProperties={userProperties}
          cohorts={cohorts}
          tags={tags}
          hideAddActions
        />
      </QueryStep>
      <Button type="link" size="small" style={{ paddingLeft: 0 }} onClick={handleExample}>
        {t('analysis:action.fillExample')}
      </Button>
      {/* 「近似计算 + 计算」作为 body 内最末一组控件（不再 sticky 于侧栏底部） */}
      <div className="analysis-editor__bottom-actions">
        <span className="approx-hint" title={t('analysis:approx.hintFunnel')}>
          <input type="checkbox" disabled /> {t('analysis:approx.label')} <span className="approx-i">i</span>
        </span>
        <Button type="primary" loading={loading} onClick={handleSubmit}>
          {t('analysis:action.calculate')}
        </Button>
      </div>
    </div>
    </div>
  );
}
