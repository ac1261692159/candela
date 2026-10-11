import { badRequest, notFound, type DomainError } from '../../i18n/domain-error';
import { DEFAULT_PLATFORM_TZ, todayInTz } from '../time/calendar';
import { conditionsUseDidNot } from '../subject/subject-definition';
import { subjectForbidsNegativeUniverse, type ResolvedSubject } from '../subject/subject-expr';

export const COHORT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
export const COHORT_KINDS = ['condition', 'id_upload', 'result', 'sql'] as const;
export type CohortKind = (typeof COHORT_KINDS)[number];
export const COHORT_SCHEDULES = ['manual', 'daily'] as const;
export type CohortSchedule = (typeof COHORT_SCHEDULES)[number];
export const COUNT_OPS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;
export const USER_PROP_OPS = [
  '=',
  '!=',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'regex',
  'not_regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'not_set',
] as const;

export type CohortTime =
  | { mode: 'last_n_days'; n: number }
  | { mode: 'static'; start: string; end: string };

export type DidEventCondition = {
  type: 'did_event';
  polarity: 'did' | 'did_not';
  event: string;
  metric: 'times';
  op: (typeof COUNT_OPS)[number];
  value: number;
  time: CohortTime;
};

export type SequenceCondition = {
  type: 'sequence';
  polarity: 'did' | 'did_not';
  events: string[];
  time: CohortTime;
};

export type UserPropCondition = {
  type: 'user_prop';
  prop: string;
  op: (typeof USER_PROP_OPS)[number];
  value?: unknown;
};

export type CohortCondition = DidEventCondition | SequenceCondition | UserPropCondition;

export type ConditionDefinition = { conditions: CohortCondition[] };
export type IdUploadDefinition = { match: 'uid' };
export type ResultDefinition = {
  source: 'event' | 'funnel' | 'retention';
  dsl: Record<string, unknown>;
  cell: Record<string, unknown>;
};

export const SQL_TIME_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const SQL_COHORT_PREVIEW_LIMIT = 1000;
export const SQL_COHORT_MATERIALIZE_LIMIT = 1_000_000;
export const SQL_COHORT_DEFAULT_WINDOW_DAYS = 7;

export type SqlTimeParam =
  | { name: string; mode: 'last_n_days'; n: number; bound: 'start' | 'end' }
  | { name: string; mode: 'static'; date: string };

export type SqlDefinition = {
  sql_text: string;
  time_params: SqlTimeParam[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 分群不存在：8 处同文案，集中一处（同一条兜底不再被复制多份） */
export function cohortNotFound(): DomainError {
  return notFound({
    code: 'cohort.notFound',
    messageKey: 'cohort:error.cohort.notFound',
    message: '分群不存在',
  });
}

/**
 * 「没做过 / 没依次做过」的宇宙是「窗内出现过的主体」，事件属性主体定义不出这个宇宙。
 * 创建与试跑共用这一处判断，避免两条路径给出不同答案。
 */
export function assertNegativeUniverseSupported(subject: ResolvedSubject, conditions: unknown): void {
  if (!subjectForbidsNegativeUniverse(subject) || !conditionsUseDidNot(conditions)) return;
  throw badRequest({
    code: 'cohort.subject.didNotUnsupported',
    messageKey: 'cohort:error.subject.didNotUnsupported',
    message: '事件属性主体不能使用「没做过 / 没依次做过」',
  });
}

export function parseDefinitionJson(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw badRequest({
        code: 'cohort.definition.jsonInvalid',
        messageKey: 'cohort:error.definition.jsonInvalid',
        message: 'definition_json 不是合法 JSON',
      });
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw badRequest({
    code: 'cohort.definition.jsonRequired',
    messageKey: 'cohort:error.definition.jsonRequired',
    message: 'definition_json 必填',
  });
}

export function validateCohortName(name: string): string {
  if (!COHORT_NAME_PATTERN.test(name)) {
    throw badRequest({
      code: 'cohort.name.invalid',
      messageKey: 'cohort:error.cohort.nameInvalid',
      message: '分群名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
    });
  }
  return name;
}

export function normalizeSchedule(kind: CohortKind, schedule?: string): CohortSchedule {
  if (kind === 'id_upload' || kind === 'result') return 'manual';
  if (!schedule || schedule === 'manual') return 'manual';
  if (schedule === 'daily') return 'daily';
  throw badRequest({
    code: 'cohort.schedule.invalid',
    messageKey: 'cohort:error.schedule.invalid',
    message: 'schedule 只能是 manual 或 daily',
  });
}

export function validateDefinition(kind: CohortKind, raw: unknown): Record<string, unknown> {
  if (kind === 'condition') return validateConditionDefinition(raw) as unknown as Record<string, unknown>;
  if (kind === 'id_upload') {
    parseDefinitionJson(raw);
    return { match: 'uid' };
  }
  if (kind === 'sql') return validateSqlDefinition(raw) as unknown as Record<string, unknown>;
  return validateResultDefinition(raw);
}

export function validateConditionDefinition(raw: unknown): ConditionDefinition {
  const def = parseDefinitionJson(raw);
  if (!Array.isArray(def.conditions) || def.conditions.length === 0) {
    throw badRequest({
      code: 'cohort.condition.required',
      messageKey: 'cohort:error.condition.required',
      message: '条件分群至少一条条件',
    });
  }
  if (def.conditions.length > 20) {
    throw badRequest({
      code: 'cohort.condition.tooMany',
      messageKey: 'cohort:error.condition.tooMany',
      params: { max: 20 },
      message: '条件最多 20 条',
    });
  }
  return { conditions: def.conditions.map((item, index) => validateCondition(item, index)) };
}

function validateCondition(raw: unknown, index: number): CohortCondition {
  if (!raw || typeof raw !== 'object') {
    throw badRequest({
      code: 'cohort.condition.notObject',
      messageKey: 'cohort:error.condition.notObject',
      params: { index },
      message: `conditions[${index}] 必须是对象`,
    });
  }
  const item = raw as Record<string, unknown>;
  if (item.type === 'did_event') return validateDidEvent(item, index);
  if (item.type === 'sequence') return validateSequence(item, index);
  if (item.type === 'user_prop') return validateUserProp(item, index);
  throw badRequest({
    code: 'cohort.condition.typeUnsupported',
    messageKey: 'cohort:error.condition.typeUnsupported',
    params: { index },
    message: `conditions[${index}].type 不支持`,
  });
}

function validateDidEvent(item: Record<string, unknown>, index: number): DidEventCondition {
  const polarity = item.polarity === 'did_not' ? 'did_not' : item.polarity === 'did' ? 'did' : null;
  if (!polarity) {
    throw badRequest({
      code: 'cohort.condition.polarityInvalid',
      messageKey: 'cohort:error.condition.polarityInvalid',
      params: { index },
      message: `conditions[${index}].polarity 必须是 did 或 did_not`,
    });
  }
  if (typeof item.event !== 'string' || !item.event.trim()) {
    throw badRequest({
      code: 'cohort.condition.eventRequired',
      messageKey: 'cohort:error.condition.eventRequired',
      params: { index },
      message: `conditions[${index}].event 必填`,
    });
  }
  const op = String(item.op);
  if (!COUNT_OPS.includes(op as (typeof COUNT_OPS)[number])) {
    throw badRequest({
      code: 'cohort.condition.opInvalid',
      messageKey: 'cohort:error.condition.opInvalid',
      params: { index },
      message: `conditions[${index}].op 不合法`,
    });
  }
  const value = Number(item.value);
  if (!Number.isFinite(value) || value < 0) {
    throw badRequest({
      code: 'cohort.condition.valueInvalid',
      messageKey: 'cohort:error.condition.valueInvalid',
      params: { index },
      message: `conditions[${index}].value 必须是非负数字`,
    });
  }
  return {
    type: 'did_event',
    polarity,
    event: item.event.trim(),
    metric: 'times',
    op: op as (typeof COUNT_OPS)[number],
    value,
    time: validateTime(item.time, index),
  };
}

function validateSequence(item: Record<string, unknown>, index: number): SequenceCondition {
  const polarity = item.polarity === 'did_not' ? 'did_not' : item.polarity === 'did' ? 'did' : null;
  if (!polarity) {
    throw badRequest({
      code: 'cohort.condition.polarityInvalid',
      messageKey: 'cohort:error.condition.polarityInvalid',
      params: { index },
      message: `conditions[${index}].polarity 必须是 did 或 did_not`,
    });
  }
  if (!Array.isArray(item.events) || item.events.length < 2) {
    throw badRequest({
      code: 'cohort.condition.eventsTooFew',
      messageKey: 'cohort:error.condition.eventsTooFew',
      params: { index, min: 2 },
      message: `conditions[${index}].events 至少 2 个`,
    });
  }
  const events = item.events.map((event, eventIndex) => {
    if (typeof event !== 'string' || !event.trim()) {
      throw badRequest({
        code: 'cohort.condition.eventItemRequired',
        messageKey: 'cohort:error.condition.eventItemRequired',
        params: { index, eventIndex },
        message: `conditions[${index}].events[${eventIndex}] 必填`,
      });
    }
    return event.trim();
  });
  return { type: 'sequence', polarity, events, time: validateTime(item.time, index) };
}

function validateUserProp(item: Record<string, unknown>, index: number): UserPropCondition {
  if (typeof item.prop !== 'string' || !item.prop.trim()) {
    throw badRequest({
      code: 'cohort.condition.propRequired',
      messageKey: 'cohort:error.condition.propRequired',
      params: { index },
      message: `conditions[${index}].prop 必填`,
    });
  }
  const op = String(item.op);
  if (!USER_PROP_OPS.includes(op as (typeof USER_PROP_OPS)[number])) {
    throw badRequest({
      code: 'cohort.condition.opInvalid',
      messageKey: 'cohort:error.condition.opInvalid',
      params: { index },
      message: `conditions[${index}].op 不合法`,
    });
  }
  if (!['is_set', 'not_set'].includes(op) && item.value === undefined) {
    throw badRequest({
      code: 'cohort.condition.valueRequired',
      messageKey: 'cohort:error.condition.valueRequired',
      params: { index },
      message: `conditions[${index}].value 必填`,
    });
  }
  return { type: 'user_prop', prop: item.prop.trim(), op: op as UserPropCondition['op'], value: item.value };
}

function validateTime(raw: unknown, index: number): CohortTime {
  if (!raw || typeof raw !== 'object') {
    throw badRequest({
      code: 'cohort.condition.timeRequired',
      messageKey: 'cohort:error.condition.timeRequired',
      params: { index },
      message: `conditions[${index}].time 必填`,
    });
  }
  const time = raw as Record<string, unknown>;
  if (time.mode === 'last_n_days') {
    const n = Number(time.n);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      throw badRequest({
        code: 'cohort.condition.timeNInvalid',
        messageKey: 'cohort:error.condition.timeNInvalid',
        params: { index, min: 1, max: 365 },
        message: `conditions[${index}].time.n 须为 1~365`,
      });
    }
    return { mode: 'last_n_days', n };
  }
  if (time.mode === 'static') {
    if (typeof time.start !== 'string' || typeof time.end !== 'string' || !DATE.test(time.start) || !DATE.test(time.end)) {
      throw badRequest({
        code: 'cohort.condition.timeStartEndInvalid',
        messageKey: 'cohort:error.condition.timeStartEndInvalid',
        params: { index },
        message: `conditions[${index}].time.start/end 须为 YYYY-MM-DD`,
      });
    }
    if (time.start > time.end) {
      throw badRequest({
        code: 'cohort.condition.timeRangeReversed',
        messageKey: 'cohort:error.condition.timeRangeReversed',
        params: { index },
        message: `conditions[${index}] 时间窗起止颠倒`,
      });
    }
    return { mode: 'static', start: time.start, end: time.end };
  }
  throw badRequest({
    code: 'cohort.condition.timeModeInvalid',
    messageKey: 'cohort:error.condition.timeModeInvalid',
    params: { index },
    message: `conditions[${index}].time.mode 不合法`,
  });
}

function validateSqlDefinition(raw: unknown): SqlDefinition {
  const def = parseDefinitionJson(raw);
  if (typeof def.sql_text !== 'string' || !def.sql_text.trim()) {
    throw badRequest({
      code: 'cohort.sql.textRequired',
      messageKey: 'cohort:error.sql.textRequired',
      message: 'SQL 分群必须填写 sql_text',
    });
  }
  if (def.sql_text.length > 20_000) {
    throw badRequest({
      code: 'cohort.sql.textTooLong',
      messageKey: 'cohort:error.sql.textTooLong',
      params: { max: 20000 },
      message: 'SQL 最长 20000 字',
    });
  }
  if (!Array.isArray(def.time_params)) {
    throw badRequest({
      code: 'cohort.sql.timeParamsNotArray',
      messageKey: 'cohort:error.sql.timeParamsNotArray',
      message: 'time_params 必须是数组',
    });
  }
  if (def.time_params.length > 20) {
    throw badRequest({
      code: 'cohort.sql.timeParamsTooMany',
      messageKey: 'cohort:error.sql.timeParamsTooMany',
      params: { max: 20 },
      message: '时间参数最多 20 个',
    });
  }
  const names = new Set<string>();
  const time_params = def.time_params.map((item, index) => validateSqlTimeParam(item, index, names));
  const sql_text = def.sql_text.trim();
  const parsed = { sql_text, time_params };
  substituteSqlPartDates(parsed, computeDay());
  return parsed;
}

function validateSqlTimeParam(raw: unknown, index: number, names: Set<string>): SqlTimeParam {
  if (!raw || typeof raw !== 'object') {
    throw badRequest({
      code: 'cohort.sql.timeParamNotObject',
      messageKey: 'cohort:error.sql.timeParamNotObject',
      params: { index },
      message: `time_params[${index}] 必须是对象`,
    });
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== 'string' || !SQL_TIME_PARAM_NAME.test(item.name)) {
    throw badRequest({
      code: 'cohort.sql.timeParamNameInvalid',
      messageKey: 'cohort:error.sql.timeParamNameInvalid',
      params: { index, max: 32 },
      message: `time_params[${index}].name 须为字母/数字/下划线，最长 32`,
    });
  }
  if (names.has(item.name)) {
    throw badRequest({
      code: 'cohort.sql.timeParamNameDuplicate',
      messageKey: 'cohort:error.sql.timeParamNameDuplicate',
      params: { name: item.name },
      message: `时间参数名重复: ${item.name}`,
    });
  }
  names.add(item.name);
  if (item.mode === 'last_n_days') {
    const n = Number(item.n);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      throw badRequest({
        code: 'cohort.sql.timeParamNInvalid',
        messageKey: 'cohort:error.sql.timeParamNInvalid',
        params: { index, min: 1, max: 365 },
        message: `time_params[${index}].n 须为 1~365`,
      });
    }
    const bound = item.bound === 'end' ? 'end' : item.bound === 'start' ? 'start' : null;
    if (!bound) {
      throw badRequest({
        code: 'cohort.sql.timeParamBoundInvalid',
        messageKey: 'cohort:error.sql.timeParamBoundInvalid',
        params: { index },
        message: `time_params[${index}].bound 必须是 start 或 end`,
      });
    }
    return { name: item.name, mode: 'last_n_days', n, bound };
  }
  if (item.mode === 'static') {
    if (typeof item.date !== 'string' || !DATE.test(item.date)) {
      throw badRequest({
        code: 'cohort.sql.timeParamDateInvalid',
        messageKey: 'cohort:error.sql.timeParamDateInvalid',
        params: { index },
        message: `time_params[${index}].date 须为 YYYY-MM-DD`,
      });
    }
    return { name: item.name, mode: 'static', date: item.date };
  }
  throw badRequest({
    code: 'cohort.sql.timeParamModeInvalid',
    messageKey: 'cohort:error.sql.timeParamModeInvalid',
    params: { index },
    message: `time_params[${index}].mode 不合法`,
  });
}

export function resolveSqlTimeParam(param: SqlTimeParam, computeDay: string): string {
  if (param.mode === 'static') return param.date;
  const window = { start: shiftDate(computeDay, -param.n), end: shiftDate(computeDay, -1) };
  return param.bound === 'end' ? window.end : window.start;
}

export function resolveSqlInjectionWindow(
  params: SqlTimeParam[],
  computeDay: string,
): { start: string; end: string } {
  if (params.length === 0) {
    return {
      start: shiftDate(computeDay, -SQL_COHORT_DEFAULT_WINDOW_DAYS),
      end: shiftDate(computeDay, -1),
    };
  }
  const dates = params.map((param) => {
    if (param.mode === 'static') return { start: param.date, end: param.date };
    return { start: shiftDate(computeDay, -param.n), end: shiftDate(computeDay, -1) };
  });
  return {
    start: dates.reduce((min, item) => (item.start < min ? item.start : min), dates[0].start),
    end: dates.reduce((max, item) => (item.end > max ? item.end : max), dates[0].end),
  };
}

export function substituteSqlPartDates(def: SqlDefinition, computeDay: string): string {
  const values = new Map(def.time_params.map((param) => [param.name, resolveSqlTimeParam(param, computeDay)]));
  return def.sql_text.replace(/\$\{([^}]+)\}/g, (full, inner: string) => {
    const match = /^PartDate:([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner.trim());
    if (!match) {
      throw badRequest({
        code: 'cohort.sql.placeholderUndeclared',
        messageKey: 'cohort:error.sql.placeholderUndeclared',
        params: { placeholder: full },
        message: `未声明的占位符: ${full}`,
      });
    }
    const value = values.get(match[1]);
    if (value === undefined) {
      throw badRequest({
        code: 'cohort.sql.timeParamUndeclared',
        messageKey: 'cohort:error.sql.timeParamUndeclared',
        params: { name: match[1] },
        message: `未声明的时间参数: ${match[1]}`,
      });
    }
    return value;
  });
}

function validateResultDefinition(raw: unknown): ResultDefinition {
  const def = parseDefinitionJson(raw);
  if (def.source !== 'event' && def.source !== 'funnel' && def.source !== 'retention') {
    throw badRequest({
      code: 'cohort.result.sourceInvalid',
      messageKey: 'cohort:error.result.sourceInvalid',
      message: '结果分群 source 必须是 event / funnel / retention',
    });
  }
  if (!def.dsl || typeof def.dsl !== 'object') {
    throw badRequest({
      code: 'cohort.result.dslRequired',
      messageKey: 'cohort:error.result.dslRequired',
      message: '结果分群缺少 dsl',
    });
  }
  if (!def.cell || typeof def.cell !== 'object') {
    throw badRequest({
      code: 'cohort.result.cellRequired',
      messageKey: 'cohort:error.result.cellRequired',
      message: '结果分群缺少 cell',
    });
  }
  return {
    source: def.source,
    dsl: def.dsl as Record<string, unknown>,
    cell: def.cell as Record<string, unknown>,
  };
}

export function shiftDate(isoDay: string, deltaDays: number): string {
  const [year, month, day] = isoDay.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return date.toISOString().slice(0, 10);
}

/**
 * 分群/标签日更的「计算日」（平台日历；ZQ-2 修正——原按 UTC 今天，
 * 与分析链路的上海今天每日 0-8 点差一天）。
 */
export function computeDay(tz = DEFAULT_PLATFORM_TZ, now: Date = new Date()): string {
  return todayInTz(tz, now);
}

export function resolveConditionTime(time: CohortTime, computeDay: string): { start: string; end: string } {
  if (time.mode === 'static') return { start: time.start, end: time.end };
  return { start: shiftDate(computeDay, -time.n), end: shiftDate(computeDay, -1) };
}

export function countOpSql(op: (typeof COUNT_OPS)[number]): string {
  if (op === 'gt') return '>';
  if (op === 'gte') return '>=';
  if (op === 'lt') return '<';
  if (op === 'lte') return '<=';
  return '=';
}

export function parseCsvUids(csvText: string): string[] {
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/);
  const ids: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const first = line.split(/[,;\t]/)[0].trim().replace(/^"|"$/g, '');
    if (i === 0 && first.toLowerCase() === 'uid') continue;
    if (first) ids.push(first);
    if (ids.length > 1_000_000) {
      throw badRequest({
        code: 'cohort.idUpload.tooManyRows',
        messageKey: 'cohort:error.idUpload.tooManyRows',
        message: 'ID 分群最多 100 万行',
      });
    }
  }
  if (ids.length === 0) {
    throw badRequest({
      code: 'cohort.idUpload.noValidIds',
      messageKey: 'cohort:error.idUpload.noValidIds',
      message: 'CSV 没有有效 ID',
    });
  }
  return [...new Set(ids)];
}
