import { Injectable, Logger } from '@nestjs/common';
import { EventAnalysisQuery, type Metric, type StageReduce } from '../../types/dsl.types';
import { DslValidatorService } from './dsl-validator.service';
import { EventSqlGeneratorService } from './event-sql-generator.service';
import { QueryCacheService } from './query-cache.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import type { DataScope } from '../iam/iam.types';
import { DataScopeService } from '../iam/data-scope.service';
import { DatatableMapService, groupMapTargets } from '../datatable/datatable-map.service';
import { DatatableService } from '../datatable/datatable.service';
import { PrismaService } from '../shared/prisma.service';
import {
  collectFormulaMetricIds,
  evalFormula,
  isDurationAnalysis,
  isDurationProp,
  metricTitleDescriptor,
  mixStageMetricValue,
  normalizeMetric,
} from './metric-normalize';

/**
 * 结果列角色（phase: clklog-analytics-event-chart-binding-v1）。
 *
 * 事件侧的分组列与指标列语义由查询定义直接决定（`groups[i]` ↔ `g_i`、`metrics[i]` ↔ `m_i`），
 * 不需要像自定义 SQL 那样靠列名/类型/样本反推，所以由服务端下发而不是前端猜。
 */
export type EventColumnRole = 'time' | 'dimension' | 'metric';

export interface EventAnalysisColumn {
  key: string;
  /** 列角色；前端图表字段绑定据此列出 X 轴 / 拆分系列 / 指标的候选列 */
  role: EventColumnRole;
  title: string;
  /**
   * 服务端**固定文案**列名的文案键（i18n phase: clklog-analytics-i18n-v1）。
   * 前端按**查看者语言**渲染（`localizedColumnTitle`），中文 `title` 原值保留：
   * 老客户端兜底 + 数据层启发式（如时间列判定）仍读 `title`。
   * 事件名 / 属性名 / 指标别名 / 维表显示名属用户数据，不下发本字段。
   */
  title_key?: string;
  /** 文案键插值参数（值为数据：时间粒度 / 属性标识 / 步骤名，不含需翻译文案） */
  title_params?: Record<string, unknown>;
  unit?: 'number' | 'duration_sec' | 'percent';
  /** 值映射（数据表 v1 §7）：原始值 → 维表业务名；只含命中的值，未命中回落原始值 */
  value_map?: Record<string, string>;
  /** 值映射用的是哪一列的显示名（页面据此标注「按 X 显示」） */
  value_map_title?: string;
  /** 命中率体检：本次结果里该列的去重值中有多少被维表命中（用于提示"疑似配错/维表覆盖不全"） */
  value_map_stats?: { sampled: number; matched: number; truncated?: boolean };
}

export interface EventAnalysisResult {
  columns: EventAnalysisColumn[];
  rows: Record<string, unknown>[];
  elapsed_ms: number;
  sql: string;
  from_cache?: boolean;
}

/**
 * 分组列角色：只有真正构成时间轴的分组才是 `time`。
 * `granularity === 'total'` 的取值是单个汇总值而非时间点，归 `dimension`；
 * cohort / tag / 属性分组（含 `extract` 出的「时/日/分」）都归 `dimension`。
 */
export function eventGroupRole(
  group: NonNullable<EventAnalysisQuery['groups']>[number],
): EventColumnRole {
  return group.scope === 'time' && group.granularity !== 'total' ? 'time' : 'dimension';
}

@Injectable()
export class EventQueryService {
  private readonly logger = new Logger(EventQueryService.name);

  constructor(
    private readonly validator: DslValidatorService,
    private readonly sqlGenerator: EventSqlGeneratorService,
    private readonly queryCache: QueryCacheService,
    private readonly clickHouse: ClickHouseService,
    private readonly dataScope: DataScopeService,
    private readonly datatableMap: DatatableMapService,
    private readonly datatables: DatatableService,
    private readonly prisma: PrismaService,
  ) {}

  async analyze(
    query: EventAnalysisQuery,
    project: string,
    refresh = false,
    scope?: DataScope,
    authUserTz?: string | null,
  ): Promise<EventAnalysisResult> {
    const start = Date.now();
    const normalized: EventAnalysisQuery = {
      ...query,
      project: query.project || project,
      metrics: (query.metrics ?? []).map((m) => normalizeMetric(m)),
      approx: query.approx === true,
    };
    this.validator.validateEventQuery(normalized, authUserTz);
    const eventKeys = normalized.metrics
      .map((m) => m.event)
      .filter((e): e is string => typeof e === 'string' && e.length > 0);
    if (normalized.event) eventKeys.push(normalized.event);
    this.dataScope.assertEvents(scope, eventKeys);
    const { extraAnd } = this.dataScope.applyToEventsQuery(scope);

    const { sql, params } = await this.sqlGenerator.generate(normalized, extraAnd);

    // 数据表修订戳进缓存 key：建表/更新数据/绑定变更后旧缓存自然失效（否则映射要等 TTL 5 分钟）
    const datatableRevision = await this.datatableMap.revision(normalized.project ?? project);

    if (!refresh) {
      const cached = await this.queryCache.get<EventAnalysisResult>({
        dsl: normalized,
        scope: this.dataScope.cacheKey(scope),
        datatable: datatableRevision,
      });
      if (cached) {
        return {
          ...cached,
          columns: await this.resolveGroupTitles(cached.columns, normalized),
          elapsed_ms: Date.now() - start,
          sql,
          from_cache: true,
        };
      }
    }

    try {
      const rawRows = await this.clickHouse.query<Record<string, unknown>>(sql, params);
      const rows = this.applyFormulas(rawRows, normalized.metrics);
      const withStage = await this.attachStageRow(rows, normalized);
      const elapsed = Date.now() - start;
      const shaped = this.formatResult(withStage, normalized);
      const columns = await this.datatableMap.attachToColumns(
        normalized.project ?? project,
        shaped.columns,
        shaped.rows,
        groupMapTargets(normalized.groups),
      );
      const result = {
        ...shaped,
        columns: await this.resolveGroupTitles(columns, normalized),
      };
      const response: EventAnalysisResult = { ...result, elapsed_ms: elapsed, sql };
      await this.queryCache.set(
        { dsl: normalized, scope: this.dataScope.cacheKey(scope), datatable: datatableRevision },
        response,
      );
      return response;
    } catch (error) {
      this.logger.error(`事件分析查询失败: ${error.message}`, error.stack);
      throw new Error(`查询失败: ${error.message}`);
    }
  }

  private applyFormulas(
    rows: Record<string, unknown>[],
    metrics: Metric[],
  ): Record<string, unknown>[] {
    return rows.map((row) => {
      const next = { ...row };
      const values: Record<string, number | null> = {};
      metrics.forEach((metric, i) => {
        if (metric.kind === 'formula') return;
        const n = Number(row[`m_${i}`]);
        values[metric.id] = Number.isFinite(n) ? n : null;
      });
      const formulaIds = new Set(
        metrics.filter((m) => m.kind === 'formula').map((m) => m.id),
      );
      const pending = metrics
        .map((metric, i) => ({ metric, i }))
        .filter((item) => item.metric.kind === 'formula' && item.metric.expression);
      const done = new Set<string>();
      for (let pass = 0; pass < pending.length; pass++) {
        for (const item of pending) {
          if (done.has(item.metric.id)) continue;
          const refs = collectFormulaMetricIds(item.metric.expression);
          if ([...refs].some((id) => formulaIds.has(id) && !done.has(id))) continue;
          next[`m_${item.i}`] = evalFormula(item.metric.expression!, values);
          values[item.metric.id] = next[`m_${item.i}`] as number | null;
          done.add(item.metric.id);
        }
      }
      return next;
    });
  }

  private hasTimeGroup(query: EventAnalysisQuery): boolean {
    return (query.groups ?? []).some((g) => g.scope === 'time' && g.granularity !== 'total');
  }

  private async attachStageRow(
    rows: Record<string, unknown>[],
    query: EventAnalysisQuery,
  ): Promise<Record<string, unknown>[]> {
    if (!this.hasTimeGroup(query) || rows.length === 0) return rows;
    const stage: Record<string, unknown> = { __stage: true };
    (query.groups ?? []).forEach((g, i) => {
      if (g.scope === 'time' && g.granularity === 'total') return;
      stage[`g_${i}`] = g.scope === 'time' ? '阶段汇总' : '';
    });

    const needsOverall = query.metrics.some((m) => {
      const reduce = m.stage_reduce;
      return reduce === 'uniq_total' || reduce === 'weighted';
    });
    let overall: Record<string, unknown> | undefined;
    if (needsOverall) {
      const overallQuery: EventAnalysisQuery = {
        ...query,
        groups: (query.groups ?? []).filter((g) => g.scope !== 'time'),
      };
      const generated = await this.sqlGenerator.generate(overallQuery);
      const overallRows = await this.clickHouse.query<Record<string, unknown>>(
        generated.sql,
        generated.params,
      );
      overall = this.applyFormulas(overallRows, query.metrics)[0];
    }

    query.metrics.forEach((metric, i) => {
      const key = `m_${i}`;
      const reduce: StageReduce = metric.stage_reduce ?? 'sum';
      const nums = rows
        .map((row) => Number(row[key]))
        .filter((n) => Number.isFinite(n));
      const overallVal = overall == null ? null : Number(overall[key]);
      stage[key] = mixStageMetricValue(
        reduce,
        nums,
        overallVal != null && Number.isFinite(overallVal) ? overallVal : null,
      );
    });
    return [stage, ...rows];
  }

  private formatResult(
    rows: Record<string, unknown>[],
    query: EventAnalysisQuery,
  ): Omit<EventAnalysisResult, 'elapsed_ms' | 'sql'> {
    const groupColumns = (query.groups ?? []).flatMap((g, i) => {
      if (g.scope === 'time' && g.granularity === 'total') return [];
      return [{ key: `g_${i}`, role: eventGroupRole(g), ...this.groupTitle(g) }];
    });
    const metricColumns = query.metrics
      .map((m, i) => ({
        key: `m_${i}`,
        role: 'metric' as EventColumnRole,
        ...metricTitleDescriptor(m),
        unit: this.metricUnit(m),
        hidden: m.hidden === true,
      }))
      .filter((col) => !col.hidden)
      .map(({ key, role, title, title_key, title_params, unit }) => ({
        key,
        role,
        title,
        ...(title_key ? { title_key, title_params } : {}),
        unit,
      }));

    return {
      columns: [...groupColumns, ...metricColumns],
      rows,
    };
  }

  /**
   * 结果表头用**属性显示名**（与查询构建器下拉口径一致），取不到回落属性标识。
   * 只读元数据、失败不影响查询结果本身；内置 `$` 属性不在元数据表里，保持原标识。
   */
  private async resolveGroupTitles<T extends { key: string; title: string; title_key?: string; title_params?: Record<string, unknown> }>(
    columns: T[],
    query: EventAnalysisQuery,
  ): Promise<T[]> {
    const groups = (query.groups ?? []) as { prop?: string }[];
    const props = [
      ...new Set(
        groups
          .map((group) => group.prop)
          .filter((prop): prop is string => !!prop && !prop.startsWith('$')),
      ),
    ];
    if (props.length === 0) return columns;
    const project = query.project ?? '';
    try {
      const [eventAttrs, userProps, dimNames] = await Promise.all([
        this.prisma.metaEventAttribute.findMany({
          where: { project_name: project, prop_key: { in: props } },
        }),
        this.prisma.metaUserProperty.findMany({ where: { project_name: project, prop_key: { in: props } } }),
        this.datatables.dimensionDisplayNames(project),
      ]);
      const names = new Map<string, string>();
      eventAttrs.forEach((item) => {
        if (item.display_name) names.set(item.prop_key, item.display_name);
      });
      userProps.forEach((item) => {
        if (item.display_name) names.set(item.prop_key, item.display_name);
      });
      dimNames.forEach((display, prop) => names.set(prop, display));
      if (names.size === 0) return columns;
      return columns.map((column) => {
        const index = Number(column.key.replace('g_', ''));
        const prop = Number.isInteger(index) ? groups[index]?.prop : undefined;
        const display = prop ? names.get(prop) : undefined;
        // 显示名属用户数据：覆盖 title 时必须丢掉固定文案键，否则按 key 渲染会盖掉用户命名
        return display
          ? { ...column, title: display, title_key: undefined, title_params: undefined }
          : column;
      });
    } catch {
      return columns;
    }
  }

  private metricUnit(metric: Metric): EventAnalysisColumn['unit'] {
    if (metric.kind === 'formula' && metric.format === 'percent') return 'percent';
    if (
      metric.kind !== 'formula' &&
      metric.analysis &&
      isDurationProp(metric.prop) &&
      isDurationAnalysis(metric.analysis)
    ) {
      return 'duration_sec';
    }
    return 'number';
  }

  /**
   * 分组列标题：**固定文案**（时间粒度 / 分群 / 标签 / 时间提取后缀 / 未知分组）附带文案键，
   * `prop`、事件名等用户数据只作插值参数或直接作标题（不附键）。
   */
  private groupTitle(group: EventAnalysisQuery['groups'][number]): {
    title: string;
    title_key?: string;
    title_params?: Record<string, unknown>;
  } {
    if (group.scope === 'time') {
      const granularity = group.granularity ?? 'day';
      return {
        title: `时间(${granularity})`,
        title_key: 'analysis:column.timeGroup',
        title_params: { granularity },
      };
    }
    if (group.scope === 'cohort') return { title: '用户分群', title_key: 'analysis:column.userCohort' };
    if (group.scope === 'tag') return { title: '用户标签', title_key: 'analysis:column.userTag' };
    if (group.extract === 'hour_of_day') {
      return {
        title: `${group.prop}(时)`,
        title_key: 'analysis:column.hourOfDay',
        title_params: { prop: group.prop },
      };
    }
    if (group.extract === 'day_of_month') {
      return {
        title: `${group.prop}(日)`,
        title_key: 'analysis:column.dayOfMonth',
        title_params: { prop: group.prop },
      };
    }
    if (group.extract === 'minute_of_hour') {
      return {
        title: `${group.prop}(分)`,
        title_key: 'analysis:column.minuteOfHour',
        title_params: { prop: group.prop },
      };
    }
    if (!group.prop) return { title: '未知分组', title_key: 'analysis:column.unknownGroup' };
    return { title: group.prop };
  }

  async listUsers(
    query: EventAnalysisQuery,
    project: string,
    cell: { metric_id?: string; groups?: Record<string, unknown> },
    limit = 1_000_000,
    scope?: DataScope,
    authUserTz?: string | null,
  ): Promise<string[]> {
    const normalized: EventAnalysisQuery = {
      ...query,
      project: query.project || project,
      metrics: (query.metrics ?? []).map((m) => normalizeMetric(m)),
    };
    this.validator.validateEventQuery(normalized, authUserTz);
    const { extraAnd } = this.dataScope.applyToEventsQuery(scope);
    const { sql, params } = await this.sqlGenerator.listUsers(
      normalized,
      cell,
      Math.min(limit, 1_000_000),
      extraAnd,
    );
    const rows = await this.clickHouse.query<{ uid: string }>(sql, params, {
      maxExecutionTime: 30,
      maxResultRows: Math.min(limit, 1_000_000),
    });
    return rows.map((row) => String(row.uid)).filter(Boolean);
  }
}

/**
 * 指标列标题的文案键与参数由 `metricTitleDescriptor`（`metric-normalize.ts`）统一产出：
 * 别名 / 名称与四种「事件名.属性名.方法名」拼装形态都在那里下发键；
 * 这里的 `metric_meta`/结果表只负责透传（旧客户端继续读中文 `title`）。
 */
