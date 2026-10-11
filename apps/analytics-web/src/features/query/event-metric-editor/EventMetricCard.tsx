import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Select, Space, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { FilterEditor } from '../../../components/FilterEditor';
import { EventSelect } from '../../../components/EventSelect';
import { SELECT_POPUP } from '../../../components/select-popup';
import { t as i18nT, useT, type TFunction } from '../../../i18n';
import type { AnalysisMethod, FilterGroup, MetricItem, StageReduce } from '../../../types/dsl.types';
import { ANY_EVENT } from '../../../types/dsl.types';
import type { MetaEventProperty, MetaVirtualProperty } from '../../../types/meta.types';
import { labeledEventProperties } from '../../../components/event-property-options';
import type { UserTag } from '../../../services/tag.service';
import {
  analysisLabel,
  analysisMethodLabels,
  defaultStageReduce,
  displayNameForProp,
  isDurationProp,
  methodsForDataType,
  percentilePresets,
  stageReduceOptions,
} from './analysis-methods';
import {
  transformOpOptions,
  type TransformOp,
} from './metric-transform';

interface EventMetricCardProps {
  metric: MetricItem;
  index: number;
  showIndex: boolean;
  canRemove: boolean;
  eventProps?: { event: MetaEventProperty[]; virtual: MetaVirtualProperty[] };
  dimensionProperties?: { prop_key: string; display_name?: string; data_type?: string }[];
  userProperties: { prop_key: string; display_name?: string; data_type?: string }[];
  tags?: UserTag[];
  loadValueLabels?: (prop: string) => Promise<{
    bound: boolean;
    items: { raw: string; label: string }[];
  }>;
  onChange: (patch: Partial<MetricItem>) => void;
  onRemove: () => void;
  onMove?: (dir: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

/**
 * 计算新的 alias：
 * - 当前 alias 是用户手动改过的（不等于旧的自动值）→ 保留用户的别名
 * - 否则（初始 / 自动生成）→ 使用新的自动值
 *
 * 这样用户改名后再改 事件/属性/分析方法 不会丢失他起的名字，初始态仍能跟随上下文自动更新。
 */
export function nextAlias(
  current: MetricItem,
  newAnalysis: AnalysisMethod,
  newPercentile?: number,
  t: TFunction = i18nT,
): string {
  const oldAuto = analysisLabel(current.analysis ?? 'total_times', current.percentile, t);
  const newAuto = analysisLabel(newAnalysis, newPercentile, t);
  const alias = current.alias?.trim();
  if (alias && alias !== oldAuto) return alias;
  return newAuto;
}

export function EventMetricCard({
  metric,
  index,
  showIndex,
  canRemove,
  eventProps,
  dimensionProperties = [],
  userProperties,
  tags = [],
  loadValueLabels,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: EventMetricCardProps) {
  const { t } = useT('analysis');
  const analysisLabels = analysisMethodLabels(t);
  const reduceOptions = stageReduceOptions(t);
  const percentileOptions = percentilePresets(t);
  const opOptions = transformOpOptions(t);
  // 次要设置默认收起：配置轨只有 280px，主路径只留「事件 / 属性 / 分析方法」（AGENTS_front §5）
  const [expanded, setExpanded] = useState(false);
  const propOptions = [
    { label: t('analysis:metric.noProp'), value: '' },
    ...(eventProps?.event ?? []).map((p) => ({
      label: displayNameForProp(p.prop_key, p.display_name, t),
      value: p.prop_key,
      dataType: p.data_type,
    })),
    ...(eventProps?.virtual ?? []).map((vp) => ({
      label: t('analysis:metric.virtualSuffix', { name: vp.display_name || vp.prop_key }),
      value: vp.prop_key,
      dataType: vp.data_type,
    })),
    ...dimensionProperties.map((prop) => ({
      label: t('analysis:metric.datatableSuffix', { name: prop.display_name || prop.prop_key }),
      value: prop.prop_key,
      dataType: prop.data_type,
    })),
  ];
  const selectedProp = propOptions.find(
    (p): p is { label: string; value: string; dataType?: string } => Boolean(p.value && p.value === metric.prop),
  );
  const dataType = selectedProp && 'dataType' in selectedProp ? selectedProp.dataType : undefined;
  const methods = methodsForDataType(metric.prop ? dataType : undefined);
  const analysis = metric.analysis ?? 'total_times';
  const eventLabel = metric.event === ANY_EVENT ? t('analysis:metric.anyEvent') : metric.event || t('analysis:metric.eventFallback');
  const autoLabel = metric.prop
    ? `${eventLabel}.${metric.prop}.${analysisLabel(analysis, metric.percentile, t)}`
    : `${eventLabel}.${analysisLabel(analysis, metric.percentile, t)}`;
  const alias = metric.alias?.trim() || '';
  const hasCustomAlias = Boolean(alias) && alias !== autoLabel;
  // 标题区：展示 alias（自动值或用户改过的值），不是 raw summary。和漏斗"点击标题改名"同款体验。
  const titleDisplay = hasCustomAlias ? (alias as string) : autoLabel;

  // 标题改名（与 QueryStep titleEditable 一致：点击进入编辑 / 失焦或回车提交 / Esc 取消）
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(titleDisplay);
  useEffect(() => {
    // 外部 alias 变化时同步 draft
    if (!titleEditing) setTitleDraft(titleDisplay);
  }, [titleDisplay, titleEditing]);

  const commitTitle = () => {
    const next = titleDraft.trim() || autoLabel;
    setTitleDraft(next);
    setTitleEditing(false);
    if (next !== metric.alias) onChange({ alias: next });
  };

  return (
    <div className={`analysis-peer${showIndex ? ' analysis-peer--indexed' : ''}${metric.hidden ? ' analysis-peer--hidden' : ''}`}>
      <div className="analysis-peer__head">
        {showIndex ? (
          <span className="analysis-peer__num" aria-hidden="true">
            {index + 1}
          </span>
        ) : null}
        {titleEditing ? (
          <Input
            size="small"
            autoFocus
            value={titleDraft}
            aria-label={t('analysis:metric.aliasAria')}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onPressEnter={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setTitleDraft(titleDisplay);
                setTitleEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="analysis-peer__title"
            title={t('analysis:step.renameHint')}
            onClick={() => setTitleEditing(true)}
          >
            <Typography.Text
              type={hasCustomAlias ? undefined : 'secondary'}
              strong={hasCustomAlias}
              ellipsis={{
                tooltip: hasCustomAlias
                  ? t('analysis:metric.autoAliasTip', { alias, auto: autoLabel })
                  : autoLabel,
              }}
              style={{ fontSize: 12 }}
            >
              {titleDisplay}
            </Typography.Text>
          </button>
        )}
      </div>
      <EventSelect
        value={metric.event}
        onChange={(event) => onChange({ event })}
        showAnyEvent
        style={{ width: '100%' }}
      />
      {metric.event === ANY_EVENT ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {t('analysis:message.anyEventSlow')}
        </Typography.Text>
      ) : null}
      <Select
        {...SELECT_POPUP}
        value={metric.prop ?? ''}
        onChange={(prop) => {
          const nextProp = prop || undefined;
          const nextType = nextProp
            ? propOptions.find((p): p is { label: string; value: string; dataType: string } =>
                p.value === nextProp && 'dataType' in p,
              )?.dataType
            : undefined;
          const nextMethods = methodsForDataType(nextProp ? nextType : undefined);
          const nextAnalysis = nextMethods.includes(analysis) ? analysis : nextMethods[0];
          const nextPercentile = nextAnalysis === 'percentile' ? metric.percentile ?? 50 : undefined;
          onChange({
            prop: nextProp,
            analysis: nextAnalysis,
            percentile: nextPercentile,
            stage_reduce: defaultStageReduce(nextAnalysis),
            alias: nextAlias(metric, nextAnalysis, nextPercentile, t),
          });
        }}
        options={propOptions}
        style={{ width: '100%' }}
        placeholder={t('analysis:metric.propPlaceholder')}
        showSearch
        optionFilterProp="label"
      />
      <Select
        {...SELECT_POPUP}
        value={analysis}
        onChange={(next) => {
          const nextPercentile = next === 'percentile' ? metric.percentile ?? 50 : undefined;
          onChange({
            analysis: next,
            percentile: nextPercentile,
            stage_reduce: defaultStageReduce(next),
            alias: nextAlias(metric, next, nextPercentile, t),
          });
        }}
        options={methods.map((value) => ({ label: analysisLabels[value], value }))}
        style={{ width: '100%' }}
      />
      <Button
        type="link"
        size="small"
        style={{ paddingLeft: 0, alignSelf: 'flex-start' }}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? t('analysis:metric.fewerSettings') : t('analysis:metric.moreSettings')}
      </Button>
      {expanded ? (
        <>
          {analysis === 'percentile' ? (
            <>
              <Select
                {...SELECT_POPUP}
                value={[25, 50, 75, 90, 99].includes(metric.percentile ?? 50) ? metric.percentile : 0}
                onChange={(value) => {
                  const percentile = value === 0 ? metric.percentile ?? 40 : value;
                  onChange({
                    percentile,
                    alias: nextAlias(metric, 'percentile', percentile, t),
                  });
                }}
                options={percentileOptions}
                style={{ width: '100%' }}
              />
              {![25, 50, 75, 90, 99].includes(metric.percentile ?? 50) ? (
                <InputNumber
                  min={1}
                  max={100}
                  value={metric.percentile}
                  onChange={(percentile) =>
                    onChange({
                      percentile: percentile ?? 50,
                      alias: nextAlias(metric, 'percentile', percentile ?? 50, t),
                    })
                  }
                  addonBefore={t('analysis:metric.percentileAddon')}
                  style={{ width: '100%' }}
                />
              ) : null}
            </>
          ) : null}
          {isDurationProp(metric.prop) ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('analysis:metric.durationHint')}
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('analysis:metric.transformHint')}
          </Typography.Text>
          <Space.Compact style={{ width: '100%' }}>
            <Select
              {...SELECT_POPUP}
              /* 96px 只装得下中文运算名；俄 «Умножить» / 德 «Multiplizieren mit»（~165px）会被截断。
                 改为「最小宽度 + 按内容增长」，右侧运算数输入框吃掉剩余宽度。 */
              style={{ flex: '0 0 auto', minWidth: 96 }}
              value={metric.transform?.op ?? 'mul'}
              options={opOptions}
              onChange={(op: TransformOp) =>
                onChange({
                  transform: {
                    // 切到四则运算时把旧 factor 升级为 op/value，读侧两种都兼容
                    op,
                    value: metric.transform?.value ?? metric.transform?.factor,
                    decimals: metric.transform?.decimals,
                  },
                })
              }
            />
            <InputNumber
              placeholder={t('analysis:metric.transformValuePlaceholder')}
              style={{ flex: '1 1 0', minWidth: 0 }}
              value={metric.transform?.value ?? metric.transform?.factor}
              min={-1000000}
              max={1000000}
              step={0.01}
              onChange={(value) =>
                onChange({
                  transform: {
                    op: metric.transform?.op ?? 'mul',
                    value: value ?? undefined,
                    decimals: metric.transform?.decimals,
                  },
                })
              }
            />
          </Space.Compact>
          <InputNumber
            placeholder={t('analysis:metric.decimalsPlaceholder')}
            style={{ width: '100%' }}
            min={0}
            max={6}
            precision={0}
            value={metric.transform?.decimals}
            onChange={(decimals) =>
              onChange({
                transform: {
                  ...metric.transform,
                  decimals: decimals ?? undefined,
                },
              })
            }
          />
          <Select
            {...SELECT_POPUP}
            value={metric.stage_reduce ?? defaultStageReduce(analysis)}
            onChange={(stage_reduce: StageReduce) => onChange({ stage_reduce })}
            options={reduceOptions}
            style={{ width: '100%' }}
          />
          {/* 别名已迁到标题点击改名；"次要设置"里去掉冗余 Input */}
          <FilterEditor
            value={metric.filters}
            onChange={(filters: FilterGroup) => onChange({ filters })}
            eventProperties={labeledEventProperties(eventProps, dimensionProperties)}
            userProperties={userProperties}
            tags={tags}
            loadValueLabels={loadValueLabels}
          />
        </>
      ) : null}
      <div className="analysis-peer__actions">
        {onMove ? (
          <>
            <Button
              className="analysis-peer__action"
              type="text"
              size="small"
              icon={<ArrowUpOutlined />}
              title={t('analysis:metric.moveUp')}
              aria-label={t('analysis:metric.moveUpAria')}
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
            />
            <Button
              className="analysis-peer__action"
              type="text"
              size="small"
              icon={<ArrowDownOutlined />}
              title={t('analysis:metric.moveDown')}
              aria-label={t('analysis:metric.moveDownAria')}
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
            />
          </>
        ) : null}
        <Button
          className="analysis-peer__action"
          type="text"
          size="small"
          icon={metric.hidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          title={metric.hidden ? t('analysis:metric.hiddenTip') : t('analysis:metric.visibleTip')}
          aria-label={metric.hidden ? t('analysis:metric.showAria') : t('analysis:metric.hideAria')}
          onClick={() => onChange({ hidden: !metric.hidden })}
        />
        {canRemove ? (
          <Button
            className="analysis-peer__action analysis-peer__remove"
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            onClick={onRemove}
          />
        ) : null}
      </div>
    </div>
  );
}
