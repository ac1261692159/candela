/**
 * 通道发送用的小 HTTP 封装（phase: clklog-analytics-alert-channels-v1）。
 *
 * 统一：超时、请求体编码、以及「失败时把厂商原始错误带出来」——
 * 告警排障最需要的就是原始错误码（钉钉 310000 / 企业微信 errcode / SNS Throttling…）。
 */

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function request(
  url: string,
  init: RequestInit,
  options: HttpOptions = {},
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function postJson(
  url: string,
  payload: unknown,
  options: HttpOptions = {},
): Promise<HttpResponse> {
  return request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers ?? {}) },
      body: JSON.stringify(payload),
    },
    options,
  );
}

export function postText(
  url: string,
  text: string,
  options: HttpOptions = {},
): Promise<HttpResponse> {
  return request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8', ...(options.headers ?? {}) },
      body: text,
    },
    options,
  );
}

/** 2xx 视为成功，否则抛出带厂商原始响应的错误 */
export function assertHttpOk(result: HttpResponse, channel: string, snippet = 200): void {
  if (result.status >= 200 && result.status < 300) return;
  const body = result.body.replace(/\s+/g, ' ').slice(0, snippet);
  throw new Error(`${channel}_http_${result.status}${body ? `(${body})` : ''}`);
}

/**
 * 解析 JSON 响应体并按回调判定业务错误码（各厂商 HTTP 200 也可能带 error code）。
 * 非 JSON 响应不判错（网关页等），交由 assertHttpOk 的状态码判断。
 */
export function assertJsonOk(
  result: HttpResponse,
  channel: string,
  check: (parsed: Record<string, unknown>) => string | null,
): void {
  assertHttpOk(result, channel);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    return;
  }
  const failure = check(parsed);
  if (failure) throw new Error(`${channel}_${failure}`);
}

/** 把任意异常转成可落库的短消息（原始错误码优先保留） */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

/** 按长度截断（企业微信 2048 / Telegram 4096 等），保留尾部提示 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const suffix = '…（已截断）';
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}
