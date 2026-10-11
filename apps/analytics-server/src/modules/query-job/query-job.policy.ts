/**
 * 异步查询任务的策略常量（phase: clklog-analytics-debug-async-query-v1；
 * 上移到 modules/query-job 供多种 kind 共用 —— phase: clklog-analytics-user-timeline-v1）。
 *
 * 设计要点：快查询单次往返秒回；超预算转后台。预算用 ClickHouse 的 `max_execution_time`
 * 近似判定（CH 按周期检查执行时间，实际可能略超 —— 文档与文案都不承诺精确秒数）。
 */
/** 同步尝试预算（秒）：超过即转后台 */
export const QUERY_JOB_SYNC_BUDGET_S = 5;
/** 后台单任务预算（秒） */
export const QUERY_JOB_RUN_BUDGET_S = 120;
/** worker 扫描间隔（ms） */
export const QUERY_JOB_WORKER_INTERVAL_MS = 1500;
/** 每轮串行执行的任务数（保护 ClickHouse） */
export const QUERY_JOB_WORKER_CONCURRENCY = 1;
/** running 超过该时长视为卡死，回收为 failed(timeout) */
export const QUERY_JOB_STALE_MS = 10 * 60 * 1000;
/** 后台任务的错误码（前端按语言渲染，明细只进服务端日志） */
export const QUERY_JOB_ERROR_TIMEOUT = 'timeout';
export const QUERY_JOB_ERROR_QUERY_FAILED = 'query_failed';

/** ClickHouse 超时错误判定（159 TIMEOUT_EXCEEDED / 160） */
export function isClickHouseTimeout(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /TIMEOUT_EXCEEDED|Timeout exceeded|code:\s*159|code:\s*160|ETIMEDOUT/i.test(text);
}
