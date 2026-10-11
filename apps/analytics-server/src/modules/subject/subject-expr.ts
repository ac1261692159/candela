import { ANALYSIS_UID_EXPR } from '../../types/dsl.types';
import { JoinRegistry, userProfileJoinRequest } from '../relation/join-registry';

export type SubjectSource = {
  scope: 'event' | 'user';
  prop: string;
  column?: string | null;
};

export type ResolvedSubject = {
  subject_id: string;
  kind: 'preset' | 'property';
  source?: SubjectSource;
};

/** 与 dsl-validator PROP_KEY_PATTERN 同口径：兼容神策/数数系 SDK 的 `$` 前缀系统属性（2026-09-17 生产 smoke AS-2 回归——`$os` 曾被这里判空导致主体统归为 ''） */
const PROP_KEY = /^\$?[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$/;

function propExtract(source: SubjectSource, alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  if (source.column && PROP_KEY.test(source.column)) {
    return `toString(${prefix}${source.column})`;
  }
  if (!PROP_KEY.test(source.prop)) return `''`;
  return `JSONExtractString(${prefix}properties, '${source.prop}')`;
}

/**
 * sa_events 上的主体 ID 表达式。
 *
 * `joins` 只在**使用方查询的 FROM 是 `clklog_sa.sa_events`** 时传入（生成器负责把
 * `joins.render()` 拼到 FROM 之后）。用户属性主体必须传：ClickHouse 23.2.1 不支持
 * 相关子查询，改由 `LEFT JOIN sa_user_profiles` 取数。
 */
export function subjectExpr(subject: ResolvedSubject | null | undefined, joins?: JoinRegistry): string {
  if (!subject || subject.kind === 'preset' || !subject.source?.prop) {
    return ANALYSIS_UID_EXPR;
  }
  if (subject.source.scope === 'user') {
    if (!joins) {
      throw new Error(
        '用户属性分析主体需要 JoinRegistry：请在使用方查询里传入 joins 并渲染 JOIN（modules/relation/join-registry.ts）',
      );
    }
    const alias = joins.register(userProfileJoinRequest());
    return `nullIf(${propExtract(subject.source, alias)}, '')`;
  }
  return `nullIf(${propExtract(subject.source)}, '')`;
}

/** sa_user_profiles 上的主体 ID（ID 上传 / 用户属性条件）。 */
export function subjectProfileExpr(subject: ResolvedSubject | null | undefined): string {
  if (!subject || subject.kind === 'preset' || !subject.source?.prop) {
    return ANALYSIS_UID_EXPR;
  }
  if (subject.source.scope === 'event') {
    return `nullIf(JSONExtractString(properties, '${subject.source.prop}'), '')`;
  }
  return `nullIf(${propExtract(subject.source)}, '')`;
}

export function subjectNonEmptyPred(expr: string): string {
  return `(${expr}) != ''`;
}

export function uniqExactSubject(expr: string): string {
  return uniqSubject(expr, false);
}

/** 主体去重：精确 uniqExactIf，近似 uniqCombinedIf(12)。 */
export function uniqSubject(expr: string, approx?: boolean): string {
  if (approx) return `uniqCombinedIf(12)(${expr}, ${subjectNonEmptyPred(expr)})`;
  return `uniqExactIf(${expr}, ${subjectNonEmptyPred(expr)})`;
}

/** 属性去重：精确 uniqExact，近似 uniqCombined(12)。 */
export function uniqExpr(expr: string, approx?: boolean): string {
  if (approx) return `uniqCombined(12)(${expr})`;
  return `uniqExact(${expr})`;
}

export function subjectForbidsNegativeUniverse(subject: ResolvedSubject | null | undefined): boolean {
  return Boolean(subject && subject.kind === 'property' && subject.source?.scope === 'event');
}
