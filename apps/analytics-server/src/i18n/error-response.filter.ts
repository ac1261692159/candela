/**
 * 全局异常过滤器（由 `src/common/filters/http-exception.filter.ts` 迁入）。
 *
 * 迁入原因：i18n v1 需要在这里补 `errorCode` / `messageKey` / `params` 三个字段，
 * 而 `src/common/` 是冻结目录（只减不增），故实现整体落到 `src/i18n/` 窄包（common 文件数 −1）。
 *
 * 行为与原实现保持一致：
 * - 5xx 与含内部信息（连接串、驱动名、内网地址）的异常统一替换为「服务不可用」，不外泄细节；
 * - `current_revision` 冲突响应原样透出（卡片并发保存用）；
 * - `DomainError` 额外带 `errorCode` / `messageKey` / `params`，老客户端继续读 `message`。
 */
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from './domain-error';

const INTERNAL_ERROR_RE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|connect e|127\.0\.0\.1|clickhouse|prisma|connection refused/i;

function joinExceptionMessage(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw)) {
    return raw.filter((item) => typeof item === 'string').join('；') || fallback;
  }
  return fallback;
}

function toPublicErrorMessage(raw: string): string {
  if (!raw || INTERNAL_ERROR_RE.test(raw)) {
    return '服务暂时不可用，请稍后重试';
  }
  return raw;
}

/**
 * 落错误信封。响应头已发出（长查询心跳保活已开始流式输出）时状态码不可再改，
 * 只能把信封续写进已打开的流；前端对 `code !== 0` 的处理与带状态码时一致。
 */
function sendEnvelope(response: Response, status: number, body: Record<string, unknown>): void {
  if (response.headersSent) {
    response.end(JSON.stringify(body));
    return;
  }
  response.status(status).json(body);
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = 500;
    let message = 'Internal server error';
    let code = -1;
    let errorCode: string | undefined;
    let messageKey: string | undefined;
    let params: Record<string, unknown> | undefined;

    this.logger.error(
      `异常: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : '',
    );

    if (exception instanceof DomainError) {
      status = exception.getStatus();
      message = exception.message;
      code = status;
      errorCode = exception.errorCode;
      messageKey = exception.messageKey;
      params = exception.params;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      const payload =
        typeof res === 'object' && res
          ? (res as { message?: unknown; current_revision?: unknown; messageKey?: unknown; params?: unknown })
          : null;
      const raw = typeof res === 'string' ? res : payload?.message;
      message = joinExceptionMessage(raw, message);
      code = status;
      if (typeof payload?.messageKey === 'string') messageKey = payload.messageKey;
      if (payload?.params && typeof payload.params === 'object') {
        params = payload.params as Record<string, unknown>;
      }
      if (status >= 500) {
        message = toPublicErrorMessage(message);
        messageKey = undefined;
        params = undefined;
      }
      const currentRevision = payload?.current_revision;
      if (Number.isSafeInteger(currentRevision)) {
        // 并发冲突响应要带 current_revision（前端据此做「本地/远端」对比），
        // 同时把 messageKey/params 一并透出：否则这条例外会丢掉本地化键、退化成中文兜底。
        sendEnvelope(response, status, {
          code,
          message,
          ...(messageKey ? { messageKey } : {}),
          ...(params ? { params } : {}),
          data: { current_revision: currentRevision },
        });
        return;
      }
    } else if (exception instanceof Error) {
      message = toPublicErrorMessage(exception.message);
    }

    sendEnvelope(response, status, {
      code,
      message,
      ...(errorCode ? { errorCode } : {}),
      ...(messageKey ? { messageKey } : {}),
      ...(params ? { params } : {}),
      data: null,
    });
  }
}
