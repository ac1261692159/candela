/**
 * 指标口径摘要的**结构**（phase: clklog-analytics-i18n-v1 收口）。
 *
 * 起因：告警抽屉的指标下拉展示「事件 pv · 计算 total_times · amount · 近 7 天 · 累计」，
 * 前端手里只有服务端渲染好的中文串（`definition_summary`），拿不到 `definition_json`，
 * 英文界面因此残留中文。
 *
 * 契约（加法式）：服务端把摘要拆成**结构 + 数据**下发（`definition_summary_structure`），
 * 固定文案（事件 / 计算 / 留存 / 天 / 队列…）由前端按 `metrics:summary.*` 与
 * `metrics:window.*` 在渲染边界按查看者语言拼装；中文原文 `definition_summary` 原样保留，
 * 老客户端与未知结构仍读它。
 *
 * 不下发任何语言的文案：`window` 只给天数 + 相对范围（`relative`），`value_pick` 只给枚举值。
 */
import type { TimeRangeRelative } from '../../types/dsl.types';
import { resolveMetricWindow } from './metric-window';

/** 事件指标的窗口结构：天数 + 相对范围（`relative` 仅在服务端按 `relativeRangeLabel` 生成文案时给出） */
export interface MetricSummaryWindow {
  days: number;
  relative?: TimeRangeRelative | null;
  source?: 'metric' | 'rule' | 'default';
  /** 留存指标的口径串带「队列 {window}」前缀（`队列 近 7 天（含今天）`） */
  cohort?: boolean;
}

export interface MetricSummaryStructure {
  kind: 'event' | 'retention' | string;
  /** 事件指标 */
  event?: string;
  analysis?: string;
  prop?: string;
  window?: MetricSummaryWindow;
  /** 取值选择（枚举原值；未登记的值前端回落原值，与 `VALUE_PICK_LABEL` 同口径） */
  value_pick?: string;
  /** 留存指标 */
  start_event?: string;
  retain_event?: string;
  n?: number;
  measure?: 'rate' | 'count';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `definition_json` → 摘要结构（与 `alert-metric-eval.definitionSummary` 的中文串同口径）。
 *
 * 注意：`analysis` 传**原值**（`sum` / `total_times`…）而不是方法展示名——这是现有摘要的
 * 既有形态，中文界面逐字不变是硬要求。
 */
export function metricSummaryStructure(
  kind: string,
  definition: Record<string, unknown>,
): MetricSummaryStructure {
  if (kind === 'event') {
    const metric = asRecord(definition.metric ?? definition);
    const window = metric.time_range ? resolveMetricWindow(metric.time_range) : null;
    return {
      kind: 'event',
      ...(typeof metric.event === 'string' && metric.event ? { event: metric.event } : {}),
      analysis:
        typeof metric.analysis === 'string' ? metric.analysis : String(metric.type ?? ''),
      ...(typeof metric.prop === 'string' && metric.prop ? { prop: metric.prop } : {}),
      ...(window
        ? {
            window: {
              days: window.days,
              // rule/default 路径的中文是短形态（`近 7 天`），结构交给前端按天数生成，不下发 relative
              relative: window.source === 'metric' ? window.range.relative ?? null : null,
              source: window.source,
            },
          }
        : {}),
      ...(typeof metric.value_pick === 'string' && metric.value_pick
        ? { value_pick: metric.value_pick }
        : {}),
    };
  }
  if (kind === 'retention') {
    const n = Number(definition.n ?? 0);
    return {
      kind: 'retention',
      ...(typeof asRecord(definition.start_event).event === 'string'
        ? { start_event: asRecord(definition.start_event).event as string }
        : {}),
      ...(typeof asRecord(definition.retain_event).event === 'string'
        ? { retain_event: asRecord(definition.retain_event).event as string }
        : {}),
      n: Number.isFinite(n) ? n : 0,
      measure: definition.measure === 'count' ? 'count' : 'rate',
    };
  }
  return { kind };
}
