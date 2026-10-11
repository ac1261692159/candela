import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { domainError } from '../../i18n/domain-error';
import { ApiKeyService } from '../../modules/auth/api-key.service';
import {
  API_KEY_IDENTITY_KEY,
  API_KEY_REQUIRED_KEY,
} from '../decorators/api-key.decorator';

/**
 * API Key 认证 Guard：仅对标记 @RequireApiKey() 的接口生效。
 * 从 `X-API-Key` 或 `Authorization: Bearer <key>` 提取 key 并校验，
 * 注入身份（含 project_name 边界）。
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(API_KEY_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const key = this.extractKey(request);
    if (!key) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'common.apiKey.missing',
        messageKey: 'errors:apiKey.missing',
        message: '缺少 API Key（请通过 X-API-Key 或 Authorization: Bearer 提供）',
      });
    }

    const identity = await this.apiKeyService.validate(key);
    request[API_KEY_IDENTITY_KEY] = identity;
    return true;
  }

  private extractKey(request: Request): string | null {
    const header = request.headers['x-api-key'];
    if (typeof header === 'string' && header.trim()) return header.trim();

    const auth = request.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice('Bearer '.length).trim();
    }
    return null;
  }
}
