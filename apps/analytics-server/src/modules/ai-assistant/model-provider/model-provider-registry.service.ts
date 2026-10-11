import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DatabaseProviderLoad,
  ModelProviderStoreService,
} from './model-provider-store.service';
import { HarnessProviderSnapshot } from './model-provider.types';

/** 快照的兜底保鲜期：覆盖「有人直接改库」与多进程，正常路径靠写入后主动 refresh */
const CACHE_TTL_MS = 30_000;

/**
 * 模型供应商注册表（phase: clklog-ai-model-providers-v1）。
 *
 * 库是唯一来源（v1.1）：快照直接由库行合成，没有配置文件或环境变量覆盖。
 * `snapshot()` 是同步的（网关每个请求都要读），因此内部持有内存快照 + 过期后台刷新：
 * 过期时先返回旧值、随后异步补齐，绝不阻塞请求。
 */
@Injectable()
export class ModelProviderRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModelProviderRegistryService.name);
  private cache: { snapshot: HarnessProviderSnapshot; loadedAt: number } | null = null;
  private loading: Promise<HarnessProviderSnapshot> | null = null;

  constructor(private readonly store: ModelProviderStoreService) {}

  async onModuleInit(): Promise<void> {
    // 预热失败不阻塞启动：首次 snapshot() 时还会重试
    await this.refresh();
  }

  /** 有效配置快照（同步；首次加载未完成或失败时给空快照，调用方按未配置处理） */
  snapshot(): HarnessProviderSnapshot {
    if (!this.cache) {
      void this.refresh().catch(() => undefined);
      return this.emptySnapshot();
    }
    if (Date.now() - this.cache.loadedAt > CACHE_TTL_MS) {
      void this.refresh().catch(() => undefined);
    }
    return this.cache.snapshot;
  }

  provider(providerId: string) {
    return this.snapshot().providers[providerId];
  }

  /** 写入后调用：把库里的新状态立即合成为快照（并发调用会复用同一次加载） */
  async refresh(): Promise<HarnessProviderSnapshot> {
    if (this.loading) return this.loading;
    const operation = (async () => {
      try {
        const load = await this.store.loadDatabase();
        const snapshot = this.compose(load);
        this.cache = { snapshot, loadedAt: Date.now() };
        return snapshot;
      } catch (error) {
        // 读库失败：给空快照（等价「未配置」）并显式记下来，不假装配置还在
        this.logger.error(
          `Model provider configuration reload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const snapshot = this.emptySnapshot();
        this.cache = { snapshot, loadedAt: Date.now() };
        return snapshot;
      }
    })().finally(() => {
      if (this.loading === operation) this.loading = null;
    });
    this.loading = operation;
    return operation;
  }

  /** 标记过期但保留旧快照继续服务（写入路径请直接 `await refresh()`） */
  invalidate(): void {
    if (this.cache) this.cache.loadedAt = 0;
    else void this.refresh().catch(() => undefined);
  }

  private compose(load: DatabaseProviderLoad): HarnessProviderSnapshot {
    const yaml = this.store.yamlConfig();
    return {
      enabled: yaml?.enabled ?? false,
      revision: load.revision,
      defaults: this.store.effectiveDefaults(load),
      providers: load.providers,
      unreadable: load.unreadable,
      broken: load.broken,
      configured: Object.keys(load.providers).length > 0,
    };
  }

  private emptySnapshot(): HarnessProviderSnapshot {
    const yaml = this.store.yamlConfig();
    return {
      enabled: yaml?.enabled ?? false,
      revision: 'empty',
      defaults: { provider: '', model: '', reasoning_effort: '' },
      providers: {},
      unreadable: [],
      broken: [],
      configured: false,
    };
  }
}
