import { Button, Dropdown, Select, Input, Radio } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import type { FilterGroup, FilterItem, FilterOperator } from '../types/dsl.types';
import { useT, type TFunction } from '../i18n';
import { SELECT_POPUP } from './select-popup';
import '../features/query/analysis-workbench.css';
import type { UserCohort } from '../services/cohort.service';
import type { UserTag } from '../services/tag.service';
import { tagValueOptions } from '../features/tag/tag-values';

interface FilterEditorProps {
  value?: FilterGroup;
  onChange?: (value: FilterGroup) => void;
  eventProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  userProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  cohorts?: UserCohort[];
  tags?: UserTag[];
  depth?: number;
  /** 隐藏内部 ➕（全局筛选场景：➕ 由区块标题行承担） */
  hideAddActions?: boolean;
  /** 已绑定维表时，= / in 等下拉显示「名称（ID）」；提交值仍是原始 ID。不传则不打接口。 */
  loadValueLabels?: (prop: string) => Promise<{
    bound: boolean;
    items: { raw: string; label: string }[];
  }>;
}

const MAX_FILTER_DEPTH = 2;

/** 通用筛选运算符（按当前语言生成，模块级常量带中文故做成接收 t 的工厂） */
function operatorOptions(t: TFunction): { label: string; value: FilterOperator }[] {
  return [
    { label: t('common:filterEditor.operatorEquals'), value: '=' },
    { label: t('common:filterEditor.operatorNotEquals'), value: '!=' },
    { label: t('common:filterEditor.operatorIn'), value: 'in' },
    { label: t('common:filterEditor.operatorNotIn'), value: 'not_in' },
    { label: t('common:filterEditor.operatorContains'), value: 'contains' },
    { label: t('common:filterEditor.operatorNotContains'), value: 'not_contains' },
    { label: t('common:filterEditor.operatorRegex'), value: 'regex' },
    { label: t('common:filterEditor.operatorNotRegex'), value: 'not_regex' },
    { label: t('common:filterEditor.operatorGt'), value: 'gt' },
    { label: t('common:filterEditor.operatorGte'), value: 'gte' },
    { label: t('common:filterEditor.operatorLt'), value: 'lt' },
    { label: t('common:filterEditor.operatorLte'), value: 'lte' },
    { label: t('common:filterEditor.operatorIsSet'), value: 'is_set' },
    { label: t('common:filterEditor.operatorNotSet'), value: 'not_set' },
  ];
}

/** 用户标签筛选运算符（无「正则/范围」语义） */
function tagOperatorOptions(t: TFunction): { label: string; value: FilterOperator }[] {
  return [
    { label: t('common:filterEditor.operatorEquals'), value: '=' },
    { label: t('common:filterEditor.operatorBelongsTo'), value: 'in' },
    { label: t('common:filterEditor.operatorNotBelongsTo'), value: 'not_in' },
  ];
}

const defaultGroup: FilterGroup = { logic: 'and', items: [] };

export function isFilterGroup(item: FilterItem | FilterGroup): item is FilterGroup {
  return typeof item === 'object' && item !== null && 'logic' in item && Array.isArray(item.items);
}

/** 空条件默认值（供外部「➕ 添加筛选条件」复用，保证形状一致） */
export function emptyFilterItem(): FilterItem {
  return emptyItem();
}

function emptyItem(): FilterItem {
  return { scope: 'event', prop: '', op: '=', value: '' };
}

function tagFilterValues(value: unknown, multi: boolean): string | string[] | undefined {
  if (multi) {
    if (Array.isArray(value)) return value.map(String);
    const parts = String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return parts;
  }
  if (Array.isArray(value)) return String(value[0] ?? '') || undefined;
  const text = String(value ?? '');
  return text || undefined;
}

export function FilterEditor({
  value = defaultGroup,
  onChange,
  eventProperties = [],
  userProperties = [],
  cohorts = [],
  tags = [],
  depth = 0,
  /** 隐藏内部 ➕（全局筛选场景：➕ 由区块标题行承担） */
  hideAddActions = false,
  loadValueLabels,
}: FilterEditorProps) {
  const { t } = useT();
  const operators = operatorOptions(t);
  const tagOperators = tagOperatorOptions(t);

  const handleLogicChange = (logic: 'and' | 'or') => {
    onChange?.({ ...value, logic });
  };

  const handleAdd = () => {
    onChange?.({ ...value, items: [...value.items, emptyItem()] });
  };

  const handleAddGroup = () => {
    onChange?.({ ...value, items: [...value.items, { logic: 'and', items: [emptyItem()] }] });
  };

  const handleRemove = (index: number) => {
    onChange?.({ ...value, items: value.items.filter((_, i) => i !== index) });
  };

  const handleItemChange = (index: number, patch: Partial<FilterItem>) => {
    const next = value.items.map((item, i) => {
      if (i !== index || isFilterGroup(item)) return item;
      return { ...item, ...patch };
    });
    onChange?.({ ...value, items: next });
  };

  const handleGroupChange = (index: number, group: FilterGroup) => {
    const next = value.items.map((item, i) => (i === index ? group : item));
    onChange?.({ ...value, items: next });
  };

  const getPropOptions = (scope: FilterItem['scope']) => {
    if (scope === 'cohort') {
      return cohorts.map((cohort) => ({
        label: `${cohort.display_name} (${cohort.name})`,
        value: cohort.cohort_id,
      }));
    }
    if (scope === 'tag') {
      return tags.map((tag) => ({
        label: `${tag.display_name} (${tag.name})`,
        value: tag.tag_id,
      }));
    }
    const list = scope === 'event' ? eventProperties : userProperties;
    return list.map((p) => ({
      label: p.display_name || p.prop_key,
      value: p.prop_key,
    }));
  };

  const showJoin = value.items.length >= 2;
  const showIndex = value.items.length >= 2;
  const canNest = depth < MAX_FILTER_DEPTH;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {/* 添加入口收纳为单个 ➕（点开才选类型：筛选条件/条件组），神策风格 */}
      {!hideAddActions ? (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'condition', label: t('common:filterEditor.addCondition') },
              ...(canNest ? [{ key: 'group', label: t('common:filterEditor.addGroup') }] : []),
            ],
            onClick: ({ key }) => (key === 'group' ? handleAddGroup() : handleAdd()),
          }}
        >
          <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('common:filterEditor.addFilter')} />
        </Dropdown>
      </div>
      ) : null}
      {value.items.map((item, index) => {
        const noValueOps: FilterOperator[] = ['is_set', 'not_set'];
        return (
          <div key={index}>
            {isFilterGroup(item) ? (
              <div className={`filter-group-nest${showIndex ? ' filter-group-nest--indexed' : ''}`}>
                {showIndex ? (
                  <span className="analysis-peer__num" aria-hidden="true">
                    {index + 1}
                  </span>
                ) : null}
                {/* 样式表里这一行是 nowrap 的（条件组，中文 3 字）：长语言标题允许换行，
                    删除按钮固定不缩，避免 229px 窄轨里两者互相挤压（G.29） */}
                <div className="filter-group-nest__head" style={{ whiteSpace: 'normal', gap: 8 }}>
                  <span style={{ minWidth: 0 }}>{t('common:filterEditor.conditionGroup')}</span>
                  <Button
                    icon={<DeleteOutlined />}
                    danger
                    size="small"
                    type="text"
                    style={{ flexShrink: 0 }}
                    aria-label={
                      showIndex
                        ? t('common:filterEditor.deleteGroupIndexed', { index: index + 1 })
                        : t('common:filterEditor.deleteGroup')
                    }
                    onClick={() => handleRemove(index)}
                  />
                </div>
                  <FilterEditor
                  value={item}
                  onChange={(group) => handleGroupChange(index, group)}
                  eventProperties={eventProperties}
                  userProperties={userProperties}
                  cohorts={cohorts}
                  tags={tags}
                  depth={depth + 1}
                  loadValueLabels={loadValueLabels}
                />
              </div>
            ) : (
              <div className={`analysis-peer${showIndex ? ' analysis-peer--indexed' : ''}`}>
                {showIndex ? (
                  <span className="analysis-peer__num" aria-hidden="true">
                    {index + 1}
                  </span>
                ) : null}
                <Button
                  className="analysis-peer__remove"
                  icon={<DeleteOutlined />}
                  danger
                  size="small"
                  type="text"
                  aria-label={
                    showIndex
                      ? t('common:filterEditor.deleteConditionIndexed', { index: index + 1 })
                      : t('common:filterEditor.deleteCondition')
                  }
                  onClick={() => handleRemove(index)}
                />
                <Select
                  {...SELECT_POPUP}
                  value={item.scope}
                  onChange={(scope) =>
                    handleItemChange(index, {
                      scope,
                      prop: '',
                      op: scope === 'cohort' ? 'in' : '=',
                      value: '',
                    })
                  }
                  options={[
                    { label: t('common:filterEditor.scopeEvent'), value: 'event' },
                    { label: t('common:filterEditor.scopeUser'), value: 'user' },
                    ...(cohorts.length > 0 ? [{ label: t('common:filterEditor.scopeCohort'), value: 'cohort' }] : []),
                    ...(tags.length > 0 ? [{ label: t('common:filterEditor.scopeTag'), value: 'tag' }] : []),
                  ]}
                  style={{ width: '100%' }}
                />
                <Select
                  {...SELECT_POPUP}
                  value={item.prop || undefined}
                  onChange={(prop) => handleItemChange(index, { prop, value: item.scope === 'tag' ? '' : item.value })}
                  options={getPropOptions(item.scope)}
                  style={{ width: '100%' }}
                  placeholder={
                    item.scope === 'cohort'
                      ? t('common:filterEditor.selectCohort')
                      : item.scope === 'tag'
                        ? t('common:filterEditor.selectTag')
                        : t('common:filterEditor.selectProperty')
                  }
                  showSearch
                  optionFilterProp="label"
                />
                <Select
                  {...SELECT_POPUP}
                  value={item.op}
                  onChange={(op) => handleItemChange(index, { op, value: item.scope === 'tag' ? '' : item.value })}
                  options={
                    item.scope === 'cohort'
                      ? [
                          { label: t('common:filterEditor.operatorBelongsTo'), value: 'in' },
                          { label: t('common:filterEditor.operatorNotBelongsTo'), value: 'not_in' },
                        ]
                      : item.scope === 'tag'
                        ? tagOperators
                        : operators
                  }
                  style={{ width: '100%' }}
                />
                {item.scope === 'tag' ? (
                  <Select
                    {...SELECT_POPUP}
                    mode={item.op === '=' ? undefined : 'tags'}
                    value={tagFilterValues(item.value, item.op !== '=')}
                    onChange={(next) => handleItemChange(index, { value: next })}
                    options={tagValueOptions(tags.find((tag) => tag.tag_id === item.prop)?.definition_json).map(
                      (label) => ({ label, value: label }),
                    )}
                    placeholder={
                      item.op === '='
                        ? t('common:filterEditor.selectTagValue')
                        : t('common:filterEditor.selectOrInputTagValue')
                    }
                    style={{ width: '100%' }}
                    showSearch
                    allowClear
                  />
                ) : !noValueOps.includes(item.op) && item.scope !== 'cohort' ? (
                  <FilterValueInput
                    item={item}
                    loadValueLabels={loadValueLabels}
                    onChange={(next) => handleItemChange(index, { value: next })}
                  />
                ) : null}
              </div>
            )}
            {showJoin && index < value.items.length - 1 ? (
              <div className="filter-logic-join" role="group" aria-label={t('common:filterEditor.relation')}>
                <Radio.Group
                  value={value.logic}
                  onChange={(e) => handleLogicChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  size="small"
                  className="chrome-chip-group"
                  options={[
                    { label: t('common:filterEditor.and'), value: 'and' },
                    { label: t('common:filterEditor.or'), value: 'or' },
                  ]}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const LABEL_OPS = new Set<FilterOperator>(['=', '!=', 'in', 'not_in']);

function FilterValueInput({
  item,
  loadValueLabels,
  onChange,
}: {
  item: FilterItem;
  loadValueLabels?: FilterEditorProps['loadValueLabels'];
  onChange: (value: unknown) => void;
}) {
  const { t } = useT();
  const [items, setItems] = useState<{ raw: string; label: string }[] | null>(null);
  useEffect(() => {
    if (!loadValueLabels || !item.prop || !LABEL_OPS.has(item.op) || item.scope === 'cohort' || item.scope === 'tag') {
      setItems(null);
      return;
    }
    let alive = true;
    void loadValueLabels(item.prop)
      .then((result) => {
        if (!alive) return;
        setItems(result.bound && result.items.length > 0 ? result.items : []);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [item.prop, item.op, item.scope, loadValueLabels]);

  if (items && items.length > 0) {
    const options = items.map((entry) => ({
      value: entry.raw,
      label: t('common:filterEditor.labelWithRawValue', { label: entry.label, raw: entry.raw }),
    }));
    if (item.op === 'in' || item.op === 'not_in') {
      const current = Array.isArray(item.value)
        ? item.value.map(String)
        : String(item.value ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
      return (
        <Select
          {...SELECT_POPUP}
          mode="multiple"
          value={current}
          options={options}
          onChange={(next) => onChange(next.join(','))}
          placeholder={t('common:filterEditor.selectOrSearchRaw')}
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
          allowClear
        />
      );
    }
    return (
      <Select
        {...SELECT_POPUP}
        value={item.value != null && item.value !== '' ? String(item.value) : undefined}
        options={options}
        onChange={(next) => onChange(next ?? '')}
        placeholder={t('common:filterEditor.selectOrSearchRaw')}
        style={{ width: '100%' }}
        showSearch
        optionFilterProp="label"
        allowClear
      />
    );
  }

  return (
    <Input
      value={String(item.value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t('common:filterEditor.commaSeparated')}
      style={{ width: '100%' }}
    />
  );
}
