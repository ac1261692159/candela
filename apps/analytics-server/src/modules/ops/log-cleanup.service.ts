import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../shared/prisma.service';
import { appConfig } from '../../config/configuration';

/**
 * 日志治理（phase: clklog-analytics-data-management-v1，程序内实现——不依赖 cron/Puppet）。
 *
 * 背景（2026-09-07 磁盘排查）：receiver 每天落盘 100-150G 原始埋点报文
 * （store-*.log，IP+完整事件 JSON 文本镜像），数据已进 ClickHouse，
 * 磁盘文本属重复副本，按此增速 2.9T 盘约 10 天写满。
 *
 * 设计：
 * - 白名单目录存 ops_log_cleanup_config（种子含 receiver，保留 3 天）；
 * - 每小时与采样同节奏执行一次「删除 mtime 早于保留期的 *.log」；
 * - 只匹配 .log 后缀 + 递归限制在配置目录内，绝不触碰 clickhouse/mysql 等数据目录；
 * - 当前活跃文件（store.log）mtime 是今天，天然不会被保留期规则命中；
 * - 每次运行（自动/手动）写 ops_action_log 审计（红线6）。
 */

const CLEANUP_INTERVAL_MS = 3_600_000;
const LOG_SUFFIX = /\.(log)$/i;

export interface LogFileScan {
  path: string;
  size_bytes: number;
  mtime: string;
}

@Injectable()
export class LogCleanupService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LogCleanupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // ingestor 进程复用 AppModule：清理只在 server 侧跑，否则每小时两条重复审计，
    // 且两个进程并发 unlink 同一批文件（CODE_HANDOVER AL-02）
    if (!appConfig.background_workers) {
      this.logger.log('日志清理未启动（非 server 进程）');
      return;
    }
    // 启动后先跑一次（延迟 5 分钟，避开发版后的资源争抢高峰）
    this.timer = setTimeout(() => {
      void this.runAll();
      this.timer = setInterval(() => void this.runAll(), CLEANUP_INTERVAL_MS);
      this.timer.unref();
    }, 5 * 60_000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 受监控目录配置列表（含实时用量） */
  async listConfigs() {
    const configs = await this.prisma.logCleanupConfig.findMany({ orderBy: { id: 'asc' } });
    return configs.map((c) => {
      const scan = this.scanDir(c.path, 0); // 保留 0 天 = 全量统计
      return {
        path: c.path,
        label: c.label,
        retain_days: c.retain_days,
        enabled: c.enabled,
        last_run_at: c.last_run_at?.toISOString() ?? null,
        last_freed_bytes: c.last_freed_bytes == null ? null : Number(c.last_freed_bytes),
        last_file_count: c.last_file_count,
        current: { file_count: scan.count, total_bytes: scan.bytes },
      };
    });
  }

  /** 更新保留天数 / 开关（手动治理入口） */
  async updateConfig(path: string, input: { retain_days?: number; enabled?: boolean }) {
    const data: { retain_days?: number; enabled?: boolean } = {};
    if (input.retain_days !== undefined) {
      const d = Math.floor(input.retain_days);
      if (!Number.isInteger(d) || d < 1 || d > 365) {
        throw badRequest({
          code: 'ops.logCleanup.retainDaysInvalid',
          messageKey: 'ops:error.logCleanup.retainDaysInvalid',
          message: '保留天数须为 1-365 的整数',
        });
      }
      data.retain_days = d;
    }
    if (input.enabled !== undefined) data.enabled = input.enabled;
    await this.prisma.logCleanupConfig.update({ where: { path }, data });
    return this.listConfigs();
  }

  /** 预演：某目录按保留期将删除的文件（只读） */
  async preview(path: string) {
    const cfg = await this.prisma.logCleanupConfig.findUnique({ where: { path } });
    if (!cfg) {
      throw badRequest({
        code: 'ops.logCleanup.pathNotAllowed',
        messageKey: 'ops:error.logCleanup.pathNotAllowed',
        params: { path },
        message: `目录不在治理白名单：${path}`,
      });
    }
    const scan = this.scanDir(path, cfg.retain_days);
    return {
      path,
      retain_days: cfg.retain_days,
      file_count: scan.count,
      total_bytes: scan.bytes,
      largest: scan.largest,
    };
  }

  /** 手动执行一次清理（跳过 enabled 开关，显式动作） */
  async execute(path: string, operator: string) {
    const cfg = await this.prisma.logCleanupConfig.findUnique({ where: { path } });
    if (!cfg) {
      throw badRequest({
        code: 'ops.logCleanup.pathNotAllowed',
        messageKey: 'ops:error.logCleanup.pathNotAllowed',
        params: { path },
        message: `目录不在治理白名单：${path}`,
      });
    }
    const result = this.cleanupDir(path, cfg.retain_days);
    await this.audit(path, 'manual', result, operator);
    await this.prisma.logCleanupConfig.update({
      where: { path },
      data: {
        last_run_at: new Date(),
        last_freed_bytes: BigInt(result.freed_bytes),
        last_file_count: result.deleted_count,
      },
    });
    return result;
  }

  /** 定时入口：对所有 enabled 目录执行清理 */
  async runAll(): Promise<void> {
    const configs = await this.prisma.logCleanupConfig.findMany({ where: { enabled: true } });
    for (const cfg of configs) {
      try {
        const result = this.cleanupDir(cfg.path, cfg.retain_days);
        await this.audit(cfg.path, 'auto', result, 'system');
        await this.prisma.logCleanupConfig.update({
          where: { path: cfg.path },
          data: {
            last_run_at: new Date(),
            last_freed_bytes: BigInt(result.freed_bytes),
            last_file_count: result.deleted_count,
          },
        });
        if (result.deleted_count > 0) {
          this.logger.log(
            `日志清理 ${cfg.path}：删除 ${result.deleted_count} 个文件，释放 ${result.freed_bytes} 字节`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `日志清理失败 ${cfg.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          await this.audit(cfg.path, 'auto', { deleted_count: 0, freed_bytes: 0 }, 'system', error);
        } catch {
          // 审计失败不再传播
        }
      }
    }
  }

  // ---------- 内部 ----------

  /** 扫描目录内过期 .log 文件（retainDays=0 表示全量统计，用于用量展示） */
  private scanDir(
    dir: string,
    retainDays: number,
  ): { count: number; bytes: number; largest: LogFileScan[] } {
    const cutoff = Date.now() - retainDays * 86_400_000;
    const files: LogFileScan[] = [];
    this.walk(dir, (p, st) => {
      if (LOG_SUFFIX.test(p) && st.mtimeMs < cutoff) {
        files.push({ path: p, size_bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      }
    });
    files.sort((a, b) => b.size_bytes - a.size_bytes);
    return {
      count: files.length,
      bytes: files.reduce((s, f) => s + f.size_bytes, 0),
      largest: files.slice(0, 5),
    };
  }

  /** 执行删除 */
  private cleanupDir(dir: string, retainDays: number): { deleted_count: number; freed_bytes: number } {
    const cutoff = Date.now() - retainDays * 86_400_000;
    let deleted = 0;
    let freed = 0;
    this.walk(dir, (p, st) => {
      if (LOG_SUFFIX.test(p) && st.mtimeMs < cutoff) {
        unlinkSync(p);
        deleted += 1;
        freed += st.size;
      }
    });
    return { deleted_count: deleted, freed_bytes: freed };
  }

  /** 递归遍历（仅文件回调；限制深度防意外越界） */
  private walk(dir: string, cb: (path: string, st: { size: number; mtimeMs: number }) => void, depth = 0): void {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        this.walk(full, cb, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          cb(full, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // 文件可能在遍历中被轮转删除，跳过
        }
      }
    }
  }

  private async audit(
    path: string,
    mode: 'auto' | 'manual',
    result: { deleted_count: number; freed_bytes: number },
    operator: string,
    error?: unknown,
  ) {
    try {
      await this.prisma.opsActionLog.create({
        data: {
          action: 'log_cleanup',
          target_table: path,
          detail: { mode, ...result } as object,
          status: error ? 'failed' : 'done',
          error: error ? (error instanceof Error ? error.message : String(error)) : null,
          operator,
        },
      });
    } catch {
      // 审计失败不阻断清理主流程
    }
  }
}
