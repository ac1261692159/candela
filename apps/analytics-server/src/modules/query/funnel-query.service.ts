import { Injectable, Logger } from '@nestjs/common';
import { FunnelQuery } from '../../types/dsl.types';
import { DslValidatorService } from './dsl-validator.service';
import { FunnelSqlGeneratorService } from './funnel-sql-generator.service';
import { QueryCacheService } from './query-cache.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import type { DataScope } from '../iam/iam.types';
import { DataScopeService } from '../iam/data-scope.service';
import { DatatableMapService, firstGroupMapTarget } from '../datatable/datatable-map.service';
import { DatatableService } from '../datatable/datatable.service';

export interface FunnelAnalysisColumn {
  key: string;
  title: string;
  /**
   * 服务端**固定文案**列名的文案键（i18n phase: clklog-analytics-i18n-v1）。
   * 前端按**查看者语言**渲染（`localizedColumnTitle`），中文 `title` 原值保留：
   * 老客户端兜底 + 数据层启发式仍读 `title`。
   * 步骤名 / 分组维度显示名属用户数据，不下发本字段。
   */
  title_key?: string;
  /** 文案键插值参数（值为数据：步骤名等，不含需翻译文案） */
  title_params?: Record<string, unknown>;
  value_map?: Record<string, string>;
  value_map_title?: string;
  value_map_stats?: { sampled: number; matched: number; truncated?: boolean };
}

export interface FunnelAnalysisResult {
  columns: FunnelAnalysisColumn[];
  rows: Record<string, unknown>[];
  steps: { key: string; title: string }[];
  elapsed_ms: number;
  sql: string;
  from_cache?: boolean;
}

interface RawRow {
  group_col?: string | number | Date;
  level: number;
  users: number;
}

@Injectable()
export class FunnelQueryService {
  private readonly logger = new Logger(FunnelQueryService.name);

  constructor(
    private readonly validator: DslValidatorService,
    private readonly sqlGenerator: FunnelSqlGeneratorService,
    private readonly queryCache: QueryCacheService,
    private readonly clickHouse: ClickHouseService,
    private readonly dataScope: DataScopeService,
    private readonly datatableMap: DatatableMapService,
    private readonly datatables: DatatableService,
  ) {}

  async analyze(
    query: FunnelQuery,
    project: string,
    refresh = false,
    scope?: DataScope,
    authUserTz?: string | null,
  ): Promise<FunnelAnalysisResult> {
    const start = Date.now();
    const normalized = { ...query, project: query.project || project };

    this.validator.validateFunnelQuery(normalized, authUserTz);
    const eventKeys = (normalized.steps ?? []).map((s) => s.event).filter(Boolean);
    this.dataScope.assertEvents(scope, eventKeys);
    const { extraAnd } = this.dataScope.applyToEventsQuery(scope);

    const { sql, params, stepCount } = await this.sqlGenerator.generate(normalized, extraAnd);
    const datatableRevision = await this.datatableMap.revision(normalized.project ?? project);

    if (!refresh) {
      const cached = await this.queryCache.get<FunnelAnalysisResult>({
        dsl: normalized,
        scope: this.dataScope.cacheKey(scope),
        datatable: datatableRevision,
      });
      if (cached) {
        return {
          ...cached,
          columns: await this.resolveGroupTitle(normalized.project ?? project, cached.columns, normalized.groups),
          elapsed_ms: Date.now() - start,
          sql,
          from_cache: true,
        };
      }
    }

    try {
      const rawRows = await this.clickHouse.query<RawRow>(sql, params);
      const elapsed = Date.now() - start;
      const shaped = this.shapeResult(rawRows, normalized, stepCount);
      const columns = await this.datatableMap.attachToColumns(
        normalized.project ?? project,
        shaped.columns,
        shaped.rows,
        firstGroupMapTarget(normalized.groups),
      );
      const titled = await this.resolveGroupTitle(normalized.project ?? project, columns, normalized.groups);
      const response: FunnelAnalysisResult = {
        ...shaped,
        columns: titled,
        elapsed_ms: elapsed,
        sql,
      };
      await this.queryCache.set(
        { dsl: normalized, scope: this.dataScope.cacheKey(scope), datatable: datatableRevision },
        response,
      );
      return response;
    } catch (error) {
      this.logger.error(`漏斗分析查询失败: ${error.message}`, error.stack);
      throw new Error(`查询失败: ${error.message}`);
    }
  }

  private shapeResult(
    rawRows: RawRow[],
    query: FunnelQuery,
    stepCount: number,
  ): Omit<FunnelAnalysisResult, 'elapsed_ms' | 'sql'> {
    const hasGroup = !!query.groups && query.groups.length > 0;
    const groups = new Map<string, number[]>();

    for (const row of rawRows) {
      const key = hasGroup ? String(row.group_col ?? '__unknown__') : '__total__';
      if (!groups.has(key)) {
        groups.set(key, new Array(stepCount).fill(0));
      }
      const counts = groups.get(key)!;
      const level = Number(row.level);
      const users = Number(row.users);
      for (let i = 0; i < stepCount; i++) {
        if (level >= i + 1) {
          counts[i] += users;
        }
      }
    }

    if (groups.size === 0) {
      groups.set('__total__', new Array(stepCount).fill(0));
    }

    const stepDefs = query.steps.map((s, i) => ({
      key: `step_${i + 1}`,
      title: s.alias ?? s.event,
    }));

    const columns: FunnelAnalysisColumn[] = [];
    if (hasGroup) {
      columns.push({ key: 'group_col', title: this.groupTitle(query.groups![0]) });
    }
    for (const step of stepDefs) {
      columns.push({ key: step.key, title: step.title });
    }
    for (let i = 1; i < stepDefs.length; i++) {
      columns.push({
        key: `step_${i + 1}_conversion`,
        title: `${stepDefs[i].title} 转化率`,
        title_key: 'analysis:column.conversionRate',
        title_params: { step: stepDefs[i].title },
      });
      columns.push({
        key: `step_${i + 1}_churn`,
        title: `${stepDefs[i].title} 流失`,
        title_key: 'analysis:column.churn',
        title_params: { step: stepDefs[i].title },
      });
    }

    const rows: Record<string, unknown>[] = [];
    for (const [groupKey, counts] of groups) {
      const row: Record<string, unknown> = {};
      if (hasGroup) {
        row.group_col = groupKey;
      }
      for (let i = 0; i < stepCount; i++) {
        row[`step_${i + 1}`] = counts[i];
      }
      for (let i = 1; i < stepCount; i++) {
        const prev = counts[i - 1];
        const curr = counts[i];
        row[`step_${i + 1}_conversion`] = prev > 0 ? Number((curr / prev).toFixed(4)) : 0;
        row[`step_${i + 1}_churn`] = prev - curr;
      }
      rows.push(row);
    }

    // 按第 1 步人数降序（总体）或按分组值排序
    rows.sort((a, b) => {
      if (hasGroup) return String(a.group_col).localeCompare(String(b.group_col));
      return Number(b.step_1) - Number(a.step_1);
    });

    return {
      columns,
      rows,
      steps: stepDefs,
    };
  }

  private async resolveGroupTitle(
    project: string,
    columns: FunnelAnalysisColumn[],
    groups?: FunnelQuery['groups'],
  ): Promise<FunnelAnalysisColumn[]> {
    const prop = groups?.[0]?.prop;
    if (!prop?.includes('@')) return columns;
    const names = await this.datatables.dimensionDisplayNames(project);
    const title = names.get(prop);
    if (!title) return columns;
    return columns.map((column) => (column.key === 'group_col' ? { ...column, title } : column));
  }

  private groupTitle(group: NonNullable<FunnelQuery['groups']>[number]): string {
    if (group.scope === 'time') {
      return `时间(${group.granularity ?? 'day'})`;
    }
    if (group.scope === 'cohort') return '用户分群';
    if (group.scope === 'tag') return '用户标签';
    return group.prop ?? '分组';
  }

  async listUsers(
    query: FunnelQuery,
    project: string,
    cell: { step?: number; group_col?: string },
    limit = 1_000_000,
    authUserTz?: string | null,
  ): Promise<string[]> {
    const normalized = { ...query, project: query.project || project };
    this.validator.validateFunnelQuery(normalized, authUserTz);
    const { sql, params } = await this.sqlGenerator.listUsers(normalized, cell, Math.min(limit, 1_000_000));
    const rows = await this.clickHouse.query<{ uid: string }>(sql, params, {
      maxExecutionTime: 30,
      maxResultRows: Math.min(limit, 1_000_000),
    });
    return rows.map((row) => String(row.uid)).filter(Boolean);
  }
}
