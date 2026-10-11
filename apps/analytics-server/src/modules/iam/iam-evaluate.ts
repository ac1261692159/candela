import { ADMIN_GRANT_FORBIDDEN, OPS_CODES, ROLE_RANK, codesForRole, ownerProjectCodes, type ProjectRoleKey } from './permission-catalog';
import { emptyScope, type DataPolicyDef, type DataScope, type FieldScope, type RowFilterNode } from './iam.types';

export function maxRole(roles: ProjectRoleKey[]): ProjectRoleKey | null {
  if (roles.length === 0) return null;
  return roles.reduce((best, cur) => (ROLE_RANK[cur] > ROLE_RANK[best] ? cur : best));
}

export function unionPermissions(
  platformRole: string,
  roles: ProjectRoleKey[],
  analysisAdminOverlay?: string[] | null,
): Set<string> {
  const set = new Set<string>();
  if (platformRole === 'super_admin') {
    for (const code of OPS_CODES) set.add(code);
  }
  const display = maxRole(roles);
  if (display === 'analysis_admin' && analysisAdminOverlay) {
    for (const code of sanitizeAdminOverlay(analysisAdminOverlay)) set.add(code);
    return set;
  }
  for (const role of roles) {
    for (const code of codesForRole(role)) set.add(code);
  }
  return set;
}

export function sanitizeAdminOverlay(grants: string[]): string[] {
  const allowed = new Set(ownerProjectCodes().filter((c) => !ADMIN_GRANT_FORBIDDEN.has(c)));
  return [...new Set(grants.filter((g) => allowed.has(g)))];
}

export function intersectField(a: FieldScope, b: FieldScope): FieldScope {
  if (a.mode === 'all' && b.mode === 'all') return { mode: 'all', keys: [] };
  if (a.mode === 'all') return { mode: 'allow', keys: [...b.keys] };
  if (b.mode === 'all') return { mode: 'allow', keys: [...a.keys] };
  const setB = new Set(b.keys);
  return { mode: 'allow', keys: a.keys.filter((k) => setB.has(k)) };
}

export function mergePolicies(policies: DataPolicyDef[]): DataScope {
  if (policies.length === 0) return emptyScope(false);
  let events: FieldScope = { mode: 'all', keys: [] };
  let eventProps: FieldScope = { mode: 'all', keys: [] };
  let userProps: FieldScope = { mode: 'all', keys: [] };
  const row: RowFilterNode[] = [];
  for (const p of policies) {
    events = intersectField(events, p.events ?? { mode: 'all', keys: [] });
    eventProps = intersectField(eventProps, p.event_properties ?? { mode: 'all', keys: [] });
    userProps = intersectField(userProps, p.user_properties ?? { mode: 'all', keys: [] });
    if (p.row_filter?.children?.length) row.push(...p.row_filter.children);
  }
  return {
    unrestricted: false,
    events,
    event_properties: eventProps,
    user_properties: userProps,
    row_filter: row,
  };
}

export function isProjectAdminRole(role: ProjectRoleKey | null): boolean {
  return role === 'project_owner' || role === 'analysis_admin';
}
