import type { Response } from 'express';

/** 心跳间隔：必须显著小于链路空闲切断阈值（公网七层实测约 60 秒）。 */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface QueryKeepalive {
  /** 客户端断开时触发；交给 ClickHouse `abort_signal`，避免白跑满墙钟。 */
  readonly signal: AbortSignal;
  /** 写响应信封：已开始流式输出则自行续写，否则交给 Express 的 json（保持既有响应形状）。 */
  finish(body: unknown): void;
  stop(): void;
}

/**
 * 长查询保活：查询期间每 15 秒往响应里写一个空白字节。
 *
 * 2026-09-21 排查：ClickHouse 墙钟是 300 秒，但公网链路只要响应等待期没有字节流动，
 * 约 60 秒就会切断连接（4 天访问日志里非流式响应真正送达客户端的最大值 59.0 秒，
 * 而持续有字节的 SSE 能存活 3660 秒）。心跳让连接不再空闲，超时裁决权回到后端。
 *
 * 心跳是纯空白字节，前置空白对 `JSON.parse` 合法，前端解析无需改动。
 * 代价：第一次心跳写出后响应头即定型（状态码与 Content-Type 不能再改），
 * 因此异常路径不能再用 `res.status().json()`——全局过滤器按 headersSent 分流。
 */
export function startQueryKeepalive(res: Response, options?: { intervalMs?: number }): QueryKeepalive {
  const intervalMs = options?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const controller = new AbortController();
  // 心跳一旦写出响应头就定型，故先把 Content-Type 定好（否则流式响应无类型）
  if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const timer = setInterval(() => {
    if (controller.signal.aborted || res.writableEnded || res.destroyed) return;
    res.write('\n');
  }, intervalMs);
  timer.unref?.();

  const onClose = () => {
    if (!res.writableEnded) controller.abort();
    clearInterval(timer);
  };
  res.once('close', onClose);

  return {
    signal: controller.signal,
    finish(body: unknown) {
      clearInterval(timer);
      if (res.headersSent) {
        res.end(JSON.stringify(body));
        return;
      }
      res.json(body);
    },
    stop() {
      clearInterval(timer);
      res.off('close', onClose);
    },
  };
}

/**
 * 长接口的统一入口包装：保活 + 成功信封。
 *
 * 用它的控制器必须声明 `@Res()`（非 passthrough）——心跳写出后响应头定型，
 * Nest 无法再改状态码，故状态码由调用方给出、信封由这里落（形状与
 * `ResponseInterceptor` 的 `{code:0,message:'ok',data}` 保持一致）。
 * 失败不需要在这里处理：抛出的异常仍由全局过滤器接管（它按 headersSent 分流）。
 */
export async function respondWithKeepalive(
  res: Response,
  status: number,
  run: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  res.status(status);
  const keepalive = startQueryKeepalive(res);
  try {
    keepalive.finish({ code: 0, message: 'ok', data: await run(keepalive.signal) });
  } finally {
    keepalive.stop();
  }
}
