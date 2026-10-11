import { t } from '../i18n';
import { resolveParamKeys } from './error-params';

export const API_ERROR_TOAST_KEY = 'clklog-api-error';

/** 系统层异常：端口、系统调用、驱动堆栈，不应直接展示给使用者 */
const INTERNAL_ERROR_RE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPERM|EACCES|ENOENT|ECONNABORTED|socket hang up|network error|connect e|getaddrinfo|aggregateerror|prisma|clickhouse|127\.0\.0\.1|0\.0\.0\.0|localhost:\d+|connection refused|connection reset|connection terminated|proxy error|request failed with status code|internal server error/i;

/** SQL 业务报错需要保留原文，方便自定义 SQL 排错 */
const SQL_BUSINESS_RE =
  /unknown identifier|syntax error|missing columns|project_name|未知标识|语法错误/i;

export interface ApiErrorInput {
  message?: string | string[];
  httpStatus?: number;
  code?: string;
  /** 后端下发的文案键（`errors:...`）；有则优先按当前语言渲染 */
  messageKey?: string;
  /** 文案插值参数 */
  params?: Record<string, unknown>;
}

function joinMessage(message?: string | string[]): string {
  if (Array.isArray(message)) {
    return message.filter(Boolean).join('；');
  }
  return (message || '').trim();
}

function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text) || /<\/[a-z][\w-]*>/i.test(text);
}

/**
 * 把接口错误翻译成给用户看的一句话。
 *
 * 优先级：后端错误码（`messageKey`）→ 业务原文（SQL 报错保留细节）→ 按状态码 / 网络状况给通用提示。
 * 技术细节（堆栈、内部地址、驱动名）一律不外泄。
 */
export function toUserFacingApiError(input: ApiErrorInput): string {
  const message = joinMessage(input.message);
  const status = input.httpStatus;
  const code = input.code || '';

  if (input.messageKey) {
    return t(input.messageKey, resolveParamKeys(input.params, t));
  }

  if (status === 401) return t('errors:status401');
  if (status === 403) return t('errors:status403');
  if (status === 404) return t('errors:status404');
  // 请求体超限（express body-parser 直接拒绝，没有 messageKey）：说清是「太大」而不是「服务不可用」
  if (status === 413) return t('errors:status413');
  if (status === 429) return t('errors:status429');

  const timeout = code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(message);
  if (timeout) return t('errors:requestTimeout');

  const noResponse = !status && (code === 'ERR_NETWORK' || /network error/i.test(message));
  const gatewayDown = status === 502 || status === 503 || status === 504;
  if (noResponse || gatewayDown) return t('errors:serviceUnavailable');

  // Vite 代理在后端未启动时返回空 body 的 500，Axios 原文不能展示给使用者
  if (status && status >= 500 && (!message || /request failed with status code/i.test(message))) {
    return t('errors:serviceUnavailable');
  }

  const technical = !message || looksLikeHtml(message) || INTERNAL_ERROR_RE.test(message);

  if (technical && !SQL_BUSINESS_RE.test(message)) {
    if (/8123|clickhouse/i.test(message)) return t('errors:dataUnavailable');
    if (status && status >= 500) return t('errors:genericUnavailable');
    if (!status) return t('errors:serviceUnavailable');
    return t('errors:genericUnavailable');
  }

  return message || t('errors:requestFailed');
}
