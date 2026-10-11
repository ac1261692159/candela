/**
 * 项目时区注册表（phase: clklog-analytics-timezone-v2）。
 *
 * 同步语义：查询窗物化与 ingest 落库都不能 async 拉单（生成器/flattener 是同步路径），
 * 故全量加载 + TTL 刷新 + 未命中 fail-open 平台时区，并触发后台补拉。
 * 源：`SaProject.timezone`（管理 API 唯一写入口）；失败不放大（只记一次 warn）。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { DEFAULT_PLATFORM_TZ, isValidTimeZoneName } from './calendar';

const REFRESH_INTERVAL_MS = 60_000;

@Injectable()
export class ProjectTimeRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectTimeRegistry.name);
  private zones = new Map<string, string | null>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private warned = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 项目落库/口径时区（同步）：未知/非法 → 平台时区兜底（fail-open，
   * 绝不让一条坏配置阻塞采集与查询）。
   */
  timeZoneOf(projectName: string | null | undefined, fallback = DEFAULT_PLATFORM_TZ): string {
    if (!projectName) return fallback;
    const tz = this.zones.get(projectName);
    if (tz && isValidTimeZoneName(tz)) return tz;
    return fallback;
  }

  /** 管理 API 写后显式失效，下一次读取回源 */
  invalidate(projectName: string): void {
    this.zones.delete(projectName);
    void this.refresh().catch(() => undefined);
  }

  /** 测试用：直接种入静态映射，免拉库 */
  seedForTest(entries: Record<string, string | null>): void {
    this.zones = new Map(Object.entries(entries));
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const rows = await this.prisma.saProject.findMany({ select: { name: true, timezone: true } });
      this.zones = new Map(rows.map((row) => [row.name, row.timezone ?? null]));
      this.warned = false;
    } catch (error) {
      // 只告警一次：DB 抖动期间保持旧缓存即可，平台时区兜底语义不变
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(`项目时区注册表刷新失败（沿用旧缓存）: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
