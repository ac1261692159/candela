export type AssetType = 'folder' | 'dashboard' | 'card' | 'cohort' | 'tag';
export type AssetAction = 'update' | 'delete' | 'lock' | 'grant';

export interface FieldScope {
  mode: 'all' | 'allow';
  keys: string[];
}

export interface RowFilterNode {
  prop: string;
  op: string;
  value?: unknown;
}

export interface DataPolicyDef {
  events: FieldScope;
  event_properties: FieldScope;
  user_properties: FieldScope;
  row_filter?: { rel: 'and'; children: RowFilterNode[] } | null;
}

export interface DataScope {
  unrestricted: boolean;
  events: FieldScope;
  event_properties: FieldScope;
  user_properties: FieldScope;
  row_filter: RowFilterNode[];
}

export interface IamContext {
  platform_role: 'super_admin' | 'none';
  member: boolean;
  role_key: import('./permission-catalog').ProjectRoleKey | null;
  permissions: Set<string>;
  data_scope: DataScope;
  group_ids: string[];
}

export const ALL_SCOPE: FieldScope = { mode: 'all', keys: [] };

export function emptyScope(unrestricted = false): DataScope {
  return {
    unrestricted,
    events: { ...ALL_SCOPE },
    event_properties: { ...ALL_SCOPE },
    user_properties: { ...ALL_SCOPE },
    row_filter: [],
  };
}

export function emptyIam(): IamContext {
  return {
    platform_role: 'none',
    member: false,
    role_key: null,
    permissions: new Set(),
    data_scope: emptyScope(false),
    group_ids: [],
  };
}
