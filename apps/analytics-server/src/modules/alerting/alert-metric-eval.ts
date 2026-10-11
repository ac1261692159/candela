/**
 * 指标告警求值的纯逻辑：窗口口径、取值、限额、失败计数（phase: clklog-analytics-alerting-v4）。
 * 不依赖 Prisma / NestJS，便于单测；SQL 与查询语义复用工作台查询服务。
 */

import { addCalendarDays, DEFAULT_PLATFORM_TZ, todayInTz } from '../time/calendar';
import { resolveMetricWindow } from '../query/metric-window';
import { VALUE_PICK_LABEL, type ValuePick } from '../query/metric-value-pick';
import { serverT } from '../../i18n/messages';
import { localizeUnit } from '../../i18n/units';

/** 指标规则数量上限（红线 4：求值有界） */
export const MAX_METRIC_RULES = 20;
/** 可选窗口天数（事件分析按天过滤 stat_date，不提供分钟级） */
export const WINDOW_DAYS_OPTIONS = [1, 2, 7, 30];
export const DEFAULT_WINDOW_DAYS = 1;
/** 连续失败多少次后标记健康度异常 */
export const EVAL_FAIL_THRESHOLD = 3;

/**
 * 窗口文案：随语言变化（i18n v1）。
 * 默认 zh-CN 保持原字面；英文走服务端文案包（`src/i18n/messages`）。
 */
export function windowLabel(windowDays: number, locale: string = 'zh-CN'): string {
  const days = Number.isFinite(windowDays) && windowDays > 1 ? windowDays : 1;
  if (locale.startsWith('zh')) {
    return days <= 1 ? '今天' : `近 ${days} 天`;
  }
  return days <= 1
    ? serverT(locale, 'alert.window.today')
    : serverT(locale, 'alert.window.lastDays', { days });
}

/** 规则窗口 → 查询时间范围（平台时区，与查询引擎同一口径，避免 8 小时错位） */
export function windowRange(windowDays: number, now = new Date(), tz = DEFAULT_PLATFORM_TZ): { start: string; end: string } {
  const days = WINDOW_DAYS_OPTIONS.includes(windowDays) ? windowDays : DEFAULT_WINDOW_DAYS;
  const today = todayInTz(tz, now);
  return { start: addCalendarDays(today, -(days - 1)), end: today };
}

/** 留存指标的队列时间范围：需覆盖 n 天成熟期，上限 180 天（有界查询） */
export function retentionRange(n: number, now = new Date(), tz = DEFAULT_PLATFORM_TZ): { start: string; end: string } {
  const today = todayInTz(tz, now);
  const span = Math.min(180, Math.max(30, n + 30));
  return { start: addCalendarDays(today, -(span - 1)), end: today };
}

/** 任意来源的原始值 → 有限数字或 null（null 表示本轮跳过，不参与状态机） */
export function toMetricValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 事件指标：单指标无分组 → 聚合单行，取值键固定 m_0 */
export function extractEventMetricValue(rows: Record<string, unknown>[], key = 'm_0'): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return toMetricValue(rows[0]?.[key]);
}

/**
 * 留存指标：取**最新一个已成熟队列**的值。
 * rate 为 0~1 小数，×100 与平台展示的百分比一致；count 直接取人数。
 */
export function extractRetentionValue(
  rows: Record<string, unknown>[],
  n: number,
  measure: string,
): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const key = measure === 'count' ? `n_${n}` : `n_${n}_rate`;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = toMetricValue(rows[i]?.[key]);
    if (value !== null) return measure === 'count' ? value : Math.round(value * 10000) / 100;
  }
  return null;
}

/**
 * 数值展示：千分位 + 单位；百分比类（0~100 数字）带 %。
 *
 * `locale` 用于单位本地化（i18n v1）：zh-CN（或未传）逐字不变（`1,204次`），
 * 其他语言映射成英文单位并在西文单位前补一个空格（`1,204 times`）。
 */
export function formatMetricValue(
  value: number,
  unit: string,
  format?: string,
  locale?: string | null,
): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  const text = rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (format === 'percent') return `${text}%`;
  const localized = localizeUnit(unit, locale);
  if (!localized) return text;
  // 中文（未被本地化）单位紧贴数字，保持历史输出；仅当单位真的被翻译成西文时才补空格
  if (localized === unit) return `${text}${localized}`;
  return /^[A-Za-z]/.test(localized) ? `${text} ${localized}` : `${text}${localized}`;
}

/** 指标定义摘要（工作台选择列表里给运营看的一句话） */
export function definitionSummary(kind: string, definition: Record<string, unknown>): string {
  if (kind === 'event') {
    const metric = (definition.metric ?? {}) as Record<string, unknown>;
    const event = typeof metric.event === 'string' ? metric.event : '(未指定事件)';
    const analysis = typeof metric.analysis === 'string' ? metric.analysis : String(metric.type ?? '');
    const prop = typeof metric.prop === 'string' && metric.prop ? ` · ${metric.prop}` : '';
    // v2：查询时间与取值属于口径，摘要里带上（未设置则保持存量文案）
    const window = metric.time_range ? ` · ${resolveMetricWindow(metric.time_range).label}` : '';
    const pick = metric.value_pick
      ? ` · ${VALUE_PICK_LABEL[metric.value_pick as ValuePick] ?? String(metric.value_pick)}`
      : '';
    return `事件 ${event} · 计算 ${analysis}${prop}${window}${pick}`;
  }
  if (kind === 'retention') {
    const start = (definition.start_event as { event?: string } | undefined)?.event ?? '?';
    const retain = (definition.retain_event as { event?: string } | undefined)?.event ?? '?';
    const n = Number(definition.n ?? 0);
    const measure = definition.measure === 'count' ? '人数' : '留存率';
    return `留存 ${start} → ${retain} · ${n} 天 · ${measure}`;
  }
  return kind;
}

/** 连续求值失败计数（内存态，进程内可见；健康度用） */
export class EvalFailureTracker {
  private readonly failures = new Map<string, { count: number; message: string }>();

  record(code: string, message: string): void {
    const prev = this.failures.get(code);
    this.failures.set(code, { count: (prev?.count ?? 0) + 1, message });
  }

  clear(code: string): void {
    this.failures.delete(code);
  }

  get(code: string): { count: number; message: string } | undefined {
    return this.failures.get(code);
  }

  /** 是否已达到「持续失败」阈值（超过阈值才报健康度异常，避免单次抖动） */
  isBroken(code: string): boolean {
    return (this.failures.get(code)?.count ?? 0) >= EVAL_FAIL_THRESHOLD;
  }
}
