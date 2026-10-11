import { Injectable, Logger } from '@nestjs/common';
import { RetentionQuery } from '../../types/dsl.types';
import { DslValidatorService } from './dsl-validator.service';
import { RetentionSqlGeneratorService } from './retention-sql-generator.service';
import { QueryCacheService } from './query-cache.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import type { DataScope } from '../iam/iam.types';
import { DataScopeService } from '../iam/data-scope.service';
import { asRetentionGranularity, maskImmatureRetentionRow } from './retention-window';
import { todayInTz } from '../time/calendar';
import { TimeScopeService } from '../time/time-scope';
import { DatatableMapService, firstGroupMapTarget } from '../datatable/datatable-map.service';

export interface RetentionAnalysisColumn {
  key: string;
  title: string;
  /**
   * 服务端**固定文案**列名的文案键（i18n phase: clklog-analytics-i18n-v1）。
   * 前端按**查看者语言**渲染（`localizedColumnTitle`），中文 `title` 原值保留：
   * 老客户端兜底 + 数据层启发式（如时间列判定）仍读 `title`。
   * 用户数据列（事件名 / 属性名 / 别名 / 维表显示名）不下发本字段。
   */
  title_key?: string;
  /** 文案键插值参数（值均为数据：粒度单位 / 第 N 日 / 步骤名，不含需翻译文案） */
  title_params?: Record<string, unknown>;
  value_map?: Record<string, string>;
  value_map_title?: string;
  value_map_stats?: { sampled: number; matched: number; truncated?: boolean };
}

export interface RetentionAnalysisResult {
  columns: RetentionAnalysisColumn[];
  rows: Record<string, unknown>[];
  elapsed_ms: number;
  sql: string;
  from_cache?: boolean;
}

interface RawRow {
  cohort_date: string | Date;
  cohort_size: number | string;
  [key: string]: unknown;
}

@Injectable()
export class RetentionQueryService {
  private readonly logger = new Logger(RetentionQueryService.name);

  constructor(
    private readonly validator: DslValidatorService,
    private readonly sqlGenerator: RetentionSqlGeneratorService,
    private readonly queryCache: QueryCacheService,
    private readonly clickHouse: ClickHouseService,
    private readonly dataScope: DataScopeService,
    private readonly datatableMap: DatatableMapService,
    private readonly timeScope: TimeScopeService,
  ) {}

  async analyze(
    query: RetentionQuery,
    project: string,
    refresh = false,
    scope?: DataScope,
    authUserTz?: string | null,
  ): Promise<RetentionAnalysisResult> {
    const start = Date.now();
    const normalized: RetentionQuery = {
      ...query,
      project: query.project || project,
      start_event: asRetentionEvent(query.start_event),
      retain_event: asRetentionEvent(query.retain_event ?? (query as { return_event?: unknown }).return_event),
      cohort: query.cohort || 'all',
      granularity: query.granularity || 'day',
      n_list: Array.isArray(query.n_list) && query.n_list.length > 0 ? query.n_list : [1, 2, 3, 7],
    };
    this.validator.validateRetentionQuery(normalized, authUserTz);
    const eventKeys = [normalized.start_event, normalized.retain_event]
      .map((e) => (typeof e === 'string' ? e : (e as { event?: string })?.event))
      .filter((e): e is string => Boolean(e));
    this.dataScope.assertEvents(scope, eventKeys);
    const { extraAnd } = this.dataScope.applyToEventsQuery(scope);

    // 「今天」按展示时区日历（留存成熟期判定；v2：含用户偏好→项目→平台链）
    const todayYmd = todayInTz(
      this.timeScope.materialize(normalized.time_range, { authUserTz, projectName: normalized.project }).tz,
    );

    const { sql, params, nList } = await this.sqlGenerator.generate(normalized, extraAnd);
    const datatableRevision = await this.datatableMap.revision(normalized.project ?? project);

    if (!refresh) {
      const cached = await this.queryCache.get<RetentionAnalysisResult>({
        dsl: { ...normalized, _shape: 'ret-null-v1' },
        scope: this.dataScope.cacheKey(scope),
        datatable: datatableRevision,
      });
      if (cached) {
        return { ...cached, elapsed_ms: Date.now() - start, sql, from_cache: true };
      }
    }

    try {
      const rawRows = await this.clickHouse.query<RawRow>(sql, params);
      const elapsed = Date.now() - start;
      const shaped = this.shapeResult(rawRows, nList, normalized.granularity, todayYmd, normalized.groups?.[0]?.scope);
      const columns = await this.datatableMap.attachToColumns(
        normalized.project ?? project,
        shaped.columns,
        shaped.rows,
        firstGroupMapTarget(normalized.groups),
      );
      const response: RetentionAnalysisResult = {
        ...shaped,
        columns,
        elapsed_ms: elapsed,
        sql,
      };
      await this.queryCache.set(
        {
          dsl: { ...normalized, _shape: 'ret-null-v1' },
          scope: this.dataScope.cacheKey(scope),
          datatable: datatableRevision,
        },
        response,
      );
      return response;
    } catch (error) {
      this.logger.error(`留存分析查询失败: ${error.message}`, error.stack);
      throw new Error(`查询失败: ${error.message}`);
    }
  }

  private shapeResult(
    rawRows: RawRow[],
    nList: number[],
    granularity: RetentionQuery['granularity'],
    today: string,
    groupScope?: string,
  ): Omit<RetentionAnalysisResult, 'elapsed_ms' | 'sql'> {
    const unit = granularity === 'week' ? 'W' : granularity === 'month' ? 'M' : 'D';
    const columns: RetentionAnalysisColumn[] = [
      { key: 'cohort_date', title: '队列日期', title_key: 'analysis:column.cohortDate' },
      ...(rawRows.some((row) => row.group_col !== undefined)
        ? [
            {
              key: 'group_col',
              title: groupScope === 'tag' ? '用户标签' : '用户分群',
              title_key: groupScope === 'tag' ? 'analysis:column.userTag' : 'analysis:column.userCohort',
            },
          ]
        : []),
      { key: 'cohort_size', title: '人数', title_key: 'analysis:column.users' },
      ...nList.flatMap((n) => [
        {
          key: `n_${n}`,
          title: `${unit}${n}`,
          title_key: 'analysis:column.retentionDay',
          title_params: { unit, n },
        },
        {
          key: `n_${n}_rate`,
          title: `${unit}${n} 留存率`,
          title_key: 'analysis:column.retentionRate',
          title_params: { unit, n },
        },
      ]),
    ];
    const rows = rawRows.map((row) => {
      const next: Record<string, unknown> = {
        cohort_date: formatCohortDate(row.cohort_date),
        cohort_size: Number(row.cohort_size ?? 0),
      };
      if (row.group_col !== undefined) next.group_col = row.group_col;
      for (const n of nList) {
        next[`n_${n}`] = Number(row[`n_${n}`] ?? 0);
        next[`n_${n}_rate`] = Number(row[`n_${n}_rate`] ?? 0);
      }
      return maskImmatureRetentionRow(next, nList, asRetentionGranularity(granularity), today);
    });
    return { columns, rows };
  }

  async listUsers(
    query: RetentionQuery,
    project: string,
    cell: { cohort_date?: string; n?: number; group_col?: string },
    limit = 1_000_000,
    authUserTz?: string | null,
  ): Promise<string[]> {
    const normalized: RetentionQuery = {
      ...query,
      project: query.project || project,
      start_event: asRetentionEvent(query.start_event),
      retain_event: asRetentionEvent(query.retain_event ?? (query as { return_event?: unknown }).return_event),
      cohort: query.cohort || 'all',
      granularity: query.granularity || 'day',
      n_list: Array.isArray(query.n_list) && query.n_list.length > 0 ? query.n_list : [1, 2, 3, 7],
    };
    this.validator.validateRetentionQuery(normalized, authUserTz);
    const { sql, params } = await this.sqlGenerator.listUsers(normalized, cell, Math.min(limit, 1_000_000));
    const rows = await this.clickHouse.query<{ uid: string }>(sql, params, {
      maxExecutionTime: 30,
      maxResultRows: Math.min(limit, 1_000_000),
    });
    return rows.map((row) => String(row.uid)).filter(Boolean);
  }
}

function asRetentionEvent(input: unknown): RetentionQuery['start_event'] {
  if (typeof input === 'string') return { event: input };
  if (input && typeof input === 'object' && typeof (input as { event?: string }).event === 'string') {
    return input as RetentionQuery['start_event'];
  }
  return { event: '' };
}

function formatCohortDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

