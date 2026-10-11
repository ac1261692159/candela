import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { validateConditions } from './condition-validation';
import type { CohortCondition } from './cohort-condition';

const didEvent = (event: string): CohortCondition => ({
  type: 'did_event',
  polarity: 'did',
  event,
  metric: 'times',
  op: 'gt',
  value: 0,
  time: { mode: 'last_n_days', n: 7 },
});

/** 客户端校验只为「定位到行 + 说人话」，后端校验仍是最终权威 */
describe('validateConditions', () => {
  it('未选事件时报该行', () => {
    expect(validateConditions([didEvent('')], t)).toEqual([{ index: 0, message: '请选择事件' }]);
  });

  it('序列步骤没填满时报该行', () => {
    const condition: CohortCondition = {
      type: 'sequence',
      polarity: 'did',
      events: ['AppStart', ''],
      time: { mode: 'last_n_days', n: 7 },
    };
    expect(validateConditions([condition], t)).toEqual([{ index: 0, message: '请把每一步的事件都选上' }]);
  });

  it('用户属性缺属性或缺少取值分别报错', () => {
    expect(validateConditions([{ type: 'user_prop', prop: '', op: '=', value: '' }], t)).toEqual([
      { index: 0, message: '请选择用户属性' },
    ]);
    expect(validateConditions([{ type: 'user_prop', prop: 'vip', op: '=', value: '' }], t)).toEqual([
      { index: 0, message: '请填写属性值' },
    ]);
  });

  it('is_set / not_set 不需要取值', () => {
    expect(validateConditions([{ type: 'user_prop', prop: 'vip', op: 'is_set' }], t)).toEqual([]);
  });

  it('多条件各自定位到自己的下标', () => {
    const issues = validateConditions([didEvent('AppStart'), didEvent('')], t);
    expect(issues).toHaveLength(1);
    expect(issues[0].index).toBe(1);
  });

  it('完整条件不报错', () => {
    expect(
      validateConditions(
        [didEvent('AppStart'), { type: 'user_prop', prop: 'vip', op: 'gte', value: 3 }],
        t,
      ),
    ).toEqual([]);
  });
});
