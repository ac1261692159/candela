import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';

/**
 * 数据表行存储（ClickHouse `clklog_sa.sa_datatable_rows`）。
 *
 * 写入语义见 `docs/architecture/clklog-analytics-design-datatable-v1.md` §5、§9：
 * **每次导入都是一份完整快照**（新 version），写完再原子切换 `active_version`，
 * 旧版本延后清理 —— 失败时线上仍读旧版本，不存在"读到空表"的窗口。
 */
const ROWS_TABLE = 'clklog_sa.sa_datatable_rows';
const INSERT_CHUNK = 5000;
const MAX_ROWS = 200_000;

export const DATATABLE_ROWS_DDL = `CREATE TABLE IF NOT EXISTS ${ROWS_TABLE}
(
    project_name  LowCardinality(String),
    datatable_key String,
    version       UInt64,
    batch_id      String,
    pk            String,
    values        String CODEC(ZSTD(3)),
    created_at    DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY version
ORDER BY (project_name, datatable_key, version, pk)`;

export interface DatatableRow {
  project_name: string;
  datatable_key: string;
  version: number;
  batch_id: string;
  pk: string;
  values: string;
}

@Injectable()
export class DatatableRowsService {
  constructor(private readonly clickHouse: ClickHouseService) {}

  /** 幂等建表（与 migrate-clickhouse 保持一致） */
  async ensureTable(): Promise<void> {
    await this.clickHouse.exec(DATATABLE_ROWS_DDL);
  }

  /** 读取某一版本的完整快照（主键 → values JSON） */
  async readSnapshot(
    project: string,
    datatableKey: string,
    version: number,
  ): Promise<Map<string, string>> {
    if (version <= 0) return new Map();
    const rows = await this.clickHouse.query<{ pk: string; values: string }>(
      `SELECT pk, values FROM ${ROWS_TABLE}
        WHERE project_name = {project: String}
          AND datatable_key = {key: String}
          AND version = {version: UInt64}
        LIMIT ${MAX_ROWS}`,
      { project, key: datatableKey, version },
      { maxResultRows: MAX_ROWS },
    );
    return new Map(rows.map((row) => [row.pk, row.values]));
  }

  /** 写入一个完整版本 */
  async writeVersion(
    project: string,
    datatableKey: string,
    version: number,
    batchId: string,
    snapshot: Map<string, string>,
  ): Promise<void> {
    const entries = [...snapshot.entries()];
    for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
      const chunk: DatatableRow[] = entries
        .slice(i, i + INSERT_CHUNK)
        .map(([pk, values]) => ({
          project_name: project,
          datatable_key: datatableKey,
          version,
          batch_id: batchId,
          pk,
          values,
        }));
      await this.clickHouse.insert<DatatableRow>(ROWS_TABLE, chunk);
    }
  }

  /** 丢掉某一个未发布的 pending 版本（失败恢复）；不得拿它去删生效版本 */
  async dropVersion(project: string, datatableKey: string, version: number): Promise<void> {
    if (version <= 0) return;
    await this.clickHouse.command(
      `ALTER TABLE ${ROWS_TABLE} DELETE
        WHERE project_name = {project: String}
          AND datatable_key = {key: String}
          AND version = {version: UInt64}`,
      { project, key: datatableKey, version },
    );
  }

  /** 切换成功且过了在途读窗口后清理其他版本（异步 mutation，尽力而为） */
  async dropOtherVersions(project: string, datatableKey: string, version: number): Promise<void> {
    await this.clickHouse.command(
      `ALTER TABLE ${ROWS_TABLE} DELETE
        WHERE project_name = {project: String}
          AND datatable_key = {key: String}
          AND version != {version: UInt64}`,
      { project, key: datatableKey, version },
    );
  }

  /** 删除数据表时清空其全部行 */
  async dropAll(project: string, datatableKey: string): Promise<void> {
    await this.clickHouse.command(
      `ALTER TABLE ${ROWS_TABLE} DELETE
        WHERE project_name = {project: String} AND datatable_key = {key: String}`,
      { project, key: datatableKey },
    );
  }
}
