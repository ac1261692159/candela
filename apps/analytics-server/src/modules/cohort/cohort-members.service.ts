import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS clklog_sa.sa_cohort_members
(
    project_name LowCardinality(String),
    cohort_id    String,
    batch_id     String,
    uid          String,
    computed_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY project_name
ORDER BY (cohort_id, batch_id, uid)
TTL computed_at + INTERVAL 180 DAY DELETE
`;

@Injectable()
export class CohortMembersService implements OnModuleInit {
  private readonly logger = new Logger(CohortMembersService.name);

  constructor(private readonly clickHouse: ClickHouseService) {}

  async onModuleInit() {
    try {
      await this.clickHouse.exec(CREATE_SQL);
    } catch (error) {
      this.logger.error(`创建 sa_cohort_members 失败: ${(error as Error).message}`);
    }
  }

  async insertSelect(sql: string, params: Record<string, unknown>) {
    await this.clickHouse.command(sql, params, { maxExecutionTime: 30 });
  }

  async count(project: string, cohortId: string, batchId: string): Promise<number> {
    const rows = await this.clickHouse.query<{ c: string | number }>(
      `SELECT count() AS c
       FROM clklog_sa.sa_cohort_members
       WHERE project_name = {project: String}
         AND cohort_id = {cohort_id: String}
         AND batch_id = {batch_id: String}`,
      { project, cohort_id: cohortId, batch_id: batchId },
      { maxExecutionTime: 30, maxResultRows: 1 },
    );
    return Number(rows[0]?.c ?? 0);
  }

  async preview(project: string, cohortId: string, batchId: string, limit: number, keyword?: string) {
    // 关键字只走参数绑定；project + cohort + batch 仍是有界前提
    const filter = keyword ? 'AND positionCaseInsensitive(uid, {keyword: String}) > 0' : '';
    return this.clickHouse.query<{ uid: string }>(
      `SELECT uid
       FROM clklog_sa.sa_cohort_members
       WHERE project_name = {project: String}
         AND cohort_id = {cohort_id: String}
         AND batch_id = {batch_id: String}
         ${filter}
       ORDER BY uid
       LIMIT {limit: UInt32}`,
      { project, cohort_id: cohortId, batch_id: batchId, limit, ...(keyword ? { keyword } : {}) },
      { maxExecutionTime: 30, maxResultRows: limit },
    );
  }

  async deleteBatch(project: string, cohortId: string, batchId: string) {
    if (!batchId) return;
    await this.clickHouse.command(
      `ALTER TABLE clklog_sa.sa_cohort_members DELETE
       WHERE project_name = {project: String}
         AND cohort_id = {cohort_id: String}
         AND batch_id = {batch_id: String}`,
      { project, cohort_id: cohortId, batch_id: batchId },
    );
  }
}
