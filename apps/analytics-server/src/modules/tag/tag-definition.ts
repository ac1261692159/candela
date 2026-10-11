import { badRequest } from '../../i18n/domain-error';
import {
  CohortCondition,
  validateCohortName,
  validateConditionDefinition,
} from '../cohort/cohort-definition';

export const TAG_VALUE_MAX = 40;
export const TAG_PROJECT_LIMIT = 100;
export const TAG_MATERIALIZE_LIMIT = 1_000_000;

export type TagSchedule = 'manual' | 'daily';

export type TagRule = {
  value: string;
  conditions: CohortCondition[];
};

export type TagDefinition = {
  rules: TagRule[];
  default_value?: string;
};

export function validateTagName(name: string): string {
  return validateCohortName(name);
}

export function parseTagDefinition(raw: unknown): TagDefinition {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw badRequest({
        code: 'tag.definition.jsonInvalid',
        messageKey: 'cohort:error.definition.jsonInvalid',
        message: 'definition_json 不是合法 JSON',
      });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest({
      code: 'tag.definition.jsonRequired',
      messageKey: 'cohort:error.definition.jsonRequired',
      message: 'definition_json 必填',
    });
  }
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.rules) || rec.rules.length < 2) {
    throw badRequest({
      code: 'tag.rule.tooFew',
      messageKey: 'cohort:error.tag.ruleTooFew',
      message: '规则标签至少两条规则',
    });
  }
  if (rec.rules.length > 20) {
    throw badRequest({
      code: 'tag.rule.tooMany',
      messageKey: 'cohort:error.tag.ruleTooMany',
      params: { max: 20 },
      message: '规则最多 20 条',
    });
  }
  const seen = new Set<string>();
  const rules = rec.rules.map((item, index) => validateRule(item, index, seen));
  let default_value: string | undefined;
  if (rec.default_value != null && rec.default_value !== '') {
    if (typeof rec.default_value !== 'string') {
      throw badRequest({
        code: 'tag.defaultValue.notString',
        messageKey: 'cohort:error.tag.defaultValueNotString',
        message: 'default_value 必须是字符串',
      });
    }
    const trimmed = rec.default_value.trim();
    if (!trimmed) {
      throw badRequest({
        code: 'tag.defaultValue.empty',
        messageKey: 'cohort:error.tag.defaultValueEmpty',
        message: 'default_value 不能为空',
      });
    }
    if (trimmed.length > TAG_VALUE_MAX) {
      throw badRequest({
        code: 'tag.defaultValue.tooLong',
        messageKey: 'cohort:error.tag.defaultValueTooLong',
        params: { max: TAG_VALUE_MAX },
        message: `默认值最长 ${TAG_VALUE_MAX} 字`,
      });
    }
    default_value = trimmed;
  }
  return default_value ? { rules, default_value } : { rules };
}

function validateRule(raw: unknown, index: number, seen: Set<string>): TagRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest({
      code: 'tag.rule.notObject',
      messageKey: 'cohort:error.tag.ruleNotObject',
      params: { index },
      message: `rules[${index}] 必须是对象`,
    });
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.value !== 'string' || !rec.value.trim()) {
    throw badRequest({
      code: 'tag.rule.valueRequired',
      messageKey: 'cohort:error.tag.ruleValueRequired',
      params: { index },
      message: `rules[${index}].value 必填`,
    });
  }
  const value = rec.value.trim();
  if (value.length > TAG_VALUE_MAX) {
    throw badRequest({
      code: 'tag.rule.valueTooLong',
      messageKey: 'cohort:error.tag.ruleValueTooLong',
      params: { index, max: TAG_VALUE_MAX },
      message: `rules[${index}].value 最长 ${TAG_VALUE_MAX} 字`,
    });
  }
  if (seen.has(value)) {
    throw badRequest({
      code: 'tag.rule.valueDuplicate',
      messageKey: 'cohort:error.tag.ruleValueDuplicate',
      params: { value },
      message: `标签值重复: ${value}`,
    });
  }
  seen.add(value);
  const conditions = validateConditionDefinition({ conditions: rec.conditions }).conditions;
  return { value, conditions };
}

export function normalizeTagSchedule(schedule?: string): TagSchedule {
  if (!schedule || schedule === 'manual') return 'manual';
  if (schedule === 'daily') return 'daily';
  throw badRequest({
    code: 'tag.schedule.invalid',
    messageKey: 'cohort:error.schedule.invalid',
    message: 'schedule 只能是 manual 或 daily',
  });
}
