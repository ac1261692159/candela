import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { appConfig } from '../../config/configuration';
import { CardRepository } from './card.repository';
import { CardService } from './card.service';
import {
  failBackoffMs,
  nextRetryAt,
  shouldWorkerRefresh,
  WORKER_CONCURRENCY,
  WORKER_INTERVAL_MS,
} from './card-cache.policy';

/**
 * 后台温热已被看板引用的查询卡缓存。
 * 间隔 30s、并发 2；退出时停表。
 *
 * 刷新失败会写入卡片缓存（error + 前进 refreshed_at）并按指数退避重试，
 * 避免持续失败的查询被每 30s 高频重试（线上事故 2026-09-07 的放大源）。
 */
@Injectable()
export class CardCacheWorker implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(CardCacheWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** 连续失败记忆：card_id → 次数与下次可重试时间。成功即清除，进程内有效。 */
  private readonly failures = new Map<string, { fails: number; nextAttemptAt: number }>();

  constructor(
    private readonly cards: CardRepository,
    private readonly cardService: CardService,
  ) {}

  onModuleInit() {
    // ingestor 进程复用 AppModule：卡片温热只在 server 侧跑，否则同一张卡片被两个进程
    // 各刷一遍，双倍 ClickHouse 负载（CODE_HANDOVER AL-02）
    if (!appConfig.background_workers) {
      this.logger.log('卡片缓存温热未启动（非 server 进程）');
      return;
    }
    this.timer = setInterval(() => void this.tick(), WORKER_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stop();
  }

  onApplicationShutdown() {
    this.stop();
  }

  private stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const rows = await this.cards.findWorkerCandidates();
      const now = Date.now();
      const due = rows.filter((row) => {
        if (
          !shouldWorkerRefresh({
            type: row.type,
            dashboardTtls: row.dashboard_cards.map((l) => l.dashboard.cache_ttl_sec),
            refreshedAt: row.cache?.refreshed_at ?? null,
          })
        ) {
          return false;
        }
        const pending = this.failures.get(row.card_id);
        return !pending || pending.nextAttemptAt <= now;
      });
      await this.runPool(due, WORKER_CONCURRENCY, (row) => this.refreshOne(row));
      this.pruneFailures(new Set(rows.map((r) => r.card_id)));
    } catch (err) {
      this.logger.warn(`卡片缓存扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async refreshOne(row: {
    card_id: string;
    type: string;
    dsl_json: string;
    project_name: string;
    cache?: { result_json: string | null } | null;
  }) {
    try {
      const result = await this.cardService.computeResult(row);
      await this.cardService.writeCache(row.card_id, result, null);
      this.failures.delete(row.card_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fails = (this.failures.get(row.card_id)?.fails ?? 0) + 1;
      this.failures.set(row.card_id, { fails, nextAttemptAt: nextRetryAt(Date.now(), fails) });

      // 失败也要落缓存：① 前端能看到失败原因而非空白；② refreshed_at 前进，
      // 卡片不再每 30s 被判为需刷新（此前失败不落库导致的高频重试放大）。
      // 保留上一次可用结果，避免把已有数据清成空白。
      try {
        await this.cardService.writeCache(row.card_id, this.previousResult(row), message);
      } catch (writeErr) {
        this.logger.warn(
          `卡片 ${row.card_id} 失败状态写入缓存失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }
      this.logger.warn(
        `卡片 ${row.card_id} 后台刷新失败（连续第 ${fails} 次，${Math.round(failBackoffMs(fails) / 1000)}s 后重试）: ${message}`,
      );
    }
  }

  /** 取上一次成功结果用于失败时保留；无历史或已损坏则为 null */
  private previousResult(row: { cache?: { result_json: string | null } | null }): unknown {
    const json = row.cache?.result_json;
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /** 卡片已删除/不再候选时清掉失败记忆，避免 map 无界增长 */
  private pruneFailures(known: Set<string>) {
    for (const cardId of this.failures.keys()) {
      if (!known.has(cardId)) this.failures.delete(cardId);
    }
  }

  private async runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
    let next = 0;
    const run = async () => {
      while (next < items.length && !this.stopped) {
        const item = items[next];
        next += 1;
        await worker(item);
      }
    };
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, () => run()));
  }
}
