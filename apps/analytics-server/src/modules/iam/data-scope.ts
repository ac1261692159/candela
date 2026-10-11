import { badRequest } from '../../i18n/domain-error';
import type { DataScope } from './iam.types';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escLit(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 事件分析 / SQL 守卫共用的 scope 谓词。unrestricted 返回空。 */
export function eventsPredicate(scope: DataScope): string | null {
  if (scope.unrestricted) return null;
  const parts: string[] = [];
  if (scope.events.mode === 'allow') {
    if (scope.events.keys.length === 0) return '0';
    const list = scope.events.keys.map((k) => `'${escLit(k)}'`).join(', ');
    parts.push(`event IN (${list})`);
  }
  if (scope.row_filter.length > 0) {
    const preds = scope.row_filter.map((n) => userPropPredicate(n));
    parts.push(`user_key IN (SELECT user_key FROM clklog_sa.sa_user_profiles WHERE ${preds.join(' AND ')})`);
  }
  return parts.length ? parts.join(' AND ') : null;
}

function userPropPredicate(n: { prop: string; op: string; value?: unknown }): string {
  if (!IDENT.test(n.prop)) {
    throw badRequest({
      code: 'iam.dataScope.invalidProp',
      messageKey: 'iam:error.dataScope.invalidProp',
      message: '非法用户属性名',
    });
  }
  const col = `JSONExtractString(properties, '${escLit(n.prop)}')`;
  if (n.op === '=' || n.op === 'eq') return `${col} = '${escLit(String(n.value ?? ''))}'`;
  if (n.op === '!=' ) return `${col} != '${escLit(String(n.value ?? ''))}'`;
  throw badRequest({
    code: 'iam.dataScope.unsupportedOperator',
    messageKey: 'iam:error.dataScope.unsupportedOperator',
    params: { op: n.op },
    message: `数据权限行过滤暂不支持操作符: ${n.op}`,
  });
}

export function assertEventsAllowed(scope: DataScope, eventKeys: string[]): void {
  if (scope.unrestricted || scope.events.mode === 'all') return;
  const allow = new Set(scope.events.keys);
  for (const key of eventKeys) {
    if (!allow.has(key)) {
      throw badRequest({
        code: 'iam.dataScope.eventForbidden',
        messageKey: 'iam:error.dataScope.eventForbidden',
        params: { event: key },
        message: `无权查询事件: ${key}`,
      });
    }
  }
}

export function assertPropsAllowed(scope: DataScope, kind: 'event' | 'user', keys: string[]): void {
  if (scope.unrestricted) return;
  const field = kind === 'event' ? scope.event_properties : scope.user_properties;
  if (field.mode === 'all') return;
  const allow = new Set(field.keys);
  for (const key of keys) {
    if (!allow.has(key)) {
      throw badRequest({
        code: 'iam.dataScope.propertyForbidden',
        messageKey: 'iam:error.dataScope.propertyForbidden',
        params: { property: key },
        message: `无权使用属性: ${key}`,
      });
    }
  }
}
