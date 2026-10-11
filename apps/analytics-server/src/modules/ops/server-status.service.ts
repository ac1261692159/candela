import { Injectable } from '@nestjs/common';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClickHouseService } from '../shared/clickhouse.service';
import { PrismaService } from '../shared/prisma.service';
import { collectHostMetrics, diskUsage } from './host-metrics';

/** 数据盘（部署约定，见 HANDOVER）：/data 挂 ClickHouse 数据与应用 */
const DATA_DISK_PATH = '/data';
const DISK_METRIC_PREFIX = 'disk_used:';

/** 应用版本文件：部署脚本维护在 server 目录的上一级 */
function readAppVersion(): string {
  try {
    return readFileSync(join(process.cwd(), '..', '.version'), 'utf8').trim();
  } catch {
    return '';
  }
}

@Injectable()
export class ServerStatusService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly prisma: PrismaService,
  ) {}

  async status() {
    const host = collectHostMetrics([DATA_DISK_PATH]);

    // 依赖探测失败不阻塞整个页面：前端按 ok:false 展示「不可达」
    let clickhouse: Record<string, unknown>;
    try {
      const stats = await this.clickhouse.queryDataStats();
      clickhouse = { ok: true, ...stats };
    } catch (error) {
      clickhouse = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      app: {
        version: readAppVersion(),
        nodeVersion: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        heapUsedBytes: process.memoryUsage().heapUsed,
        rssBytes: process.memoryUsage().rss,
      },
      host: { ...host, cpuCores: cpus().length },
      clickhouse,
    };
  }

  /**
   * 磁盘用量采样历史（切片 3 + 数据管理 V1.1 多目录扩展）。
   * path 可选：默认整盘 /data；传白名单目录则读该目录的采样（disk_used:{path}）。
   * 精确匹配 metric_key（避免 /data 前缀误匹配子目录）。
   * 只返回采样点；拟合与外推由前端 trend-forecast 纯函数计算。
   */
  async diskTrend(hours: number, path?: string) {
    const target = this.resolvePath(path);
    const since = new Date(Date.now() - hours * 3_600_000);
    const samples = await this.prisma.hostMetricSample.findMany({
      where: { metric_key: `${DISK_METRIC_PREFIX}${target}`, sampled_at: { gte: since } },
      orderBy: { sampled_at: 'asc' },
      take: 6000, // 180 天 × 24 点/天 = 4320，留余量
    });
    const disk = diskUsage(target);
    return {
      path: target,
      samples: samples.map((sample) => ({
        sampled_at: sample.sampled_at.toISOString(),
        value: sample.value,
      })),
      current: disk
        ? {
            path: disk.path,
            totalBytes: disk.totalBytes,
            usedBytes: disk.totalBytes - disk.freeBytes,
            usedPercent: disk.usedPercent,
          }
        : null,
    };
  }

  /** 采样/治理路径白名单（防任意路径探测） */
  private resolvePath(path?: string): string {
    const allowed = ['/', '/data', '/data/clklog/clklog-docker-compose/clklog_dc_data/receiver'];
    if (!path) return DATA_DISK_PATH;
    // 允许根盘（df 里 / 与 /data 不同文件系统）
    if (path === '/') return '/';
    if (!allowed.includes(path)) {
      throw new Error(`路径不在监控白名单（允许：${allowed.join(', ')}）`);
    }
    return path;
  }
}
