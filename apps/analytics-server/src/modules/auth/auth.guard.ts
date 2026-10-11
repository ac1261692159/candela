import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { USER_KEY } from '../../common/decorators/current-user.decorator';
import { API_KEY_REQUIRED_KEY } from '../../common/decorators/api-key.decorator';
import { domainError } from '../../i18n/domain-error';
import { AuthService } from './auth.service';

/**
 * 全局鉴权 Guard：从 Authorization: Bearer <token> 解析用户注入 request。
 * 标记 @Public() 的接口豁免；标记 @RequireApiKey() 的接口由 ApiKeyGuard
 * 负责认证（本 Guard 跳过，否则会先于 ApiKeyGuard 拦截 X-API-Key 请求）。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const apiKeyRequired = this.reflector.getAllAndOverride<boolean>(API_KEY_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (apiKeyRequired) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw domainError(HttpStatus.UNAUTHORIZED, {
        code: 'auth.session.required',
        messageKey: 'auth:error.session.required',
        message: '未登录',
      });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const user = await this.authService.validateToken(token);
    request[USER_KEY] = user;
    return true;
  }
}
