import { Button, Dropdown, InputNumber, Select } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { GroupItem, GroupScope } from '../types/dsl.types';
import { t as currentT, useT, type TFunction } from '../i18n';
import { SELECT_POPUP } from './select-popup';
import { datatableGroupOptionLabel, isDatatableDimensionKey } from './event-property-options';
import '../features/query/analysis-workbench.css';
import type { UserCohort } from '../services/cohort.service';
import type { UserTag } from '../services/tag.service';

interface GroupEditorProps {
  value?: GroupItem[];
  onChange?: (value: GroupItem[]) => void;
  eventProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  dimensionProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  userProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  cohorts?: UserCohort[];
  tags?: UserTag[];
  /** 隐藏内部 ➕（全局筛选/分组项区块：➕ 由区块标题行承担） */
  hideAddActions?: boolean;
}

/** 时间粒度选项（按当前语言生成，模块级常量带中文故做成接收 t 的工厂） */
function granularityOptions(t: TFunction): { label: string; value: string }[] {
  return [
    { label: t('common:label.total'), value: 'total' },
    { label: t('common:groupEditor.byMinute'), value: 'minute' },
    { label: t('common:groupEditor.byHour'), value: 'hour' },
    { label: t('common:groupEditor.byDay'), value: 'day' },
    { label: t('common:groupEditor.byWeek'), value: 'week' },
    { label: t('common:groupEditor.byMonth'), value: 'month' },
  ];
}

/** datetime 属性取值提取方式（按当前语言生成） */
function extractOptions(t: TFunction): { label: string; value: string }[] {
  return [
    { label: t('common:groupEditor.extractNone'), value: '' },
    { label: t('common:groupEditor.extractHourOfDay'), value: 'hour_of_day' },
    { label: t('common:groupEditor.extractDayOfMonth'), value: 'day_of_month' },
    { label: t('common:groupEditor.extractMinuteOfHour'), value: 'minute_of_hour' },
  ];
}

/**
 * 添加入口菜单项。组件调用时传入订阅语言的 `t`；未传的旧调用方
 * 走当前语言的一次性取值，行为与迁移前的中文标签一致。
 */
export function groupAddMenuItems(
  opts: {
    attrCount: number;
    limitAttr?: boolean;
    hasCohorts?: boolean;
    hasTags?: boolean;
  },
  t: TFunction = currentT,
): { key: GroupScope; label: string; disabled?: boolean }[] {
  const disabled = opts.limitAttr !== false && opts.attrCount >= 2;
  return [
    { key: 'time', label: t('common:groupEditor.addTime') },
    { key: 'event', label: t('common:groupEditor.addEventProperty'), disabled },
    { key: 'user', label: t('common:groupEditor.addUserProperty'), disabled },
    ...(opts.hasCohorts ? [{ key: 'cohort' as const, label: t('common:groupEditor.addCohort'), disabled }] : []),
    ...(opts.hasTags ? [{ key: 'tag' as const, label: t('common:groupEditor.addTag'), disabled }] : []),
    { key: 'dimension', label: t('common:groupEditor.addDimension'), disabled },
  ];
}

export function createGroupItem(scope: GroupScope): GroupItem {
  return scope === 'time' ? { scope: 'time', granularity: 'day' } : { scope, prop: '', topn: 20 };
}

export function GroupEditor({
  value = [],
  onChange,
  eventProperties = [],
  dimensionProperties = [],
  userProperties = [],
  cohorts = [],
  tags = [],
  hideAddActions = false,
}: GroupEditorProps) {
  const handleAdd = (scope: GroupScope) => {
    onChange?.([...value, createGroupItem(scope)]);
  };

  const handleRemove = (index: number) => {
    onChange?.(value.filter((_, i) => i !== index));
  };

  const { t } = useT();
  const granularities = granularityOptions(t);
  const extracts = extractOptions(t);

  const handleChange = (index: number, patch: Partial<GroupItem>) => {
    onChange?.(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const getPropOptions = (scope: GroupScope) => {
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
    if (scope === 'dimension') {
      return dimensionProperties.map((prop) => ({
        label: datatableGroupOptionLabel(prop.prop_key, prop.display_name),
        value: prop.prop_key,
      }));
    }
    const list = scope === 'event' ? eventProperties.filter((prop) => !isDatatableDimensionKey(prop.prop_key)) : userProperties;
    return list.map((p) => ({ label: p.display_name || p.prop_key, value: p.prop_key }));
  };

  const attrCount = value.filter((g) => g.scope !== 'time').length;
  const discreteGroup = (scope: GroupScope) => scope === 'cohort' || scope === 'tag';
  const editorScope = (group: GroupItem): GroupScope =>
    group.scope === 'event' && isDatatableDimensionKey(group.prop) ? 'dimension' : group.scope;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {/* 添加入口收纳为单个 ➕（点开才选分组类型），置于区块顶部右上 */}
      {!hideAddActions ? (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Dropdown
          trigger={['click']}
            menu={{
            items: groupAddMenuItems(
              {
                attrCount,
                hasCohorts: cohorts.length > 0,
                hasTags: tags.length > 0,
              },
              t,
            ),
            onClick: ({ key }) => handleAdd(key as GroupScope),
          }}
        >
          <Button type="text" size="small" icon={<PlusOutlined />} aria-label={t('common:groupEditor.addGroup')} />
        </Dropdown>
      </div>
      ) : null}
      {value.map((group, index) => (
        <div
          key={index}
          className={`analysis-peer${value.length >= 2 ? ' analysis-peer--indexed' : ''}`}
        >
          {value.length >= 2 ? (
            <span className="analysis-peer__num" aria-hidden="true">
              {index + 1}
            </span>
          ) : null}
          <Select
            {...SELECT_POPUP}
            value={editorScope(group)}
            disabled={group.scope === 'time'}
            onChange={(scope: GroupScope) =>
              handleChange(index, {
                scope,
                prop: '',
                extract: undefined,
                granularity: undefined,
              })
            }
            options={[
              ...(group.scope === 'time' ? [{ label: t('common:groupEditor.scopeTime'), value: 'time' }] : []),
              { label: t('common:groupEditor.scopeEvent'), value: 'event' },
              { label: t('common:groupEditor.scopeDimension'), value: 'dimension' },
              { label: t('common:groupEditor.scopeUser'), value: 'user' },
              ...(cohorts.length > 0 ? [{ label: t('common:groupEditor.scopeCohort'), value: 'cohort' }] : []),
              ...(tags.length > 0 ? [{ label: t('common:groupEditor.scopeTag'), value: 'tag' }] : []),
            ]}
            style={{ width: '100%' }}
          />
          {value.length >= 2 ? null : null}
          <Button
            className="analysis-peer__remove"
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => handleRemove(index)}
            aria-label={t('common:groupEditor.deleteGroup')}
          />
          {group.scope === 'time' ? (
            <Select
              {...SELECT_POPUP}
              value={group.granularity}
              onChange={(granularity) => handleChange(index, { granularity })}
              options={granularities}
              style={{ width: '100%' }}
            />
          ) : (
            <>
              <Select
                {...SELECT_POPUP}
                value={group.prop || undefined}
                onChange={(prop) => handleChange(index, { prop, extract: undefined })}
                options={getPropOptions(editorScope(group))}
                style={{ width: '100%' }}
                placeholder={
                  editorScope(group) === 'cohort'
                    ? t('common:groupEditor.selectCohort')
                    : editorScope(group) === 'tag'
                      ? t('common:groupEditor.selectTag')
                      : editorScope(group) === 'dimension'
                        ? t('common:groupEditor.selectDimensionField')
                        : t('common:groupEditor.selectProperty')
                }
                showSearch
                optionFilterProp="label"
              />
              {(() => {
                const listed =
                  editorScope(group) === 'dimension'
                    ? dimensionProperties
                    : editorScope(group) === 'event'
                      ? eventProperties
                      : userProperties;
                const meta = listed.find((p) => p.prop_key === group.prop);
                if (meta?.data_type !== 'datetime') return null;
                return (
                  <Select
                    {...SELECT_POPUP}
                    value={group.extract ?? ''}
                    onChange={(extract) =>
                      handleChange(index, { extract: extract ? (extract as GroupItem['extract']) : undefined })
                    }
                    options={extracts}
                    style={{ width: '100%' }}
                  />
                );
              })()}
              {!discreteGroup(group.scope) ? (
                <InputNumber
                  value={group.topn ?? 20}
                  onChange={(topn) => handleChange(index, { topn: topn ?? 20 })}
                  min={1}
                  max={1000}
                  style={{ width: '100%' }}
                  addonBefore="TopN"
                />
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
