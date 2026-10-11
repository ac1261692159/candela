import { useState } from 'react';
import { Button, Dropdown, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { t as i18nT, useT } from '../../../i18n';
import type { MetricItem } from '../../../types/dsl.types';
import { ANY_EVENT, MAX_EVENT_METRICS } from '../../../types/dsl.types';
import { EventMetricCard } from './EventMetricCard';
import { FormulaMetricCard } from './FormulaMetricCard';
import { ApplySavedMetricButton } from '../../metrics/ApplySavedMetricButton';
import { appendEventMetric, metricFromSavedEvent } from '../../metrics/apply-saved-metric';
import type { MetaEventProperty, MetaVirtualProperty } from '../../../types/meta.types';
import type { UserTag } from '../../../services/tag.service';

interface EventMetricEditorProps {
  value?: MetricItem[];
  onChange?: (value: MetricItem[]) => void;
  userProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  propMap?: Record<string, { event: MetaEventProperty[]; virtual: MetaVirtualProperty[] }>;
  onNeedProperties?: (eventKey: string) => void;
  tags?: UserTag[];
  /** 隐藏内部 ➕（指标区块：➕ 由区块标题行承担） */
  hideAddActions?: boolean;
  loadValueLabels?: (prop: string) => Promise<{
    bound: boolean;
    items: { raw: string; label: string }[];
  }>;
  dimensionProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
}

export function createEventMetric(): MetricItem {
  return {
    id: `m_${Date.now()}`,
    kind: 'event',
    analysis: 'total_times',
    alias: i18nT('analysis:analysisMethod.totalTimes'),
  };
}

export function createFormulaMetric(peers: MetricItem[]): MetricItem {
  return {
    id: `f_${Date.now()}`,
    kind: 'formula',
    alias: i18nT('analysis:metric.formula'),
    format: 'number',
    expression: {
      type: 'op',
      op: '/',
      left: { type: 'metric', id: peers[0]?.id ?? '' },
      right: { type: 'metric', id: peers[1]?.id ?? peers[0]?.id ?? '' },
    },
  };
}

export function EventMetricEditor({
  value = [],
  onChange,
  userProperties = [],
  propMap = {},
  onNeedProperties,
  tags = [],
  hideAddActions = false,
  loadValueLabels,
  dimensionProperties = [],
}: EventMetricEditorProps) {
  const { t } = useT('analysis');
  const handleAddEvent = () => {
    if (value.length >= MAX_EVENT_METRICS) {
      message.warning(t('analysis:message.maxMetrics', { max: MAX_EVENT_METRICS }));
      return;
    }
    onChange?.([...value, createEventMetric()]);
  };

  const handleAddFormula = () => {
    if (value.length >= MAX_EVENT_METRICS) {
      message.warning(t('analysis:message.maxMetrics', { max: MAX_EVENT_METRICS }));
      return;
    }
    if (!value.some((item) => item.kind !== 'formula')) {
      message.warning(t('analysis:message.addEventMetricFirst'));
      return;
    }
    onChange?.([...value, createFormulaMetric(value)]);
  };

  const handleRemove = (index: number) => {
    if (value.length <= 1) {
      message.warning(t('analysis:message.keepOneMetric'));
      return;
    }
    onChange?.(value.filter((_, i) => i !== index));
  };
  const handleMove = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange?.(next);
  };

  const [applyOpen, setApplyOpen] = useState(false);

  const handleChange = (index: number, patch: Partial<MetricItem>) => {
    const next = value.map((item, i) => (i === index ? { ...item, ...patch } : item));
    const changed = next[index];
    if (changed?.event && changed.kind !== 'formula' && changed.event !== ANY_EVENT) {
      onNeedProperties?.(changed.event);
    }
    onChange?.(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {/* 添加入口收纳为单个 ➕（点开才选类型：指标/Σ公式/套用已存指标），神策风格 */}
      {!hideAddActions ? (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Dropdown
          trigger={['click']}
          // 与 SELECT_POPUP 同一约定：弹出层挂到 body，避免被滚动容器裁切（AGENTS_front §8）
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
              if (key === 'metric') handleAddEvent();
              if (key === 'formula') handleAddFormula();
              if (key === 'apply') setApplyOpen(true);
            },
          }}
        >
          <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('analysis:metric.add')} />
        </Dropdown>
      </div>
      ) : null}
      {value.map((metric, index) =>
        metric.kind === 'formula' ? (
          <FormulaMetricCard
            key={metric.id}
            metric={metric}
            peers={value.slice(0, index)}
            index={index}
            showBadge={value.length >= 2}
            canRemove={value.length > 1}
            onChange={(patch) => handleChange(index, patch)}
            onRemove={() => handleRemove(index)}
            onMove={(dir) => handleMove(index, dir)}
            canMoveUp={index > 0}
            canMoveDown={index < value.length - 1}
          />
        ) : (
          <EventMetricCard
            key={metric.id}
            metric={metric}
            index={index}
            showIndex={value.length >= 2}
            canRemove={value.length > 1}
            eventProps={metric.event ? propMap[metric.event] : undefined}
            dimensionProperties={dimensionProperties}
            userProperties={userProperties}
            tags={tags}
            loadValueLabels={loadValueLabels}
            onChange={(patch) => handleChange(index, patch)}
            onRemove={() => handleRemove(index)}
            onMove={(dir) => handleMove(index, dir)}
            canMoveUp={index > 0}
            canMoveDown={index < value.length - 1}
          />
        ),
      )}
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
          const next = appendEventMetric(value, incoming);
          if (next.length > MAX_EVENT_METRICS) {
            message.warning(t('analysis:message.maxMetrics', { max: MAX_EVENT_METRICS }));
            return;
          }
          onChange?.(next);
          if (incoming.event && incoming.event !== ANY_EVENT) onNeedProperties?.(incoming.event);
        }}
      />
    </div>
  );
}
