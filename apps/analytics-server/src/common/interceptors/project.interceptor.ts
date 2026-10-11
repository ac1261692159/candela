import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';

export const PROJECT_KEY = 'project_name';

/** 与前端 project.store 默认项一致；缺头时不能落到无成员的 `default`。 */
export const DEFAULT_ANALYTICS_PROJECT = 'clklogapp';

export function resolveProjectName(request: {
  headers: { [key: string]: string | string[] | undefined };
  query: { [key: string]: unknown };
  body?: unknown;
}): string {
  const bodyProject =
    request.body && typeof request.body === 'object' && request.body !== null
      ? (request.body as { project?: unknown }).project
      : undefined;
  const raw = request.headers['x-project-name'] ?? request.query['project'] ?? bodyProject;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return DEFAULT_ANALYTICS_PROJECT;
}

@Injectable()
export class ProjectInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    request[PROJECT_KEY] = resolveProjectName(request);
    return next.handle();
  }
}
