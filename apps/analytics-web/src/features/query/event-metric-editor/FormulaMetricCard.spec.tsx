// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormulaMetricCard, describeFormula, isFormulaComplete } from './FormulaMetricCard';
import type { FormulaExpr, MetricItem } from '../../../types/dsl.types';

const peers: MetricItem[] = [
  { id: 'm1', kind: 'event', analysis: 'total_times', alias: '访问次数' },
  { id: 'm2', kind: 'event', analysis: 'total_times', alias: '订单数' },
];

const labelOf = (id: string) => peers.find((p) => p.id === id)?.alias ?? '（已删除）';

const divExpr: FormulaExpr = {
  type: 'op',
  op: '/',
  left: { type: 'metric', id: 'm2' },
  right: { type: 'metric', id: 'm1' },
};

describe('describeFormula', () => {
  it('渲染指标引用为别名', () => {
    expect(describeFormula({ type: 'metric', id: 'm1' }, labelOf)).toBe('访问次数');
  });

  it('渲染常量为数字', () => {
    expect(describeFormula({ type: 'const', value: 100 }, labelOf)).toBe('100');
  });

  it('把二元运算渲染成人类可读文本', () => {
    expect(describeFormula(divExpr, labelOf)).toBe('(订单数 ÷ 访问次数)');
  });

  it('指标未选值时给出占位', () => {
    expect(describeFormula({ type: 'metric', id: '' }, labelOf)).toBe('（未选指标）');
  });

  it('引用了已删除指标时标注出来', () => {
    expect(describeFormula({ type: 'metric', id: 'gone' }, labelOf)).toBe('（已删除）');
  });

  it('超出深度上限降级为省略号', () => {
    expect(describeFormula(divExpr, labelOf, 4)).toBe('…');
  });
});

describe('isFormulaComplete', () => {
  it('指标未选值时不完整', () => {
    expect(isFormulaComplete({ type: 'metric', id: '' })).toBe(false);
  });

  it('指标已选值时完整', () => {
    expect(isFormulaComplete({ type: 'metric', id: 'm1' })).toBe(true);
  });

  it('常量视为完整', () => {
    expect(isFormulaComplete({ type: 'const', value: 0 })).toBe(true);
  });

  it('运算两槽都完整才算完整', () => {
    expect(isFormulaComplete(divExpr)).toBe(true);
    expect(
      isFormulaComplete({
        type: 'op',
        op: '/',
        left: { type: 'metric', id: 'm1' },
        right: { type: 'metric', id: '' },
      }),
    ).toBe(false);
  });
});

describe('FormulaMetricCard', () => {
  it('填完整的公式显示摘要、不显示示例引导', () => {
    render(
      <FormulaMetricCard
        index={0}
        metric={{ id: 'f1', kind: 'formula', alias: '转化率', expression: divExpr }}
        peers={peers}
        showBadge
        canRemove
        onChange={() => {}}
        onRemove={() => {}}
      />,
    );
    // 别名「转化率」成为标题，摘要在 tooltip 中（点击改名交互）
    expect(screen.getByTestId('formula-summary').textContent).toBe('转化率');
    expect(screen.queryByText(/例：转化率/)).toBeNull();
    expect(screen.getByTestId('formula-expr')).toBeTruthy();
    expect(screen.getByText('左')).toBeTruthy();
    expect(screen.getByText('右')).toBeTruthy();
    expect(screen.getByText('运算')).toBeTruthy();
    expect(screen.getByText('格式')).toBeTruthy();
    expect(screen.getAllByLabelText('运算符').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('结果格式').length).toBeGreaterThan(0);
  });

  it('未填完整时给出示例引导', () => {
    render(
      <FormulaMetricCard
        index={0}
        metric={{
          id: 'f1',
          kind: 'formula',
          expression: { type: 'op', op: '/', left: { type: 'metric', id: '' }, right: { type: 'metric', id: 'm1' } },
        }}
        peers={peers}
        showBadge={false}
        canRemove={false}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/例：转化率/)).toBeTruthy();
  });

  it('顶层非运算表达式按单槽渲染且仍可读', () => {
    render(
      <FormulaMetricCard
        index={0}
        metric={{ id: 'f1', kind: 'formula', expression: { type: 'metric', id: 'm2' } }}
        peers={peers}
        showBadge={false}
        canRemove={false}
        onChange={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByTestId('formula-summary').textContent).toBe('订单数');
  });

  it('窄栏里完整显示 DAU / DNU 别名，不被挤成 DAI/DN', () => {
    const named: MetricItem[] = [
      { id: 'm1', kind: 'event', analysis: 'trig_user_num', alias: 'DAU' },
      { id: 'm2', kind: 'event', analysis: 'trig_user_num', alias: 'DNU' },
    ];
    render(
      <FormulaMetricCard
        index={2}
        metric={{
          id: 'f1',
          kind: 'formula',
          alias: 'DOU',
          expression: {
            type: 'op',
            op: '/',
            left: { type: 'metric', id: 'm1' },
            right: { type: 'metric', id: 'm2' },
          },
        }}
        peers={named}
        showBadge
        canRemove
        onChange={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText('DAU')).toBeTruthy();
    expect(screen.getByText('DNU')).toBeTruthy();
    expect(screen.queryByText('DAI')).toBeNull();
    const head = document.querySelector('.analysis-peer__head');
    expect(head?.querySelector('.analysis-peer__num')?.textContent).toBe('3');
    expect(head?.querySelector('[data-testid="formula-summary"]')?.textContent).toBe('DOU');
  });
});
