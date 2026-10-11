import { afterEach, describe, expect, it } from 'vitest';
import { changeLocale, t } from '../../i18n';
import { cohortSummary } from './cohort-summary';
import type { CohortCondition } from './cohort-condition';

afterEach(async () => {
  await changeLocale('zh-CN');
});

const didEvent = (over: Partial<Extract<CohortCondition, { type: 'did_event' }>> = {}) =>
  ({
    type: 'did_event',
    polarity: 'did',
    event: 'AppStart',
    metric: 'times',
    op: 'gt',
    value: 0,
    time: { mode: 'last_n_days', n: 7 },
    ...over,
  }) as CohortCondition;

function summary(kind: string, definition_json: Record<string, unknown>) {
  return cohortSummary({ kind, definition_json } as never, t);
}

/**
 * 摘要渲染是**前端**行为（接口只给结构化定义，翻译不进载荷）——
 * 事件名与属性名是用户自己起的标识，取不到显示名就原样显示。
 */
describe('cohortSummary', () => {
  it('做过事件：时间窗 + 次数比较', () => {
    expect(summary('condition', { conditions: [didEvent()] })).toBe('过去 7 天 做过 AppStart 的次数 大于 0');
  });

  it('没做过事件不带次数比较（语义上次数恒为 0）', () => {
    expect(summary('condition', { conditions: [didEvent({ polarity: 'did_not' })] })).toBe('过去 7 天 没做过 AppStart');
  });

  it('依次做过用箭头串起步骤', () => {
    const condition: CohortCondition = {
      type: 'sequence',
      polarity: 'did',
      events: ['AppStart', 'PageView'],
      time: { mode: 'last_n_days', n: 30 },
    };
    expect(summary('condition', { conditions: [condition] })).toBe('过去 30 天 依次做过 AppStart → PageView');
  });

  it('用户属性条件渲染属性名与运算符', () => {
    const condition: CohortCondition = { type: 'user_prop', prop: 'vip_level', op: 'gte', value: 3 };
    expect(summary('condition', { conditions: [condition] })).toBe('用户属性 vip_level 大于等于 3');
  });

  it('固定日期窗口用起止日期', () => {
    expect(summary('condition', { conditions: [didEvent({ time: { mode: 'static', start: '2026-09-01', end: '2026-09-07' } })] })).toBe(
      '2026-09-01 至 2026-09-07 做过 AppStart 的次数 大于 0',
    );
  });

  it('多条条件用「且」连接', () => {
    const conditions: CohortCondition[] = [
      didEvent(),
      { type: 'user_prop', prop: 'vip_level', op: 'gte', value: 3 },
    ];
    expect(summary('condition', { conditions })).toBe(
      '过去 7 天 做过 AppStart 的次数 大于 0 且 用户属性 vip_level 大于等于 3',
    );
  });

  it('事件显示名可用时优先显示名，任意事件走通用文案', () => {
    const text = cohortSummary(
      { kind: 'condition', definition_json: { conditions: [didEvent({ event: '*' })] } } as never,
      t,
      { eventLabel: (key) => (key === 'AppStart' ? '启动' : undefined) },
    );
    expect(text).toContain('任意事件');
    expect(
      cohortSummary({ kind: 'condition', definition_json: { conditions: [didEvent()] } } as never, t, {
        eventLabel: (key) => (key === 'AppStart' ? '启动' : undefined),
      }),
    ).toContain('启动');
  });

  it('ID / SQL / 结果分群各有专属摘要', () => {
    expect(summary('id_upload', { match: 'uid' })).toBe('CSV 名单匹配到的用户');
    expect(summary('sql', { sql_text: 'SELECT 1' })).toBe('自定义 SQL 圈出的用户');
    expect(summary('result', { source: 'funnel' })).toBe('来自漏斗分析人数格的快照');
    expect(summary('result', {})).toBe('分析结果快照');
  });

  it('缺条件时不抛错', () => {
    expect(summary('condition', {})).toBe('没有条件');
  });

  it('切换到 en-US 时句式随语言重排（占位符顺序不同）', async () => {
    await changeLocale('en-US');
    expect(summary('condition', { conditions: [didEvent()] })).toBe(
      'Did AppStart greater than 0 times in the last 7 days',
    );
  });
});
