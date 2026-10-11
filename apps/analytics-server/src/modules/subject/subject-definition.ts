import { badRequest } from '../../i18n/domain-error';

export const SUBJECT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
export const PRESET_SUBJECT_NAME = 'user';
export const PRESET_SUBJECT_DISPLAY = '用户';

export type SubjectKind = 'preset' | 'property';

export type SubjectSourceJson = {
  scope: 'event' | 'user';
  prop: string;
};

export function validateSubjectName(name: string): string {
  const trimmed = name.trim();
  if (!SUBJECT_NAME_PATTERN.test(trimmed)) {
    throw badRequest({
      code: 'subject.name.invalid',
      messageKey: 'cohort:error.subject.nameInvalid',
      message: '主体名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
    });
  }
  if (trimmed === PRESET_SUBJECT_NAME) {
    throw badRequest({
      code: 'subject.name.presetTaken',
      messageKey: 'cohort:error.subject.presetNameTaken',
      message: 'user 为预置主体名，不可占用',
    });
  }
  return trimmed;
}

export function parseSubjectSource(raw: unknown): SubjectSourceJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest({
      code: 'subject.source.required',
      messageKey: 'cohort:error.subject.sourceRequired',
      message: '自定义主体必须指定来源属性',
    });
  }
  const rec = raw as Record<string, unknown>;
  if (rec.scope !== 'event' && rec.scope !== 'user') {
    throw badRequest({
      code: 'subject.source.scopeInvalid',
      messageKey: 'cohort:error.subject.sourceScopeInvalid',
      message: '来源 scope 必须是 event 或 user',
    });
  }
  if (typeof rec.prop !== 'string' || !rec.prop.trim()) {
    throw badRequest({
      code: 'subject.source.propRequired',
      messageKey: 'cohort:error.subject.sourcePropRequired',
      message: '来源属性必填',
    });
  }
  return { scope: rec.scope, prop: rec.prop.trim() };
}

export function conditionsUseDidNot(conditions: unknown): boolean {
  if (!Array.isArray(conditions)) return false;
  return conditions.some((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as { polarity?: string }).polarity === 'did_not';
  });
}
