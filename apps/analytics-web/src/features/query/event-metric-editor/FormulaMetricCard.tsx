import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Select, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { SELECT_POPUP } from '../../../components/select-popup';
import { t as i18nT, useT, type TFunction } from '../../../i18n';
import type { FormulaExpr, FormulaFormat, MetricItem } from '../../../types/dsl.types';
import { analysisLabel } from './analysis-methods';

interface FormulaMetricCardProps {
  metric: MetricItem;
  peers: MetricItem[];
  /** 流水线位置（0 基），用于步骤序号徽章 */
  index: number;
  /** 多指标时显示序号徽章与操作钮 */
  showBadge: boolean;
  canRemove: boolean;
  onChange: (patch: Partial<MetricItem>) => void;
  onRemove: () => void;
  onMove?: (dir: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

/**
 * 公式槽嵌套深度上限。
 * 读取任意深度的旧数据不受影响（describe 会降级为「…」），
 * 但新建/编辑只允许嵌到这一层，避免窄配置轨里出现无限缩进的控件列。
 */
const MAX_DEPTH = 3;

const OP_LABEL: Record<string, string> = { '+': '＋', '-': '－', '*': '×', '/': '÷' };

const OP_OPTIONS = (['+', '-', '*', '/'] as const).map((op) => ({
  label: `${OP_LABEL[op]}`,
  value: op,
}));

function metricLabel(item: MetricItem, t: TFunction = i18nT): string {
  if (item.alias?.trim()) return item.alias.trim();
  if (item.kind === 'formula') return t('analysis:metric.formula');
  return analysisLabel(item.analysis ?? 'total_times', item.percentile, t);
}

/** 把表达式渲染成人类可读文本，让 Σ 不再是黑盒（如「(收入 ÷ 订单数)」） */
export function describeFormula(
  expr: FormulaExpr | undefined,
  labelOf: (id: string) => string,
  depth = 0,
  t: TFunction = i18nT,
): string {
  if (!expr) return t('analysis:formula.unset');
  // 空 id = 还没选，与「引用了已删除的指标」区分开
  if (expr.type === 'metric') return expr.id ? labelOf(expr.id) : t('analysis:formula.pickMetric');
  if (expr.type === 'const') return String(expr.value);
  if (depth > MAX_DEPTH) return '…';
  const left = describeFormula(expr.left, labelOf, depth + 1, t);
  const right = describeFormula(expr.right, labelOf, depth + 1, t);
  return `(${left} ${OP_LABEL[expr.op] ?? expr.op} ${right})`;
}

/** 公式是否填完整（每个指标槽都选了值）；未完整时给一句示例引导 */
export function isFormulaComplete(expr: FormulaExpr | undefined): boolean {
  if (!expr) return false;
  if (expr.type === 'metric') return Boolean(expr.id);
  if (expr.type === 'const') return true;
  return isFormulaComplete(expr.left) && isFormulaComplete(expr.right);
}

function defaultFor(type: FormulaExpr['type'], peers: MetricItem[]): FormulaExpr {
  if (type === 'const') return { type: 'const', value: 1 };
  if (type === 'metric') return { type: 'metric', id: peers[0]?.id ?? '' };
  return {
    type: 'op',
    op: '/',
    left: { type: 'metric', id: peers[0]?.id ?? '' },
    right: { type: 'metric', id: peers[1]?.id ?? peers[0]?.id ?? '' },
  };
}

/**
 * 单个公式槽：类型（指标 / 数字 / 子公式）+ 对应控件。
 * 子公式会递归渲染成缩进的两槽，深度受 MAX_DEPTH 限制。
 */
function SlotEditor({
  expr,
  peers,
  depth,
  onChange,
}: {
  expr: FormulaExpr;
  peers: MetricItem[];
  depth: number;
  onChange: (next: FormulaExpr) => void;
}) {
  const { t } = useT('analysis');
  return (
    <div className="formula-slot">
      <Select
        {...SELECT_POPUP}
        size="small"
        value={expr.type}
        aria-label={t('analysis:formula.slotTypeAria')}
        onChange={(type) => onChange(defaultFor(type, peers))}
        options={[
          { label: t('analysis:formula.slotMetric'), value: 'metric' },
          { label: t('analysis:formula.slotConst'), value: 'const' },
          ...(depth < MAX_DEPTH ? [{ label: t('analysis:formula.slotSubFormula'), value: 'op' }] : []),
        ]}
        style={{ width: '100%' }}
      />
      {expr.type === 'metric' ? (
        <Select
          {...SELECT_POPUP}
          size="small"
          value={expr.id || undefined}
          aria-label={t('analysis:formula.referenceMetric')}
          onChange={(id) => onChange({ type: 'metric', id })}
          options={peers.map((p) => ({ label: metricLabel(p, t), value: p.id }))}
          placeholder={t('analysis:formula.referenceMetric')}
          style={{ width: '100%' }}
        />
      ) : null}
      {expr.type === 'const' ? (
        <InputNumber
          size="small"
          value={expr.value}
          aria-label={t('analysis:formula.constantAria')}
          onChange={(value) => onChange({ type: 'const', value: value ?? 0 })}
          style={{ width: '100%' }}
        />
      ) : null}
      {expr.type === 'op' ? (
        <div className="formula-slots formula-slots--nested">
          <SlotEditor
            expr={expr.left}
            peers={peers}
            depth={depth + 1}
            onChange={(left) => onChange({ ...expr, left })}
          />
          <Select
            {...SELECT_POPUP}
            size="small"
            className="formula-slots__op"
            value={expr.op}
            aria-label={t('analysis:formula.operatorAria')}
            onChange={(op) => onChange({ ...expr, op })}
            options={OP_OPTIONS}
          />
          <SlotEditor
            expr={expr.right}
            peers={peers}
            depth={depth + 1}
            onChange={(right) => onChange({ ...expr, right })}
          />
        </div>
      ) : null}
    </div>
  );
}

export function FormulaMetricCard({
  metric,
  peers,
  index,
  showBadge,
  canRemove,
  onChange,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
}: FormulaMetricCardProps) {
  const { t } = useT('analysis');
  const expression: FormulaExpr =
    metric.expression ?? { type: 'metric', id: peers[0]?.id ?? '' };
  const labelOf = (id: string) => {
    const found = peers.find((p) => p.id === id);
    return found ? metricLabel(found, t) : t('analysis:formula.deleted');
  };
  const summary = describeFormula(expression, labelOf, 0, t);
  const commit = (next: FormulaExpr) => onChange({ expression: next, kind: 'formula' });

  // 标题点击改名（与普通指标步骤一致）：默认名 = 公式摘要
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const autoTitle = summary;
  const alias = metric.alias?.trim() || '';
  const titleDisplay = alias || autoTitle;
  useEffect(() => {
    if (!titleEditing) setTitleDraft(titleDisplay);
  }, [titleDisplay, titleEditing]);
  const commitTitle = () => {
    const next = titleDraft.trim();
    setTitleEditing(false);
    onChange({ alias: next && next !== autoTitle ? next : undefined });
  };

  const formatSelect = (
    <Select
      {...SELECT_POPUP}
      size="small"
      value={metric.format ?? 'number'}
      aria-label={t('analysis:formula.formatAria')}
      onChange={(format: FormulaFormat) => onChange({ format })}
      options={[
        { label: t('analysis:formula.slotConst'), value: 'number' },
        { label: t('analysis:formula.formatPercent'), value: 'percent' },
        { label: t('analysis:formula.formatDecimal2'), value: 'decimal2' },
        { label: t('analysis:formula.formatDecimal3'), value: 'decimal3' },
      ]}
      style={{ width: '100%' }}
    />
  );

  return (
    <div className={`analysis-peer analysis-peer--formula${showBadge ? ' analysis-peer--indexed' : ''}${metric.hidden ? ' analysis-peer--hidden' : ''}`}>
      <div className="analysis-peer__head">
        {showBadge ? (
          <span className="analysis-peer__num" title={t('analysis:formula.derivedTip')} aria-hidden="true">
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
            data-testid="formula-summary"
            onClick={() => setTitleEditing(true)}
          >
            <Typography.Text
              type={alias ? undefined : 'secondary'}
              strong={Boolean(alias)}
              ellipsis={{
                tooltip: alias ? t('analysis:formula.defaultTip', { alias, auto: autoTitle }) : autoTitle,
              }}
              style={{ fontSize: 12 }}
            >
              {titleDisplay}
            </Typography.Text>
          </button>
        )}
      </div>
      {/* 未填完整时给一句示例，降低 Σ 的上手门槛（P4） */}
      {isFormulaComplete(expression) ? null : (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {t('analysis:formula.completeHint')}
        </Typography.Text>
      )}
      {expression.type === 'op' ? (
        <div className="formula-expr" data-testid="formula-expr">
          <div className="formula-expr__operand">
            <span className="formula-expr__label">{t('analysis:formula.leftLabel')}</span>
            <SlotEditor
              expr={expression.left}
              peers={peers}
              depth={1}
              onChange={(left) => commit({ ...expression, left })}
            />
          </div>
          <div className="formula-expr__operand">
            <span className="formula-expr__label">{t('analysis:formula.opLabel')}</span>
            <Select
              {...SELECT_POPUP}
              size="small"
              className="formula-expr__op"
              value={expression.op}
              aria-label={t('analysis:formula.operatorAria')}
              onChange={(op) => commit({ ...expression, op })}
              options={OP_OPTIONS}
            />
          </div>
          <div className="formula-expr__operand">
            <span className="formula-expr__label">{t('analysis:formula.rightLabel')}</span>
            <SlotEditor
              expr={expression.right}
              peers={peers}
              depth={1}
              onChange={(right) => commit({ ...expression, right })}
            />
          </div>
          <div className="formula-expr__operand">
            <span className="formula-expr__label">{t('analysis:formula.formatLabel')}</span>
            {formatSelect}
          </div>
        </div>
      ) : (
        <div className="formula-expr" data-testid="formula-expr">
          <SlotEditor expr={expression} peers={peers} depth={0} onChange={commit} />
          <div className="formula-expr__operand">
            <span className="formula-expr__label">{t('analysis:formula.formatLabel')}</span>
            {formatSelect}
          </div>
        </div>
      )}
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
