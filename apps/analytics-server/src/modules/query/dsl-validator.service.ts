import { Injectable } from '@nestjs/common';
import { badRequest, DomainError } from '../../i18n/domain-error';
import {
  EventAnalysisQuery,
  FunnelQuery,
  RetentionQuery,
  FilterOp,
  FilterGroup,
  FilterItem,
  TimeGranularity,
  AnalysisMethod,
  MAX_FUNNEL_STEPS,
  MIN_FUNNEL_STEPS,
  MAX_EVENT_METRICS,
  ANY_EVENT,
  type Metric,
  type EventTimeGranularity,
  type TimeRange,
} from '../../types/dsl.types';
import {
  calendarDaysInclusive,
  formulaHasCycle,
  methodNeedsProp,
  normalizeMetric,
} from './metric-normalize';
import { TimeScopeService } from '../time/time-scope';
import { TimezoneService } from '../time/timezone.service';
import { validateTransform } from './metric-transform';
import { parseDatatableDimension } from '../relation/datatable-join';

// 可选的 `$` 前缀：兼容神策/ThinkingData 系 SDK 的系统属性（如 $is_first_day）；注入防护不依赖此正则（属性名以参数化字面量进 JSONExtract）。
const PROP_KEY_PATTERN = /^\$?[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$/;
/**
 * 合法 filter 比较符白名单。
 *
 * ⚠️ 必须与前端 `FilterEditor.tsx` / `ConditionSentenceEditor.tsx` 的 OPERATORS、
 * 以及 `FilterOp` 类型声明保持一致，否则会出现「UI 提供该选项、提交却 400」——
 * 2026-09-15 生产实测：`not_regex`（「正则不匹配」两处编辑器都提供、三个 SQL 生成器都已实现）
 * 与 `eq`（类型声明合法、生成器归一为 `=`）都被这里拒掉。
 */
const VALID_FILTER_OPS: FilterOp[] = [
  '=', '!=', 'in', 'not_in', 'contains', 'not_contains', 'regex', 'not_regex',
  'gt', 'gte', 'lt', 'lte', 'is_set', 'not_set',
  // 别名：生成器 normalizeFilterOp 会归一为等价形式
  'eq',
];
const VALID_TIME_GRANULARITY: TimeGranularity[] = ['hour', 'day', 'week', 'month'];
const VALID_EVENT_TIME_GRANULARITY: EventTimeGranularity[] = [
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'total',
];
const VALID_ANALYSIS: AnalysisMethod[] = [
  'total_times',
  'trig_user_num',
  'per_capita_times',
  'sum',
  'avg',
  'per_capita_num',
  'max',
  'min',
  'distinct',
  'true_num',
  'false_num',
  'is_empty',
  'is_not_empty',
  'array_distinct',
  'array_item_distinct',
  'percentile',
  'variance',
  'stddev',
];
const VALID_STAGE = new Set(['sum', 'avg', 'weighted', 'max', 'min', 'uniq_total']);
const VALID_EXTRACT = new Set(['hour_of_day', 'day_of_month', 'minute_of_hour']);

@Injectable()
export class DslValidatorService {
  /**
   * 缺省构造保留给纯校验场景的既有调用方/单测；运行期由 DI 注入
   * （TimeModule 为 @Global，生产线上的实例一定带配置时区）。
   */
  constructor(
    private readonly timeScope: TimeScopeService = new TimeScopeService(new TimezoneService(undefined)),
  ) {}

  capabilities() {
    return {
      analysis_methods: VALID_ANALYSIS,
      filter_ops: VALID_FILTER_OPS,
      event_granularities: VALID_EVENT_TIME_GRANULARITY,
      max_event_metrics: MAX_EVENT_METRICS,
      funnel_steps: { min: MIN_FUNNEL_STEPS, max: MAX_FUNNEL_STEPS },
      retention_granularities: ['day', 'week', 'month'],
      retention_cohort_semantics: '当前引擎按查询扫描范围内每个主体最早满足初始条件的日期入组；first_day 另要求 is_first_day=1。all 不代表每日重复入组，first_day 不等于注册新用户。',
      metric_format: 'metrics[]: id, kind=event, event, analysis; 数值分析另带 prop。不要把 max/sum 写入 type。',
    };
  }
  validateEventQuery(query: EventAnalysisQuery, authUserTz?: string | null): void {
    if (!query.project || typeof query.project !== 'string') {
      throw badRequest({
        code: 'analysis.dsl.projectRequired',
        messageKey: 'analysis:error.dsl.projectRequired',
        message: 'project 必填',
      });
    }
    if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
      throw badRequest({
        code: 'analysis.dsl.metricsRequired',
        messageKey: 'analysis:error.dsl.metricsRequired',
        message: 'metrics 至少 1 个',
      });
    }
    if (query.metrics.length > MAX_EVENT_METRICS) {
      throw badRequest({
        code: 'analysis.dsl.tooManyMetrics',
        messageKey: 'analysis:error.dsl.tooManyMetrics',
        params: { count: MAX_EVENT_METRICS },
        message: `指标最多 ${MAX_EVENT_METRICS} 个`,
      });
    }
    query.metrics = query.metrics.map((m) => normalizeMetric(m));
    const eventMetrics = query.metrics.filter((m) => m.kind !== 'formula');
    if (eventMetrics.length === 0) {
      throw badRequest({
        code: 'analysis.dsl.eventMetricRequired',
        messageKey: 'analysis:error.dsl.eventMetricRequired',
        message: '至少需要一个事件指标',
      });
    }
    query.metrics.forEach((m, index) => this.validateMetric(m, index, query.metrics));
    if (formulaHasCycle(query.metrics)) {
      throw badRequest({
        code: 'analysis.dsl.formulaCycle',
        messageKey: 'analysis:error.dsl.formulaCycle',
        message: '公式不能循环引用',
      });
    }
    if (!query.event || typeof query.event !== 'string') {
      query.event = eventMetrics[0].event || ANY_EVENT;
    }
    if (query.filters) this.validateFilterGroup(query.filters);
    if (query.groups) query.groups.forEach((g, index) => this.validateGroup(g, index));
    this.validateTimeRange(query.time_range, authUserTz, query.project);
    const hasMinute = (query.groups ?? []).some((g) => g.scope === 'time' && g.granularity === 'minute');
    if (hasMinute && calendarDaysInclusive(query.time_range.start, query.time_range.end) > 1) {
      throw badRequest({
        code: 'analysis.dsl.minuteRangeTooLong',
        messageKey: 'analysis:error.dsl.minuteRangeTooLong',
        message: '按分钟查询时间跨度不能超过 1 天',
      });
    }
    if (query.approx !== undefined && typeof query.approx !== 'boolean') {
      throw badRequest({
        code: 'analysis.dsl.approxInvalid',
        messageKey: 'analysis:error.dsl.approxInvalid',
        message: 'approx 必须是 boolean',
      });
    }
    query.approx = query.approx === true;
  }

  validateFunnelQuery(query: FunnelQuery, authUserTz?: string | null): void {
    if (!query.project || typeof query.project !== 'string') {
      throw badRequest({
        code: 'analysis.dsl.projectRequired',
        messageKey: 'analysis:error.dsl.projectRequired',
        message: 'project 必填',
      });
    }
    if (
      !Array.isArray(query.steps) ||
      query.steps.length < MIN_FUNNEL_STEPS ||
      query.steps.length > MAX_FUNNEL_STEPS
    ) {
      throw badRequest({
        code: 'analysis.dsl.funnelStepsOutOfRange',
        messageKey: 'analysis:error.dsl.funnelStepsOutOfRange',
        params: { min: MIN_FUNNEL_STEPS, max: MAX_FUNNEL_STEPS },
        message: `漏斗步骤数必须在 ${MIN_FUNNEL_STEPS}~${MAX_FUNNEL_STEPS} 之间`,
      });
    }
    query.steps.forEach((s, index) => {
      if (!s.event || typeof s.event !== 'string') {
        throw badRequest({
          code: 'analysis.dsl.stepEventRequired',
          messageKey: 'analysis:error.dsl.stepEventRequired',
          params: { index },
          message: `steps[${index}].event 必填`,
        });
      }
      if (s.filters) this.validateFilterGroup(s.filters);
    });
    if (typeof query.window_seconds !== 'number' || query.window_seconds <= 0) {
      throw badRequest({
        code: 'analysis.dsl.windowSecondsInvalid',
        messageKey: 'analysis:error.dsl.windowSecondsInvalid',
        message: 'window_seconds 必须是正整数',
      });
    }
    if (query.filters) this.validateFilterGroup(query.filters);
    if (query.groups) query.groups.forEach((g, index) => this.validateGroup(g, index));
    if (query.granularity && query.granularity !== 'total' && !VALID_TIME_GRANULARITY.includes(query.granularity)) {
      throw badRequest({
        code: 'analysis.dsl.granularityInvalid',
        messageKey: 'analysis:error.dsl.granularityInvalid',
        message: 'granularity 不合法',
      });
    }
    this.validateTimeRange(query.time_range, authUserTz, query.project);
  }

  validateRetentionQuery(query: RetentionQuery, authUserTz?: string | null): void {
    if (!query.project || typeof query.project !== 'string') {
      throw badRequest({
        code: 'analysis.dsl.projectRequired',
        messageKey: 'analysis:error.dsl.projectRequired',
        message: 'project 必填',
      });
    }
    this.validateRetentionEvent(query.start_event, 'start_event');
    this.validateRetentionEvent(query.retain_event, 'retain_event');
    if (query.cohort !== 'first_day' && query.cohort !== 'all') {
      throw badRequest({
        code: 'analysis.dsl.retentionCohortInvalid',
        messageKey: 'analysis:error.dsl.retentionCohortInvalid',
        message: 'cohort 必须是 first_day 或 all',
      });
    }
    if (!['day', 'week', 'month'].includes(query.granularity)) {
      throw badRequest({
        code: 'analysis.dsl.retentionGranularityInvalid',
        messageKey: 'analysis:error.dsl.retentionGranularityInvalid',
        message: 'granularity 必须是 day / week / month',
      });
    }
    if (!Array.isArray(query.n_list) || query.n_list.length === 0 || query.n_list.length > 31) {
      throw badRequest({
        code: 'analysis.dsl.nListLengthInvalid',
        messageKey: 'analysis:error.dsl.nListLengthInvalid',
        message: 'n_list 长度必须在 1~31',
      });
    }
    const seen = new Set<number>();
    for (const n of query.n_list) {
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        throw badRequest({
          code: 'analysis.dsl.nListItemInvalid',
          messageKey: 'analysis:error.dsl.nListItemInvalid',
          message: 'n_list 每项必须是 1~90 的整数',
        });
      }
      if (seen.has(n)) {
        throw badRequest({
          code: 'analysis.dsl.nListDuplicate',
          messageKey: 'analysis:error.dsl.nListDuplicate',
          message: 'n_list 不能重复',
        });
      }
      seen.add(n);
    }
    if (query.start_event.filters) this.validateFilterGroup(query.start_event.filters);
    if (query.retain_event.filters) this.validateFilterGroup(query.retain_event.filters);
    if (query.filters) this.validateFilterGroup(query.filters);
    if (query.groups) query.groups.forEach((g, index) => this.validateGroup(g, index));
    this.validateTimeRange(query.time_range, authUserTz, query.project);
  }

  private validateRetentionEvent(spec: RetentionQuery['start_event'], field: string): void {
    if (!spec || typeof spec !== 'object' || typeof spec.event !== 'string' || !spec.event.trim()) {
      throw badRequest({
        code: 'analysis.dsl.retentionEventRequired',
        messageKey: 'analysis:error.dsl.retentionEventRequired',
        params: { field },
        message: `${field}.event 必填`,
      });
    }
  }

  validatePropKey(key: string): void {
    if (key.includes('@')) {
      if (!parseDatatableDimension(key)) {
        throw badRequest({
          code: 'analysis.dsl.propInvalid',
          messageKey: 'analysis:error.dsl.propInvalid',
          params: { prop: key },
          message: `属性名不合法: ${key}`,
        });
      }
      return;
    }
    if (!PROP_KEY_PATTERN.test(key)) {
      throw badRequest({
        code: 'analysis.dsl.propInvalid',
        messageKey: 'analysis:error.dsl.propInvalid',
        params: { prop: key },
        message: `属性名不合法: ${key}`,
      });
    }
  }

  private validateMetric(metric: Metric, index: number, all: Metric[]): void {
    if (!metric || typeof metric !== 'object') {
      throw badRequest({
        code: 'analysis.dsl.metricNotObject',
        messageKey: 'analysis:error.dsl.metricNotObject',
        params: { index },
        message: `metrics[${index}] 必须是对象`,
      });
    }
    if (!metric.id || typeof metric.id !== 'string') {
      throw badRequest({
        code: 'analysis.dsl.metricIdRequired',
        messageKey: 'analysis:error.dsl.metricIdRequired',
        params: { index },
        message: `metrics[${index}].id 必填`,
      });
    }
    if (metric.filters) this.validateFilterGroup(metric.filters);
    if (metric.kind === 'formula') {
      if (!metric.expression) {
        throw badRequest({
          code: 'analysis.dsl.metricExpressionRequired',
          messageKey: 'analysis:error.dsl.metricExpressionRequired',
          params: { index },
          message: `metrics[${index}].expression 必填`,
        });
      }
      this.validateFormulaExpr(metric.expression, index, all);
      return;
    }
    if (!metric.analysis || !VALID_ANALYSIS.includes(metric.analysis)) {
      throw badRequest({
        code: 'analysis.dsl.metricAnalysisInvalid',
        messageKey: 'analysis:error.dsl.metricAnalysisInvalid',
        params: { index },
        message: `metrics[${index}].analysis 不合法`,
      });
    }
    if (!metric.event || typeof metric.event !== 'string') {
      throw badRequest({
        code: 'analysis.dsl.metricEventRequired',
        messageKey: 'analysis:error.dsl.metricEventRequired',
        params: { index },
        message: `metrics[${index}].event 必填`,
      });
    }
    if (metric.hidden !== undefined && typeof metric.hidden !== 'boolean') {
      throw badRequest({
        code: 'analysis.dsl.metricHiddenInvalid',
        messageKey: 'analysis:error.dsl.metricHiddenInvalid',
        params: { index },
        message: `metrics[${index}].hidden 必须是布尔值`,
      });
    }
    if (metric.transform !== undefined) {
      // 四则运算 + 小数位（v3）：校验逻辑与保存指标共用一份实现
      const error = validateTransform(metric.transform);
      if (error) {
        throw badRequest({
          code: 'analysis.dsl.metricTransformInvalid',
          messageKey: 'analysis:error.dsl.metricTransformInvalid',
          params: { index, reason: error },
          message: `metrics[${index}].transform ${error}`,
        });
      }
    }
    if (methodNeedsProp(metric.analysis)) {
      if (!metric.prop || typeof metric.prop !== 'string') {
        throw badRequest({
          code: 'analysis.dsl.metricPropRequired',
          messageKey: 'analysis:error.dsl.metricPropRequired',
          params: { index },
          message: `metrics[${index}].prop 必填`,
        });
      }
      this.validatePropKey(metric.prop);
    }
    if (metric.analysis === 'percentile') {
      const p = metric.percentile;
      if (!Number.isInteger(p) || p == null || p < 1 || p > 100) {
        throw badRequest({
          code: 'analysis.dsl.metricPercentileInvalid',
          messageKey: 'analysis:error.dsl.metricPercentileInvalid',
          params: { index },
          message: `metrics[${index}].percentile 必须是 1~100 的整数`,
        });
      }
    }
    if (metric.stage_reduce && !VALID_STAGE.has(metric.stage_reduce)) {
      throw badRequest({
        code: 'analysis.dsl.metricStageReduceInvalid',
        messageKey: 'analysis:error.dsl.metricStageReduceInvalid',
        params: { index },
        message: `metrics[${index}].stage_reduce 不合法`,
      });
    }
  }

  private validateFormulaExpr(expr: unknown, index: number, all: Metric[]): void {
    if (!expr || typeof expr !== 'object') {
      throw badRequest({
        code: 'analysis.dsl.metricExpressionInvalid',
        messageKey: 'analysis:error.dsl.metricExpressionInvalid',
        params: { index },
        message: `metrics[${index}].expression 不合法`,
      });
    }
    const node = expr as { type?: string; id?: string; value?: number; left?: unknown; right?: unknown };
    if (node.type === 'const') {
      if (typeof node.value !== 'number' || !Number.isFinite(node.value)) {
        throw badRequest({
          code: 'analysis.dsl.formulaConstInvalid',
          messageKey: 'analysis:error.dsl.formulaConstInvalid',
          params: { index },
          message: `metrics[${index}] 公式常量必须是有限数字`,
        });
      }
      return;
    }
    if (node.type === 'metric') {
      if (!node.id || !all.some((m) => m.id === node.id)) {
        throw badRequest({
          code: 'analysis.dsl.formulaMetricNotFound',
          messageKey: 'analysis:error.dsl.formulaMetricNotFound',
          params: { index },
          message: `metrics[${index}] 公式引用了不存在的指标`,
        });
      }
      if (all[index]?.id === node.id) {
        throw badRequest({
          code: 'analysis.dsl.formulaSelfReference',
          messageKey: 'analysis:error.dsl.formulaSelfReference',
          params: { index },
          message: `metrics[${index}] 公式不能引用自己`,
        });
      }
      return;
    }
    if (node.type === 'op') {
      this.validateFormulaExpr(node.left, index, all);
      this.validateFormulaExpr(node.right, index, all);
      return;
    }
    throw badRequest({
      code: 'analysis.dsl.metricExpressionInvalid',
      messageKey: 'analysis:error.dsl.metricExpressionInvalid',
      params: { index },
      message: `metrics[${index}].expression 不合法`,
    });
  }

  private validateFilterGroup(group: FilterGroup): void {
    if (!group || typeof group !== 'object') {
      throw badRequest({
        code: 'analysis.dsl.filtersNotObject',
        messageKey: 'analysis:error.dsl.filtersNotObject',
        message: 'filters 必须是对象',
      });
    }
    if (!['and', 'or'].includes(group.logic)) {
      throw badRequest({
        code: 'analysis.dsl.filterLogicInvalid',
        messageKey: 'analysis:error.dsl.filterLogicInvalid',
        message: 'filters.logic 必须是 and 或 or',
      });
    }
    if (!Array.isArray(group.items)) {
      throw badRequest({
        code: 'analysis.dsl.filterItemsNotArray',
        messageKey: 'analysis:error.dsl.filterItemsNotArray',
        message: 'filters.items 必须是数组',
      });
    }
    group.items.forEach((item) => {
      if ('logic' in item) {
        this.validateFilterGroup(item as FilterGroup);
      } else {
        this.validateFilterItem(item as FilterItem);
      }
    });
  }

  private validateFilterItem(item: FilterItem): void {
    if (item.scope === 'cohort') {
      if (!item.prop || typeof item.prop !== 'string') {
        throw badRequest({
        code: 'analysis.dsl.filterPropRequired',
        messageKey: 'analysis:error.dsl.filterPropRequired',
        message: 'filter prop 必填',
      });
      }
      this.validatePropKey(item.prop);
      if (item.op !== 'in' && item.op !== 'not_in') {
        throw badRequest({
          code: 'analysis.dsl.cohortFilterOpUnsupported',
          messageKey: 'analysis:error.dsl.cohortFilterOpUnsupported',
          message: '分群筛选只支持属于 / 不属于',
        });
      }
      return;
    }
    if (item.scope === 'tag') {
      if (!item.prop || typeof item.prop !== 'string') {
        throw badRequest({
        code: 'analysis.dsl.filterPropRequired',
        messageKey: 'analysis:error.dsl.filterPropRequired',
        message: 'filter prop 必填',
      });
      }
      this.validatePropKey(item.prop);
      if (item.op !== 'in' && item.op !== 'not_in' && item.op !== '=' && item.op !== 'eq') {
        throw badRequest({
          code: 'analysis.dsl.tagFilterOpUnsupported',
          messageKey: 'analysis:error.dsl.tagFilterOpUnsupported',
          message: '标签筛选只支持等于 / 属于 / 不属于',
        });
      }
      if (item.value === undefined) {
        throw badRequest({
          code: 'analysis.dsl.tagFilterValueRequired',
          messageKey: 'analysis:error.dsl.tagFilterValueRequired',
          message: '标签筛选必须给取值',
        });
      }
      return;
    }
    if (!['event', 'user'].includes(item.scope)) {
      throw badRequest({
        code: 'analysis.dsl.filterScopeInvalid',
        messageKey: 'analysis:error.dsl.filterScopeInvalid',
        message: 'filter scope 必须是 event 或 user',
      });
    }
    if (!item.prop || typeof item.prop !== 'string') {
      throw badRequest({
        code: 'analysis.dsl.filterPropRequired',
        messageKey: 'analysis:error.dsl.filterPropRequired',
        message: 'filter prop 必填',
      });
    }
    this.validatePropKey(item.prop);
    if (!VALID_FILTER_OPS.includes(item.op)) {
      throw badRequest({
        code: 'analysis.dsl.filterOpInvalid',
        messageKey: 'analysis:error.dsl.filterOpInvalid',
        params: { op: item.op },
        message: `filter op 不合法: ${item.op}`,
      });
    }
    if (!['is_set', 'not_set'].includes(item.op) && item.value === undefined) {
      throw badRequest({
        code: 'analysis.dsl.filterValueRequired',
        messageKey: 'analysis:error.dsl.filterValueRequired',
        params: { op: item.op },
        message: `filter value 必填（op=${item.op}）`,
      });
    }
  }

  private validateGroup(group: any, index: number): void {
    if (!group || typeof group !== 'object') {
      throw badRequest({
        code: 'analysis.dsl.groupNotObject',
        messageKey: 'analysis:error.dsl.groupNotObject',
        params: { index },
        message: `groups[${index}] 必须是对象`,
      });
    }
    if (!['event', 'user', 'time', 'cohort', 'tag'].includes(group.scope)) {
      throw badRequest({
        code: 'analysis.dsl.groupScopeInvalid',
        messageKey: 'analysis:error.dsl.groupScopeInvalid',
        params: { index },
        message: `groups[${index}].scope 不合法`,
      });
    }
    if (group.scope !== 'time') {
      if (!group.prop || typeof group.prop !== 'string') {
        throw badRequest({
          code: 'analysis.dsl.groupPropRequired',
          messageKey: 'analysis:error.dsl.groupPropRequired',
          params: { index },
          message: `groups[${index}].prop 必填`,
        });
      }
      this.validatePropKey(group.prop);
    }
    if (group.scope === 'time') {
      if (!VALID_EVENT_TIME_GRANULARITY.includes(group.granularity)) {
        throw badRequest({
          code: 'analysis.dsl.groupGranularityInvalid',
          messageKey: 'analysis:error.dsl.groupGranularityInvalid',
          params: { index },
          message: `groups[${index}].granularity 不合法`,
        });
      }
    }
    if (group.extract && !VALID_EXTRACT.has(group.extract)) {
      throw badRequest({
        code: 'analysis.dsl.groupExtractInvalid',
        messageKey: 'analysis:error.dsl.groupExtractInvalid',
        params: { index },
        message: `groups[${index}].extract 不合法`,
      });
    }
  }

  private validateTimeRange(range: TimeRange, authUserTz?: string | null, projectName?: string | null): void {
    if (!range || typeof range !== 'object') {
      throw badRequest({
        code: 'analysis.dsl.timeRangeRequired',
        messageKey: 'analysis:error.dsl.timeRangeRequired',
        message: 'time_range 必填',
      });
    }
    try {
      // 含展示时区校验与 relative 当日快照（v2：显式→用户偏好→项目→平台链）
      const scope = this.timeScope.materialize(range, { authUserTz, projectName });
      range.start = scope.startYmd;
      range.end = scope.endYmd;
      if (!range.relative) delete range.relative;
      // 链解析带用户偏好差异时回写 timezone，保证生成器同源；缺省（=项目/平台口径）不落字段，
      // 与 v1 请求形状与缓存键逐字节一致
      if (!range.timezone && scope.tz !== scope.statTz) range.timezone = scope.tz;
    } catch (err) {
      if (err instanceof DomainError) throw err; // timezone_invalid 等自带契约错误原样抛出
      throw badRequest({
        code: 'analysis.dsl.timeRangeInvalid',
        messageKey: 'analysis:error.dsl.timeRangeInvalid',
        message: err instanceof Error ? err.message : 'time_range 不合法',
      });
    }
  }
}
