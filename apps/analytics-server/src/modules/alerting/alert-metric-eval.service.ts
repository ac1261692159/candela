import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { EventQueryService } from '../query/event-query.service';
import { MetricEvalService } from '../query/metric-eval.service';
import { RetentionQueryService } from '../query/retention-query.service';
import { metricTimeRange, resolveMetricWindow } from '../query/metric-window';
import { calendarDaysInclusive } from '../query/metric-normalize';
import { metricSummaryStructure, type MetricSummaryStructure } from '../query/metric-summary';
import { isValuePick, resolveValuePick, VALUE_PICK_LABEL } from '../query/metric-value-pick';
import type { EventAnalysisQuery, RetentionQuery, TimeRangeRelative } from '../../types/dsl.types';
import {
  EvalFailureTracker,
  definitionSummary,
  extractEventMetricValue,
  extractRetentionValue,
  formatMetricValue,
  retentionRange,
  windowLabel,
  windowRange,
} from './alert-metric-eval';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { TimezoneService } from '../time/timezone.service';
import { notFound } from '../../i18n/domain-error';

/** 可告警的指标行（metasavedmetric 的读取视图） */
export interface SavedMetricRow {
  metric_id: string;
  project_name: string;
  name: string;
  display_name: string;
  kind: string;
  definition_json: string;
  format: string;
  remark: string | null;
  updated_at: Date;
}

export interface MetricCatalogItem {
  /** 指标自带查询时间的文案（null = 未设置，告警按规则窗口） */
  window_label: string | null;
  /** 取值选择文案（未设置 → 按计算方法推荐） */
  value_pick_label: string | null;
  metric_id: string;
  name: string;
  display_name: string;
  kind: string;
  kind_label: string;
  /** 指标类型名的前端资源键（前端优先用 key；`kind_label` 仅兜底） */
  kind_label_key: string;
  format: string;
  unit: string;
  remark: string | null;
  definition_summary: string;
  /**
   * 口径摘要的**结构**（i18n 收口）：固定文案由前端按 `metrics:summary.*` 渲染；
   * 中文原文 `definition_summary` 保留兜底（老客户端 / 未知 kind）。
   */
  definition_summary_structure?: MetricSummaryStructure | null;
  /** 指标自带查询时间的结构（天数 + 相对范围）：`window_label` 的中文原值不含语言结构 */
  window_days?: number | null;
  window_relative?: TimeRangeRelative | null;
  /** 指标的取值选择（枚举原值；前端用 `metrics:valuePick.*` 渲染） */
  value_pick?: string | null;
  alertable: boolean;
  reason: string | null;
  updated_at: string;
}

export interface MetricProbeResult {
  value: number | null;
  /** 数值 + 单位（试算展示）：按操作者语言本地化单位（i18n v1） */
  value_fmt: string;
  window_days: number;
  window_fmt: string;
  unit: string;
  elapsed_ms: number;
  /** 窗口来源（metric-v2）：metric=指标查询时间；rule=规则窗口；default=默认 7 天 */
  window_source?: 'metric' | 'rule' | 'default';
  /**
   * 窗口的**结构**（i18n 收口）：`relative` 只在指标自带查询时间时下发，
   * 其余按 `window_days` 生成短形态「近 N 天」；`window_cohort` 表示留存口径的「队列」前缀。
   */
  window_relative?: TimeRangeRelative | null;
  window_cohort?: boolean;
  /** 实际使用的取值（metric-v2） */
  pick?: string;
  pick_label?: string;
  error?: string;
}

export interface MetricRuleLike {
  code: string;
  name: string;
  metric_id: string | null;
  project_name: string | null;
  window_days: number;
  /** metric（默认，跟随指标查询时间）/ rule（由本规则窗口指定） */
  time_source?: string | null;
}

/** 指标摘要（模板变量用，避免检测器再查一次库） */
export interface MetricBrief {
  metric_id: string;
  name: string;
  display_name: string;
  kind: string;
  /** 求值窗口文案（metric-v2）：通知模板里的 {{.window}} 用它，指标自带查询时间时显示指标口径 */
  window_label?: string;
}

/** 求值结果：值为 null 表示本轮跳过；metric 为空表示指标已删除 */
export interface MetricEvalOutcome {
  value: number | null;
  metric: MetricBrief | null;
}

const METRIC_CACHE_TTL_MS = 60_000;

/**
 * 指标告警求值（phase: clklog-analytics-alerting-v4）。
 *
 * 观测源 = 数据管理里的**已保存指标**（metasavedmetric），求值复用工作台查询链路
 * （EventQueryService / RetentionQueryService），保证「工作台看到的数」与「告警判定的数」同口径。
 * 有界：每规则每轮 1 次查询，带项目过滤 + 天窗口；失败即跳过本轮（不改状态机，避免误报/误恢复）。
 */
@Injectable()
export class AlertMetricEvalService {
  private readonly logger = new Logger(AlertMetricEvalService.name);
  private readonly failures = new EvalFailureTracker();
  private readonly cache = new Map<string, { at: number; metric: SavedMetricRow | null }>();

  constructor(
    private readonly metricEval: MetricEvalService,
    private readonly prisma: PrismaService,
    private readonly eventQuery: EventQueryService,
    private readonly retentionQuery: RetentionQueryService,
    @Optional() private readonly timezones?: TimezoneService,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  /** 连续失败计数（健康度用） */
  failureOf(code: string) {
    return this.failures.get(code);
  }

  isBroken(code: string): boolean {
    return this.failures.isBroken(code);
  }

  /** 规则/指标变更后清缓存（同进程内立即生效） */
  invalidate(metricId?: string): void {
    if (metricId) this.cache.delete(metricId);
    else this.cache.clear();
  }

  /** 检测循环入口：命中返回数值，取不到返回 null（跳过本轮） */
  async evaluate(rule: MetricRuleLike): Promise<MetricEvalOutcome> {
    if (!rule.metric_id) return { value: null, metric: null };
    try {
      const metric = await this.loadMetric(rule.metric_id);
      if (!metric) {
        this.failures.record(rule.code, '指标不存在或已删除');
        return { value: null, metric: null };
      }
      const computed = await this.compute(metric, rule.window_days, rule.time_source);
      const brief: MetricBrief = {
        metric_id: metric.metric_id,
        name: metric.name,
        display_name: metric.display_name,
        kind: metric.kind,
        window_label: computed.window_fmt,
      };
      if (computed.value === null) {
        this.failures.record(rule.code, '求值结果为空（时间窗口内无数据或队列未成熟）');
        return { value: null, metric: brief };
      }
      this.failures.clear(rule.code);
      return { value: computed.value, metric: brief };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.record(rule.code, message.slice(0, 200));
      this.logger.warn(`指标求值失败 [${rule.code}]: ${message}`);
      return { value: null, metric: null };
    }
  }

  /** 手动「测试取值」：不记录失败计数，直接返回结果或错误；`locale` 为操作者语言（单位本地化） */
  async probe(
    metricId: string,
    project: string,
    windowDays: number,
    timeSource?: string | null,
    locale?: string | null,
  ): Promise<MetricProbeResult> {
    const start = Date.now();
    const metric = await this.loadMetric(metricId, true);
    if (!metric) {
      throw notFound({
        code: 'alerting.metric.notFound',
        messageKey: 'alerting:error.metric.notFound',
        message: '指标不存在',
      });
    }
    const unit = this.unitOf(metric);
    try {
      const computed = await this.compute(metric, windowDays, timeSource);
      return {
        value: computed.value,
        value_fmt:
          computed.value === null ? '—' : formatMetricValue(computed.value, unit, metric.format, locale),
        window_days: computed.window_days,
        // 结构 + 中文原文并存：界面按查看者语言渲染，老客户端仍读 `window_fmt`（i18n 收口）
        window_fmt: computed.window_fmt,
        window_source: computed.window_source,
        window_relative: computed.window_relative,
        window_cohort: computed.window_cohort,
        pick: computed.pick,
        pick_label: computed.pick_label,
        unit,
        elapsed_ms: Date.now() - start,
      };
    } catch (error) {
      return {
        value: null,
        value_fmt: '—',
        window_days: windowDays,
        window_fmt: windowLabel(windowDays, locale ?? undefined),
        // 失败路径没有结构：前端按天数生成短形态「近 N 天」
        window_relative: null,
        window_cohort: false,
        unit,
        elapsed_ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 可选指标清单（含可告警性判断与定义摘要） */
  async catalog(project: string): Promise<MetricCatalogItem[]> {
    const rows = (await this.prisma.metaSavedMetric.findMany({
      where: { project_name: project },
      orderBy: { updated_at: 'desc' },
      take: 200,
    })) as unknown as SavedMetricRow[];
    return rows.map((row) => {
      const definition = this.parseDefinition(row.definition_json);
      const reason = this.unavailableReason(row.kind, definition);
      // 指标自带查询时间：中文文案 + 结构（界面按查看者语言渲染）
      const ownWindow =
        row.kind === 'event' && (definition.metric as { time_range?: unknown } | undefined)?.time_range
          ? resolveMetricWindow((definition.metric as { time_range?: unknown }).time_range)
          : null;
      return {
        metric_id: row.metric_id,
        name: row.name,
        display_name: row.display_name,
        kind: row.kind,
        kind_label: row.kind === 'retention' ? '留存指标' : '事件指标',
        // 前端优先用资源键渲染类型名（中文 label 仅兜底；i18n v1）
        kind_label_key: row.kind === 'retention' ? 'metrics:kind.retention' : 'metrics:kind.event',
        format: row.format,
        unit: this.unitOf(row),
        remark: row.remark ?? null,
        definition_summary: definitionSummary(row.kind, definition),
        // 摘要的结构：固定文案（事件 / 计算 / 留存 / 天…）由前端按语言渲染（i18n 收口）
        definition_summary_structure: metricSummaryStructure(row.kind, definition),
        window_label: ownWindow ? ownWindow.label : null,
        window_days: ownWindow ? ownWindow.days : null,
        window_relative: ownWindow && ownWindow.source === 'metric' ? ownWindow.range.relative ?? null : null,
        value_pick: row.kind === 'event'
          ? pickValueOf(definition.metric as { value_pick?: unknown } | undefined)
          : null,
        value_pick_label: row.kind === 'event'
          ? pickLabelOf(definition.metric as { value_pick?: unknown; analysis?: unknown } | undefined)
          : null,
        alertable: reason === null,
        reason,
        updated_at: (row.updated_at instanceof Date ? row.updated_at : new Date()).toISOString(),
      };
    });
  }

  /** 指标展示单位（留存率固定 %；事件指标没有单位概念，交由规则填写） */
  unitOf(metric: SavedMetricRow): string {
    if (metric.kind === 'retention') {
      const definition = this.parseDefinition(metric.definition_json);
      return definition.measure === 'count' ? '人' : '%';
    }
    return '';
  }

  private unavailableReason(kind: string, definition: Record<string, unknown>): string | null {
    if (kind === 'event') {
      const event = (definition.metric as { event?: unknown } | undefined)?.event;
      if (typeof event !== 'string' || !event) return '事件指标未指定事件，无法求值';
      return null;
    }
    if (kind === 'retention') {
      const n = Number(definition.n ?? 0);
      if (!Number.isInteger(n) || n < 1) return '留存指标周期非法，无法求值';
      return null;
    }
    return `不支持的指标类型：${kind}`;
  }

  /**
   * 真实求值：事件指标走**共享求值服务**（与指标编辑器试算同一实现，PRD AC-7），
   * 留存指标走留存分析。时间范围：规则 time_source=metric 时用指标自带查询时间，
   * 否则用规则窗口（存量规则行为不变）。
   */
  private async compute(
    metric: SavedMetricRow,
    windowDays: number,
    timeSource?: string | null,
  ): Promise<{
    value: number | null;
    window_days: number;
    window_fmt: string;
    window_source: 'metric' | 'rule' | 'default';
    /** 窗口结构（i18n 收口）：仅指标自带查询时间时给出相对范围，其余按天数生成短形态 */
    window_relative: TimeRangeRelative | null;
    /** 留存口径的文案带「队列 {window}」前缀 */
    window_cohort: boolean;
    pick?: string;
    pick_label?: string;
  }> {
    const definition = this.parseDefinition(metric.definition_json);
    if (metric.kind === 'event') {
      const outcome = await this.metricEval.evaluateEvent({
        project: metric.project_name,
        definition,
        fallbackWindowDays: windowDays,
        windowSource: timeSource === 'rule' ? 'rule' : 'metric',
      });
      return {
        value: outcome.value,
        window_days: outcome.window.days,
        window_fmt: outcome.window.label,
        window_source: outcome.window.source,
        window_relative:
          outcome.window.source === 'metric' ? outcome.window.range.relative ?? null : null,
        window_cohort: false,
        pick: outcome.pick,
        pick_label: outcome.pick_label,
      };
    }
    if (metric.kind === 'retention') {
      const n = Number(definition.n ?? 0);
      const measure = definition.measure === 'count' ? 'count' : 'rate';
      // v3：留存指标可自带「队列范围」；未设置时沿用按周期推导（max(30, n+30) 天，上限 180）
      const ownRange = metricTimeRange(definition.time_range);
      const window = ownRange
        ? resolveMetricWindow(ownRange, {
            fallbackDays: calendarDaysInclusive(ownRange.start, ownRange.end),
            tz: this.projectTimes?.timeZoneOf(metric.project_name, this.timezones?.platformTz),
          })
        : null;
      const query: RetentionQuery = {
        project: metric.project_name,
        start_event: definition.start_event as RetentionQuery['start_event'],
        retain_event: definition.retain_event as RetentionQuery['retain_event'],
        cohort: (definition.cohort as RetentionQuery['cohort']) ?? 'all',
        granularity: (definition.granularity as RetentionQuery['granularity']) ?? 'day',
        n_list: [n],
        time_range: window
          ? window.range
          : retentionRange(n, undefined, this.projectTimes?.timeZoneOf(metric.project_name, this.timezones?.platformTz) ?? undefined),
      };
      const result = await this.retentionQuery.analyze(query, metric.project_name, true);
      return {
        value: extractRetentionValue(result.rows as Record<string, unknown>[], n, measure),
        window_days: window ? window.days : windowDays,
        window_fmt: window ? `队列 ${window.label}` : windowLabel(windowDays),
        window_source: window ? ('metric' as const) : ('rule' as const),
        window_relative: window && window.source === 'metric' ? window.range.relative ?? null : null,
        window_cohort: window != null,
      };
    }
    throw new Error(`不支持的指标类型：${metric.kind}`);
  }

  private parseDefinition(json: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async loadMetric(metricId: string, fresh = false): Promise<SavedMetricRow | null> {
    const cached = this.cache.get(metricId);
    if (!fresh && cached && Date.now() - cached.at < METRIC_CACHE_TTL_MS) return cached.metric;
    const row = (await this.prisma.metaSavedMetric.findUnique({
      where: { metric_id: metricId },
    })) as unknown as SavedMetricRow | null;
    this.cache.set(metricId, { at: Date.now(), metric: row });
    return row;
  }
}

/** 取值选择的**原值**：只有用户显式设置过才返回（未设置 = 自动，摘要里不写噪声） */
function pickValueOf(metric: { value_pick?: unknown } | undefined): string | null {
  return metric && isValuePick(metric.value_pick) ? metric.value_pick : null;
}

/** 取值选择文案：只有用户显式设置过才展示（未设置 = 按计算方法推荐，摘要里不写噪声） */
function pickLabelOf(metric: { value_pick?: unknown; analysis?: unknown } | undefined): string | null {
  if (!metric || !isValuePick(metric.value_pick)) return null;
  const analysis = String(metric.analysis ?? 'total_times') as Parameters<typeof resolveValuePick>[1];
  return VALUE_PICK_LABEL[resolveValuePick(metric.value_pick, analysis)];
}
