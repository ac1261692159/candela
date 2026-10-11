import { Injectable } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { SqlAstGuardService } from '../report/sql-ast-guard.service';
import {
  SQL_COHORT_MATERIALIZE_LIMIT,
  SQL_COHORT_PREVIEW_LIMIT,
  SqlDefinition,
  resolveSqlInjectionWindow,
  substituteSqlPartDates,
} from './cohort-definition';

const EXEC_SECONDS = 30;

@Injectable()
export class CohortSqlService {
  constructor(
    private readonly guard: SqlAstGuardService,
    private readonly clickHouse: ClickHouseService,
  ) {}

  preview(project: string, definition: SqlDefinition, computeDay: string, limit = SQL_COHORT_PREVIEW_LIMIT) {
    const capped = Math.min(Math.max(limit, 1), SQL_COHORT_PREVIEW_LIMIT);
    return this.runSelect(project, definition, computeDay, capped);
  }

  async selectUids(
    project: string,
    definition: SqlDefinition,
    computeDay: string,
    limit = SQL_COHORT_MATERIALIZE_LIMIT,
  ): Promise<{ uids: string[]; truncated: boolean }> {
    const result = await this.runSelect(project, definition, computeDay, limit + 1);
    const truncated = result.uids.length > limit;
    const uids = truncated ? result.uids.slice(0, limit) : result.uids;
    return { uids, truncated };
  }

  private async runSelect(
    project: string,
    definition: SqlDefinition,
    computeDay: string,
    limit: number,
  ): Promise<{ uids: string[]; columns: { name: string; type: string }[] }> {
    const substituted = substituteSqlPartDates(definition, computeDay);
    const window = resolveSqlInjectionWindow(definition.time_params, computeDay);
    const sql = applySqlCohortLimit(substituted, limit);
    const bound = { project, from: window.start, to: window.end };
    const guarded = this.guard.guard(sql, bound, { logicalTablesOnly: true });
    const result = await this.clickHouse.querySql(guarded, undefined, {
      additional_table_filters: this.guard.tableFilterSetting(bound),
      max_execution_time: EXEC_SECONDS,
      max_result_rows: limit,
    });
    assertSingleUidColumn(result.columns);
    const col = result.columns[0].name;
    const seen = new Set<string>();
    const uids: string[] = [];
    for (const row of result.rows) {
      const value = String(row[col] ?? '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      uids.push(value);
    }
    return { uids, columns: result.columns };
  }
}

export function applySqlCohortLimit(sql: string, limit: number): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  const match = trimmed.match(/\blimit\s+(\d+)\s*$/i);
  if (!match) return `${trimmed} LIMIT ${limit}`;
  if (Number(match[1]) > limit) {
    return `${trimmed.slice(0, match.index).trim()} LIMIT ${limit}`;
  }
  return trimmed;
}

export function assertSingleUidColumn(columns: { name: string }[]): void {
  if (!columns || columns.length === 0) {
    throw badRequest({
      code: 'cohort.sql.resultEmpty',
      messageKey: 'cohort:error.sql.resultEmpty',
      message: 'SQL 分群结果必须恰好一列主体 ID',
    });
  }
  if (columns.length !== 1) {
    throw badRequest({
      code: 'cohort.sql.resultNotSingleColumn',
      messageKey: 'cohort:error.sql.resultNotSingleColumn',
      message: 'SQL 分群结果必须恰好一列（uid）',
    });
  }
}
