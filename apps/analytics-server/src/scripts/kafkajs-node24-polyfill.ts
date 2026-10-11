/**
 * KafkaJS 2.2.4 在 Node.js 24 下会发出 TimeoutNegativeWarning：
 *   RequestQueue.scheduleCheckPendingRequests 使用 throttledUntil - Date.now()
 *   计算 setTimeout 延迟，当 throttledUntil 未初始化时得到极大的负数。
 *
 * 这是 kafkajs 上游已知问题（tulios/kafkajs#1751），目前尚无修复版本。
 * 本 polyfill 把负延迟钳位到 0，既消除警告，也避免 Node 把负值截断为 1ms 的语义偏差。
 *
 * 仅在 ingestor 入口（run-ingestor.ts）中作为第一行导入，使其在 kafkajs
 * 加载前生效；不影响其它业务逻辑的正常超时。
 */

const originalSetTimeout = global.setTimeout;

(global as any).setTimeout = function (
  callback: (...args: any[]) => void,
  ms?: number,
  ...args: any[]
): NodeJS.Timeout {
  const delay = typeof ms === 'number' && ms < 0 ? 0 : ms;
  return originalSetTimeout(callback, delay, ...args);
};
