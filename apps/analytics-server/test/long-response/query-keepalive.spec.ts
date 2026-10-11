/**
 * 长查询保活（心跳 + 断开取消）单测。
 *
 * 背景：公网链路在响应等待期无字节流动约 60 秒会切断连接，
 * 心跳必须在查询期间持续产出字节；而心跳写出后响应头定型，落信封要走手动续写分支。
 */
import type { Response } from 'express';
import { respondWithKeepalive, startQueryKeepalive } from '../../src/modules/long-response/query-keepalive';

interface FakeResponse {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  status: jest.Mock;
  setHeader: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  json: jest.Mock;
  once: jest.Mock;
  off: jest.Mock;
  closed?: () => void;
}

function fakeResponse(overrides: Partial<FakeResponse> = {}): FakeResponse {
  const res: FakeResponse = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status: jest.fn(function (this: FakeResponse) {
      return res;
    }),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    json: jest.fn(),
    once: jest.fn(function (this: FakeResponse, event: string, handler: () => void) {
      if (event === 'close') res.closed = handler;
      return res;
    }),
    off: jest.fn(),
    ...overrides,
  };
  return res;
}

/** 保活只依赖 res 的少量成员，这里给出最小替身 */
function asResponse(res: FakeResponse): Response {
  return res as unknown as Response;
}

describe('startQueryKeepalive', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('按间隔写空白字节（不写正文、不改状态码），并先定好 Content-Type', () => {
    const res = fakeResponse();
    const keepalive = startQueryKeepalive(asResponse(res), { intervalMs: 1000 });

    // 心跳写出后响应头定型，Content-Type 必须在第一次写之前设置
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    jest.advanceTimersByTime(3000);
    expect(res.write).toHaveBeenCalledTimes(3);
    expect(res.write).toHaveBeenCalledWith('\n');
    expect(res.json).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    keepalive.stop();
  });

  it('未开始流式输出时走 Express json（保持既有响应形状）', () => {
    const res = fakeResponse();
    const keepalive = startQueryKeepalive(asResponse(res), { intervalMs: 1000 });

    keepalive.finish({ code: 0, message: 'ok', data: { rows: 1 } });
    expect(res.json).toHaveBeenCalledWith({ code: 0, message: 'ok', data: { rows: 1 } });
    expect(res.end).not.toHaveBeenCalled();
    keepalive.stop();
  });

  it('已写心跳（headersSent）后手动续写信封，前置空白仍可 JSON.parse', () => {
    const res = fakeResponse();
    const keepalive = startQueryKeepalive(asResponse(res), { intervalMs: 1000 });

    jest.advanceTimersByTime(2000);
    res.write.mockClear();
    res.headersSent = true;

    const body = { code: 0, message: 'ok', data: { rows: 7 } };
    keepalive.finish(body);

    expect(res.json).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
    const written = String(res.end.mock.calls[0][0]);
    // 心跳已写出的两个 \n + 信封，客户端侧按一段文本解析
    expect(JSON.parse(`\n\n${written}`)).toEqual(body);
    keepalive.stop();
  });

  it('客户端断开触发取消信号（供 ClickHouse abort_signal）', () => {
    const res = fakeResponse();
    const keepalive = startQueryKeepalive(asResponse(res), { intervalMs: 1000 });

    expect(keepalive.signal.aborted).toBe(false);
    res.closed?.();
    expect(keepalive.signal.aborted).toBe(true);
    // 断开后不再写（连接已不可用）
    res.write.mockClear();
    jest.advanceTimersByTime(5000);
    expect(res.write).not.toHaveBeenCalled();
    keepalive.stop();
  });

  it('正常结束（writableEnded）不触发取消，且 stop 后不再写', () => {
    const res = fakeResponse();
    const keepalive = startQueryKeepalive(asResponse(res), { intervalMs: 1000 });

    res.writableEnded = true;
    res.closed?.();
    expect(keepalive.signal.aborted).toBe(false);

    keepalive.stop();
    res.write.mockClear();
    jest.advanceTimersByTime(10_000);
    expect(res.write).not.toHaveBeenCalled();
  });

  describe('respondWithKeepalive（长接口统一入口包装）', () => {
    it('状态码由调用方给出，成功信封与 ResponseInterceptor 一致', async () => {
      const res = fakeResponse();
      await respondWithKeepalive(asResponse(res), 201, async () => ({ rows: 2 }));

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ code: 0, message: 'ok', data: { rows: 2 } });
    });

    it('心跳已写出时信封走手动续写分支', async () => {
      const res = fakeResponse();
      await respondWithKeepalive(asResponse(res), 201, async () => {
        res.headersSent = true;
        return { rows: 5 };
      });

      expect(res.json).not.toHaveBeenCalled();
      expect(JSON.parse(String(res.end.mock.calls[0][0]))).toEqual({
        code: 0,
        message: 'ok',
        data: { rows: 5 },
      });
    });

    it('业务抛错时不写信封，异常交给全局过滤器', async () => {
      const res = fakeResponse();
      await expect(
        respondWithKeepalive(asResponse(res), 201, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(res.json).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });
  });
});
