import { emptyScope, type IamContext } from './iam.types';

/** API Key 目录：项目内只读全开，不伪造 super_admin / project_owner。 */
export function catalogIamContext(): IamContext {
  return {
    platform_role: 'none',
    member: true,
    role_key: 'analyst',
    permissions: new Set([
      'dashboard.view',
      'dashboard.view_all',
      'model.query',
      'model.sql',
      'model.card_save',
    ]),
    data_scope: emptyScope(true),
    group_ids: [],
  };
}
