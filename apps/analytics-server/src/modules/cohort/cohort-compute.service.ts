import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { nanoid } from 'nanoid';
import {
  EventAnalysisQuery,
  FunnelQuery,
  RetentionQuery,
} from '../../types/dsl.types';
import { badRequest } from '../../i18n/domain-error';
import { EventQueryService } from '../query/event-query.service';
import { FunnelQueryService } from '../query/funnel-query.service';
import { RetentionQueryService } from '../query/retention-query.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import { CohortConditionSqlService } from './cohort-condition-sql.service';
import { CohortSqlService } from './cohort-sql.service';
import {
  ConditionDefinition,
  SQL_COHORT_MATERIALIZE_LIMIT,
  SqlDefinition,
  parseCsvUids,
  ResultDefinition,
  computeDay,
} from './cohort-definition';
import { CohortMembersService } from './cohort-members.service';
import { TimezoneService } from '../time/timezone.service';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { CohortRepository } from './cohort.repository';

/** 启动回收：单次最多补算多少条 + 相邻入队间隔（防启动风暴） */
const RECOVER_LIMIT = 50;
const RECOVER_STAGGER_MS = 1000;

@Injectable()
export class CohortComputeService implements OnModuleInit {
  private readonly logger = new Logger(CohortComputeService.name);
  private readonly running = new Set<string>();
  constructor(
    private readonly repository: CohortRepository,
    private readonly members: CohortMembersService,
    private readonly conditionSql: CohortConditionSqlService,
    private readonly sql: CohortSqlService,
    private readonly events: EventQueryService,
    private readonly funnels: FunnelQueryService,
    private readonly retentions: RetentionQueryService,
    private readonly clickHouse: ClickHouseService,
    private readonly timezones: TimezoneService,
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  /** 项目统计日历（timezone-v2；稳态缺省 = 平台时区） */
  private statTzOf(project: string): string {
    return this.projectTimes?.timeZoneOf(project, this.timezones.platformTz) ?? this.timezones.platformTz;
  }

  async onModuleInit() {
    await this.recoverPending();
  }

  /**
   * 启动回收「计算中」的分群：发版重启 / OOM 在计算中被杀会留下永久的 `pending`——
   * 列表每 3 秒空轮询、分析选择器永远看不到这条分群。
   *
   * 不设年龄阈值：重启时本进程没有在跑的计算，阈值只会漏掉「刚创建就重启」的正是要救的那批。
   * 上限 + 错峰防启动风暴；某条分群真算不出来会被置 `failed`，不会每次启动都重试。
   * 单实例部署（supervisord）是前提，多实例需要租约（见设计文档非目标）。
   */
  private async recoverPending() {
    try {
      const rows = await this.repository.listPending(RECOVER_LIMIT);
      if (rows.length === 0) return;
      // 日志不翻译（i18n 规范：日志与审计原文），此处用英文避免推高中文硬编码计数
      this.logger.warn(`recovering ${rows.length} pending cohort(s) after restart`);
      rows.forEach((row, index) => {
        setTimeout(() => void this.compute(row.cohort_id, row.project_name), index * RECOVER_STAGGER_MS);
      });
    } catch (error) {
      this.logger.error(`cohort pending recovery failed: ${(error as Error).message}`);
    }
  }

  enqueue(cohortId: string, project: string) {
    setTimeout(() => {
      void this.compute(cohortId, project);
    }, 0);
  }

  async compute(cohortId: string, project: string) {
    if (this.running.has(cohortId)) return;
    const row = await this.repository.findById(cohortId, project);
    if (!row) return;
    if (row.kind === 'result') return;
    this.running.add(cohortId);
    const batchId = `b_${nanoid(10)}`;
    const oldBatch = row.batch_id;
    try {
      await this.repository.update(cohortId, project, { status: 'pending', compute_error: null });
      if (row.kind === 'condition') {
        const definition = JSON.parse(row.definition_json) as ConditionDefinition;
        const part = await this.conditionSql.buildInsertSelect(
          project,
          cohortId,
          batchId,
          definition,
          computeDay(this.statTzOf(project)),
          row.subject_id,
        );
        await this.members.insertSelect(part.sql, part.params);
      } else if (row.kind === 'sql') {
        const definition = JSON.parse(row.definition_json) as SqlDefinition;
        const selected = await this.sql.selectUids(
          project,
          definition,
          computeDay(this.statTzOf(project)),
          SQL_COHORT_MATERIALIZE_LIMIT,
        );
        if (selected.truncated) {
          throw badRequest({
            code: 'cohort.sql.materializeTooLarge',
            messageKey: 'cohort:error.sql.materializeTooLarge',
            message: 'SQL 分群超过 100 万，请收紧条件后重算',
          });
        }
        await this.insertUidRows(project, cohortId, batchId, selected.uids);
      } else if (row.kind === 'id_upload') {
        throw badRequest({
          code: 'cohort.idUpload.uploadRequiredOnCreate',
          messageKey: 'cohort:error.idUpload.uploadRequiredOnCreate',
          message: 'ID 分群请在创建时上传',
        });
      }
      const count = await this.members.count(project, cohortId, batchId);
      await this.repository.update(cohortId, project, {
        status: 'ready',
        batch_id: batchId,
        member_count: count,
        last_computed_at: new Date(),
        compute_error: null,
      });
      if (oldBatch && oldBatch !== batchId) {
        await this.members.deleteBatch(project, cohortId, oldBatch);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`分群 ${cohortId} 计算失败: ${message}`);
      await this.repository.update(cohortId, project, {
        status: 'failed',
        compute_error: message.slice(0, 1000),
      });
    } finally {
      this.running.delete(cohortId);
    }
  }

  async computeIdUpload(cohortId: string, project: string, csvText: string) {
    const row = await this.repository.findById(cohortId, project);
    if (!row) return;
    const uids = parseCsvUids(csvText);
    const batchId = `b_${nanoid(10)}`;
    const oldBatch = row.batch_id;
    const part = await this.conditionSql.buildIdUploadInsert(project, cohortId, batchId, uids, row.subject_id);
    await this.members.insertSelect(part.sql, part.params);
    const count = await this.members.count(project, cohortId, batchId);
    await this.repository.update(cohortId, project, {
      status: 'ready',
      batch_id: batchId,
      member_count: count,
      last_computed_at: new Date(),
      compute_error: null,
    });
    if (oldBatch && oldBatch !== batchId) {
      await this.members.deleteBatch(project, cohortId, oldBatch);
    }
  }

  async materializeResult(cohortId: string, project: string, definition: ResultDefinition) {
    const uids = await this.listResultUsers(project, definition, 1_000_000);
    const batchId = `b_${nanoid(10)}`;
    await this.insertUidRows(project, cohortId, batchId, uids);
    await this.repository.update(cohortId, project, {
      status: 'ready',
      batch_id: batchId,
      member_count: uids.length,
      last_computed_at: new Date(),
      compute_error: null,
    });
  }

  private async insertUidRows(project: string, cohortId: string, batchId: string, uids: string[]) {
    const rows = uids.map((uid) => ({
      project_name: project,
      cohort_id: cohortId,
      batch_id: batchId,
      uid,
    }));
    const chunk = 5000;
    for (let i = 0; i < rows.length; i += chunk) {
      await this.clickHouse.insert('clklog_sa.sa_cohort_members', rows.slice(i, i + chunk));
    }
  }

  async listResultUsers(project: string, definition: ResultDefinition, limit: number) {
    if (definition.source === 'event') {
      return this.events.listUsers(
        definition.dsl as unknown as EventAnalysisQuery,
        project,
        definition.cell as { metric_id?: string; groups?: Record<string, unknown> },
        limit,
      );
    }
    if (definition.source === 'funnel') {
      return this.funnels.listUsers(
        definition.dsl as unknown as FunnelQuery,
        project,
        definition.cell as { step?: number; group_col?: string },
        limit,
      );
    }
    return this.retentions.listUsers(
      definition.dsl as unknown as RetentionQuery,
      project,
      definition.cell as { cohort_date?: string; n?: number; group_col?: string },
      limit,
    );
  }
}
