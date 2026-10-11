import { Injectable, Logger } from '@nestjs/common';
import { ClickHouseService } from '../shared/clickhouse.service';
import type { SlowQueryListDto } from './dto/slow-query.dto';

/**
 * 慢 SQL 查询（phase: clklog-analytics-ops-console-v1）。
 *
 * 数据源为 ClickHouse `system.query_log`，只读，不落库。
 * 实际查询与约束（表名/列白名单、参数化、LIMIT、readonly 账号）
 * 全部封装在 `ClickHouseService.querySlowQueries`，本服务只做参数收敛与出参整形。
 *
 * 加载优化（用户要求秒开）：单槽 stale-while-revalidate 内存缓存——
 * 命中 60s 内直接回缓存；过期则**先回旧数据、后台静默刷新**；
 * 无缓存才同步查询。响应带 generated_at 供前端标注数据时间。
 */

const DEFAULT_HOURS = 24;
const DEFAULT_MIN_DURATION_MS = 5000;
const DEFAULT_LIMIT = 100;
const CACHE_FRESH_MS = 60_000;

/** 前端需原样展示，避免用户把「日志过期」误读为「没有慢查询」 */
export const SLOW_QUERY_RETENTION_NOTE =
  '数据来自 ClickHouse 查询日志（system.query_log），仅保留最近约 3 天';

/** 同一条提示的文案键与参数（i18n v1：前端优先用 key 渲染，中文原值保留为兜底） */
export const SLOW_QUERY_RETENTION_NOTE_KEY = 'ops:slowQuery.retentionNote';
export const SLOW_QUERY_RETENTION_NOTE_PARAMS = { days: 3 };

export interface SlowQueryItem {
  event_time: string;
  duration_ms: number;
  read_rows: number;
  read_bytes: number;
  memory_usage: number;
  user: string;
  status: 'success' | 'failed';
  query: string;
  exception: string | null;
}

export interface SlowQueryPayload {
  items: SlowQueryItem[];
  window: { hours: number; since: string };
  retention_note: string;
  /** 提示的文案键与参数（i18n v1；前端优先用 key 渲染） */
  retention_note_key?: string;
  retention_note_params?: Record<string, unknown>;
  generated_at: string;
  from_cache: boolean;
}

@Injectable()
export class SlowQueryService {
  private readonly logger = new Logger(SlowQueryService.name);
  /** 单槽缓存（慢 SQL 页参数组合有限，key 区分即可） */
  private cache: { key: string; at: number; data: SlowQueryPayload } | null = null;
  private refreshing = false;

  constructor(private readonly clickhouse: ClickHouseService) {}

  async list(dto: SlowQueryListDto): Promise<SlowQueryPayload> {
    const hours = dto.hours ?? DEFAULT_HOURS;
    const key = `${hours}|${dto.min_duration_ms ?? DEFAULT_MIN_DURATION_MS}|${dto.status ?? 'all'}|${dto.limit ?? DEFAULT_LIMIT}`;

    if (this.cache && this.cache.key === key) {
      const age = Date.now() - this.cache.at;
      if (age < CACHE_FRESH_MS) {
        return { ...this.cache.data, from_cache: true };
      }
      // 过期：stale-while-revalidate——立即回旧数据，后台静默刷新
      if (!this.refreshing) {
        this.refreshing = true;
        void this.queryAndCache(key, hours, dto)
          .catch((e) => this.logger.warn(`慢 SQL 缓存后台刷新失败: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            this.refreshing = false;
          });
      }
      return { ...this.cache.data, from_cache: true };
    }
    return this.queryAndCache(key, hours, dto);
  }

  private async queryAndCache(key: string, hours: number, dto: SlowQueryListDto): Promise<SlowQueryPayload> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.clickhouse.querySlowQueries({
      since,
      minDurationMs: dto.min_duration_ms ?? DEFAULT_MIN_DURATION_MS,
      status: dto.status ?? 'all',
      limit: dto.limit ?? DEFAULT_LIMIT,
    });
    const items: SlowQueryItem[] = rows.map((row) => ({
      event_time: String(row.event_time ?? ''),
      duration_ms: Number(row.query_duration_ms ?? 0),
      read_rows: Number(row.read_rows ?? 0),
      read_bytes: Number(row.read_bytes ?? 0),
      memory_usage: Number(row.memory_usage ?? 0),
      user: String(row.user ?? ''),
      status: row.type === 'ExceptionWhileProcessing' ? 'failed' : 'success',
      query: String(row.query ?? ''),
      exception: row.exception ? String(row.exception) : null,
    }));
    const payload: SlowQueryPayload = {
      items,
      window: { hours, since: since.toISOString() },
      retention_note: SLOW_QUERY_RETENTION_NOTE,
      retention_note_key: SLOW_QUERY_RETENTION_NOTE_KEY,
      retention_note_params: SLOW_QUERY_RETENTION_NOTE_PARAMS,
      generated_at: new Date().toISOString(),
      from_cache: false,
    };
    this.cache = { key, at: Date.now(), data: payload };
    return payload;
  }
}
