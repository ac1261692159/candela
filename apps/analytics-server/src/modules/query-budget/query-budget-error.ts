import { badRequest } from '../../i18n/domain-error';

/**
 * ClickHouse 资源守卫错误码 → 可读、可执行的领域错误。
 *
 * 这些错误不是故障，而是「查询超出平台预算」：原文（如
 * `Estimated query execution time (1818.45 seconds) is too long. Maximum: 300`）
 * 对使用者没有指向性，且经长查询心跳送出后已无 4xx/5xx 状态码可用，
 * 只能靠 `messageKey` 让前端/AI 拿到可读文案与机器码。
 */
const TIME_LIMIT_CODES = new Set(['158', '160']); // TIMEOUT_EXCEEDED、TOO_SLOW
const SIZE_LIMIT_CODES = new Set(['241', '307', '321']); // MEMORY_LIMIT、TOO_MANY_ROWS、TOO_MANY_BYTES

const TIME_LIMIT_RE = /estimated query execution time|timeout exceeded/i;
const SIZE_LIMIT_RE = /limit for rows or bytes to read exceeded|memory limit/i;

/** 命中预算类错误时返回对应 DomainError，否则返回 null（调用方透传原错误）。 */
export function toQueryBudgetError(error: unknown, maxExecutionTimeSeconds: number): Error | null {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (TIME_LIMIT_CODES.has(code) || TIME_LIMIT_RE.test(message)) {
    return badRequest({
      code: 'report.sql.queryTimeout',
      messageKey: 'report:error.sql.queryTimeout',
      params: { seconds: maxExecutionTimeSeconds },
      message: `查询超出平台时间上限（${maxExecutionTimeSeconds} 秒）。请缩小时间范围，或补上事件/属性过滤条件后重试`,
    });
  }
  if (SIZE_LIMIT_CODES.has(code) || SIZE_LIMIT_RE.test(message)) {
    return badRequest({
      code: 'report.sql.queryTooLarge',
      messageKey: 'report:error.sql.queryTooLarge',
      message: '查询读取的数据量超出平台上限。请缩小时间范围，或补上事件/属性过滤条件后重试',
    });
  }
  return null;
}
