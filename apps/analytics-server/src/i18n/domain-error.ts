/**
 * 领域错误（i18n v1）：错误提示不再只带一句中文，而是携带
 * `errorCode`（机器码）+ `messageKey`（前端文案键）+ `params`（插值参数），
 * 中文 `message` 保留作为兼容兜底（老客户端 / API Key / Harness 调用方）。
 *
 * 契约见 `docs/architecture/clklog-analytics-design-i18n-v1.md` §6.1。
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export interface DomainErrorInput {
  /** 稳定机器码，形如 `meta.datatable.no_fields`（日志 / 告警 / 埋点用） */
  code: string;
  /** 前端文案键，形如 `errors:meta.datatable.noFields`（与前端 errors 命名空间对齐） */
  messageKey: string;
  /** 插值参数（无则省略） */
  params?: Record<string, unknown>;
  /**
   * 中文兜底文案（老客户端 / API Key / Harness 读它；新客户端优先走 messageKey）。
   *
   * 可省略：新增错误若没有值得保留的中文兜底，只给 `code` + `messageKey` 即可。
   * 覆盖率棘轮统计的是「未迁移抛错」（调用块内没有 messageKey），有 key 即不算未迁移；
   * 而新增中文兜底会推高目录的硬编码计数，与「只减不增」冲突。
   */
  message?: string;
}

export class DomainError extends HttpException {
  readonly errorCode: string;
  readonly messageKey: string;
  readonly params?: Record<string, unknown>;

  constructor(status: HttpStatus, input: DomainErrorInput) {
    super(
      {
        code: input.code,
        message: input.message,
        errorCode: input.code,
        messageKey: input.messageKey,
        ...(input.params ? { params: input.params } : {}),
      },
      status,
    );
    this.errorCode = input.code;
    this.messageKey = input.messageKey;
    this.params = input.params;
  }
}

export function domainError(status: HttpStatus, input: DomainErrorInput): DomainError {
  return new DomainError(status, input);
}

export function badRequest(input: DomainErrorInput): DomainError {
  return new DomainError(HttpStatus.BAD_REQUEST, input);
}

export function notFound(input: DomainErrorInput): DomainError {
  return new DomainError(HttpStatus.NOT_FOUND, input);
}

export function conflict(input: DomainErrorInput): DomainError {
  return new DomainError(HttpStatus.CONFLICT, input);
}

export function forbidden(input: DomainErrorInput): DomainError {
  return new DomainError(HttpStatus.FORBIDDEN, input);
}
