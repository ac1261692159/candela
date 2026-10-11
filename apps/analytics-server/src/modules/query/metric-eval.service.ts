import { Injectable, Optional } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import type { AnalysisMethod, EventAnalysisQuery, FilterGroup, Metric } from '../../types/dsl.types';
import { EventQueryService } from './event-query.service';
import { resolveMetricWindow, windowDates, type MetricWindow } from './metric-window';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { TimezoneService } from '../time/timezone.service';
import {
  isValuePick,
  pickNeedsSeries,
  pickSeriesValue,
  resolveValuePick,
  VALUE_PICK_DESCRIPTION,
  VALUE_PICK_LABEL,
  type SeriesPoint,
  type ValuePick,
} from './metric-value-pick';

export interface MetricEvalOutcome {
  /** 归并（并应用数值变换）后的指标值；null = 本轮无值 */
  value: number | null;
  /** 窗口内日序列（补齐无数据的日子）；未取序列时为空数组 */
  series: SeriesPoint[];
  window: MetricWindow;
  /** 实际使用的取值（未设置时给推荐值） */
  pick: ValuePick;
  pick_label: string;
  pick_note: string;
  /** 该取值是用户显式设置还是按方法推荐 */
  pick_explicit: boolean;
  /** 指标值是否由「整段查询」得出（不可加方法唯一正确的路径） */
  used_overall: boolean;
  elapsed_ms: number;
}

export interface MetricEvalInput {
  project: string;
  /** 指标定义（`definition_json`，事件指标：`{ metric: {...} }`） */
  definition: Record<string, unknown>;
  /** 指标的 kind（本期只支持 event） */
  kind?: string;
  /** 没有指标级查询时间时的兜底窗口（告警规则的 N 天） */
  fallbackWindowDays?: number;
  /** 是否要日序列（试算面板要；告警求值不要，省一条查询） */
  withSeries?: boolean;
  /** 取整段结果时的数据权限（告警无；工作台按登录人） */
  refresh?: boolean;
  /** 时间范围来源：metric（默认，指标优先）/ rule（规则窗口覆盖指标） */
  windowSource?: 'metric' | 'rule';
}

/**
 * 已保存指标求值（phase: clklog-analytics-metric-v2）。
 *
 * **试算（指标编辑器）与告警求值共用这一份实现**——两个入口各写一套必然出现「界面一个数、
 * 告警另一个数」的经典问题（PRD AC-7 用交叉验证锁住）。
 *
 * 归并口径（与既有告警完全兼容）：
 * - 未设「取值选择」→ 整段聚合查询（现状口径），值不变；
 * - 取值 ∈ {整段去重合计, 加权平均} → 同样整段聚合（去重/人均按日相加是错的）；
 * - 其余取值 → 按天分组取日序列，再按取值归并。
 */
@Injectable()
export class MetricEvalService {
  constructor(
    private readonly eventQuery: EventQueryService,
    @Optional() private readonly timezones?: TimezoneService,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  async evaluateEvent(input: MetricEvalInput): Promise<MetricEvalOutcome> {
    if (input.kind && input.kind !== 'event') {
      throw badRequest({
        code: 'analysis.metricEval.kindUnsupported',
        messageKey: 'analysis:error.metricEval.kindUnsupported',
        params: { kind: input.kind },
        message: `暂不支持 ${input.kind} 指标试算/求值`,
      });
    }
    const definition = input.definition ?? {};
    const raw = (definition.metric ?? definition) as Record<string, unknown>;
    const event = typeof raw.event === 'string' ? raw.event.trim() : '';
    if (!event) {
      throw badRequest({
        code: 'analysis.metricEval.eventRequired',
        messageKey: 'analysis:error.metricEval.eventRequired',
        message: '指标未指定事件，无法求值',
      });
    }

    const analysis = String(raw.analysis ?? raw.type ?? 'total_times') as AnalysisMethod;
    const explicit = isValuePick(raw.value_pick);
    const pick = resolveValuePick(raw.value_pick, analysis);
    // 窗口日历按项目时区（timezone-v2；未设 = 平台）
    const metricTz = this.projectTimes?.timeZoneOf(input.project, this.timezones?.platformTz);
    const window = resolveMetricWindow(
      input.windowSource === 'rule' ? undefined : raw.time_range,
      { fallbackDays: input.fallbackWindowDays, tz: metricTz },
    );
    // 定义里的 metric 就是分析 DSL 的指标对象（event/analysis/prop/filters/percentile…）
    const metric: Metric = { ...(raw as unknown as Metric), id: 'm_metric', kind: 'event' };
    const filters = raw.filters as FilterGroup | undefined;

    const started = Date.now();
    let value: number | null = null;
    let series: SeriesPoint[] = [];
    let usedOverall = false;

    const needsSeries = explicit && pickNeedsSeries(pick);
    if (needsSeries) {
      // stage_reduce 固定 sum：本层自己归并，避免引擎为整段值再跑一条查询
      series = await this.loadSeries(input.project, event, { ...metric, stage_reduce: 'sum' }, filters, window, input.refresh);
      value = pickSeriesValue(pick, series, window.days);
      usedOverall = false;
    } else {
      value = await this.loadOverall(input.project, event, metric, filters, window, input.refresh);
      usedOverall = true;
      if (input.withSeries) {
        series = await this.loadSeries(input.project, event, { ...metric, stage_reduce: 'sum' }, filters, window, input.refresh);
      }
    }

    // 数值变换已由 SQL 生成器在聚合层应用（metric.transform 随查询下传），此处不再重复计算
    return {
      value,
      series,
      window,
      pick,
      pick_label: VALUE_PICK_LABEL[pick],
      pick_note: VALUE_PICK_DESCRIPTION[pick],
      pick_explicit: explicit,
      used_overall: usedOverall,
      elapsed_ms: Date.now() - started,
    };
  }

  /** 整段聚合（无分组，一行）——存量告警走的路径，保持零变化 */
  private async loadOverall(
    project: string,
    event: string,
    metric: Metric,
    filters: FilterGroup | undefined,
    window: MetricWindow,
    refresh: boolean | undefined,
  ): Promise<number | null> {
    const query: EventAnalysisQuery = {
      project,
      event,
      metrics: [metric],
      time_range: window.range,
      groups: [],
      ...(filters ? { filters } : {}),
    };
    const result = await this.eventQuery.analyze(query, project, refresh ?? true);
    return toNumber(result.rows?.[0]?.m_0);
  }

  /** 按天分组的日序列（过滤引擎插入的「阶段汇总」行，并补齐无数据的日子） */
  private async loadSeries(
    project: string,
    event: string,
    metric: Metric,
    filters: FilterGroup | undefined,
    window: MetricWindow,
    refresh: boolean | undefined,
  ): Promise<SeriesPoint[]> {
    const query: EventAnalysisQuery = {
      project,
      event,
      metrics: [metric],
      time_range: window.range,
      groups: [{ scope: 'time', granularity: 'day' }],
      ...(filters ? { filters } : {}),
    };
    const result = await this.eventQuery.analyze(query, project, refresh ?? true);
    const byDate = new Map<string, number | null>();
    for (const row of result.rows ?? []) {
      if (row.__stage === true) continue;
      const date = normalizeDate(row.g_0);
      if (!date) continue;
      byDate.set(date, toNumber(row.m_0));
    }
    return windowDates(window).map((date) => ({ date, value: byDate.get(date) ?? null }));
  }
}

function normalizeDate(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return null;
}

function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}
