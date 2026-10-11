import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Request } from 'express';

/** 标记「使用 API Key 认证」的接口（区别于用户登录 token） */
export const API_KEY_REQUIRED_KEY = 'apiKeyRequired';
export const RequireApiKey = () => SetMetadata(API_KEY_REQUIRED_KEY, true);

/** API Key 校验后注入 request 的身份信息 */
export interface ApiKeyIdentity {
  id: string;
  name: string;
  project_name: string;
}

export const API_KEY_IDENTITY_KEY = 'sa_api_key_identity';

export const CurrentApiKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiKeyIdentity => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request[API_KEY_IDENTITY_KEY] as ApiKeyIdentity;
  },
);
