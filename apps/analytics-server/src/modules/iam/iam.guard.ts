import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { API_KEY_REQUIRED_KEY } from '../../common/decorators/api-key.decorator';
import { USER_KEY } from '../../common/decorators/current-user.decorator';
import { IAM_KEY } from './current-iam.decorator';
import {
  ALLOW_WITHOUT_MEMBERSHIP_KEY,
  REQUIRE_MEMBER_KEY,
  REQUIRE_PERMISSION_KEY,
} from './require-permission';
import { IamService } from './iam.service';
import type { AuthUser } from '../auth/auth.service';
import { emptyIam } from './iam.types';
import { resolveProjectName } from '../../common/interceptors/project.interceptor';
import { forbidden } from '../../i18n/domain-error';

@Injectable()
export class IamGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly iam: IamService,
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
    const user = request[USER_KEY] as AuthUser | undefined;
    if (!user) {
      request[IAM_KEY] = emptyIam();
      return true;
    }

    const project = projectFromRequest(request);
    const ctx = await this.iam.evaluate(user.id, project);
    request[IAM_KEY] = ctx;

    const codes = this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (codes?.length) {
      if (!codes.some((c) => ctx.permissions.has(c))) {
        throw forbidden({
          code: 'iam.forbidden',
          messageKey: 'iam:error.forbidden',
          message: '无权访问该资源',
        });
      }
      return true;
    }

    const allowWithout = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_MEMBERSHIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowWithout) return true;

    const requireMember = this.reflector.getAllAndOverride<boolean>(REQUIRE_MEMBER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requireMember && !ctx.member) {
      throw forbidden({
        code: 'iam.member.notMember',
        messageKey: 'iam:error.member.notMember',
        message: '不是该项目成员',
      });
    }

    if (!ctx.member && ctx.platform_role !== 'super_admin') {
      throw forbidden({
        code: 'iam.member.notMember',
        messageKey: 'iam:error.member.notMember',
        message: '不是该项目成员',
      });
    }
    return true;
  }
}

function projectFromRequest(request: Request): string {
  return resolveProjectName(request);
}
