/**
 * 校验失败负载的构造与抛错（i18n v1 补交）。
 *
 * 校验器（`channel-config-schema` / `senders/*`）只产出 `ValidationIssue`：
 * - `message`：中文原文，**逐字保留**（老客户端 / API Key / Harness 兜底）；
 * - `message_key`：前端 `alerting:error.*` 文案键，由查看者按界面语言渲染；
 * - `params`：插值参数（显示名以 `xxx` + `xxx_key` 成对下发，见 `channel-types.ts`）。
 *
 * 抛错统一走 `validationError()`：一次填齐 code / messageKey / params / message，
 * 前端既有 `api-error.ts` 的「优先 messageKey、回落 message」逻辑即可显示本地化文案。
 */
import { badRequest, type DomainError } from '../../../i18n/domain-error';
import type { ValidationIssue } from './channel-types';

/** 兜底文案键：正常路径上每个 issue 都自带 message_key，这里只防手写出错时前端露出键名 */
export const VALIDATION_FALLBACK_KEY = 'alerting:error.validate.failed';

export function validationIssue(
  message: string,
  messageKey: string,
  params?: Record<string, unknown>,
): ValidationIssue {
  return { message, message_key: messageKey, ...(params ? { params } : {}) };
}

/** 校验失败 → 领域错误（HTTP 400）：code 为稳定机器码，文案由 messageKey 决定 */
export function validationError(code: string, issue: ValidationIssue): DomainError {
  return badRequest({
    code,
    messageKey: issue.message_key ?? VALIDATION_FALLBACK_KEY,
    ...(issue.params ? { params: issue.params } : {}),
    message: issue.message,
  });
}
