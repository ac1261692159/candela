/**
 * 通道级限流与合并（phase: clklog-analytics-alert-channels-v1，PRD C-7）。
 *
 * 为什么必须有：钉钉官方「每机器人 20 条/分钟，超限限流 10 分钟」，企业微信 20 条/分钟，
 * Telegram 群 20 条/分钟——而检测器一轮就可能命中多条规则。没有限流，一次告警风暴会让
 * 通道静默 10 分钟，一条都发不出去。
 *
 * 策略：每通道一个串行队列 + 最小发送间隔（60s / ratePerMinute）；
 * 排到该通道时若积压 ≥ mergeThreshold，则**合并成一条摘要**而不是逐条发。
 */

export interface DispatchItem {
  /** 规则名（摘要里列出） */
  ruleName: string;
  /** 渲染好的正文（逐条发送时用） */
  text: string;
  /** 实际发送（内部含重试）；返回 Promise 表示该次发送结束 */
  send: (text: string) => Promise<void>;
  /** 每条自己的落库回调：ok 表示投递成功 */
  done: (ok: boolean, error?: Error) => void | Promise<void>;
}

export interface DispatcherOptions {
  /** 合并阈值：积压达到该条数就发摘要（默认 3） */
  mergeThreshold?: number;
  /** 摘要里最多列出的规则名条数（默认 5） */
  digestNames?: number;
  /** 队列上限：超过后新来的直接合并（避免无界增长，默认 100） */
  maxQueue?: number;
  /**
   * 合并窗口（ms，默认 250）：一轮告警是**突发**到达的，
   * 给队列一点点时间攒批，才能真正合并成一条摘要而不是逐条发。
   */
  coalesceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChannelState {
  queue: DispatchItem[];
  draining: boolean;
  /** 下一次可发送的最早时间戳 */
  nextAt: number;
}

export class ChannelDispatcher {
  private readonly states = new Map<string, ChannelState>();
  private readonly mergeThreshold: number;
  private readonly digestNames: number;
  private readonly maxQueue: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DispatcherOptions = {}) {
    this.mergeThreshold = options.mergeThreshold ?? 3;
    this.digestNames = options.digestNames ?? 5;
    this.maxQueue = options.maxQueue ?? 100;
    this.coalesceMs = options.coalesceMs ?? 250;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 入队并触发 drain（不阻塞调用方：检测器的下一轮不应被限流拖住） */
  dispatch(channelKey: string, ratePerMinute: number, item: DispatchItem): void {
    const state = this.state(channelKey);
    if (state.queue.length >= this.maxQueue) {
      // 队列已满：合并最旧的一条（保持信息量，不无限堆积）
      void state.queue.shift()?.done(true, new Error('rate_limit_dropped_merged'));
    }
    state.queue.push(item);
    void this.drain(channelKey, ratePerMinute);
  }

  /** 队列深度（健康度/测试用） */
  queueDepth(channelKey: string): number {
    return this.states.get(channelKey)?.queue.length ?? 0;
  }

  /**
   * 等待指定通道的队列排空（验收与单测用）。
   * 用真实定时器轮询：这是「观察」，不应推进被测的注入时钟。
   */
  async idle(channelKey: string): Promise<void> {
    for (let i = 0; i < 5_000; i += 1) {
      const state = this.states.get(channelKey);
      if (!state || (!state.draining && state.queue.length === 0)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  private state(channelKey: string): ChannelState {
    const existing = this.states.get(channelKey);
    if (existing) return existing;
    const created: ChannelState = { queue: [], draining: false, nextAt: 0 };
    this.states.set(channelKey, created);
    return created;
  }

  private intervalMs(ratePerMinute: number): number {
    const rate = Number.isFinite(ratePerMinute) && ratePerMinute > 0 ? ratePerMinute : 60;
    return Math.ceil(60_000 / rate);
  }

  private async drain(channelKey: string, ratePerMinute: number): Promise<void> {
    const state = this.state(channelKey);
    if (state.draining) return;
    state.draining = true;
    try {
      const interval = this.intervalMs(ratePerMinute);
      while (state.queue.length > 0) {
        // 合并窗口：突发告警先攒一下批，才有机会合并成一条摘要
        if (this.coalesceMs > 0) await this.sleep(this.coalesceMs);

        const batch = state.queue.splice(0, state.queue.length);
        if (batch.length >= this.mergeThreshold) {
          await this.waitTurn(state);
          await this.sendDigest(batch);
          state.nextAt = this.now() + interval;
          continue;
        }
        // 逐条发送：**每条之间**都要拉开间隔（否则会踩厂商限流）
        for (const item of batch) {
          await this.waitTurn(state);
          await this.sendOne(item);
          state.nextAt = this.now() + interval;
        }
      }
    } finally {
      state.draining = false;
    }
  }

  private async waitTurn(state: ChannelState): Promise<void> {
    const wait = state.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async sendOne(item: DispatchItem): Promise<void> {
    try {
      await item.send(item.text);
      await item.done(true);
    } catch (error) {
      await item.done(false, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** 合并发送：一条摘要代表 N 条告警（用批内任一投递器发送） */
  private async sendDigest(batch: DispatchItem[]): Promise<void> {
    const text = buildDigestText(batch, this.digestNames);
    const sender = batch[0];
    try {
      await sender.send(text);
      for (const item of batch) await item.done(true);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const item of batch) await item.done(false, failure);
    }
  }
}

export function buildDigestText(batch: DispatchItem[], nameLimit = 5): string {
  const names = batch.slice(0, nameLimit).map((item) => item.ruleName);
  const rest = batch.length - names.length;
  const header = `【告警汇总】本轮 ${batch.length} 条告警（已合并发送）`;
  const lines = names.map((name) => `・${name}`);
  if (rest > 0) lines.push(`・…另有 ${rest} 条`);
  lines.push('（详情见平台「监控告警 → 历史」）');
  return [header, ...lines].join('\n');
}
