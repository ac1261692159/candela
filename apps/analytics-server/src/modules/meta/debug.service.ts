import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { badRequest, domainError } from '../../i18n/domain-error';
import { addCalendarDays, ymdInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import { isClickHouseTimeout } from '../query-job/query-job.policy';
import { DEBUG_DEFAULT_WINDOW, DEBUG_WINDOWS, type DebugWindow } from './dto/debug-query.dto';

export interface RecentDebugQuery {
  distinct_id?: string;
  user_key?: string;
  event?: string;
  limit?: number;
  /** 原始字符串，由 normalizeWindow 校验并归一（非法值抛 400） */
  window?: string;
}

export interface DebugRow {
  log_time: string;
  event: string;
  distinct_id: string;
  user_key: string;
  properties: string;
  /** 窗口函数带出的命中总数（UInt64；JSON 里可能被引号包成字符串） */
  matched_total?: number | string;
}

export interface DebugQueryResult {
  items: DebugRow[];
  /** 该条件下窗口内的真实命中总数（count() OVER ()，与 LIMIT 无关） */
  matched_total: number;
  window: DebugWindow;
  limit: number;
  /** 实际生效的绝对下界（epoch 秒），供留档与排障核对口径 */
  since: number;
}

export const DEBUG_DEFAULT_LIMIT = 20;
export const DEBUG_MAX_LIMIT = 100;

const WINDOW_HOURS: Record<DebugWindow, number> = { '1h': 1, '24h': 24, '7d': 24 * 7 };

/**
 * stat_date 下界余量（天）。`stat_date` 按项目时区切日、`log_time` 按平台时区，
 * 再叠加设备时钟的轻微偏移，故下界必须留余量；且只加**下界**不加上界，
 * 这样「设备时钟超前」的行仍然可见（埋点排查恰恰要看这种事实）。
 *
 * 补这个谓词的意义：表按 `toYYYYMM(stat_date)` 分区，而原查询只给 `log_time`
 * （既不在分区键、也不在排序键 (event, stat_date, distinct_id, crc) 前缀），
 * 分区裁剪失效。实测（7 天窗、单设备）读行数 98,384,102 → 28,101,385。
 * 语义代价见 phase 文档 §1.3：stat_date 与 log_time 相差超过余量的行不进入本窗口。
 */
export const DEBUG_STAT_DATE_MARGIN_DAYS = 2;

@Injectable()
export class DebugService {
  private readonly logger = new Logger(DebugService.name);

  // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  /** 越界收敛到 [1,100]（缺省 20）；非数值在入口被 DTO / 控制器拦成 400 */
  normalizeLimit(raw?: number): number {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return DEBUG_DEFAULT_LIMIT;
    return Math.min(DEBUG_MAX_LIMIT, Math.max(1, Math.trunc(raw)));
  }

  normalizeWindow(raw?: string): DebugWindow {
    if (!raw) return DEBUG_DEFAULT_WINDOW;
    const hit = DEBUG_WINDOWS.find((w) => w === raw);
    if (!hit) {
      throw badRequest({
        code: 'meta.debug.invalidWindow',
        messageKey: 'meta:error.debug.invalidWindow',
        params: { windows: DEBUG_WINDOWS.join(' / ') },
      });
    }
    return hit;
  }

  /**
   * 窗口内的原始事件行。时间窗一律用 **epoch 秒 + toDateTime()**：
   * naïve 字符串字面量会按 CH 服务端时区解释（曾造成 8 小时偏移事故，见 clickhouse.service.ts）。
   *
   * `options.maxExecutionTime`：单次预算（秒）。控制器用它做「快查询同步跑、超预算转后台」的两段式；
   * 不带则用全局默认（300s）。
   */
  async recent(
    query: RecentDebugQuery,
    projectName: string,
    now: number = Date.now(),
    options: { maxExecutionTime?: number } = {},
  ): Promise<DebugQueryResult> {
    const conditions: string[] = ['project_name = {project: String}'];
    const params: Record<string, unknown> = { project: projectName };

    if (query.distinct_id) {
      conditions.push('distinct_id = {distinct_id: String}');
      params.distinct_id = query.distinct_id;
    }
    if (query.user_key) {
      conditions.push('user_key = {user_key: String}');
      params.user_key = query.user_key;
    }
    if (query.event) {
      conditions.push('event = {event: String}');
      params.event = query.event;
    }

    const window = this.normalizeWindow(query.window);
    const limit = this.normalizeLimit(query.limit);
    const since = Math.floor(now / 1000) - WINDOW_HOURS[window] * 3600;
    // 下界必须从**窗口起点**往前留余量：曾经写成「今天 - 余量」，把 7 天窗悄悄截成 2 天
    // （生产实测：单设备命中 27492 → 8102，fish_open 4 条 → 0 条）。
    const sinceDate = ymdInTz(this.timezones.platformTz, since * 1000);
    const statFrom = addCalendarDays(sinceDate, -DEBUG_STAT_DATE_MARGIN_DAYS);

    const where = conditions.join(' AND ');
    // count() OVER () 在 LIMIT 之前求值 = 命中总数：与主查询共用同一次扫描，不额外增加成本。
    // 时间下界仍必须有：log_time 不在排序键前缀（event 打头），无界 ORDER BY log_time DESC
    // 是整表扫（HANDOVER §11.2 对拍事故）。Debug 语义即「最近」。
    const sql = `
      SELECT log_time, event, distinct_id, user_key, properties,
             count() OVER () AS matched_total
      FROM clklog_sa.sa_events
      WHERE ${where}
        AND log_time >= toDateTime({since: UInt32})
        AND stat_date >= toDate({stat_from: String})
      ORDER BY log_time DESC
      LIMIT {limit: UInt32}
    `;

    let rows: DebugRow[];
    try {
      rows = await this.clickHouse.query<DebugRow>(
        sql,
        { ...params, since, stat_from: statFrom, limit },
        options.maxExecutionTime ? { maxExecutionTime: options.maxExecutionTime } : {},
      );
    } catch (error) {
      // CH 内部报错只进服务端日志：响应体给稳定错误码，不外泄引擎细节（phase 文档 §1.4）。
      // 超时要单独识别：控制器据此把查询转后台（两段式），GET /recent 则如实回超时。
      const timedOut = isClickHouseTimeout(error);
      this.logger.error(
        `Debug 查询失败（window=${window} limit=${limit}${timedOut ? ' timeout' : ''}）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (timedOut) {
        throw domainError(HttpStatus.GATEWAY_TIMEOUT, {
          code: 'meta.debug.queryTimeout',
          messageKey: 'meta:error.debug.queryTimeout',
        });
      }
      throw domainError(HttpStatus.INTERNAL_SERVER_ERROR, {
        code: 'meta.debug.queryFailed',
        messageKey: 'meta:error.debug.queryFailed',
      });
    }

    const matchedTotal = rows.length ? Number(rows[0].matched_total ?? 0) : 0;
    return { items: rows, matched_total: matchedTotal, window, limit, since };
  }
}
