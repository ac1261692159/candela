import type { TFunction } from '../../i18n';
import type { CohortCondition } from './cohort-condition';

/**
 * 条件草稿的客户端校验：保存与试跑前先跑一遍，命中就在对应条件行内联提示。
 *
 * 后端校验仍是最终权威（同一个 DTO 校验也拦），这里只负责把
 * `conditions[0].event 必填` 这类带数组下标的机器文案换成定位到行的提示。
 */
export interface ConditionIssue {
  index: number;
  message: string;
}

const NO_VALUE_OPS = ['is_set', 'not_set'];

export function validateConditions(conditions: CohortCondition[], t: TFunction): ConditionIssue[] {
  const issues: ConditionIssue[] = [];
  conditions.forEach((condition, index) => {
    if (condition.type === 'did_event') {
      if (!condition.event) issues.push({ index, message: t('cohort:cohortEdit.needEvent') });
      return;
    }
    if (condition.type === 'sequence') {
      if (condition.events.some((event) => !event)) {
        issues.push({ index, message: t('cohort:cohortEdit.needStepEvent') });
      }
      return;
    }
    if (!condition.prop) {
      issues.push({ index, message: t('cohort:cohortEdit.needProp') });
      return;
    }
    if (
      !NO_VALUE_OPS.includes(condition.op) &&
      (condition.value === undefined || String(condition.value ?? '').trim() === '')
    ) {
      issues.push({ index, message: t('cohort:cohortEdit.needPropValue') });
    }
  });
  return issues;
}
