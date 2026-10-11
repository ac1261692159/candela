import { Injectable } from '@nestjs/common';
import { assertEventsAllowed, assertPropsAllowed, eventsPredicate } from './data-scope';
import type { DataScope } from './iam.types';

/** 数据权限注入唯一入口；SQL 生成器只吃 extraAnd 字符串。 */
@Injectable()
export class DataScopeService {
  applyToEventsQuery(scope: DataScope | undefined | null): { extraAnd: string | null } {
    if (!scope) return { extraAnd: null };
    return { extraAnd: eventsPredicate(scope) };
  }

  cacheKey(scope: DataScope | undefined | null): string {
    if (!scope || scope.unrestricted) return 'unrestricted';
    return JSON.stringify({
      e: scope.events,
      ep: scope.event_properties,
      up: scope.user_properties,
      r: scope.row_filter,
    });
  }

  assertEvents(scope: DataScope | undefined | null, keys: string[]): void {
    if (!scope) return;
    assertEventsAllowed(scope, keys);
  }

  assertProps(scope: DataScope | undefined | null, kind: 'event' | 'user', keys: string[]): void {
    if (!scope) return;
    assertPropsAllowed(scope, kind, keys);
  }
}
