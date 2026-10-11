import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import type { IamContext } from './iam.types';
import { emptyIam } from './iam.types';

export const IAM_KEY = 'sa_iam_context';

export const CurrentIam = createParamDecorator((_data: unknown, ctx: ExecutionContext): IamContext => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return (request[IAM_KEY] as IamContext | undefined) ?? emptyIam();
});
