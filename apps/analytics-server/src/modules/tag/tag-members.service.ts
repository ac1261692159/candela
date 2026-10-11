import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS clklog_sa.sa_tag_members
(
    project_name LowCardinality(String),
    tag_id       String,
    batch_id     String,
    uid          String,
    tag_value    String,
    computed_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY project_name
ORDER BY (tag_id, batch_id, uid)
TTL computed_at + INTERVAL 180 DAY DELETE
`;

@Injectable()
export class TagMembersService implements OnModuleInit {
  private readonly logger = new Logger(TagMembersService.name);

  constructor(private readonly clickHouse: ClickHouseService) {}

  async onModuleInit() {
    try {
      await this.clickHouse.exec(CREATE_SQL);
    } catch (error) {
      this.logger.error(`创建 sa_tag_members 失败: ${(error as Error).message}`);
    }
  }

  async insertSelect(sql: string, params: Record<string, unknown>) {
    await this.clickHouse.command(sql, params, { maxExecutionTime: 30 });
  }

  async count(project: string, tagId: string, batchId: string): Promise<number> {
    const rows = await this.clickHouse.query<{ c: string | number }>(
      `SELECT count() AS c
       FROM clklog_sa.sa_tag_members
       WHERE project_name = {project: String}
         AND tag_id = {tag_id: String}
         AND batch_id = {batch_id: String}`,
      { project, tag_id: tagId, batch_id: batchId },
      { maxExecutionTime: 30, maxResultRows: 1 },
    );
    return Number(rows[0]?.c ?? 0);
  }

  async preview(project: string, tagId: string, batchId: string, limit: number) {
    return this.clickHouse.query<{ uid: string; tag_value: string }>(
      `SELECT uid, tag_value
       FROM clklog_sa.sa_tag_members
       WHERE project_name = {project: String}
         AND tag_id = {tag_id: String}
         AND batch_id = {batch_id: String}
       ORDER BY uid
       LIMIT {limit: UInt32}`,
      { project, tag_id: tagId, batch_id: batchId, limit },
      { maxExecutionTime: 30, maxResultRows: limit },
    );
  }

  async deleteBatch(project: string, tagId: string, batchId: string) {
    if (!batchId) return;
    await this.clickHouse.command(
      `ALTER TABLE clklog_sa.sa_tag_members DELETE
       WHERE project_name = {project: String}
         AND tag_id = {tag_id: String}
         AND batch_id = {batch_id: String}`,
      { project, tag_id: tagId, batch_id: batchId },
    );
  }
}
