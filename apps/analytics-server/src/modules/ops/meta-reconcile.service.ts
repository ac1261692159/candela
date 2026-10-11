import { Injectable, Logger } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { ClickHouseService } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';

/**
 * 数据 ↔ 元数据对账（phase: clklog-data-management-v1.2，R4-c）。
 *
 * 解决的真实问题：「以前上报的测试事件已写进 ClickHouse，但平台里看不到」——
 * 平台的事件选择器读 MySQL `meta_event`，只有经过 ingestor 发现链路的 `type='track'`
 * 消息才会自动登记（`meta-discovery.service.ts`），因此「数据里有、元数据没有」的事件
 * 在平台里到处都查不到（实测 2026-10-09：`$SignUp` 448,923 行、`$undefined` 2 行）。
 *
 * 本服务把两侧做差集：未登记事件（CH 有 / MySQL 无，附未来日期标记）与幽灵登记
 * （MySQL 有 / CH 无，测试残留或虚拟事件）。只读，不写任何数据。
 *
 * ⚠️ 窗口成本（2026-10-09 端到端实测）：`sa_events` 单表 18.5 亿行、可用数据跨 ~74 天，
 * CH 的**执行前估算**对该表按行数线性放大——30 天窗口估算已接近/超过时限（90 天实测报
 * `Estimated query execution time 81s / 1.85B rows`）。因此：默认窗口 30 天、上限 30 天、
 * 护栏 120s，并把 CH 的估算超限翻译成可操作的错误提示；更早的历史事件请用
 * `scripts/reconcile.sh`（或在服务器上跑差集脚本）按需查。
 */
@Injectable()
export class MetaReconcileService {
  private readonly logger = new Logger(MetaReconcileService.name);

  constructor(
    private readonly clickHouse: ClickHouseService,
    private readonly prisma: PrismaService,
  ) {}

  /** 数据 ↔ 元数据差集（默认窗口 30 天；窗口内无事件的旧事件不会出现在「未登记」里） */
  async unregisteredEvents(
    project: string,
    options: { windowDays?: number; limit?: number; today: string },
  ): Promise<{
    project: string;
    window_days: number;
    window_from: string;
    data_events: number;
    registered_events: number;
    unregistered: Array<{ event: string; rows: number; min_date: string; max_date: string; has_future: boolean }>;
    ghost_registered: string[];
    truncated: boolean;
  }> {
    const windowDays = Math.min(Math.max(Math.trunc(options.windowDays ?? 14), 1), 30);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const from = shiftYmd(options.today, -(windowDays - 1));

    // CH 侧：窗口内按事件聚合（带护栏：60s / 1GB / 2 线程，避免拖垮单机 CH）
    const rows = await this.clickHouse.query<{
      event: string;
      cnt: string;
      min_d: string;
      max_d: string;
      future: string;
    }>(
      `SELECT event, count() AS cnt, toString(min(stat_date)) AS min_d, toString(max(stat_date)) AS max_d,
              countIf(stat_date > {today: Date}) AS future
       FROM clklog_sa.sa_events
       WHERE project_name = {project: String} AND stat_date >= {from: Date}
       GROUP BY event ORDER BY cnt DESC`,
      { project, from, today: options.today },
      // 120s / 1GB / 2 线程：窗口已在上面夹到 ≤30 天，仍留足余量
      { maxExecutionTime: 300, maxMemoryUsage: 1_000_000_000, maxThreads: 2 },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/estimated query execution time|max_execution_time/i.test(message)) {
        throw badRequest({
          code: 'ops.metaReconcile.windowTooWide',
          messageKey: 'ops:error.metaReconcile.windowTooWide',
          params: { days: windowDays },
          message: `窗口 ${windowDays} 天超出 ClickHouse 估算上限：请换更小的窗口（默认 14 天，可试 7 天），更早的历史事件用 scripts/reconcile.sh 差集查询`,
        });
      }
      throw error;
    });

    const registered = new Set(
      (
        await this.prisma.metaEvent.findMany({ where: { project_name: project }, select: { event_key: true } })
      ).map((r) => r.event_key),
    );

    const inData = new Set(rows.map((r) => r.event));
    const unregistered = rows
      .filter((r) => !registered.has(r.event))
      .map((r) => ({
        event: r.event,
        rows: parseInt(r.cnt, 10),
        min_date: r.min_d,
        max_date: r.max_d,
        has_future: parseInt(r.future, 10) > 0,
      }));
    const ghost = [...registered].filter((e) => !inData.has(e));

    // 幽灵登记的语义提醒：虚拟事件（ve_*）与测试残留都会落在这里，交给人工判断
    if (ghost.length) {
      this.logger.log(`项目 ${project} 幽灵登记 ${ghost.length} 个（元数据有、窗口内数据无）`);
    }

    return {
      project,
      window_days: windowDays,
      window_from: from,
      data_events: rows.length,
      registered_events: registered.size,
      unregistered: unregistered.slice(0, limit),
      ghost_registered: ghost.slice(0, limit),
      truncated: unregistered.length > limit || ghost.length > limit,
    };
  }
}

/** `YYYY-MM-DD` 偏移（纯字符串，避免时区二次换算） */
function shiftYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
