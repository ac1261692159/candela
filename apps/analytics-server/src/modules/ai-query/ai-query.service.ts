import { Injectable, Logger } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { AiSqlGuardService } from './ai-sql-guard.service';
import type { ApiKeyIdentity } from '../../common/decorators/api-key.decorator';

/**
 * 外部 AI 只读查询业务。
 *
 * 安全边界：
 * - 只读账号 sa_readonly（ClickHouseService.querySql 使用 readonlyClient）—— 账号无写权限。
 * - SQL 守卫：单条 SELECT、禁写/管理命令、禁表函数、库白名单。
 * - 强制 LIMIT（未写自动追加，超上限拒绝）。
 * - 强制 project 边界：project 由 API Key 绑定，SQL 若引用 sa_events 等
 *   含 project_name 的逻辑表，由守卫/账号双重兜底（详见架构文档）。
 */
@Injectable()
export class AiQueryService {
  private readonly logger = new Logger(AiQueryService.name);
  private static readonly DEFAULT_LIMIT = 1000;
  private static readonly MAX_LIMIT = 100000;

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly guard: AiSqlGuardService,
  ) {}

  async query(dto: { sql: string; limit?: number }, identity: ApiKeyIdentity) {
    const sql = dto.sql?.trim();
    if (!sql) {
      throw badRequest({
        code: 'ai.query.sqlRequired',
        messageKey: 'ai:error.query.sqlRequired',
        message: '缺少 SQL',
      });
    }

    // 安全守卫（单条 SELECT + 禁写 + 库白名单）
    this.guard.guard(sql);

    // 强制 LIMIT
    const limit = dto.limit ?? AiQueryService.DEFAULT_LIMIT;
    if (limit > AiQueryService.MAX_LIMIT) {
      throw badRequest({
        code: 'ai.query.limitTooLarge',
        messageKey: 'ai:error.query.limitTooLarge',
        params: { max: AiQueryService.MAX_LIMIT },
        message: `LIMIT 最大 ${AiQueryService.MAX_LIMIT}`,
      });
    }
    const boundedSql = this.applyLimit(sql, limit);

    // 走只读账号执行（querySql 内部用 readonlyClient + 统一资源限额：
    // 6亿行扫描 / 50GB 字节 / 2GB 内存 / 30s 超时，见 clickhouse.service.ts）
    const result = await this.clickHouse.querySql(boundedSql);

    this.logger.log(
      `AI 查询 key=${identity.name} project=${identity.project_name} rows=${result.rows.length}`,
    );

    return {
      columns: result.columns,
      rows: result.rows,
      row_count: result.rows.length,
      truncated: result.rows.length >= limit,
      read_rows: result.read_rows,
      read_bytes: result.read_bytes,
      query_id: result.query_id,
      project: identity.project_name,
    };
  }

  /** 强制 LIMIT：未写 LIMIT 自动追加 */
  private applyLimit(sql: string, limit: number): string {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (!/limit\s+\d+\s*$/i.test(trimmed)) {
      return `${trimmed} LIMIT ${limit}`;
    }
    return trimmed;
  }
}
