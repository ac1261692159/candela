import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import { appConfig } from '../../config/configuration';
import { diskUsage } from './host-metrics';

/** 采样间隔：1 小时（PRD §4.2 D 组） */
const SAMPLE_INTERVAL_MS = 3_600_000;
const DISK_METRIC_PREFIX = 'disk_used:';
const DATA_DISK_PATH = '/data';

/**
 * 目录级磁盘用量采样（数据管理 V1.1 扩展）：
 * 除整盘 /data 外，对可治理的日志目录单独采样（metric_key: disk_used:{path}）。
 * 供服务器状态页「日志磁盘使用量」趋势与清理决策消费。
 */
const SAMPLED_PATHS: string[] = [
  DATA_DISK_PATH,
  '/data/clklog/clklog-docker-compose/clklog_dc_data/receiver',
];

/**
 * 表级存储采样的目标表（数据管理 V1.0，设计文档 §3.1）。
 * metric_key：`table:{db}.{tbl}:rows|bytes`，值分别取行数/压缩后字节。
 */
const SAMPLED_TABLES: Array<{ db: string; table: string }> = [
  { db: 'clklog_sa', table: 'sa_events' },
  { db: 'clklog', table: 'log_analysis' },
];

@Injectable()
export class MetricSamplerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MetricSamplerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickHouse: ClickHouseService,
  ) {}

  onModuleInit() {
    // ingestor 进程复用 AppModule：采样只在 server 侧跑，否则每小时两份重复采样点
    // （CODE_HANDOVER AL-02）
    if (!appConfig.background_workers) {
      this.logger.log('指标采样未启动（非 server 进程）');
      return;
    }
    // 启动即采一次，尽快积累首个样本
    void this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sample(): Promise<void> {
    const writes: Array<{ metric_key: string; value: number }> = [];
    for (const path of SAMPLED_PATHS) {
      const disk = diskUsage(path);
      if (disk) {
        writes.push({ metric_key: `${DISK_METRIC_PREFIX}${disk.path}`, value: disk.totalBytes - disk.freeBytes });
      } else {
        this.logger.warn(`磁盘指标采集失败：${path}`);
      }
    }
    writes.push(...(await this.sampleTables()));

    try {
      await this.prisma.hostMetricSample.createMany({ data: writes.map((w) => ({ ...w })) });
    } catch (error) {
      this.logger.warn(
        `指标写入失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 表级行数/字节采样（system.parts，快照查询，带护栏） */
  private async sampleTables(): Promise<Array<{ metric_key: string; value: number }>> {
    const list = SAMPLED_TABLES.map((t) => `'${t.db}.${t.table}'`).join(',');
    try {
      // ⚠️ 别名不可用 `AS table`（table 是 CH 关键字，HTTP 裸 SQL 下解析为空结果）
      const rows = await this.clickHouse.queryReconcile<{
        tname: string;
        cnt: string;
        bytes: string;
      }>(
        `SELECT database || '.' || table AS tname, sum(rows) AS cnt, sum(data_compressed_bytes) AS bytes
         FROM system.parts WHERE active AND (database || '.' || table) IN (${list})
         GROUP BY tname`,
        undefined,
        { readonly: true, maxExecutionTime: 30, maxMemoryUsage: 1_000_000_000, maxThreads: 2 },
      );
      return rows.flatMap((r) => [
        { metric_key: `table:${r.tname}:rows`, value: parseInt(r.cnt, 10) },
        { metric_key: `table:${r.tname}:bytes`, value: parseInt(r.bytes, 10) },
      ]);
    } catch (error) {
      this.logger.warn(
        `表级采样失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
