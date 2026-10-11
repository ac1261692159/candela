import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { PROJECT_KEY } from '../interceptors/project.interceptor';

export const CurrentProject = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request[PROJECT_KEY];
  },
);
