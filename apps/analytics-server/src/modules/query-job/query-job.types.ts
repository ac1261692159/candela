/**
 * 异步查询任务的 runner 契约（phase: clklog-analytics-user-timeline-v1）。
 *
 * 管道（认领 / 状态机 / 卡死回收 / 串行 / 门禁）由 `QueryJobWorker` 统一负责；
 * **每种 kind 的查询执行与结果落库由各自的 runner 独占**（单一写入方）：
 * - `debug` → `DebugJobRunner`（modules/meta，写 Debug 留档）
 * - `user_timeline` → `TimelineJobRunner`（modules/timeline，写时间线记录）
 */

/** runner 认领到的任务（spec 由各 kind 自行解析） */
export interface ClaimedQueryJob {
  id: string;
  project: string;
  spec: unknown;
  /** 提交时刻（窗口以它为准，不因排队漂移） */
  createdAt: Date;
}

export interface QueryJobRunner {
  /** 负责的 kind，与记录表 `kind` 列一致 */
  readonly kind: string;
  /** 回收卡死的 running（进程被杀等），返回回收条数 */
  reclaimStale(before: Date): Promise<number>;
  /** 原子认领一条待办（无待办返回 null） */
  claimNext(): Promise<ClaimedQueryJob | null>;
  /** 执行并落结果；失败由 runner 自行标记（不抛出） */
  run(job: ClaimedQueryJob): Promise<void>;
}

/** 多 provider 注入令牌：由 QueryJobModule 组装两个 runner */
export const QUERY_JOB_RUNNERS = Symbol('QUERY_JOB_RUNNERS');
